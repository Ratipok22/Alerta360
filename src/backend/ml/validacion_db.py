"""Validación temporal con registros SQL posteriores al entrenamiento."""
import pandas as pd
from .dataset_db import generate
from database.database import obtener_conexion
from .features import add_rolling_features
from .entradas_prediccion_db import modelo_activo,historico


def generate_validation():
    modelo=modelo_activo()
    with obtener_conexion() as conn,conn.cursor() as cur:
        cur.execute('SELECT datos_desde,datos_hasta FROM emergencia.modelo_demanda WHERE id_modelo=%s',(modelo['id_modelo'],))
        desde,hasta=cur.fetchone()
    if desde is None or hasta is None:
        raise ValueError('Faltan las fechas de entrenamiento del modelo activo.')
    df=generate()
    posteriores=df['fecha']>pd.Timestamp(hasta)
    if not posteriores.any():
        raise ValueError(f'No hay validación independiente: PostgreSQL no tiene registros posteriores a {hasta}, fin del entrenamiento del modelo #{modelo["id_modelo"]}. No se generarán datos simulados.')
    pares=set(historico(modelo['entradas']))
    conocidos=pd.Series([(str(z),str(t)) in pares for z,t in zip(df.zona_id,df.tipo_emergencia)],index=df.index)
    # Mantener el contexto anterior para calcular variables rolling de validación.
    valid=add_rolling_features(df.loc[conocidos].copy())
    valid=valid.loc[valid['fecha']>pd.Timestamp(hasta)].copy()
    if valid.empty:raise ValueError('Los registros posteriores pertenecen únicamente a pares zona/tipo no entrenados.')
    train=df.loc[(df.fecha>=pd.Timestamp(desde)) & (df.fecha<=pd.Timestamp(hasta)) & conocidos]
    if train.empty:raise ValueError('No hay histórico del período entrenado para calcular la referencia de comparación.')
    valid.attrs.update({'id_modelo':modelo['id_modelo'],'baseline_media_entrenamiento':float(train.cantidad_emergencias.mean()),
                        'no_evaluados_pares_desconocidos':int((posteriores & ~conocidos).sum()),
                        'origen':'registro_historico PostgreSQL; período posterior al entrenamiento'})
    return valid.reset_index(drop=True)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--salida',help='CSV opcional')
    args=parser.parse_args()
    df=generate_validation()
    print(f'{len(df)} registros de validación: {df.fecha.min()} a {df.fecha.max()}')
    if args.salida:df.to_csv(args.salida,index=False)
