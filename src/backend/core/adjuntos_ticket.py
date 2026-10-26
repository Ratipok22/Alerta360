"""Imágenes de tickets en disco; PostgreSQL conserva una referencia corta."""
import base64
import binascii
from pathlib import Path
from uuid import uuid4

DIRECTORIO = Path(__file__).resolve().parents[1] / 'uploads' / 'tickets'
PREFIJO = 'local-ticket:'
MAX_BYTES = 3 * 1024 * 1024
EXTENSIONES = {'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg',
               'image/gif':'gif','image/webp':'webp'}


def validar(valor):
    if not valor:
        return None
    if valor.startswith(('https://','http://')):
        if len(valor)>255:
            raise ValueError('La URL del adjunto no puede superar 255 caracteres.')
        return None
    encabezado, separador, contenido = valor.partition(',')
    mime=encabezado[5:].split(';')[0] if encabezado.startswith('data:') else ''
    if not separador or mime not in EXTENSIONES or not encabezado.endswith(';base64'):
        raise ValueError('Adjunto inválido: utiliza una imagen PNG, JPEG, GIF o WebP.')
    if len(contenido)>4*1024*1024:
        raise ValueError('La imagen supera el máximo de 3 MB.')
    try:
        data=base64.b64decode(contenido,validate=True)
    except (ValueError,binascii.Error) as exc:
        raise ValueError('El contenido base64 de la imagen es inválido.') from exc
    if not data or len(data)>MAX_BYTES:
        raise ValueError('La imagen debe contener datos y no superar 3 MB.')
    firmas={'png':data.startswith(b'\x89PNG\r\n\x1a\n'),
            'jpg':data.startswith(b'\xff\xd8\xff'),
            'gif':data.startswith((b'GIF87a',b'GIF89a')),
            'webp':data.startswith(b'RIFF') and data[8:12]==b'WEBP'}
    if not firmas[EXTENSIONES[mime]]:
        raise ValueError('El contenido del archivo no coincide con el formato de imagen.')
    return mime,data


def guardar(valor):
    imagen=validar(valor)
    if imagen is None:
        return valor
    mime,data=imagen
    DIRECTORIO.mkdir(parents=True,exist_ok=True)
    nombre=f'{uuid4().hex}.{EXTENSIONES[mime]}'
    with (DIRECTORIO/nombre).open('xb') as f:
        f.write(data)
    return PREFIJO+nombre


def _ruta(valor):
    if not valor or not valor.startswith(PREFIJO):
        return None
    nombre=valor[len(PREFIJO):]
    if Path(nombre).name != nombre or '/' in nombre or '\\' in nombre:
        raise ValueError('Referencia de adjunto inválida.')
    ruta=(DIRECTORIO/nombre).resolve()
    if ruta.parent != DIRECTORIO.resolve():
        raise ValueError('Referencia de adjunto fuera del directorio permitido.')
    return ruta


def leer(valor):
    ruta=_ruta(valor)
    if ruta is None:
        return valor
    if not ruta.is_file():
        return None
    mime={'.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}[ruta.suffix]
    return f'data:{mime};base64,'+base64.b64encode(ruta.read_bytes()).decode('ascii')


def descartar(valor):
    ruta=_ruta(valor)
    if ruta is not None:
        ruta.unlink(missing_ok=True)
