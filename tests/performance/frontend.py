"""Transferencia HTTP de HTML/JS/CSS de Vercel; no mide renderizado ni Web Vitals."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urljoin, urlparse
import httpx
from run import percentile


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='script' and attrs.get('src'):
            self.urls.append(attrs['src'])
        if tag=='link' and attrs.get('rel')=='stylesheet' and attrs.get('href'):
            self.urls.append(attrs['href'])


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',default='https://alerta360-zeta.vercel.app/')
    p.add_argument('--users',type=int,default=5)
    p.add_argument('--iterations',type=int,default=10)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    parsed=urlparse(args.url)
    if parsed.scheme not in ('http','https') or parsed.username or parsed.password:
        p.error('URL HTTP sin credenciales requerida')
    if not 1<=args.users<=20 or not 1<=args.iterations<=100:
        p.error('users 1–20; iterations 1–100')
    # Sin autorización ni JWT: nunca se envían credenciales de la API a Vercel.
    with httpx.Client(timeout=30) as client:
        response=client.get(args.url);response.raise_for_status()
        parser=Assets();parser.feed(response.text)
        assets=list(dict.fromkeys(urljoin(args.url,s) for s in parser.urls))
        if not assets or any(urlparse(a).netloc!=parsed.netloc for a in assets):
            raise ValueError('Se requieren assets locales al dominio de la página.')
        hashes={a:hashlib.sha256(client.get(a).raise_for_status().content).hexdigest() for a in assets}
    started=time.perf_counter()
    def worker(index):
        rows=[]
        with httpx.Client(timeout=30) as client:
            for iteration in range(args.iterations):
                start=time.perf_counter();error=None;size=0
                try:
                    for url in [args.url]+assets:
                        r=client.get(url);r.raise_for_status();size+=len(r.content)
                        if url==args.url and '<html' not in r.text.lower():
                            raise ValueError('HTML inválido')
                        if url!=args.url and hashlib.sha256(r.content).hexdigest()!=hashes[url]:
                            raise ValueError('Asset cambió durante prueba')
                except (httpx.HTTPError,ValueError) as exc:
                    error=type(exc).__name__
                rows.append(dict(worker=index,iteration=iteration,ms=round((time.perf_counter()-start)*1000,2),decoded_bytes=size,error=error))
        return rows
    with ThreadPoolExecutor(max_workers=args.users) as pool:
        rows=[r for batch in pool.map(worker,range(args.users)) for r in batch]
    times=[r['ms'] for r in rows];errors=sum(r['error'] is not None for r in rows)
    report=dict(timestamp_utc=datetime.now(timezone.utc).isoformat(),url=args.url,users=args.users,
        page_transfers=len(rows),requests=len(rows)*(1+len(assets)),actual_seconds=round(time.perf_counter()-started,2),
        errors=errors,p50_ms=percentile(times,50),p95_ms=percentile(times,95),p99_ms=percentile(times,99),
        assets_sha256=hashes,samples=rows,
        scope='HTML y JS/CSS declarados en HTML, secuenciales por usuario, caché CDN posiblemente caliente. Sin caché de navegador, imágenes, mapas, API, ejecución JS ni renderizado. No equivale a tiempo de página interactiva.')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='samples'},indent=2))
    return int(errors>0)


if __name__=='__main__':
    raise SystemExit(main())
