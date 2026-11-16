import httpx

import main
from core import auth


def test_RE05_si_osrm_no_responde_devuelve_fallback_explicito(monkeypatch):
    def fuera_de_linea(*args, **kwargs):
        raise httpx.ConnectError("OSRM no disponible")

    monkeypatch.setattr(main.httpx, "get", fuera_de_linea)
    origen = (-33.04, -71.60)
    destino = (-33.05, -71.61)

    resultado = main.route(*origen, *destino, auth.USUARIOS["alex.aravena@bomberos.cl"])

    assert resultado == {
        "puntos": [
            {"lat": origen[0], "lng": origen[1]},
            {"lat": destino[0], "lng": destino[1]},
        ],
        "distancia_km": None,
        "duracion_min": None,
        "fuente": "linea_recta_fallback",
    }


def test_RE05_ruta_osrm_se_marca_como_real(monkeypatch):
    class Respuesta:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "code": "Ok",
                "routes": [{
                    "geometry": {"coordinates": [[-71.60, -33.04], [-71.61, -33.05]]},
                    "distance": 2450,
                    "duration": 252,
                }],
            }

    monkeypatch.setattr(main.httpx, "get", lambda *args, **kwargs: Respuesta())
    resultado = main.route(-33.04, -71.60, -33.05, -71.61, auth.USUARIOS["alex.aravena@bomberos.cl"])

    assert resultado["fuente"] == "osrm_local"
    assert resultado["puntos"] == [
        {"lat": -33.04, "lng": -71.60},
        {"lat": -33.05, "lng": -71.61},
    ]
    assert resultado["distancia_km"] == 2.45
    assert resultado["duracion_min"] == 4.2
