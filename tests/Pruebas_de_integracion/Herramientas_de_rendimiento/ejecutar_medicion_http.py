"""Carga HTTP controlada. No crea ni cierra emergencias. Python 3.10+, httpx."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time
import threading
from urllib.parse import urlparse

import httpx

TARGETS = {
    'health': ('/health', 2000),
    'emergencies': ('/emergencies', 5000),
    'resources': ('/resources', 5000),
    'route': ('/route?origen_lat=-33.0391&origen_lng=-71.6240&destino_lat=-33.0472&destino_lng=-71.6127', 10000),
    'tickets': ('/tickets', 5000),
    'tickets_support': ('/tickets', 5000),
    'ticket_catalogs': ('/tickets/catalogos', 5000),
    'zones': ('/zones', 5000),
    'models': ('/prediction/models?limite=10', 5000),
    'history': ('/historial', 5000),
    'assignments': ('/assignments/activas', 5000),
    'catalog': ('/catalog/claves', 5000),
    'me': ('/auth/me', 5000),
    'staff': ('/companies/personal-activo', 5000),
    'state': ('/state', 5000),
    'prediction': ('/prediction/demand?horizon=4', 45000),
}


def valid(name, data):
    if not isinstance(data, dict):
        return False
    if name == 'health':
        return data.get('status') == 'ok'
    keys = {'tickets':'tickets', 'tickets_support':'tickets', 'zones':'zones',
            'models':'modelos', 'history':'historial', 'assignments':'asignaciones', 'catalog':'claves'}
    if name in keys:
        return isinstance(data.get(keys[name]), list)
    if name == 'ticket_catalogs':
        return isinstance(data.get('tipos'), list) and isinstance(data.get('apartados'), list)
    if name == 'me':
        return data.get('rol') in ('admin','visualizador','soporte') and isinstance(data.get('email'), str)
    if name == 'staff':
        return isinstance(data.get('personal_activo'), dict)
    if name == 'state':
        return isinstance(data.get('publicado'), bool)
    if name in ('emergencies', 'resources'):

        return isinstance(data.get(name), list)
    if name == 'route':
        return (data.get('fuente') == 'osrm_local' and len(data.get('puntos', [])) > 2
                and isinstance(data.get('distancia_km'), (int, float))
                and isinstance(data.get('duracion_min'), (int, float)))
    periods = data.get('periodos', [])
    return len(periods) == 4 and all(isinstance(p.get('zonas'), list) and p['zonas']
        and all(isinstance(z.get('demanda_total'), (int, float)) and
                math.isfinite(z['demanda_total']) and z['demanda_total'] >= 0 for z in p['zonas'])
        for p in periods)


def request(client, name, path):
    start = time.perf_counter()
    status, error = None, None
    try:
        extra = {'Authorization':'Bearer ' + os.environ['PERF_SUPPORT_TOKEN']} if name == 'tickets_support' else {}
        response = client.get(path, headers=extra)
        status = response.status_code
        if status != 200:
            error = 'http_' + str(status)
        elif not valid(name, response.json()):
            error = 'respuesta_invalida'
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError) as exc:
        error = type(exc).__name__
    return {'target': name, 'ms': round((time.perf_counter()-start)*1000, 2),
            'status': status, 'error': error}


def percentile(values, percent):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered)*percent/100)-1)] if ordered else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--targets', default='health,emergencies,resources,route')
    parser.add_argument('--users', type=int, default=2)
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--pause', type=float, default=1)
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--min-samples', type=int, default=20)
    parser.add_argument('--max-error-rate', type=float, default=0.01)
    parser.add_argument('--abort-error-rate', type=float, default=0.05)
    parser.add_argument('--allow-prediction-write', action='store_true',
                        help='La consulta puede generar/persistir predicciones si no hay caché.')
    parser.add_argument('--output', type=Path, default=Path(__file__).parent/'results'/'latest.json')
    args = parser.parse_args()
    names = list(dict.fromkeys(args.targets.split(',')))
    url = urlparse(args.base_url)
    if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        parser.error('URL HTTP(S) sin credenciales, parámetros ni fragmento requerida.')
    if any(n not in TARGETS for n in names):
        parser.error('Targets: ' + ','.join(TARGETS))
    if not (1 <= args.users <= 50 and 1 <= args.seconds <= 3600 and 0 <= args.pause <= 60
            and 1 <= args.timeout <= 120 and args.min_samples >= 1 and 0 <= args.max_error_rate <= 1 and 0 <= args.abort_error_rate <= 1):
        parser.error('Parámetros fuera de los límites permitidos.')
    token = os.getenv('PERF_TOKEN', '').strip()
    if any(n not in ('health','emergencies') for n in names) and not token:
        parser.error('Define PERF_TOKEN con un JWT de una cuenta de pruebas; no se guarda en el reporte.')
    if 'tickets_support' in names and not os.getenv('PERF_SUPPORT_TOKEN'):
        parser.error('tickets_support requiere PERF_SUPPORT_TOKEN de una cuenta soporte.')
    if 'prediction' in names and not args.allow_prediction_write:
        parser.error('Predicción requiere --allow-prediction-write; no modifica el modelo.')
    headers = {'ngrok-skip-browser-warning': '1'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    config = dict(base_url=args.base_url.rstrip('/'), headers=headers,
                  timeout=args.timeout, follow_redirects=False)
    # Una petición por endpoint previa a la carga; latencia inicial separada.
    with httpx.Client(**config) as client:
        initial = [request(client, n, TARGETS[n][0]) for n in names]
    stop = threading.Event()
    lock = threading.Lock()
    counts = [0,0]
    start = time.perf_counter()
    deadline = start + args.seconds
    def worker(index):
        worker_id = index
        samples = []
        with httpx.Client(**config) as client:
            while time.perf_counter() < deadline and not stop.is_set():
                name = names[index % len(names)]
                sample = request(client, name, TARGETS[name][0])
                sample['offset_s'] = round(time.perf_counter()-start,3)
                sample['worker'] = worker_id
                samples.append(sample)
                with lock:
                    counts[0] += 1
                    counts[1] += sample['error'] is not None
                    if counts[0] >= 20 and counts[1]/counts[0] > args.abort_error_rate:
                        stop.set()
                index += 1
                remaining = deadline-time.perf_counter()
                if remaining > 0:
                    time.sleep(min(args.pause, remaining))
        return samples
    with ThreadPoolExecutor(max_workers=args.users) as pool:
        samples = [s for batch in pool.map(worker, range(args.users)) for s in batch]
    elapsed = time.perf_counter()-start
    metrics = {}
    for name in names:
        rows = [s for s in samples if s['target']==name]
        times = [s['ms'] for s in rows]
        errors = sum(s['error'] is not None for s in rows)
        rate = errors/len(rows) if rows else 1
        p95 = percentile(times,95)
        result = 'INSUFICIENTE' if len(rows)<args.min_samples else (
            'APROBADO' if rate<=args.max_error_rate and p95<=TARGETS[name][1] else 'FALLIDO')
        metrics[name] = dict(samples=len(rows), errors=errors, error_rate=rate,
            p50_ms=percentile(times,50), p95_ms=p95, p99_ms=percentile(times,99),
            max_ms=max(times) if times else None, limit_p95_ms=TARGETS[name][1],
            errors_by_type=dict(Counter(s['error'] for s in rows if s['error'])), result=result)
    passed = not stop.is_set() and all(m['result']=='APROBADO' for m in metrics.values()) and all(s['error'] is None for s in initial)
    report = dict(timestamp_utc=datetime.now(timezone.utc).isoformat(), base_url=args.base_url,
        users=args.users, requested_seconds=args.seconds, actual_seconds=round(elapsed,2),
        pause_seconds=args.pause, min_samples=args.min_samples, max_error_rate=args.max_error_rate,
        total_requests=len(samples), requests_per_second=round(len(samples)/elapsed,3),
        initial_requests=initial, metrics=metrics, passed=passed,
        aborted=stop.is_set(), abort_error_rate=args.abort_error_rate, samples=samples,
        methodology='Carga cerrada: una petición en vuelo por usuario; sin reintentos. Percentiles nearest-rank incluyen fallos. Iniciales fuera de carga. No mide navegador ni capacidad máxima.')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(report,indent=2,ensure_ascii=False))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
