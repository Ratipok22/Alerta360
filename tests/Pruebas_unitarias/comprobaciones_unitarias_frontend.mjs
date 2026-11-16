import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const frontendDir = path.join(projectRoot, 'src', 'frontend');
const source = fs.readFileSync(path.join(frontendDir, 'src', 'main.tsx'), 'utf8');

function balancedEnd(text, start, openChar, closeChar) {
  let depth = 0;
  let state = 'code';
  for (let i = start; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (state === 'line') { if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++; } continue; }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (c === '\\') { i++; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
      continue;
    }
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === "'") { state = 'single'; continue; }
    if (c === '"') { state = 'double'; continue; }
    if (c === '`') { state = 'template'; continue; }
    if (c === openChar) depth++;
    if (c === closeChar && --depth === 0) return i + 1;
  }
  throw new Error('No se pudo cerrar el bloque extraído');
}

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Función no encontrada: ' + name);
  const paren = source.indexOf('(', start);
  const closeParen = balancedEnd(source, paren, '(', ')') - 1;
  const body = source.indexOf('{', closeParen + 1);
  return source.slice(start, balancedEnd(source, body, '{', '}'));
}

function extractArrow(name) {
  const start = source.indexOf('const ' + name + ' = (');
  if (start < 0) throw new Error('Arrow no encontrada: ' + name);
  const paren = source.indexOf('(', start);
  const closeParen = balancedEnd(source, paren, '(', ')') - 1;
  const arrow = source.indexOf('=>', closeParen + 1);
  const body = source.indexOf('{', arrow + 2);
  return source.slice(start, balancedEnd(source, body, '{', '}'));
}

const cStart = source.indexOf('const IDONEIDAD_TIPO_CLAVE:');
const cEnd = source.indexOf('\n};', cStart) + 3;
if (cStart < 0 || cEnd < 3) throw new Error('No se encontró la tabla de idoneidad');
const constants = source.slice(cStart, cEnd);
const units = extractFunction('unidadesRequeridasEfectivas');
const scoreHelpers = ['idoneidadTipoPara', 'tipoPreferidoPara', 'scoreDetalle', 'score', 'justificarRecomendacion', 'pickRecommendation', 'esDisponible', 'unidadesEnCaminoA'].map(extractFunction).join('\n');
const sharedFn = extractArrow('intentarIniciarTrabajoCompartido');

const shim = `
type TipoEstructura = string;
type RequisitoUnidad = { tipos: string[]; cantidad: number };
type ResourceType = 'Bomberos'|'Escala'|'Cisterna'|'Rescate'|'Hazmat'|'Forestal';
type Resource = { id:string; type:ResourceType; crew:number; radioState:string; distanceKm:number; eta:number; destino?:{emergenciaId:number} };
type Clave = { codigo:string; prioridad_nivel?:number; terreno?:string; unidades_requeridas?:RequisitoUnidad[] };
type Emergency = { id:number; codigo:string; lat?:number; lng?:number; tipoEstructura?:TipoEstructura|null; piso?:number|null };
type ScoreDesglose = {total:number;tipoPreferido:ResourceType;coincideTipo:boolean;idoneidadTipo:number;coincideTerreno:boolean;esCritica:boolean;dotacionBonus:number;disponibilidadBonus:number;penalizacionVelocidad:number};
type EtaCache = Record<string, unknown>;
const LIMITE_UNIDADES_POR_EMERGENCIA=3;
const distanciaYEtaHacia=(r:Resource)=>({distanciaKm:r.distanceKm,etaMin:r.eta});
let isAdmin=true;
let resourcesRef:any={current:[]};
let trabajoCompartidoRef:any={current:{}};
let timeoutsRef:any={current:[]};
let claves:any={};
const TIEMPO_TRABAJO_MS:any={};
const tiposFaltantesPara=()=>[];
const timerHandles:any[]=[];
let timerId=0;
const window={setTimeout:(cb:()=>void,ms:number)=>{timerHandles.push({cb,ms});return ++timerId}};
`;

const tests = `
const assert=(condition,name)=>{if(!condition){console.log(name+': FAIL');failures.push(name)}else console.log(name+': PASS')};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const base=[{tipos:['Bomberos'],cantidad:2},{tipos:['Escala'],cantidad:1}];
const withoutScale=[{tipos:['Bomberos'],cantidad:2}];
assert(same(unidadesRequeridasEfectivas({unidades_requeridas:base},{tipoEstructura:'edificio_residencial',piso:2}),withoutScale),'EM05 piso 2');
for(const piso of [3,4,null,0,-1,2.5]) assert(same(unidadesRequeridasEfectivas({unidades_requeridas:base},{tipoEstructura:'edificio_residencial',piso}),base),'EM05 piso '+piso+' conservador');
assert(same(unidadesRequeridasEfectivas({unidades_requeridas:base},{tipoEstructura:'vivienda',piso:4}),withoutScale),'EM05 vivienda');
const clave={codigo:'10-1',prioridad_nivel:2,terreno:'urbano'};
const resources=[
 {id:'bomberos',type:'Bomberos',crew:4,radioState:'6-0',distanceKm:5,eta:5},
 {id:'rescate',type:'Rescate',crew:4,radioState:'6-0',distanceKm:5,eta:5},
 {id:'busy',type:'Bomberos',crew:6,radioState:'6-9',distanceKm:1,eta:1}
];
const rec=pickRecommendation(resources,{id:1},new Set(),clave,0);
assert(rec?.id==='bomberos','AS01 elige tipo idóneo y disponible');
assert(justificarRecomendacion(rec,clave,5,5).includes('tipo ideal'),'AS01 explica puntuación');
assert(pickRecommendation(resources,{id:1},new Set(['bomberos']),clave,0)?.id==='rescate','AS01 respeta rechazo');
assert(pickRecommendation(resources,{id:1},new Set(),clave,0,undefined,['Rescate'])?.id==='rescate','AS01 respeta tipo pendiente');
function arrivals(initial){
 timerHandles.length=0;timerId=0;
 resourcesRef={current:initial};trabajoCompartidoRef={current:{}};timeoutsRef={current:[]};
 claves={'10-0':clave};
 const emergency={id:99,codigo:'10-0'};
 return {timers:timerHandles,resourcesRef,trabajoCompartidoRef,timeoutsRef,start:()=>intentarIniciarTrabajoCompartido(emergency)};
}
const both=arrivals([{id:'a',radioState:'6-7',destino:{emergenciaId:99}},{id:'b',radioState:'6-7',destino:{emergenciaId:99}}]);
both.start();both.start();assert(both.timers.length===1,'AS08 llegadas simultáneas inician una ola');
const seq=arrivals([{id:'a',radioState:'6-7',destino:{emergenciaId:99}},{id:'b',radioState:'6-3',destino:{emergenciaId:99}}]);
seq.start();assert(seq.timers.length===0,'AS08 espera mientras queda una unidad en trayecto');
seq.resourcesRef.current=seq.resourcesRef.current.map(r=>({...r,radioState:'6-7'}));seq.start();assert(seq.timers.length===1,'AS08 llegada diferida no se pierde');
`;

const temp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp_matrix_unit_harness.ts');
const sourceTs = shim + '\n' + constants + '\n' + units + '\n' + scoreHelpers + '\n' + sharedFn + '\nconst failures:string[]=[];\n' + tests + '\nif(failures.length)process.exitCode=1;';
fs.writeFileSync(temp, sourceTs, 'utf8');
try {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', temp], { cwd: frontendDir, encoding: 'utf8' });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(temp, { force: true });
}
