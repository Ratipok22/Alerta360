import pytest

from conftest import ADMIN, headers_de


@pytest.mark.parametrize("prioridad", [0, 4, 99, -1])
def test_EM03_rechaza_prioridad_fuera_de_rango(client, prioridad):
    payload = {
        "codigo_emergencia": "10-1",
        "direccion_emergencia": "CODEX-EM03-VALIDACION",
        "latitud_emergencia": -33.037,
        "longitud_emergencia": -71.629,
        "prioridad_emergencia": prioridad,
    }
    respuesta = client.post("/emergencies", headers=headers_de(ADMIN), json=payload)
    assert respuesta.status_code == 422
