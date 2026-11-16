"""Regresión de coordinación sin cargar el modelo ni acceder a PostgreSQL."""
import sys
import time
import unittest
from pathlib import Path
from threading import Barrier, Lock
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src/backend'))
from ml.concurrencia import TrabajoCompartido


class ConcurrenciaTests(unittest.TestCase):
    def test_diez_solicitudes_comparten_calculo_y_no_respuesta_mutable(self):
        trabajo = TrabajoCompartido()
        barrera = Barrier(10)
        conteo = []
        def calcular():
            conteo.append(1)
            time.sleep(.2)
            return {'zonas': [1]}
        def pedir(_):
            barrera.wait(timeout=5)
            return trabajo.ejecutar(('bloque', False), calcular)
        with ThreadPoolExecutor(max_workers=10) as pool:
            resultados = list(pool.map(pedir, range(10)))
        self.assertEqual(len(conteo), 1)
        self.assertEqual(resultados, [{'zonas': [1]}] * 10)
        resultados[0]['zonas'].append(2)
        self.assertEqual(resultados[1], {'zonas': [1]})
        trabajo.ejecutar(('bloque', False), calcular)
        self.assertEqual(len(conteo), 2)  # No conserva caché en memoria.

    def test_error_no_deja_bloqueo_y_permite_reintento(self):
        trabajo = TrabajoCompartido()
        def fallar():
            raise ValueError('fallo controlado')
        with self.assertRaisesRegex(ValueError, 'fallo controlado'):
            trabajo.ejecutar('bloque', fallar)
        self.assertEqual(trabajo.ejecutar('bloque', lambda: 42), 42)

    def test_claves_distintas_no_se_mezclan(self):
        trabajo = TrabajoCompartido()
        barrera = Barrier(2)
        def pedir(clave):
            def calcular():
                barrera.wait(timeout=5)
                return clave
            return trabajo.ejecutar(clave, calcular)
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(pedir, [('bloque', False), ('bloque', True)])),
                             [('bloque', False), ('bloque', True)])


if __name__ == '__main__':
    unittest.main()
