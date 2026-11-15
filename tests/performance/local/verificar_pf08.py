"""Regresión HTTP real de DEF-PERF-01. Solo laboratorio local; no Supabase.

Requiere el laboratorio indicado en README.md. Reemplaza sus datos sintéticos.
Ejecutar: python tests/performance/local/verificar_pf08.py
"""
import json
from pathlib import Path
import perf_cases as cases


def main():
    output = cases.WORK / 'results' / 'PF08-regresion'
    for repetition in range(1, 4):
        cases.OUT = output / f'repeticion_{repetition}'
        cases.OUT.mkdir(parents=True, exist_ok=True)
        cases.pf08()
        report = json.loads((cases.OUT / 'PF08.json').read_text(encoding='utf-8'))
        checks = (
            report['status'] == 'APROBADO',
            report['metrics']['login']['n'] == 100,
            report['metrics']['login']['errors'] == 0,
            report['identity_and_ticket_checks'] == 200,
            report['failed_checks'] == 0,
            report['active_accounts_after'] == 1,
        )
        if not all(checks):
            raise SystemExit(f'PF08 falló en repetición {repetition}; revisar evidencia.')
    print('PF08 aprobado: 300 logins y 600 controles, sin errores.')


if __name__ == '__main__':
    main()
