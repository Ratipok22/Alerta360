"""Consulta el histórico de PostgreSQL. El nombre se conserva por compatibilidad.

Ya no genera eventos, clima ni factores de riesgo sintéticos.
"""
from datetime import timedelta
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
import pandas as pd
from .database import cargar_base_datos
from .db_catalog import obtener_zonas, obtener_tipos


def generate(start=None, days=None, seed=None):
    """Sin filtros devuelve todo el histórico; seed ya no altera los datos."""
    df=cargar_base_datos()
    zonas={str(z['zona_id']) for z in obtener_zonas()}
    tipos={str(t['codigo']) for t in obtener_tipos()}
    if not set(df['zona_id'].astype(str)).issubset(zonas) or not set(df['tipo_emergencia'].astype(str)).issubset(tipos):
        raise ValueError('El histórico contiene zonas o tipos que no están en el catálogo PostgreSQL.')
    if days is not None and days<=0:
        raise ValueError('days debe ser positivo.')
    if start is None and days is not None:
        start=df['fecha'].max().date()-timedelta(days=days-1)
    if start is not None:
        start=pd.Timestamp(start)
        mask=df['fecha']>=start
        if days is not None:mask &= df['fecha']<start+pd.Timedelta(days=days)
        df=df.loc[mask].copy()
    if df.empty:raise ValueError('No hay registros históricos en PostgreSQL para el período solicitado.')
    df.attrs['origen']='PostgreSQL: emergencia.registro_historico; procedencia original de los registros conservada'
    return df.reset_index(drop=True)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desde')
    parser.add_argument('--dias',type=int)
    parser.add_argument('--salida',help='CSV opcional; no modifica PostgreSQL')
    args=parser.parse_args()
    df=generate(args.desde,args.dias)
    print(f'Consultados {len(df)} registros: {df.fecha.min()} a {df.fecha.max()}')
    if args.salida:df.to_csv(args.salida,index=False)
