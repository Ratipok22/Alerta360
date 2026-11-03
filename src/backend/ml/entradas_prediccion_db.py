"""Contexto de inferencia leído de PostgreSQL, sin zonas o clima prefijados."""
import hashlib
import json
import math

from psycopg.rows import dict_row
from database.database import obtener_conexion


def huella(contexto):
    return hashlib.sha256(json.dumps(contexto,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def clave_clima(zona,mes,hora):
    return f'{zona}|{mes}|{hora}'


def validar(contexto):
    if not isinstance(contexto,dict) or contexto.get('version') != 1:
        raise ValueError('No se pudieron reconstruir las entradas desde registro_historico.')
    if not contexto.get('historico') or not contexto.get('clima'):
        raise ValueError('Contexto predictivo incompleto en PostgreSQL.')
    pares=set()
    for row in contexto['historico']:
        key=(str(row['zona_id']),str(row['tipo_emergencia']))
        if key in pares:
            raise ValueError('Pares duplicados en el contexto del modelo.')
        pares.add(key)
        for k in ('freq_hist_7d','demanda_recursos_hist_7d'):
            if not math.isfinite(float(row[k])) or row[k]<0:
                raise ValueError('Variables históricas inválidas en PostgreSQL.')
    for valor in contexto['clima'].values():
        for k in ('temperatura_c','viento_kmh','precipitacion_mm'):
            if not math.isfinite(float(valor[k])):
                raise ValueError('Variables climáticas inválidas en PostgreSQL.')
        if valor['viento_kmh']<0 or valor['precipitacion_mm']<0:
            raise ValueError('Viento o precipitación negativos en PostgreSQL.')
    return contexto


def modelo_activo():
    with obtener_conexion() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute('''SELECT id_modelo,ruta_artefacto,datos_desde,datos_hasta,importancia_variables
            FROM emergencia.modelo_demanda WHERE activo=TRUE
            ORDER BY entrenado_en DESC,id_modelo DESC LIMIT 1''')
        row=cur.fetchone()
    if row is None:
        raise ValueError('No hay modelo activo en PostgreSQL.')
    row['entradas'] = entradas_historicas(row)
    return row


def historico(contexto):
    return {(str(r['zona_id']),str(r['tipo_emergencia'])):r for r in contexto['historico']}


def clima(contexto,zona,mes,hora):
    value=contexto['clima'].get(clave_clima(zona,mes,hora))
    if value is None:
        raise ValueError(f'Falta el perfil climático en PostgreSQL para {zona}, mes {mes}, bloque {hora}.')
    return dict(value)


def crear_contexto(artefacto, conexion):
    """Nuevos entrenamientos: estadísticas entrenadas y clima del histórico SQL.

    Para meses sin muestras usa el promedio por zona/bloque, identificado
    como estimación histórica. Nunca usa el catálogo simulado.
    """
    from .contratos import PERIOD_HOURS
    rows=[{'zona_id':str(z),'tipo_emergencia':str(t),
           'freq_hist_7d':float(r['freq_hist_7d']),
           'demanda_recursos_hist_7d':float(r['demanda_recursos_hist_7d'])}
          for (z,t),r in artefacto['last_features'].iterrows()]
    with conexion.cursor() as cur:
        # Promediar primero cada zona/fecha/bloque evita contar el clima
        # repetido para cada tipo de emergencia como observaciones distintas.
        cur.execute('''WITH bloques AS (
            SELECT id_zona,fecha,bloque_horario,
                   AVG(temperatura_c) t,AVG(viento_kmh) v,AVG(precipitacion_mm) p
            FROM emergencia.registro_historico
            WHERE temperatura_c IS NOT NULL AND viento_kmh IS NOT NULL
              AND precipitacion_mm IS NOT NULL AND fecha <= CURRENT_DATE
            GROUP BY id_zona,fecha,bloque_horario)
            SELECT id_zona, EXTRACT(MONTH FROM fecha)::int, bloque_horario,
                   AVG(t),AVG(v),AVG(p)
            FROM bloques GROUP BY GROUPING SETS
                ((id_zona,EXTRACT(MONTH FROM fecha)::int,bloque_horario),
                 (id_zona,bloque_horario))''')
        datos={(str(z),m,h):(t,v,p) for z,m,h,t,v,p in cur.fetchall()}
    perfiles={}
    for zona in {r['zona_id'] for r in rows}:
        for mes in range(1,13):
            for hora in PERIOD_HOURS:
                values=datos.get((zona,mes,hora),datos.get((zona,None,hora)))
                if values is None:
                    raise ValueError(f'Falta clima histórico para entrenar {zona} en bloque {hora}.')
                perfiles[clave_clima(zona,mes,hora)]=dict(zip(
                    ('temperatura_c','viento_kmh','precipitacion_mm'),map(float,values)))
    result={'version':1,'historico':rows,'clima':perfiles,
            'fuente_clima':'Promedios de registro_historico; estimación, no pronóstico ni observación actual'}
    return validar(result)


def entradas_historicas(modelo):
    """Reconstruye las variables con el mismo cálculo usado al entrenar.

    El artefacto solo delimita los pares entrenados. Los valores se leen de SQL.
    Se respeta el período de entrenamiento para evitar incorporar validación.
    """
    import pandas as pd
    from .predict import _load_artifact
    from .features import add_rolling_features
    artefacto = _load_artifact(modelo)
    pares = set(artefacto['last_features'].index)
    if modelo['datos_desde'] is None or modelo['datos_hasta'] is None:
        raise ValueError('Faltan las fechas de entrenamiento del modelo.')
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("""SELECT id_zona,codigo_emergencia,
                COALESCE(timestamp_registro,fecha::timestamp+make_interval(hours=>bloque_horario)),
                cantidad_emergencias,recursos_utilizados
                FROM emergencia.registro_historico WHERE fecha BETWEEN %s AND %s
                ORDER BY fecha,bloque_horario,id_zona,codigo_emergencia""",
                (modelo['datos_desde'],modelo['datos_hasta']))
            df=pd.DataFrame(cur.fetchall(),columns=['zona_id','tipo_emergencia','timestamp','cantidad_emergencias','recursos_utilizados'])
        if df.empty:
            raise ValueError('No hay registros del período de entrenamiento en PostgreSQL.')
        df=df.loc[[(str(z),str(t)) in pares for z,t in zip(df.zona_id,df.tipo_emergencia)]].copy()
        if df.empty:
            raise ValueError('No hay histórico para los pares entrenados.')
        if df[['cantidad_emergencias','recursos_utilizados']].isna().any().any():
            raise ValueError('El histórico de entrenamiento contiene conteos incompletos.')
        df['timestamp']=pd.to_datetime(df['timestamp'])
        features=add_rolling_features(df)
        last=features.sort_values('timestamp').groupby(['zona_id','tipo_emergencia'])[['freq_hist_7d','demanda_recursos_hist_7d']].last()
        if set(last.index)!=pares:
            raise ValueError('Faltan pares entrenados en registro_historico.')
        return crear_contexto({'last_features':last},conn)
