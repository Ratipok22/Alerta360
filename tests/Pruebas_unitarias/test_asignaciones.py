import pytest

import main
from conftest import ADMIN, FakeConexion, FakeCursor, headers_de


@pytest.mark.parametrize("resources", [
    [],
    [{"codigo": "R-1", "tipo": "Rescate", "disponible": True, "lat": -33.0, "lng": -71.0}],
    [{"codigo": "B-1", "tipo": "Bomberos", "disponible": False, "lat": -33.0, "lng": -71.0}],
])
def test_AS02_no_recomienda_si_no_hay_unidad_compatible_disponible(client, monkeypatch, resources):
    monkeypatch.setattr(main, "obtener_tipos", lambda: [{"codigo": "10-1", "terreno": "urbano"}])
    monkeypatch.setattr(main, "obtener_recursos", lambda *_args, **_kwargs: resources)
    respuesta = client.post("/assignment/recommend", headers=headers_de(ADMIN), json={
        "type": "10-1", "priority": "ALTA", "lat": -33.04, "lng": -71.60,
    })
    assert respuesta.status_code == 404
    assert "No hay recursos disponibles" in respuesta.json()["detail"]


def test_AS03_rechaza_recurso_incompatible_antes_de_insertar(client, monkeypatch):
    cursor = FakeCursor(filas=[
        ("Activa", -33.04, -71.60, "urbano", "10-1"),
        (0,),
        ("R-1", "6-0", -33.03, -71.59),
    ])
    monkeypatch.setattr(main, "_resolver_id_usuario", lambda _email: 1)
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))

    respuesta = client.post(
        "/assignments?id_emergencia=7&id_recurso=22&tipo_asignacion=Manual",
        headers=headers_de(ADMIN),
    )

    assert respuesta.status_code == 400
    assert "no es compatible" in respuesta.json()["detail"]
    assert not any("INSERT INTO emergencia.asignacion" in sql for sql, _ in cursor.consultas)


def test_AS03_asigna_unidad_compatible_y_persiste_estado_en_trayecto(client, monkeypatch):
    cursor = FakeCursor(filas=[
        ("Activa", -33.04, -71.60, "urbano", "10-1"),
        (0,),
        ("B-1", "6-0", -33.03, -71.59),
        (19,),
    ])
    monkeypatch.setattr(main, "_resolver_id_usuario", lambda _email: 1)
    monkeypatch.setattr(main, "obtener_conexion", lambda: FakeConexion(cursor))

    respuesta = client.post(
        "/assignments?id_emergencia=7&id_recurso=22&tipo_asignacion=Manual",
        headers=headers_de(ADMIN),
    )

    assert respuesta.status_code == 200
    assert respuesta.json()["id_asignacion"] == 19
    assert respuesta.json()["estado_asignacion"] == "ASIGNADO"
    assert respuesta.json()["estado_recurso"] == "En trayecto"
    assert any("INSERT INTO emergencia.asignacion" in sql for sql, _ in cursor.consultas)
