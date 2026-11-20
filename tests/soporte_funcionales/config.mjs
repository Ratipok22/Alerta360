import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const here=path.dirname(fileURLToPath(import.meta.url));
export const out=path.resolve(here,'../resultados_funcionales');
export const fixturePath=path.join(here,'resources.json');
export const controlPath=path.join(here,'planificadas_control.py');
export const python=process.env.PRUEBAS_PYTHON || path.resolve(here,'../../src/backend/.venv/Scripts/python.exe');
await fs.mkdir(out,{recursive:true});
