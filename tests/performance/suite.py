"""Ejecuta escalones de consulta de los tres módulos usando JWT en el entorno."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

TARGETS='health,emergencies,resources,route,assignments,history,catalog,me,staff,state,tickets,tickets_support,ticket_catalogs,zones,models,prediction'


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url',required=True)
    p.add_argument('--seconds',type=int,default=180)
    p.add_argument('--prediction-seconds',type=int,default=120)
    p.add_argument('--output-dir',type=Path,default=Path(__file__).parent/'results'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    args=p.parse_args()
    failed=False
    for name,users,seconds,targets in [('modulos-5usuarios',5,args.seconds,TARGETS),
            ('modulos-10usuarios',10,args.seconds,TARGETS),
            ('prediccion-5usuarios',5,args.prediction_seconds,'prediction')]:
        output=args.output_dir/(name+'.json')
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('run.py')),
            '--base-url',args.base_url,'--targets',targets,'--users',str(users),
            '--seconds',str(seconds),'--min-samples','10','--pause','1',
            '--allow-prediction-write','--output',str(output)])
        if not output.exists():
            return result.returncode or 1
        report=json.loads(output.read_text(encoding='utf-8'))
        failed |= not report['passed']
        if report['aborted']:
            print('Se detiene el escalamiento por errores. Revisar el informe.')
            return 1
    return int(failed)


if __name__=='__main__':
    raise SystemExit(main())
