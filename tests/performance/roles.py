"""Carga mixta por roles. Solo consultas; no valida permisos de escritura."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import threading
import time
import httpx
from run import TARGETS, request, percentile

PROFILES={
 'admin': ['emergencies','resources','route','assignments','history','catalog','prediction','zones','tickets','ticket_catalogs','me','staff'],
 'visualizador': ['state','emergencies','resources','prediction','zones','tickets','ticket_catalogs','me'],
 'soporte': ['tickets','ticket_catalogs','me'],
}
TOKENS={'admin':'PERF_TOKEN','visualizador':'PERF_VIEWER_TOKEN','soporte':'PERF_SUPPORT_TOKEN'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url',required=True)
    p.add_argument('--users',type=int,choices=[5,10],required=True)
    p.add_argument('--seconds',type=int,default=120)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--allow-prediction-write',action='store_true')
    args=p.parse_args()
    if not args.allow_prediction_write or not 1<=args.seconds<=3600:
        p.error('Duración 1–3600 y --allow-prediction-write requeridos.')
    from urllib.parse import urlparse
    url=urlparse(args.base_url)
    if url.scheme not in ('https','http') or not url.hostname or url.username or url.password or url.query or url.fragment:
        p.error('URL HTTP(S) sin credenciales ni parámetros requerida.')
    configs={}
    for role,variable in TOKENS.items():
        token=os.getenv(variable)
        if not token:p.error('Falta '+variable)
        configs[role]=dict(base_url=args.base_url.rstrip('/'),timeout=60,
            headers={'Authorization':'Bearer '+token,'ngrok-skip-browser-warning':'1'})
        with httpx.Client(**configs[role]) as client:
            r=client.get('/auth/me');r.raise_for_status()
            if r.json().get('rol')!=role:p.error('El token no corresponde al rol '+role)
    start=time.perf_counter();deadline=start+args.seconds
    stop=threading.Event();lock=threading.Lock();counts=[0,0]
    role_names=list(PROFILES)
    def worker(index):
        role=role_names[index%3];names=PROFILES[role];rows=[];position=0
        with httpx.Client(**configs[role]) as client:
            while time.perf_counter()<deadline and not stop.is_set():
                name=names[position%len(names)];position+=1
                sample=request(client,name,TARGETS[name][0])
                sample.update(role=role,worker=index,offset_s=round(time.perf_counter()-start,3))
                rows.append(sample)
                with lock:
                    counts[0]+=1;counts[1]+=sample['error'] is not None
                    if counts[0]>=20 and counts[1]/counts[0]>.05:stop.set()
                remaining=deadline-time.perf_counter()
                if remaining>0:time.sleep(min(1,remaining))
        return rows
    with ThreadPoolExecutor(max_workers=args.users) as pool:
        samples=[s for batch in pool.map(worker,range(args.users)) for s in batch]
    metrics={}
    for role,names in PROFILES.items():
        metrics[role]={}
        for name in names:
            rows=[s for s in samples if s['role']==role and s['target']==name]
            times=[s['ms'] for s in rows];errors=sum(s['error'] is not None for s in rows)
            p95=percentile(times,95)
            result='INSUFICIENTE' if len(rows)<10 else ('APROBADO' if errors/len(rows)<=.01 and p95<=TARGETS[name][1] else 'FALLIDO')
            metrics[role][name]=dict(samples=len(rows),errors=errors,p50_ms=percentile(times,50),p95_ms=p95,
                p99_ms=percentile(times,99),max_ms=max(times) if times else None,result=result)
    elapsed=time.perf_counter()-start
    report=dict(timestamp_utc=datetime.now(timezone.utc).isoformat(),base_url=args.base_url,users=args.users,
        distribution=dict(Counter(role_names[i%3] for i in range(args.users))),requested_seconds=args.seconds,
        actual_seconds=round(elapsed,2),total_requests=len(samples),requests_per_second=round(len(samples)/elapsed,3),
        errors=sum(s['error'] is not None for s in samples),aborted=stop.is_set(),metrics=metrics,samples=samples,
        scope='Cada worker mantiene un rol. Un JWT por rol compartido por sus workers; no son cuentas independientes. Sin login concurrente ni mutaciones. Predicción puede persistir caché.')
    args.output.parent.mkdir(exist_ok=True,parents=True)
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','metrics')},indent=2))
    return int(stop.is_set() or any(m['result']!='APROBADO' for group in metrics.values() for m in group.values()))


if __name__=='__main__':
    raise SystemExit(main())
