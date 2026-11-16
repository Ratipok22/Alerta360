from datetime import date, datetime, time, timedelta, timezone

import pytest

import core.clima_historico as clima


class RespuestaClima:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def _serie_horaria(params):
    desde = datetime.combine(date.fromisoformat(params["start_date"]), time.min, tzinfo=timezone.utc)
    hasta = datetime.combine(date.fromisoformat(params["end_date"]) + timedelta(days=1), time.min, tzinfo=timezone.utc)
    tiempos = list(range(int(desde.timestamp()), int(hasta.timestamp()), 3600))
    return {
        "hourly_units": {
            "temperature_2m": "°C",
            "wind_speed_10m": "km/h",
            "precipitation": "mm",
        },
        "hourly": {
            "time": tiempos,
            "temperature_2m": [20.0] * len(tiempos),
            "wind_speed_10m": [3.0] * len(tiempos),
            "precipitation": [0.5] * len(tiempos),
        },
    }


def test_HI07_proveedor_reciente_y_era5_agregan_bloque(monkeypatch):
    hoy = datetime.now(clima.CHILE).date()
    llamadas = []

    def get(url, params, timeout):
        llamadas.append((url, dict(params), timeout))
        return RespuestaClima(_serie_horaria(params))

    monkeypatch.setattr(clima.httpx, "get", get)
    reciente = clima.obtener_clima(hoy - timedelta(days=1), 0, -33.037, -71.629)
    antiguo = clima.obtener_clima(hoy - timedelta(days=7), 0, -33.037, -71.629)

    assert llamadas[0][0] == "https://api.open-meteo.com/v1/forecast"
    assert "models" not in llamadas[0][1]
    assert llamadas[1][0] == clima.URL
    assert llamadas[1][1]["models"] == "era5"
    for resultado in (reciente, antiguo):
        assert resultado["temperatura_c"] == 20.0
        assert resultado["viento_kmh"] == 3.0
        assert resultado["precipitacion_mm"] == pytest.approx(1.5)
        assert resultado["fuente"]
    assert "modelos recientes" in reciente["fuente"]
    assert "ERA5" in antiguo["fuente"]


def test_HI08_respuesta_meteorologica_incompleta_queda_pendiente():
    with pytest.raises(clima.DatosPendientes, match="Unidades meteorológicas inesperadas"):
        clima.interpretar({
            "hourly_units": {
                "temperature_2m": "°F",
                "wind_speed_10m": "mph",
                "precipitation": "in",
            },
            "hourly": {"time": [], "temperature_2m": [], "wind_speed_10m": [], "precipitation": []},
        }, datetime(2026, 1, 1, tzinfo=clima.CHILE), datetime(2026, 1, 1, 3, tzinfo=clima.CHILE))
