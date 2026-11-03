"""Clima Open-Meteo: ERA5 para fechas antiguas y API reciente para cierres actuales.
Los datos recientes son estimaciones meteorológicas, no mediciones de estación.
"""
from datetime import datetime, timedelta, timezone
from math import isfinite
from zoneinfo import ZoneInfo

import httpx

CHILE = ZoneInfo('America/Santiago')
FUENTE = 'Open-Meteo / ERA5 (reanálisis); media T/viento y suma lluvia del bloque'
URL = 'https://archive-api.open-meteo.com/v1/archive'


class DatosPendientes(ValueError):
    """Falta información necesaria; el cierre de la emergencia se conserva."""


def obtener_clima(fecha, bloque, latitud, longitud):
    if latitud is None or longitud is None:
        raise DatosPendientes('Faltan coordenadas para consultar el clima histórico.')
    if not (isfinite(latitud) and isfinite(longitud) and -90 <= latitud <= 90 and -180 <= longitud <= 180):
        raise DatosPendientes('Coordenadas inválidas para consultar el clima histórico.')
    hoy = datetime.now(CHILE).date()
    if fecha > hoy:
        raise DatosPendientes('La fecha de la emergencia está en el futuro.')
    reciente = fecha > hoy - timedelta(days=6)
    inicio = datetime.combine(fecha, datetime.min.time(), tzinfo=CHILE).replace(hour=bloque)
    fin = inicio + timedelta(hours=3)
    params = {
        'latitude': latitud, 'longitude': longitud,
        'start_date': (fecha - timedelta(days=1)).isoformat(),
        'end_date': (fecha + timedelta(days=1)).isoformat(),
        'hourly': 'temperature_2m,wind_speed_10m,precipitation',
        'models': 'era5', 'timezone': 'UTC', 'timeformat': 'unixtime',
        'temperature_unit': 'celsius', 'wind_speed_unit': 'kmh',
        'precipitation_unit': 'mm',
    }
    url = URL
    if reciente:
        url = 'https://api.open-meteo.com/v1/forecast'
        params.pop('models')
    try:
        response = httpx.get(url, params=params, timeout=12.0)
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise DatosPendientes('No se pudo obtener el clima histórico; se reintentará.') from exc
    resultado = interpretar(data, inicio, fin)
    if reciente:
        resultado['fuente'] = 'Open-Meteo / modelos recientes (incluye pronóstico si el bloque no ha terminado)'
    resultado['fuente'] += f'; punto representativo de zona ({latitud:.6f}, {longitud:.6f})'
    return resultado


def interpretar(data, inicio, fin):
    """Trabaja en UTC para incluir correctamente cambios de hora de Chile.

La lluvia horaria corresponde a la hora precedente: para [00,03) se
acumulan las muestras con fin de intervalo 01,02,03.
"""
    try:
        units = data['hourly_units']
        if units.get('temperature_2m') != '°C' or units.get('wind_speed_10m') != 'km/h' or units.get('precipitation') != 'mm':
            raise DatosPendientes('Unidades meteorológicas inesperadas.')
        hourly = data['hourly']
        times = hourly['time']
        arrays = [hourly[k] for k in ('temperature_2m','wind_speed_10m','precipitation')]
        if any(len(a) != len(times) for a in arrays) or len(set(times)) != len(times):
            raise DatosPendientes('Serie meteorológica incompleta o duplicada.')
        start, end = int(inicio.timestamp()), int(fin.timestamp())
        # El bloque civil puede tener dos o cuatro horas por horario de verano.
        expected = set(range(start, end, 3600))
        expected_rain = {t + 3600 for t in expected}
        indexed = {int(t): values for t, *values in zip(times, *arrays)}
        if not expected or not (expected | expected_rain).issubset(indexed):
            raise DatosPendientes('Faltan horas del bloque meteorológico.')
        temp = [indexed[t][0] for t in sorted(expected)]
        wind = [indexed[t][1] for t in sorted(expected)]
        rain = [indexed[t][2] for t in sorted(expected_rain)]
        if any(v is None or not isfinite(float(v)) for v in temp + wind + rain):
            raise DatosPendientes('El proveedor aún no tiene valores completos para ese bloque.')
        if any(v < 0 for v in wind + rain):
            raise DatosPendientes('Viento o precipitación negativos en la fuente.')
        return {'temperatura_c': sum(temp)/len(temp), 'viento_kmh': sum(wind)/len(wind),
                'precipitacion_mm': sum(rain), 'fuente': FUENTE}
    except (KeyError, TypeError, OverflowError) as exc:
        raise DatosPendientes('Respuesta meteorológica incompleta.') from exc
