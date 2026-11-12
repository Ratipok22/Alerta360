"""Suite automatizada de los 16 casos de seguridad de la matriz de pruebas
(MATRIZ_CASOS_PRUEBA, tipo Seguridad). Cada test indica su ID de caso."""
import base64
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException

import main
from core import auth
from conftest import (ADMIN, CLAVE_DEMO, SOPORTE, VISUALIZADOR, FakeConexion,
                      FakeCursor, headers_de, token_de)


# ---------------------------------------------------------------- Acceso
def test_AUT02_credencial_invalida_respuesta_generica(client):
    variantes = [
        {"email": "noexiste@bomberos.cl", "password": "x"},
        {"email": ADMIN, "password": "incorrecta"},
        {"email": "", "password": ""},
    ]
    respuestas = [client.post("/auth/login", json=v) for v in variantes]
    assert all(r.status_code == 401 for r in respuestas)
    assert len({r.json()["detail"] for r in respuestas}) == 1
    assert all("token" not in r.json() for r in respuestas)


@pytest.mark.parametrize("header", [
    None,
    "",
    "Bearer abc.def.ghi",
    "Bearer " + jwt.encode({"sub": ADMIN, "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                           "clave-falsa", algorithm="HS256"),
    "Bearer " + jwt.encode({"sub": ADMIN, "exp": datetime.now(timezone.utc) - timedelta(hours=1)},
                           auth.SECRET_KEY, algorithm="HS256"),
])
def test_AUT04_jwt_invalido_rechazado(client, header):
    h = {"Authorization": header} if header is not None else {}
    assert client.get("/auth/me", headers=h).status_code == 401
    assert client.get("/resources", headers=h).status_code == 401
    r = client.post("/emergencies", headers=h, json={})
    assert r.status_code in (401, 422)


def test_AUT05_rol_se_resuelve_en_servidor_no_desde_token(client):
    # Un token con un claim de rol inventado no eleva privilegios.
    falso = jwt.encode({"sub": VISUALIZADOR, "rol": "admin",
                        "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                       auth.SECRET_KEY, algorithm="HS256")
    assert auth.verificar_token(falso).rol == "visualizador"
    r = client.post("/emergencies", headers={"Authorization": f"Bearer {falso}"},
                    json={"codigo_emergencia": "10-1", "direccion_emergencia": "x",
                          "latitud_emergencia": -33.04, "longitud_emergencia": -71.6,
                          "prioridad_emergencia": 3})
    assert r.status_code == 403


def test_AUT08_bloqueo_por_fuerza_bruta():
    for _ in range(5):
        assert auth.verificar_credenciales(ADMIN, "mala") is None
    with pytest.raises(auth.CuentaBloqueada):
        auth.verificar_credenciales(ADMIN, CLAVE_DEMO)


def test_AUT08_login_responde_429_al_bloquear(client):
    for _ in range(5):
        client.post("/auth/login", json={"email": ADMIN, "password": "mala"})
    r = client.post("/auth/login", json={"email": ADMIN, "password": "mala"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


# ---------------------------------------------------------------- Roles
@pytest.mark.parametrize("email,esperado", [(VISUALIZADOR, 403), (SOPORTE, 403), (None, 401)])
def test_PER01_despacho_reservado_a_admin(client, email, esperado):
    h = headers_de(email) if email else {}
    cuerpo = {"codigo_emergencia": "10-1", "direccion_emergencia": "x",
              "latitud_emergencia": -33.04, "longitud_emergencia": -71.6, "prioridad_emergencia": 3}
    assert client.post("/emergencies", headers=h, json=cuerpo).status_code == esperado
    assert client.post("/assignments?id_emergencia=1&id_recurso=1", headers=h).status_code == esperado


@pytest.mark.parametrize("email", [ADMIN, VISUALIZADOR])
def test_PER02_solo_soporte_administra_tickets(client, email):
    h = headers_de(email)
    assert client.patch("/tickets/1/prioridad", headers=h, json={"prioridad_ticket": "Alta"}).status_code == 403
    r = client.post("/tickets/1/respuestas", headers=h, json={"tipo_respuesta": "Respuesta", "mensaje": "x"})
    assert r.status_code == 403


def test_PER03_no_responde_ticket_ajeno(client, monkeypatch):
    monkeypatch.setattr(main, "_resolver_id_usuario", lambda email: 1)
    cursor = FakeCursor(filas=[("Abierto", 2)])  # ticket creado por el usuario 2
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))
    r = client.post("/tickets/5/respuestas", headers=headers_de(VISUALIZADOR),
                    json={"tipo_respuesta": "Usuario", "mensaje": "intento IDOR"})
    assert r.status_code == 403
    assert not any("INSERT" in sql for sql, _ in cursor.consultas)


def test_PER05_visualizador_solo_ve_su_compania(client, monkeypatch):
    recibido = {}
    monkeypatch.setattr(main, "_resolver_id_compania_usuario", lambda email: 9)
    monkeypatch.setattr(main, "obtener_recursos",
                        lambda filtro=None: recibido.setdefault("filtro", filtro) and [])
    assert client.get("/resources", headers=headers_de(VISUALIZADOR)).status_code == 200
    assert recibido["filtro"] == 9

    recibido.clear()
    client.get("/resources", headers=headers_de(ADMIN))
    assert recibido["filtro"] is None


def test_PER05_visualizador_no_da_de_baja_recurso_ajeno(client, monkeypatch):
    monkeypatch.setattr(main, "_resolver_id_compania_usuario", lambda email: 9)
    cursor = FakeCursor(filas=[(8,)])  # el recurso pertenece a la compania 8
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))
    r = client.patch("/resources/R-8/estado", headers=headers_de(VISUALIZADOR), json={"estado": "6-9"})
    assert r.status_code == 403
    assert not any("UPDATE" in sql for sql, _ in cursor.consultas)


# ---------------------------------------------------------------- Tickets
PNG_REAL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


@pytest.mark.parametrize("adjunto", [
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",   # MIME no permitido
    "data:image/png;base64,###CORRUPTO###",                          # base64 invalido
    "data:image/png;base64," + base64.b64encode(b"hola mundo").decode(),  # contenido falso
    "data:image/png;base64," + "A" * (main._LIMITE_ADJUNTO_BASE64 + 4),   # sobre el limite
])
def test_TK03_adjuntos_invalidos_rechazados(adjunto):
    with pytest.raises(HTTPException) as e:
        main._validar_archivo_adjunto(adjunto)
    assert e.value.status_code == 400


def test_TK03_imagen_real_aceptada():
    main._validar_archivo_adjunto("data:image/png;base64," + PNG_REAL)
    main._validar_archivo_adjunto(None)


@pytest.mark.parametrize("adjunto", ["javascript:alert(1)", "file:///etc/passwd", "vbscript:msgbox(1)"])
def test_TK11_esquemas_maliciosos_rechazados(adjunto):
    with pytest.raises(HTTPException) as e:
        main._validar_archivo_adjunto(adjunto)
    assert e.value.status_code == 400


# ---------------------------------------------------------------- Seguridad general
@pytest.mark.parametrize("payload", ["' OR '1'='1", "<script>alert(1)</script>", "'); DROP TABLE emergencia.emergencia;--"])
def test_SE01_entrada_maliciosa_viaja_como_parametro(client, monkeypatch, payload):
    import core.zonificacion as zon
    monkeypatch.setattr(main, "obtener_tipos", lambda: [{"codigo": "10-1"}])
    monkeypatch.setattr(zon, "resolver_zona", lambda *a, **k: "Z1")
    fila = (1, "10-1", payload, -33.04, -71.6, 3, "Activa", datetime.now(), "Z1", None, None)
    cursor = FakeCursor(filas=[fila])
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))
    r = client.post("/emergencies", headers=headers_de(ADMIN),
                    json={"codigo_emergencia": "10-1", "direccion_emergencia": payload,
                          "latitud_emergencia": -33.04, "longitud_emergencia": -71.6,
                          "prioridad_emergencia": 3})
    assert r.status_code == 200
    sql, params = cursor.consultas[-1]
    assert payload not in sql            # nunca se concatena al SQL
    assert payload in params             # viaja como parametro
    assert r.json()["direccion_emergencia"] == payload  # se devuelve literal


