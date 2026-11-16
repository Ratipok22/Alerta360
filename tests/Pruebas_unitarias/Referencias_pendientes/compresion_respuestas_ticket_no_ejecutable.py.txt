import sys
import unittest
from pathlib import Path
import httpx
from starlette.responses import JSONResponse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src/backend'))
from core.compresion import ComprimirTickets


class CompresionTests(unittest.IsolatedAsyncioTestCase):
    async def test_conserva_json_y_no_comprime_otras_rutas(self):
        contenido = {'tickets': [{'archivo_url': 'data:image/png;base64,' + 'ABCD' * 1000}]}
        async def app(scope, receive, send):
            await JSONResponse(contenido)(scope, receive, send)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ComprimirTickets(app)), base_url='http://test') as client:
            plano = await client.get('/tickets', headers={'Accept-Encoding': 'identity'})
            comprimido = await client.get('/tickets', headers={'Accept-Encoding': 'gzip'})
            otro = await client.get('/prediction/demand', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(plano.json(), contenido)
        self.assertEqual(comprimido.json(), contenido)
        self.assertEqual(comprimido.headers['content-encoding'], 'gzip')
        self.assertIn('Accept-Encoding', comprimido.headers['vary'])
        self.assertLess(int(comprimido.headers['content-length']), int(plano.headers['content-length']))
        self.assertNotIn('content-encoding', otro.headers)
        self.assertNotIn('content-encoding', plano.headers)


if __name__ == '__main__':
    unittest.main()
