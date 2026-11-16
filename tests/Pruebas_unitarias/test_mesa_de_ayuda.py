import pytest

import main
from conftest import FakeConexion, FakeCursor, SOPORTE, headers_de


@pytest.mark.parametrize("payload", [
    {"id_tipo": 1, "titulo_ticket": "", "descripcion": "detalle"},
    {"id_tipo": 1, "titulo_ticket": "   ", "descripcion": "detalle"},
    {"id_tipo": 1, "titulo_ticket": "x" * 101, "descripcion": "detalle"},
    {"id_tipo": 1, "titulo_ticket": "Reporte", "descripcion": ""},
    {"id_tipo": 1, "titulo_ticket": "Reporte", "descripcion": "   "},
])
def test_TK02_rechaza_vacios_y_titulo_mayor_a_100_sin_conectar(client, payload):
    respuesta = client.post("/tickets", headers=headers_de(SOPORTE), json=payload)
    assert respuesta.status_code == 422


def _cursor_para_ticket(monkeypatch, filas):
    cursor = FakeCursor(filas=filas)
    monkeypatch.setattr(main, "_resolver_id_usuario", lambda _email: 1)
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))
    return cursor


def test_TK02_tipo_inexistente_o_inactivo_no_inserta(monkeypatch, client):
    cursor = _cursor_para_ticket(monkeypatch, [None])
    respuesta = client.post("/tickets", headers=headers_de(SOPORTE), json={
        "id_tipo": 999999, "titulo_ticket": "Prueba", "descripcion": "Entrada sintética",
    })
    assert respuesta.status_code == 404
    assert "estado_tipo = 'Activo'" in cursor.consultas[0][0]
    assert not any("INSERT INTO emergencia.ticket" in sql for sql, _ in cursor.consultas)


def test_TK02_apartado_inexistente_o_inactivo_no_inserta(monkeypatch, client):
    cursor = _cursor_para_ticket(monkeypatch, [("Tipo activo",), None])
    respuesta = client.post("/tickets", headers=headers_de(SOPORTE), json={
        "id_tipo": 1, "id_apartado": 999999,
        "titulo_ticket": "Prueba", "descripcion": "Entrada sintética",
    })
    assert respuesta.status_code == 404
    assert "estado_apartado = 'Activo'" in cursor.consultas[1][0]
    assert not any("INSERT INTO emergencia.ticket" in sql for sql, _ in cursor.consultas)


def test_TK09_responder_ticket_inexistente_devuelve_404(monkeypatch, client):
    cursor = _cursor_para_ticket(monkeypatch, [])
    respuesta = client.post(
        "/tickets/99999999/respuestas",
        headers=headers_de(SOPORTE),
        json={"mensaje": "respuesta sintética", "tipo_respuesta": "Respuesta"},
    )
    assert respuesta.status_code == 404
    assert not any("INSERT INTO emergencia.respuesta_ticket" in sql for sql, _ in cursor.consultas)


@pytest.mark.parametrize(("path", "payload"), [
    ("/tickets/99999999/estado", {"estado": "INVALIDO"}),
    ("/tickets/99999999/prioridad", {"prioridad": "Urgente"}),
])
def test_TK08_valores_estado_y_prioridad_invalidos_devuelven_422(client, path, payload):
    respuesta = client.patch(path, headers=headers_de(SOPORTE), json=payload)
    assert respuesta.status_code == 422


@pytest.mark.parametrize(("path", "payload"), [
    ("/tickets/99999999/estado", {"estado": "En proceso"}),
    ("/tickets/99999999/prioridad", {"prioridad": "Alta"}),
])
def test_TK09_actualizaciones_de_ticket_inexistente_devuelven_404(monkeypatch, client, path, payload):
    cursor = _cursor_para_ticket(monkeypatch, [])
    respuesta = client.patch(path, headers=headers_de(SOPORTE), json=payload)
    assert respuesta.status_code == 404
    assert "RETURNING id_ticket" in cursor.consultas[0][0]


def test_TK08_actualizacion_valida_confirma_ticket_existente(monkeypatch, client):
    cursor = _cursor_para_ticket(monkeypatch, [(17,)])
    respuesta = client.patch(
        "/tickets/17/prioridad", headers=headers_de(SOPORTE), json={"prioridad": "Alta"},
    )
    assert respuesta.status_code == 200
    assert respuesta.json() == {"ok": True, "prioridad": "Alta"}