def test_SE02_cors_solo_origen_autorizado(client):
    pre = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    malo = client.options("/resources", headers={"Origin": "http://sitio-malicioso.com", **pre})
    bueno = client.options("/resources", headers={"Origin": "http://localhost:5173", **pre})
    assert "access-control-allow-origin" not in malo.headers
    assert bueno.headers.get("access-control-allow-origin") == "http://localhost:5173"


PUBLICAS = {("/health", "get"), ("/auth/login", "post"),
            ("/docs", "get"), ("/openapi.json", "get"), ("/redoc", "get")}


def test_SE03_toda_ruta_de_datos_exige_sesion(client):
    spec = client.get("/openapi.json").json()
    sin_proteccion = []
    for ruta, metodos in spec["paths"].items():
        for metodo in metodos:
            if (ruta, metodo) in PUBLICAS:
                continue
            url = ruta.replace("{", "").replace("}", "")  # parametros de ruta con valor dummy
            r = client.request(metodo.upper(), url)
            if r.status_code not in (401, 403, 422):
                sin_proteccion.append(f"{metodo.upper()} {ruta} -> {r.status_code}")
            elif r.status_code == 422 and "authorization" not in r.text.lower():
                # 422 solo es aceptable si la validacion fallo antes que la auth por falta de body
                r2 = client.request(metodo.upper(), url, json={})
                if r2.status_code not in (401, 403, 422):
                    sin_proteccion.append(f"{metodo.upper()} {ruta} -> {r2.status_code}")
    assert not sin_proteccion, sin_proteccion


def test_SE04_error_500_no_expone_detalles_de_bd(client, monkeypatch):
    def falla():
        raise Exception('password authentication failed for user "emergency" host 127.0.0.1 port 5432')
    monkeypatch.setattr(main, "obtener_conexion", falla)
    r = client.get("/emergencies", headers=headers_de(ADMIN))
    assert r.status_code == 500
    for fuga in ("emergency", "127.0.0.1", "5432", "password"):
        assert fuga not in r.text


def test_SE05_limite_de_tasa_en_prediccion(client, monkeypatch):
    monkeypatch.setattr(main, "obtener_o_generar", lambda **k: {"periodos": []})
    h = headers_de(ADMIN)
    codigos = [client.get("/prediction/demand", headers=h).status_code for _ in range(21)]
    assert codigos[:20] == [200] * 20
    assert codigos[20] == 429


def _version(paquete):
    from importlib.metadata import version
    return tuple(int(x) for x in version(paquete).split(".")[:2])


def test_SE06_dependencias_sin_vulnerabilidades_conocidas():
    # Versiones minimas que corrigen los CVEs detectados con pip-audit (PYSEC-2026-4141/4183/4320).
    assert _version("PyJWT") >= (2, 15)
    assert _version("certifi") >= (2026, 10)
