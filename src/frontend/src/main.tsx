import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import {AlertTriangle, BarChart3, Bell, Building2, CheckCircle2, Clock3, Crosshair, Droplet, Flame, HardHat, History, Layers3, MapPin, Menu, Navigation, Radio, RefreshCw, Settings, ShieldCheck, Truck, TreePine, Users, XCircle, Zap} from 'lucide-react';

// En localhost apunta al backend local de siempre. Si la app se abre a
// traves de un dev tunnel (ej. VS Code Ports / *.devtunnels.ms), reconstruye
// la URL del backend cambiando el puerto en el mismo subdominio del tunel
// (ambos puertos deben estar reenviados: 5173 y 8000).
function detectarApiBase():string{
  const {protocol, hostname}=window.location;
  if(hostname.endsWith('.devtunnels.ms')){
    const hostBackend=hostname.replace(/-\d+\./, '-8000.');
    return `${protocol}//${hostBackend}`;
  }
  return 'http://localhost:8000';
}
const API_BASE = detectarApiBase();

// Ubicacion por defecto: Valparaiso. A futuro, cuando el sistema se despliegue
// en una central real, este valor se reemplaza por la geolocalizacion del
// dispositivo/direccion donde se esta utilizando (ver intento de geolocalizacion abajo).
const VALPARAISO_CENTER = {lat: -33.0472, lng: -71.6127};

// Toda la app trabaja en hora de Valparaiso/Chile, no en la zona horaria del
// navegador donde se este viendo (importante si algun dia se ve desde otro
// huso horario: la lectura del mapa de calor y las horas mostradas deben
// coincidir siempre con la hora real de la central en Chile).
const CHILE_TZ = 'America/Santiago';

type ResourceType = 'Bomberos' | 'Forestal' | 'Rescate' | 'Hazmat' | 'Escala' | 'Cisterna';
type RadioState = '6-0' | '6-3' | '6-7' | '6-8' | '6-9';
type Resource={
  id:string; name:string; type:ResourceType; lat:number; lng:number;
  radioState:RadioState; eta:number; distance:number; capacity:string; crew:number;
  compania:string; sector:string;
  destino?:{emergenciaId:number; lat:number; lng:number; address:string};
};
type Emergency={id:number; codigo:string; address:string; lat:number; lng:number; status:'Activa'|'Asignada'; creadaEn:number;};
type ZoneDemand={zona_id:string; nombre:string; bounds:{lat_min:number;lat_max:number;lng_min:number;lng_max:number}; centroid:{lat:number;lng:number}; demanda_total:number; desglose:Record<string,number>;};
type Periodo={periodo_inicio:string; periodo_fin:string; zonas:ZoneDemand[];};
type VariableImportancia={nombre:string; peso_pct:number};
type Clave={codigo:string; nombre:string; prioridad:string; prioridad_nivel:number; terreno:string;};
type HistorialTipo='asignacion'|'rechazo'|'en_emergencia'|'liberacion'|'nueva_emergencia';
type HistorialEntry={id:number; ts:number; tipo:HistorialTipo; texto:string;};

const RADIO_LABELS:Record<RadioState,string>={'6-0':'Disponible en cuartel','6-3':'En trayecto','6-7':'En la emergencia','6-8':'Regresando','6-9':'Fuera de servicio'};
const RADIO_COLORS:Record<RadioState,string>={'6-0':'#34C759','6-3':'#2C9AF6','6-7':'#FFCC00','6-8':'#2C9AF6','6-9':'#FF3B30'};
function scoreColor(v:number){return v>=70?'#34C759':v>=40?'#FFCC00':'#FF3B30';}

// Flota real: 16 compañías del Cuerpo de Bomberos de Valparaíso (fundado 1851)
// + 3 compañías confirmadas del Cuerpo de Bomberos de Viña del Mar. Nombre,
// numeración y ubicación cruzados contra dos fuentes: Wikipedia (nombre/
// sector) y cuarteles reales etiquetados como `amenity=fire_station` en
// OpenStreetMap/Overpass (2026-09-09) — esta segunda es la más confiable,
// ya que son puntos verificables, no un sector aproximado. El tipo de carro
// asignado a cada compañía es una aproximación para el prototipo (ver
// backend/core/companies.py para el detalle completo, incluidos los
// conflictos encontrados contra una tercera lista con direcciones que no
// coincidían con OSM, p.ej. la 13ª y 15ª aparecían con Placilla/Rodelillo
// invertidos).
const RESOURCES_INICIALES:Resource[]=[
{id:'B-1',name:'Carro Bomba B-1',type:'Bomberos',lat:-33.0388,lng:-71.6286,radioState:'6-0',eta:23.8,distance:13.88,capacity:'Incendios estructurales',crew:5,compania:'1ª Cía. "Bomba Americana"',sector:'Cochrane 625 / Plaza Sotomayor, Valparaíso'},
{id:'B-2',name:'Carro Bomba B-2',type:'Bomberos',lat:-33.0388,lng:-71.6284,radioState:'6-9',eta:23.8,distance:13.86,capacity:'Incendios estructurales',crew:5,compania:'2ª Cía. "Bomba Germania"',sector:'Blanco 630, Valparaíso'},
{id:'B-3',name:'Carro Bomba B-3',type:'Bomberos',lat:-33.0474,lng:-71.6152,radioState:'6-0',eta:22.4,distance:13.09,capacity:'Incendios estructurales',crew:5,compania:'3ª Cía. "Cousiño y A. Edwards"',sector:'Sector Almendral / Pedro Montt, Valparaíso'},
{id:'B-4',name:'Carro Bomba B-4',type:'Bomberos',lat:-33.0445,lng:-71.6144,radioState:'6-0',eta:22.1,distance:12.89,capacity:'Incendios estructurales',crew:5,compania:'4ª Cía. "Almirante Blanco Encalada"',sector:'Freire, Almendral, Valparaíso'},
{id:'R-5',name:'Unidad Rescate R-5',type:'Rescate',lat:-33.0443,lng:-71.6143,radioState:'6-0',eta:22.1,distance:12.87,capacity:'Rescate vehicular',crew:4,compania:'5ª Cía. "Pompe France"',sector:'Blanco, Almendral, Valparaíso'},
{id:'B-6',name:'Carro Bomba B-6',type:'Bomberos',lat:-33.0487,lng:-71.6139,radioState:'6-0',eta:22.4,distance:13.05,capacity:'Incendios estructurales',crew:5,compania:'6ª Cía. "Cristoforo Colombo"',sector:'General Cruz 630, Valparaíso'},
{id:'Q-7',name:'Escala Mecánica Q-7',type:'Escala',lat:-33.0470,lng:-71.6123,radioState:'6-0',eta:22.0,distance:12.83,capacity:'Escala en altura',crew:4,compania:'7ª Cía. "Bomba España"',sector:'Sector Almendral / Pedro Montt, Valparaíso'},
{id:'H-8',name:'Unidad HazMat H-8',type:'Hazmat',lat:-33.0427,lng:-71.6239,radioState:'6-0',eta:23.4,distance:13.63,capacity:'Materiales peligrosos',crew:4,compania:'8ª Cía. "Zapadores Franco Chilenos"',sector:'Blanco Sur, Valparaíso'},
{id:'B-9',name:'Carro Bomba B-9',type:'Bomberos',lat:-33.0447,lng:-71.6143,radioState:'6-0',eta:22.1,distance:12.89,capacity:'Incendios estructurales',crew:5,compania:'9ª Cía. "Zapadores Freire"',sector:'Freire, Almendral, Valparaíso'},
{id:'B-10',name:'Carro Bomba B-10',type:'Bomberos',lat:-33.0486,lng:-71.6139,radioState:'6-0',eta:22.4,distance:13.04,capacity:'Incendios estructurales',crew:5,compania:'10ª Cía. "Bomba Chileno Árabe"',sector:'Sector Almendral / Parque Italia, Valparaíso'},
{id:'R-11',name:'Unidad Rescate R-11',type:'Rescate',lat:-33.0428,lng:-71.6240,radioState:'6-0',eta:23.4,distance:13.64,capacity:'Rescate vehicular y técnico',crew:4,compania:'11ª Cía. "George Garland"',sector:'Melgarejo 147, Barrio Puerto, Valparaíso'},
{id:'B-12',name:'Carro Bomba B-12',type:'Bomberos',lat:-33.0387,lng:-71.6458,radioState:'6-0',eta:26.4,distance:15.40,capacity:'Incendios estructurales',crew:5,compania:'12ª Cía. "Luis Bravo Osses - Bomba Suiza"',sector:'Cerro Playa Ancha, Valparaíso'},
{id:'BF-13',name:'Autobomba Forestal BF-13',type:'Forestal',lat:-33.1186,lng:-71.5742,radioState:'6-0',eta:27.0,distance:15.73,capacity:'Incendios forestales',crew:6,compania:'13ª Cía. "George Mustakis Dragonas"',sector:'Av. Cardenal Samoré 930, Placilla, Valparaíso'},
{id:'Z-13',name:'Carro Aljibe Z-13',type:'Cisterna',lat:-33.1186,lng:-71.5742,radioState:'6-0',eta:27.0,distance:15.73,capacity:'Cisterna de agua',crew:3,compania:'13ª Cía. "George Mustakis Dragonas"',sector:'Av. Cardenal Samoré 930, Placilla, Valparaíso'},
{id:'BF-14',name:'Autobomba Forestal BF-14',type:'Forestal',lat:-33.0495,lng:-71.5747,radioState:'6-0',eta:17.1,distance:9.95,capacity:'Incendios forestales',crew:6,compania:'14ª Cía. "Reino de Bélgica"',sector:'Av. Manuel Antonio Matta 2503, Placeres Alto, Valparaíso'},
{id:'BF-15',name:'Autobomba Forestal BF-15',type:'Forestal',lat:-33.0582,lng:-71.5767,radioState:'6-0',eta:18.3,distance:10.69,capacity:'Incendios forestales',crew:6,compania:'15ª Cía. "Bomba Israel"',sector:'Av. Rodelillo, Valparaíso'},
{id:'BF-16',name:'Autobomba Forestal BF-16',type:'Forestal',lat:-33.1076,lng:-71.6692,radioState:'6-0',eta:35.8,distance:20.87,capacity:'Incendios forestales',crew:6,compania:'16ª Cía. "Libertador Bernardo O\'Higgins"',sector:'Laguna Verde, Valparaíso'},
{id:'B-V1',name:'Carro Bomba B-V1',type:'Bomberos',lat:-33.0263,lng:-71.5549,radioState:'6-0',eta:12.0,distance:7.01,capacity:'Incendios estructurales',crew:5,compania:'1ª Cía. (Bomberos Viña del Mar)',sector:'Álvarez 562, Viña del Mar'},
{id:'B-V2',name:'Carro Bomba B-V2',type:'Bomberos',lat:-33.0251,lng:-71.5500,radioState:'6-0',eta:11.2,distance:6.55,capacity:'Incendios estructurales',crew:5,compania:'2ª Cía. (Bomberos Viña del Mar)',sector:'Av. Valparaíso 791, Viña del Mar'},
{id:'R-V3',name:'Unidad Rescate R-V3',type:'Rescate',lat:-33.0361,lng:-71.5266,radioState:'6-0',eta:9.7,distance:5.64,capacity:'Rescate vehicular',crew:4,compania:'3ª Cía. (Bomberos Viña del Mar)',sector:'Limache 3001, Viña del Mar'},
{id:'R-V4',name:'Unidad Rescate R-V4',type:'Rescate',lat:-33.0127,lng:-71.5417,radioState:'6-0',eta:9.0,distance:5.28,capacity:'Rescate vehicular',crew:4,compania:'4ª Cía. (Bomberos Viña del Mar)',sector:'12 Norte, Viña del Mar'},
{id:'BF-V5',name:'Autobomba Forestal BF-V5',type:'Forestal',lat:-32.9979,lng:-71.5181,radioState:'6-0',eta:4.8,distance:2.77,capacity:'Incendios forestales',crew:6,compania:'5ª Cía. (Bomberos Viña del Mar)',sector:'Pacífico 5215, Viña del Mar'},
{id:'B-V6',name:'Carro Bomba B-V6',type:'Bomberos',lat:-32.9262,lng:-71.5122,radioState:'6-0',eta:14.0,distance:8.16,capacity:'Incendios estructurales',crew:5,compania:'6ª Cía. (Bomberos Viña del Mar)',sector:'Vergara 1115, Viña del Mar'},
{id:'H-V7',name:'Unidad HazMat H-V7',type:'Hazmat',lat:-33.0336,lng:-71.5551,radioState:'6-0',eta:12.8,distance:7.44,capacity:'Materiales peligrosos',crew:4,compania:'7ª Cía. (Bomberos Viña del Mar)',sector:'Logroño 1298, Viña del Mar'},
{id:'Q-V8',name:'Escala Mecánica Q-V8',type:'Escala',lat:-32.9722,lng:-71.5376,radioState:'6-0',eta:9.2,distance:5.34,capacity:'Escala en altura',crew:4,compania:'8ª Cía. (Bomberos Viña del Mar)',sector:'Av. José Manuel Balmaceda 601, Viña del Mar'},
{id:'BF-V9',name:'Autobomba Forestal BF-V9',type:'Forestal',lat:-32.9996,lng:-71.4882,radioState:'6-0',eta:2,distance:0.31,capacity:'Incendios forestales',crew:6,compania:'9ª Cía. "Brigada Reñaca Alto" (Bomberos Viña del Mar)',sector:'Altamira, Reñaca Alto'},
{id:'BF-V10',name:'Autobomba Forestal BF-V10',type:'Forestal',lat:-33.0225,lng:-71.5040,radioState:'6-0',eta:5.5,distance:3.21,capacity:'Incendios forestales',crew:6,compania:'10ª Cía. (Bomberos Viña del Mar)',sector:'Av. Presidente Eduardo Frei Montalva 4350, Viña del Mar'},
];

// Pool de emergencias simuladas que rota (una nueva reemplaza a la que se atiende)
// Coordenadas geocodificadas con Nominatim/OpenStreetMap (2026-09-09).
const POOL_EMERGENCIAS:{codigo:string; address:string; lat:number; lng:number}[]=[
{codigo:'10-2', address:'Camino cerros, sector Reñaca Alto, Viña del Mar', lat:-32.9968, lng:-71.4884},
{codigo:'10-0', address:'Av. Argentina, Barrio Almendral, Valparaíso', lat:-33.0499, lng:-71.6031},
{codigo:'10-4', address:'Av. España, Valparaíso', lat:-33.0395, lng:-71.6036},
{codigo:'10-1', address:'Camino Internacional, Placilla, Valparaíso', lat:-33.1149, lng:-71.5680},
{codigo:'10-5', address:'Terminal Pacífico Sur, Puerto de Valparaíso', lat:-33.0327, lng:-71.6276},
{codigo:'10-3', address:'Población Rodelillo, Valparaíso', lat:-33.0577, lng:-71.5764},
{codigo:'10-0', address:'Casona patrimonial, Cerro Concepción, Valparaíso', lat:-33.0423, lng:-71.6265},
{codigo:'10-2', address:'Sector Cerro Placeres, Valparaíso', lat:-33.0366, lng:-71.5952},
{codigo:'10-1', address:'Camino Troncal, Miraflores, Viña del Mar', lat:-33.0357, lng:-71.4998},
{codigo:'10-4', address:'Av. Alemania (curva), Valparaíso', lat:-33.0564, lng:-71.6072},
{codigo:'10-5', address:'Planta industrial, zona Placilla, Valparaíso', lat:-33.1149, lng:-71.5680},
{codigo:'10-3', address:'Cerro Bellavista, Valparaíso', lat:-33.0501, lng:-71.6223},
];

const CODIGO_TIPO_PREFERIDO:Record<string,ResourceType>={'10-0':'Bomberos','10-1':'Bomberos','10-2':'Forestal','10-3':'Rescate','10-4':'Rescate','10-5':'Hazmat'};
// Tiempo (ms, escalado para demo) que la unidad permanece "trabajando" en el
// lugar segun la clave — un incendio estructural o forestal toma mas tiempo
// en resolverse que un salvamento, por ejemplo. Mientras dura, el recurso
// queda excluido de nuevas recomendaciones (no vuelve a estar "disponible"
// hasta terminar este tiempo + el regreso a cuartel).
const TIEMPO_TRABAJO_MS:Record<string,number>={'10-0':26000,'10-1':14000,'10-2':32000,'10-3':16000,'10-4':17000,'10-5':22000};
const CAPACIDAD_CLAVE:Record<ResourceType,string>={Forestal:'forestal',Hazmat:'peligrosos',Rescate:'rescate',Bomberos:'estructural',Escala:'escala',Cisterna:'cisterna'};

// Conocimiento sobre los factores horarios/estacionales que usa el modelo de
// ML (backend/ml/generate_dataset.py) para cada clave, usado para explicar
// en lenguaje simple por que una zona/periodo aparece con mayor demanda.
type FactorClave={horasAltas:number[]; diasAltas:number[]; mesesAltos:number[]; motivoHora:string; motivoDia:string; motivoMes:string};
const CLAVE_FACTORES:Record<string,FactorClave>={
  '10-0':{horasAltas:[12,15,18],diasAltas:[5,6],mesesAltos:[6,7,8],motivoHora:'uso de cocina y calefacción al mediodía y en la tarde',motivoDia:'fines de semana, con más actividad doméstica',motivoMes:'temporada de invierno (más uso de calefacción y artefactos eléctricos)'},
  '10-1':{horasAltas:[9,18],diasAltas:[4,5,6],mesesAltos:[],motivoHora:'horas de mayor tráfico (mañana y tarde-noche)',motivoDia:'entre viernes y domingo, con más desplazamientos',motivoMes:''},
  '10-2':{horasAltas:[12,15,18],diasAltas:[3,4,5,6],mesesAltos:[12,1,2,3],motivoHora:'horas de mayor calor y viento durante el día',motivoDia:'entre jueves y domingo, con más visitantes en cerros y quebradas',motivoMes:'temporada seca de incendios forestales en Chile central (diciembre a marzo)'},
  '10-3':{horasAltas:[],diasAltas:[5,6],mesesAltos:[],motivoHora:'',motivoDia:'fines de semana, con más actividad en espacios públicos',motivoMes:''},
  '10-4':{horasAltas:[6,9,18],diasAltas:[4,5,6],mesesAltos:[5,6,7,8],motivoHora:'horario punta de tráfico vehicular',motivoDia:'entre viernes y domingo, con más desplazamientos (incluida la noche)',motivoMes:'meses de invierno, con más lluvia y menor visibilidad'},
  '10-5':{horasAltas:[9,12],diasAltas:[0,1,2,3],mesesAltos:[],motivoHora:'horario de mayor actividad portuaria e industrial',motivoDia:'días hábiles, con más operación industrial',motivoMes:''},
};
const DIA_NOMBRES=['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
const MES_NOMBRES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

const DOW_ABREV_A_INDICE:Record<string,number>={Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6};

// Extrae hora/dia/mes en hora de Valparaiso (America/Santiago) sin importar
// la zona horaria configurada en el navegador donde se vea la aplicacion.
function periodoInfo(iso:string){
  const d=new Date(iso);
  const partes=new Intl.DateTimeFormat('en-US',{timeZone:CHILE_TZ,hour:'2-digit',hour12:false,weekday:'short',month:'numeric'}).formatToParts(d);
  const valor=(tipo:string)=>partes.find(p=>p.type===tipo)?.value??'';
  const hora=Number(valor('hour'))%24;
  const dow=DOW_ABREV_A_INDICE[valor('weekday')]??0;
  const mes=Number(valor('month'));
  return {hora, dow, mes};
}

function explicarZona(periodo:Periodo, zona:ZoneDemand, claves:Record<string,Clave>){
  const {hora,dow,mes}=periodoInfo(periodo.periodo_inicio);
  const desglose=Object.entries(zona.desglose).sort((a,b)=>b[1]-a[1]);
  const [codigoTop,valorTop]=desglose[0]||['',0];
  const factor=CLAVE_FACTORES[codigoTop];
  const razones:string[]=[];
  if(factor){
    if(factor.horasAltas.includes(hora)) razones.push(`Es un horario de mayor actividad para esta clave: ${factor.motivoHora}.`);
    if(factor.diasAltas.includes(dow)) razones.push(`El día de la semana también influye: ${factor.motivoDia}.`);
    if(factor.mesesAltos.includes(mes)) razones.push(`El mes actual eleva el riesgo: ${factor.motivoMes}.`);
  }
  if(!razones.length) razones.push('No coincide con un pico horario ni estacional conocido; el valor refleja principalmente la tasa histórica base de la zona y el historial reciente de emergencias.');
  return {codigoTop, nombreTop:claves[codigoTop]?.nombre??codigoTop, valorTop, razones, desglose};
}

// Version breve de la misma explicacion, para la tarjeta de la emergencia
// activa: por que esta clave es mas probable justo ahora (hora/dia/mes
// reales), usando el mismo conocimiento de factores que el mapa de calor.
function explicarEmergenciaActual(codigo:string, nowMs:number):string{
  const {hora,dow,mes}=periodoInfo(new Date(nowMs).toISOString());
  const factor=CLAVE_FACTORES[codigo];
  if(!factor) return 'No hay un patrón horario o estacional conocido asociado a esta clave.';
  if(factor.horasAltas.includes(hora)) return `Es un horario de mayor actividad para este tipo de emergencia: ${factor.motivoHora}.`;
  if(factor.diasAltas.includes(dow)) return `El día de hoy influye: ${factor.motivoDia}.`;
  if(factor.mesesAltos.includes(mes)) return `El mes actual influye: ${factor.motivoMes}.`;
  return 'No coincide con un pico horario ni estacional conocido para esta clave; puede deberse a factores puntuales del lugar.';
}

function resumenGeneral(periodo:Periodo|undefined, zonas:ZoneDemand[], claves:Record<string,Clave>){
  if(!periodo || !zonas.length) return 'Cargando la predicción del modelo…';
  const {hora,dow,mes}=periodoInfo(periodo.periodo_inicio);
  const horaFin=(hora+3)%24;
  const top=zonas.slice().sort((a,b)=>b.demanda_total-a.demanda_total)[0];
  const {codigoTop,nombreTop}=explicarZona(periodo, top, claves);
  const nivel=top.demanda_total<0.8?'baja':top.demanda_total<1.8?'media':'alta';
  let contexto='';
  if(mes>=12||mes<=3) contexto=' Estamos en temporada de incendios forestales (dic-mar), por lo que el riesgo de la clave 10-2 tiende a ser más alto de lo normal.';
  else if(mes>=6&&mes<=8) contexto=' Estamos en temporada de invierno, con más riesgo de incendios estructurales (10-0) y rescates viales (10-4).';
  return `Bloque actual ${String(hora).padStart(2,'0')}:00–${String(horaFin).padStart(2,'0')}:00, ${DIA_NOMBRES[dow]} de ${MES_NOMBRES[mes-1]}. La zona con mayor demanda esperada es ${top.nombre}, con riesgo ${nivel} (${top.demanda_total.toFixed(1)} casos esperados), dominada por la clave ${codigoTop} (${nombreTop}).${contexto} Toca cualquier zona del mapa para ver el detalle.`;
}

function esDisponible(r:Resource){return r.radioState==='6-0';}

type ScoreDesglose={
  total:number; tipoPreferido:ResourceType; coincideTipo:boolean; coincideTerreno:boolean;
  esCritica:boolean; dotacionBonus:number; penalizacionVelocidad:number;
};

// Asignacion multicriterio: ademas de tipo/capacidad y distancia (ya
// existentes), considera la dotacion de la unidad (mas relevante mientras
// mas critica es la clave, porque en incidentes graves se necesitan mas
// manos de inmediato) y si el terreno de la unidad coincide con el terreno
// real de la clave (urbano/forestal) — no solo el tipo preferido puntual.
// La velocidad de respuesta (ETA/distancia) tambien pesa mas en emergencias
// criticas/altas que en las de baja prioridad.
function scoreDetalle(r:Resource, clave:Clave|undefined):ScoreDesglose{
  const tipoPreferido=clave?(CODIGO_TIPO_PREFERIDO[clave.codigo]||'Bomberos'):'Bomberos';
  const prioridadNivel=clave?.prioridad_nivel??3;
  const terrenoClave=clave?.terreno??'urbano';
  const esCritica=prioridadNivel<=2;

  const coincideTipo=r.type===tipoPreferido;
  const typeBonus=coincideTipo?32:(r.type==='Bomberos'?16:10);
  const capacityBonus=r.capacity.toLowerCase().includes(CAPACIDAD_CLAVE[tipoPreferido])?25:12;

  const coincideTerreno=(terrenoClave==='forestal')===(r.type==='Forestal');
  const terrenoBonus=coincideTerreno?6:-6;

  const dotacionBonus=Math.min(r.crew,6)*(esCritica?1.4:0.8);

  const pesoVelocidad=esCritica?1.2:0.85;
  const penalizacionVelocidad=(Math.min(r.eta*2,25)+Math.min(r.distance*2,18))*pesoVelocidad;

  const total=35+typeBonus+capacityBonus+terrenoBonus+dotacionBonus-penalizacionVelocidad;
  return {total, tipoPreferido, coincideTipo, coincideTerreno, esCritica, dotacionBonus, penalizacionVelocidad};
}

function score(r:Resource, clave:Clave|undefined):number{
  return scoreDetalle(r,clave).total;
}

// Texto legible de por que el algoritmo eligio esta unidad, a partir del
// mismo desglose que calcula el puntaje (no un texto aparte inventado).
function justificarRecomendacion(r:Resource, clave:Clave|undefined):string{
  const d=scoreDetalle(r,clave);
  const partes:string[]=[];
  partes.push(d.coincideTipo?`tipo compatible con la clave (${d.tipoPreferido})`:`tipo más cercano disponible (${r.type})`);
  partes.push(d.coincideTerreno?'coincide con el terreno de la emergencia':'no es el terreno ideal, pero es la mejor opción disponible');
  partes.push(`dotación de ${r.crew} personas${d.esCritica?' (más relevante por ser clave crítica/alta)':''}`);
  partes.push(`${r.eta} min / ${r.distance} km${d.esCritica?' (la velocidad pesa más por la prioridad de esta clave)':''}`);
  return partes.join(' · ');
}

// Una compania se considera "ocupada" si ya tiene alguna unidad en camino o
// trabajando en OTRA emergencia (6-3/6-7). Mientras eso ocurra, el resto de
// unidades de esa misma compania/cuartel tampoco se recomiendan, para que
// no se despache el mismo cuartel a dos emergencias distintas al mismo tiempo.
function companiaOcupada(resources:Resource[], compania:string):boolean{
  return resources.some(r=>r.compania===compania && (r.radioState==='6-3'||r.radioState==='6-7'));
}

function pickRecommendation(resources:Resource[], emergencia:Emergency|null, rechazados:Set<string>, clave:Clave|undefined):Resource|null{
  if(!emergencia) return null;
  const candidatos=resources.filter(r=>esDisponible(r) && !rechazados.has(r.id) && !companiaOcupada(resources, r.compania));
  if(!candidatos.length) return null;
  return candidatos.slice().sort((a,b)=>score(b,clave)-score(a,clave))[0];
}

function resourceIcon(type:ResourceType){
  if(type==='Forestal') return <TreePine/>;
  if(type==='Bomberos') return <Flame/>;
  if(type==='Hazmat') return <HardHat/>;
  if(type==='Escala') return <Building2/>;
  if(type==='Cisterna') return <Droplet/>;
  return <Truck/>;
}
const RESOURCE_LETRA:Record<ResourceType,string>={Forestal:'F',Hazmat:'H',Rescate:'R',Escala:'Q',Cisterna:'Z',Bomberos:'B'};

function historialIcon(tipo:HistorialTipo){
  if(tipo==='asignacion') return <Navigation size={14}/>;
  if(tipo==='rechazo') return <XCircle size={14}/>;
  if(tipo==='en_emergencia') return <Flame size={14}/>;
  if(tipo==='liberacion') return <Truck size={14}/>;
  return <AlertTriangle size={14}/>;
}
function historialTitle(tipo:HistorialTipo){
  if(tipo==='asignacion') return 'Recurso asignado';
  if(tipo==='rechazo') return 'Recomendación rechazada';
  if(tipo==='en_emergencia') return 'Unidad en la emergencia';
  if(tipo==='liberacion') return 'Unidad disponible';
  return 'Nueva emergencia registrada';
}

function elapsedLabel(startMs:number, nowMs:number){
  const s=Math.max(0,Math.floor((nowMs-startMs)/1000));
  const m=Math.floor(s/60); const sec=s%60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function timeAgo(ts:number, nowMs:number){
  const diff=Math.max(0,Math.floor((nowMs-ts)/1000));
  if(diff<60) return `hace ${diff}s`;
  const m=Math.floor(diff/60);
  if(m<60) return `hace ${m} min`;
  return `hace ${Math.floor(m/60)} h`;
}

function beep(){
  try{
    const Ctx=window.AudioContext || (window as any).webkitAudioContext;
    const ctx=new Ctx();
    const o=ctx.createOscillator(); const g=ctx.createGain();
    o.frequency.value=880; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.001,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2,ctx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.3);
    o.start(); o.stop(ctx.currentTime+0.3);
  }catch{ /* audio no disponible en este navegador */ }
}

function formatHour(iso:string){return new Date(iso).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit',timeZone:CHILE_TZ});}

function buildAlerts(periodos:Periodo[], claves:Record<string,Clave>){
  const entries:{text:string;value:number;zonaId:string}[]=[];
  periodos.forEach(p=>{
    const hora=formatHour(p.periodo_inicio);
    p.zonas.forEach(z=>{
      Object.entries(z.desglose).forEach(([codigo,valor])=>{
        if(valor>=0.5){
          const clave=claves[codigo];
          const etiqueta=clave?`Clave ${codigo} (${clave.nombre})`:codigo;
          entries.push({text:`${hora} · ${etiqueta} — aumenta la probabilidad en ${z.nombre} (${valor.toFixed(1)} casos esperados)`,value:valor,zonaId:z.zona_id});
        }
      });
    });
  });
  return entries.sort((a,b)=>b.value-a.value).slice(0,5);
}

// Fuerza a Leaflet a remedir su contenedor: evita mapas gigantes/desalineados
// cuando el contenedor cambia de tamaño (ventana redimensionada, layout
// flexible, o el propio arranque del mapa antes de que el layout se asiente).
function fixMapSize(map:L.Map):()=>void{
  const invalidate=()=>map.invalidateSize();
  const t=window.setTimeout(invalidate,0);
  window.addEventListener('resize',invalidate);
  return()=>{window.clearTimeout(t); window.removeEventListener('resize',invalidate);};
}

function MapPanel({resources, emergencies, focus, center}:{resources:Resource[]; emergencies:Emergency[]; focus:{lat:number;lng:number}|null; center:{lat:number;lng:number}}){
  const mapRef=useRef<L.Map|null>(null);
  const layerRef=useRef<L.LayerGroup|null>(null);

  // El mapa (tiles, zoom, paneo) se crea una sola vez por cada `center` nuevo
  // (p.ej. cuando resuelve la geolocalizacion). Así, mientras el operador hace
  // zoom o mueve el mapa, los cambios de estado de las unidades no lo reinician.
  useEffect(()=>{
    const map=L.map('map',{zoomControl:false}).setView([center.lat,center.lng],12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
    const layer=L.layerGroup().addTo(map);
    mapRef.current=map;
    layerRef.current=layer;
    const cleanupResize=fixMapSize(map);
    return()=>{cleanupResize(); map.remove(); mapRef.current=null; layerRef.current=null;};
  },[center]);

  // Marcadores y rutas se redibujan encima del mapa existente cada vez que
  // cambian los datos, sin recrear el mapa (no se pierde el zoom/paneo manual).
  useEffect(()=>{
    const layer=layerRef.current;
    if(!layer) return;
    layer.clearLayers();
    emergencies.forEach(e=>{
      L.marker([e.lat,e.lng],{icon:L.divIcon({className:'emergency-marker',html:'<div>!</div>',iconSize:[36,36],iconAnchor:[18,18]})}).addTo(layer).bindPopup(`<b>Emergencia #${e.id}</b><br/>Clave ${e.codigo}<br/>${e.address}`);
    });
    // Emergencias ya asignadas (fuera de la cola) pero que aun tienen una unidad
    // en camino o trabajando: se mantienen marcadas para que la ruta apunte a
    // un incidente real y no a un punto vacio del mapa.
    const destinosMostrados=new Set<number>();
    resources.forEach(r=>{
      if(r.destino && (r.radioState==='6-3'||r.radioState==='6-7') && !destinosMostrados.has(r.destino.emergenciaId)){
        destinosMostrados.add(r.destino.emergenciaId);
        L.marker([r.destino.lat,r.destino.lng],{icon:L.divIcon({className:'emergency-marker emergency-marker-asignada',html:'<div>✓</div>',iconSize:[34,34],iconAnchor:[17,17]})}).addTo(layer).bindPopup(`<b>Emergencia #${r.destino.emergenciaId}</b><br/>${r.destino.address}<br/><i>Asignada</i>`);
      }
    });
    resources.forEach(r=>{
      const color=RADIO_COLORS[r.radioState];
      const icon=L.divIcon({className:'resource-marker',html:`<div style="background:${color}">${RESOURCE_LETRA[r.type]}</div>`,iconSize:[30,30],iconAnchor:[15,15]});
      const m=L.marker([r.lat,r.lng],{icon}).addTo(layer);
      m.bindTooltip(`${r.name} · ${RADIO_LABELS[r.radioState]}`);
      if(r.destino && (r.radioState==='6-3'||r.radioState==='6-7')){
        L.polyline([[r.lat,r.lng],[r.destino.lat,r.destino.lng]],{color:'#29a9ff',weight:4,dashArray:'8 8'}).addTo(layer);
      }
    });
  },[resources, emergencies]);

  // Recentrar solo cuando el operador pide explicitamente ubicar algo
  // ("Ver en el mapa"), no en cada actualizacion de datos.
  useEffect(()=>{
    if(focus && mapRef.current){
      mapRef.current.setView([focus.lat,focus.lng], Math.max(mapRef.current.getZoom(),13));
    }
  },[focus]);

  return <div id="map"/>
}

// Verde/amarillo/rojo segun demanda esperada (mismos umbrales usados en el
// backend para "exactitud de nivel de riesgo").
function demandColor(v:number){return v<0.8?'#2fae66':v<1.8?'#e0b23c':'#e0483f';}

function HeatMapPanel({zonas, seleccionadaId, onSelectZona}:{zonas:ZoneDemand[]; seleccionadaId:string|null; onSelectZona:(zona:ZoneDemand)=>void}){
  const mapRef=useRef<L.Map|null>(null);
  const zoneLayerRef=useRef<L.LayerGroup|null>(null);

  // El mapa se crea una sola vez: hacer zoom/paneo no se pierde cuando llega
  // una nueva prediccion del modelo.
  useEffect(()=>{
    const map=L.map('heatmap',{zoomControl:false}).setView([-33.01,-71.565],11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
    zoneLayerRef.current=L.layerGroup().addTo(map);
    mapRef.current=map;
    const cleanupResize=fixMapSize(map);
    return()=>{cleanupResize(); map.remove(); mapRef.current=null; zoneLayerRef.current=null;};
  },[]);

  // Cada zona se pinta con SU PROPIO color solido segun su demanda esperada
  // (no un difuminado continuo entre zonas): al ser sectores discretos y no
  // puntos de incidentes individuales, un mapa de calor de densidad mezclaba
  // el color de zonas vecinas cercanas entre si, dando lugar a manchas que no
  // correspondian a ninguna zona real. Este "choropleth" es la forma correcta
  // de representar datos agregados por zona.
  useEffect(()=>{
    const zoneLayer=zoneLayerRef.current;
    if(!zoneLayer) return;
    zoneLayer.clearLayers();
    zonas.forEach(z=>{
      const seleccionada=seleccionadaId===z.zona_id;
      const radioMetros=(z.bounds.lat_max-z.bounds.lat_min)/2*111320*0.5;
      const rect=L.circle(
        [z.centroid.lat,z.centroid.lng],
        {radius:radioMetros, color:seleccionada?'#ffffff':'#0d1c2b', weight:seleccionada?2.5:1, fillColor:demandColor(z.demanda_total), fillOpacity:0.7}
      ).addTo(zoneLayer);
      rect.bindTooltip(`${z.nombre} · ${z.demanda_total.toFixed(1)} casos esperados`);
      rect.on('click',()=>onSelectZona(z));
      rect.on('mouseover',()=>{if(!seleccionada) rect.setStyle({weight:2});});
      rect.on('mouseout',()=>{if(!seleccionada) rect.setStyle({weight:1});});
    });
  },[zonas, seleccionadaId, onSelectZona]);

  return <div id="heatmap"/>
}

function EmergenciasView({queue,claves,now,onAtender}:{queue:Emergency[];claves:Record<string,Clave>;now:number;onAtender:(id:number)=>void}){
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Emergencias activas</b><span>{queue.length} en cola de atención</span></div></div>
    <div className="tableWrap"><table className="dataTable">
      <thead><tr><th>ID</th><th>Clave</th><th>Prioridad</th><th>Dirección</th><th>Tiempo</th><th>Estado</th><th></th></tr></thead>
      <tbody>{queue.map(e=>{const c=claves[e.codigo]; return <tr key={e.id}>
        <td>#{e.id}</td>
        <td>{e.codigo} · {c?.nombre??'—'}</td>
        <td><span className={`prio prio-${c?.prioridad_nivel??3}`}>{c?.prioridad??'—'}</span></td>
        <td>{e.address}</td>
        <td>{elapsedLabel(e.creadaEn,now)}</td>
        <td>{e.status}</td>
        <td><button className="linkBtn" onClick={()=>onAtender(e.id)}>Atender</button></td>
      </tr>;})}</tbody>
    </table></div>
  </div>;
}

function RecursosView({resources}:{resources:Resource[]}){
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Flota de Bomberos</b><span>{resources.length} unidades registradas · Cuerpos de Bomberos de Valparaíso y Viña del Mar</span></div></div>
    <div className="tableWrap"><table className="dataTable">
      <thead><tr><th></th><th>Unidad</th><th>Compañía</th><th>Sector</th><th>Tipo</th><th>Dotación</th><th>Distancia</th><th>ETA</th><th>Estado</th></tr></thead>
      <tbody>{resources.map(r=><tr key={r.id}>
        <td className="resIconCell">{resourceIcon(r.type)}</td>
        <td>{r.name}</td>
        <td>{r.compania}</td>
        <td>{r.sector}</td>
        <td>{r.type}</td>
        <td>{r.crew}</td>
        <td>{r.distance} km</td>
        <td>{r.eta} min</td>
        <td><span className={`estado estado-${r.radioState.replace('6-','')}`}>{r.radioState} · {RADIO_LABELS[r.radioState]}</span></td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

function MapaView({resources,emergencies,center,zonas,zonaSeleccionada,onSelectZona}:{resources:Resource[];emergencies:Emergency[];center:{lat:number;lng:number};zonas:ZoneDemand[];zonaSeleccionada:string|null;onSelectZona:(zona:ZoneDemand)=>void}){
  return <div className="sectionGrid">
    <div className="card sectionCard mapaFull">
      <div className="cardHead"><div><b>Mapa operacional</b><span>Todas las unidades y emergencias activas</span></div></div>
      <div className="mapaFullWrap"><MapPanel resources={resources} emergencies={emergencies} focus={null} center={center}/></div>
    </div>
    <div className="card sectionCard mapaFull">
      <div className="cardHead"><div><b>Mapa de calor · Demanda de Bomberos</b><span>Predicción ML · toca una zona para ver el detalle</span></div></div>
      <div className="mapaFullWrap"><HeatMapPanel zonas={zonas} seleccionadaId={zonaSeleccionada} onSelectZona={onSelectZona}/></div>
    </div>
  </div>;
}

function HistorialView({historial,now}:{historial:HistorialEntry[];now:number}){
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Historial de acciones</b><span>{historial.length} eventos registrados esta sesión</span></div></div>
    <div className="activityRows">{historial.length?historial.map(h=><Activity key={h.id} icon={historialIcon(h.tipo)} title={historialTitle(h.tipo)} detail={h.texto} time={timeAgo(h.ts,now)}/>):<p className="emptyState">Aún no hay acciones registradas. Asigna o rechaza una recomendación desde el Dashboard para empezar a construir el historial.</p>}</div>
  </div>;
}

function ReportesView({historial}:{historial:HistorialEntry[]}){
  const asignaciones=historial.filter(h=>h.tipo==='asignacion').length;
  const rechazos=historial.filter(h=>h.tipo==='rechazo').length;
  const liberaciones=historial.filter(h=>h.tipo==='liberacion').length;
  return <div className="sectionGrid">
    <div className="kpis">
      <Kpi icon={<Navigation/>} label="Asignaciones realizadas" value={String(asignaciones)} meta="esta sesión"/>
      <Kpi icon={<XCircle/>} label="Recomendaciones rechazadas" value={String(rechazos)} meta="esta sesión"/>
      <Kpi icon={<Truck/>} label="Unidades liberadas" value={String(liberaciones)} meta="regresaron a cuartel"/>
    </div>
    <div className="card sectionCard"><div className="cardHead"><div><b>Nota</b></div></div><p className="emptyState">Estos indicadores se calculan en vivo a partir de las acciones tomadas en esta sesión (asignar/rechazar recomendaciones). Al recargar la página el historial se reinicia, ya que aún no hay persistencia en base de datos.</p></div>
  </div>;
}

function ConfiguracionView({soundOn,onToggleSound,autoRefreshSec,onChangeAutoRefresh,perfil,onChangePerfil,onNotify}:{soundOn:boolean;onToggleSound:(v:boolean)=>void;autoRefreshSec:number;onChangeAutoRefresh:(v:number)=>void;perfil:{nombre:string;correo:string;telefono:string};onChangePerfil:(p:Partial<{nombre:string;correo:string;telefono:string}>)=>void;onNotify:(s:string)=>void}){
  return <div className="sectionGrid">
    <div className="card sectionCard">
      <div className="cardHead"><div><b>Perfil del operador</b><span>Información de contacto</span></div></div>
      <div className="configBody">
        <label className="configRow">Nombre<input value={perfil.nombre} onChange={e=>onChangePerfil({nombre:e.target.value})}/></label>
        <label className="configRow">Correo<input type="email" value={perfil.correo} onChange={e=>onChangePerfil({correo:e.target.value})}/></label>
        <label className="configRow">Teléfono de contacto<input value={perfil.telefono} onChange={e=>onChangePerfil({telefono:e.target.value})}/></label>
        <button className="locateBtn" onClick={()=>onNotify('El cambio de contraseña requiere un sistema de autenticación en el backend (pendiente de implementar).')}>Cambiar contraseña</button>
        <div className="configNote">Estos datos se guardan solo en esta sesión del navegador — aún no hay backend de usuarios/autenticación.</div>
      </div>
    </div>
    <div className="card sectionCard">
      <div className="cardHead"><div><b>Preferencias</b><span>Comportamiento del sistema</span></div></div>
      <div className="configBody">
        <label className="configRow"><input type="checkbox" checked={soundOn} onChange={e=>onToggleSound(e.target.checked)}/> Notificación sonora al registrarse una nueva emergencia</label>
        <label className="configRow">Actualizar predicción ML cada
          <select value={autoRefreshSec} onChange={e=>onChangeAutoRefresh(Number(e.target.value))}>
            <option value={0}>Manual (botón refrescar)</option>
            <option value={30}>30 segundos</option>
            <option value={60}>1 minuto</option>
            <option value={300}>5 minutos</option>
          </select>
        </label>
      </div>
    </div>
  </div>;
}

function App(){
 const [section,setSection]=useState('Dashboard');
 const [toast,setToast]=useState('');
 const [refresh,setRefresh]=useState(0);
 const [operationalCenter,setOperationalCenter]=useState(VALPARAISO_CENTER);
 const [periodos,setPeriodos]=useState<Periodo[]>([]);
 const [claves,setClaves]=useState<Record<string,Clave>>({});
 const [apiError,setApiError]=useState<string|null>(null);
 const [importanciaVariables,setImportanciaVariables]=useState<VariableImportancia[]>([]);
 const [resources,setResources]=useState<Resource[]>(RESOURCES_INICIALES);
 const [queue,setQueue]=useState<Emergency[]>(()=>POOL_EMERGENCIAS.slice(0,4).map((e,i)=>({...e,id:1258+i,status:'Activa',creadaEn:Date.now()})));
 const [rechazadosPorEmergencia,setRechazadosPorEmergencia]=useState<Record<number,Set<string>>>({});
 const [historial,setHistorial]=useState<HistorialEntry[]>([]);
 const [focus,setFocus]=useState<{lat:number;lng:number}|null>(null);
 const [now,setNow]=useState(Date.now());
 const [soundOn,setSoundOn]=useState(false);
 const [autoRefreshSec,setAutoRefreshSec]=useState(0);
 const [zonaSeleccionada,setZonaSeleccionada]=useState<string|null>(null);
 const [mobileNavOpen,setMobileNavOpen]=useState(false);
 const [perfil,setPerfil]=useState({nombre:'Operador OP', correo:'operador@bomberosvalparaiso.cl', telefono:'+56 9 0000 0000'});

 const emergenciaIdRef=useRef(1258+4);
 const poolIndexRef=useRef(4%POOL_EMERGENCIAS.length);
 const historialIdRef=useRef(1);
 const timeoutsRef=useRef<number[]>([]);
 const soundOnRef=useRef(soundOn);

 useEffect(()=>{soundOnRef.current=soundOn;},[soundOn]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000); return()=>clearInterval(t);},[]);
 useEffect(()=>()=>{timeoutsRef.current.forEach(id=>clearTimeout(id));},[]);

 const currentEmergencia=queue[0]??null;
 const claveActual=currentEmergencia?claves[currentEmergencia.codigo]:undefined;
 const recommendation=useMemo(
   ()=>pickRecommendation(resources,currentEmergencia,rechazadosPorEmergencia[currentEmergencia?.id??-1]||new Set(), claveActual),
   [resources,currentEmergencia,rechazadosPorEmergencia,claveActual]
 );

 const notify=(s:string)=>{setToast(s); setTimeout(()=>setToast(''),2800)};

 const pushHistorial=(tipo:HistorialTipo, texto:string)=>{
   setHistorial(h=>[{id:historialIdRef.current++, ts:Date.now(), tipo, texto}, ...h].slice(0,200));
 };

 const spawnEmergencia=():Emergency=>{
   const seed=POOL_EMERGENCIAS[poolIndexRef.current % POOL_EMERGENCIAS.length];
   poolIndexRef.current+=1;
   const id=emergenciaIdRef.current++;
   return {...seed, id, status:'Activa', creadaEn:Date.now()};
 };

 const advanceQueue=(resolvedId:number)=>{
   setQueue(q=>{
     const rest=q.filter(e=>e.id!==resolvedId);
     if(rest.length<4){
       const nueva=spawnEmergencia();
       pushHistorial('nueva_emergencia',`Emergencia #${nueva.id} · Clave ${nueva.codigo} en ${nueva.address}`);
       if(soundOnRef.current) beep();
       return [...rest, nueva];
     }
     return rest;
   });
   setRechazadosPorEmergencia(r=>{const c={...r}; delete c[resolvedId]; return c;});
 };

 const scheduleResourceLifecycle=(resourceId:string, emergenciaSnap:Emergency, etaMin:number)=>{
   const tiempoTrabajo=TIEMPO_TRABAJO_MS[emergenciaSnap.codigo]??18000;
   const t1=window.setTimeout(()=>{
     setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-7'}:r));
     pushHistorial('en_emergencia',`${resourceId} llegó a la Emergencia #${emergenciaSnap.id} (${emergenciaSnap.address})`);
     const t2=window.setTimeout(()=>{
       setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-8'}:r));
       pushHistorial('liberacion',`${resourceId} finalizó la atención de la Emergencia #${emergenciaSnap.id}, regresando a cuartel`);
       const t3=window.setTimeout(()=>{
         setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-0',destino:undefined}:r));
         pushHistorial('liberacion',`${resourceId} disponible nuevamente en cuartel`);
       }, 7000);
       timeoutsRef.current.push(t3);
     }, tiempoTrabajo);
     timeoutsRef.current.push(t2);
   }, Math.max(2000, Math.min(etaMin*1000, 12000)));
   timeoutsRef.current.push(t1);
 };

 const handleAsignar=()=>{
   if(!currentEmergencia || !recommendation) return;
   const emergenciaSnap=currentEmergencia;
   const resourceId=recommendation.id;
   const nombreClave=claves[emergenciaSnap.codigo]?.nombre??emergenciaSnap.codigo;
   setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-3',destino:{emergenciaId:emergenciaSnap.id,lat:emergenciaSnap.lat,lng:emergenciaSnap.lng,address:emergenciaSnap.address}}:r));
   pushHistorial('asignacion',`${recommendation.name} asignada a Emergencia #${emergenciaSnap.id} · Clave ${emergenciaSnap.codigo} (${nombreClave}) — score ${Math.round(score(recommendation,claveActual))}/100`);
   notify(`${recommendation.name} asignada a la Emergencia #${emergenciaSnap.id}`);
   setFocus({lat:emergenciaSnap.lat,lng:emergenciaSnap.lng});
   scheduleResourceLifecycle(resourceId, emergenciaSnap, recommendation.eta);
   advanceQueue(emergenciaSnap.id);
 };

 const handleRechazar=()=>{
   if(!currentEmergencia || !recommendation) return;
   const emergenciaId=currentEmergencia.id;
   pushHistorial('rechazo',`Se rechazó a ${recommendation.name} para la Emergencia #${emergenciaId}`);
   notify('Recomendación rechazada, buscando siguiente unidad…');
   setRechazadosPorEmergencia(r=>{
     const set=new Set(r[emergenciaId]||[]);
     set.add(recommendation.id);
     return {...r, [emergenciaId]:set};
   });
 };

 const atenderEmergencia=(id:number)=>{
   const target=queue.find(e=>e.id===id);
   setQueue(q=>{if(!target) return q; return [target, ...q.filter(e=>e.id!==id)];});
   if(target) setFocus({lat:target.lat,lng:target.lng});
   setSection('Dashboard');
 };

 useEffect(()=>{
   // Intento de geolocalizacion del navegador: base para, a futuro, ubicar el
   // mapa segun la direccion real donde se este utilizando el sistema.
   // Si no hay permiso o no esta disponible, se mantiene Valparaiso por defecto.
   if('geolocation' in navigator){
     navigator.geolocation.getCurrentPosition(
       pos=>setOperationalCenter({lat:pos.coords.latitude,lng:pos.coords.longitude}),
       ()=>{},
       {timeout:5000}
     );
   }
 },[]);

 useEffect(()=>{
   fetch(`${API_BASE}/prediction/demand?horizon=4`, {credentials:'include'})
     .then(r=>{if(!r.ok)throw new Error(`API respondió ${r.status}`); return r.json();})
     .then(d=>{setPeriodos(d.periodos||[]); setImportanciaVariables(Object.values(d.importancia_variables||{})); setApiError(null);})
     .catch(err=>{setPeriodos([]); setApiError(`No se pudo conectar a ${API_BASE}: ${err.message||err}`);});
 },[refresh]);

 useEffect(()=>{
   fetch(`${API_BASE}/catalog/claves`, {credentials:'include'})
     .then(r=>{if(!r.ok)throw new Error(`API respondió ${r.status}`); return r.json();})
     .then(d=>{
       const porCodigo:Record<string,Clave>={};
       (d.claves||[]).forEach((c:Clave)=>{porCodigo[c.codigo]=c;});
       setClaves(porCodigo);
     })
     .catch(err=>{setClaves({}); setApiError(`No se pudo conectar a ${API_BASE}: ${err.message||err}`);});
 },[]);

 useEffect(()=>{
   if(!autoRefreshSec) return;
   const t=setInterval(()=>setRefresh(x=>x+1), autoRefreshSec*1000);
   return()=>clearInterval(t);
 },[autoRefreshSec]);

 const periodoActual=periodos[0];
 const currentZonas=periodoActual?.zonas||[];
 const alerts=useMemo(()=>buildAlerts(periodos, claves),[periodos, claves]);
 const disponibles=resources.filter(esDisponible).length;
 const resumenHeatmap=useMemo(()=>resumenGeneral(periodoActual, currentZonas, claves),[periodoActual, currentZonas, claves]);
 const zonaDetalle=zonaSeleccionada?currentZonas.find(z=>z.zona_id===zonaSeleccionada):undefined;
 const explicacionZona=(zonaDetalle && periodoActual)?explicarZona(periodoActual, zonaDetalle, claves):undefined;

 return <div className="app">
   {mobileNavOpen && <div className="navBackdrop" onClick={()=>setMobileNavOpen(false)}/>}
   <aside className={`sidebar${mobileNavOpen?' open':''}`}><div className="brand"><div className="brandIcon"><Zap size={20}/></div><div><b>ALERTA360</b><span>BOMBEROS · VALPARAÍSO</span></div></div>
    <nav>{[['Dashboard',BarChart3],['Emergencias',AlertTriangle],['Recursos',Truck],['Mapa',MapPin],['Historial',History],['Reportes',Layers3],['Configuración',Settings]].map(([label,Icon]:any)=><button key={label} className={section===label?'active':''} onClick={()=>{setSection(label);setMobileNavOpen(false);}}><Icon size={18}/><span>{label}</span></button>)}</nav>
    <div className="sidebarBottom"><div className="online"><span></span>Sistema operativo</div><small>Última sincronización<br/><b>hace 18 segundos</b></small></div>
   </aside>
   <main className="main"><header><button className="mobileMenu" onClick={()=>setMobileNavOpen(o=>!o)}><Menu/></button><div><h1>{section}</h1><p>Central de coordinación · Valparaíso</p></div><div className="headerActions"><div className="live"><span/> EN VIVO</div><button onClick={()=>{setRefresh(x=>x+1);notify('Datos actualizados')}}><RefreshCw size={17}/></button><button onClick={()=>notify(`${queue.length} emergencias en cola`)}><Bell size={18}/></button><button className="avatar" onClick={()=>setSection('Configuración')} title="Ver perfil del operador">OP</button></div></header>
    {section==='Emergencias' && <EmergenciasView queue={queue} claves={claves} now={now} onAtender={atenderEmergencia}/>}
    {section==='Recursos' && <RecursosView resources={resources}/>}
    {section==='Mapa' && <MapaView resources={resources} emergencies={queue} center={operationalCenter} zonas={currentZonas} zonaSeleccionada={zonaSeleccionada} onSelectZona={z=>setZonaSeleccionada(z.zona_id)}/>}
    {section==='Historial' && <HistorialView historial={historial} now={now}/>}
    {section==='Reportes' && <ReportesView historial={historial}/>}
    {section==='Configuración' && <ConfiguracionView soundOn={soundOn} onToggleSound={setSoundOn} autoRefreshSec={autoRefreshSec} onChangeAutoRefresh={setAutoRefreshSec} perfil={perfil} onChangePerfil={p=>setPerfil(prev=>({...prev,...p}))} onNotify={notify}/>}
    {section==='Dashboard' && <>
    <section className="kpis"><Kpi icon={<AlertTriangle/>} label="Emergencias activas" value={String(queue.length)} meta={currentEmergencia?`atendiendo clave ${currentEmergencia.codigo}`:'sin emergencia activa'}/><Kpi icon={<Truck/>} label="Recursos disponibles" value={String(disponibles)} meta={`de ${resources.length} unidades`}/><Kpi icon={<Clock3/>} label="Tiempo promedio" value="07:42" meta="−11% esta semana"/><Kpi icon={<ShieldCheck/>} label="Cobertura estimada" value="86%" meta="objetivo 90%"/></section>
    <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa operacional</b><span>Emergencias y recursos en tiempo real</span></div></div><MapPanel resources={resources} emergencies={queue} focus={focus} center={operationalCenter}/><div className="legend"><span><i className="dot green"/> Disponible</span><span><i className="dot red"/> En misión</span><span><i className="dot blue"/> Ruta recomendada</span></div></div>
      <div className="sideCards">
      {currentEmergencia?<div className="emergencyCard"><div className={`tag prio prio-${claveActual?.prioridad_nivel??4}`}>{claveActual?`${claveActual.prioridad.toUpperCase()} PRIORIDAD`:'PRIORIDAD'}</div><div className="emergencyTitle"><div className="danger"><AlertTriangle/></div><div><b>Emergencia #{currentEmergencia.id}</b><span>{claveActual?.nombre??currentEmergencia.codigo}</span></div></div><div className="details"><p><MapPin size={15}/> {currentEmergencia.address}</p><p><Clock3 size={15}/> Tiempo transcurrido: <b>{elapsedLabel(currentEmergencia.creadaEn,now)}</b></p><p><Radio size={15}/> Estado: <b>{currentEmergencia.status}</b></p></div><p className="recJustificacion">{explicarEmergenciaActual(currentEmergencia.codigo, now)}</p><button className="locateBtn" onClick={()=>setFocus({lat:currentEmergencia.lat,lng:currentEmergencia.lng})}><Crosshair size={13}/> Ver en el mapa</button></div>:<div className="emergencyCard"><p className="emptyState">Sin emergencias activas por el momento.</p></div>}
      <div className="recommend"><div className="recHead"><div><span>RECURSO RECOMENDADO</span><small>Asignación multicriterio</small></div>{recommendation && <div className="score" style={{color:scoreColor(Math.round(score(recommendation,claveActual)))}}>{Math.round(score(recommendation,claveActual))}<small>/100</small></div>}</div>
      {recommendation?<>
       <div className="recBody"><div className="vehicleIcon">{resourceIcon(recommendation.type)}</div><div><b>{recommendation.name}</b><span className="recBodyCia">{recommendation.compania} · {recommendation.sector}</span><p><Clock3 size={14}/> ETA estimado: <strong>{recommendation.eta} min</strong></p><p><Navigation size={14}/> Distancia: <strong>{recommendation.distance} km</strong></p><p><CheckCircle2 size={14}/> Disponibilidad: <strong>Disponible</strong></p><p><ShieldCheck size={14}/> Capacidad: <strong>{recommendation.capacity}</strong></p><p><Users size={14}/> Dotación: <strong>{recommendation.crew} personas</strong></p></div></div>
       <p className="recJustificacion">Por qué esta unidad: {justificarRecomendacion(recommendation,claveActual)}.</p>
       <button className="locateBtn" onClick={()=>setFocus({lat:recommendation.lat,lng:recommendation.lng})}><Crosshair size={13}/> Ver en el mapa</button>
       <div className="actions"><button className="assign" onClick={handleAsignar}>ASIGNAR</button><button className="reject" onClick={handleRechazar}>RECHAZAR</button></div>
      </>:<p className="emptyState">Sin unidades disponibles para esta emergencia en este momento — todas las compatibles están en misión.</p>}
      </div></div></section>
      <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa de calor · Demanda de Bomberos</b><span>Predicción ML · próximas {(periodos.length||4)*3} horas · toca una zona para ver el detalle</span></div><span className="mlBadge">ML</span></div><HeatMapPanel zonas={currentZonas} seleccionadaId={zonaSeleccionada} onSelectZona={z=>setZonaSeleccionada(z.zona_id)}/><div className="legend heatLegend"><span><i className="dot green"/> Baja</span><span><i className="dot yellow"/> Media</span><span><i className="dot red"/> Alta</span></div></div>
      <div className="sideCards"><div className="card alertsCard"><div className="cardHead"><div><b>Alertas predictivas</b><span>Zonas y horarios de mayor riesgo</span></div></div>
      {apiError && <div className="apiErrorBox"><AlertTriangle size={14}/> {apiError}</div>}
      {explicacionZona && zonaDetalle?<div className="zonaDetalle">
        <div className="zonaDetalleHead"><b>{zonaDetalle.nombre}</b><button className="linkBtn" onClick={()=>setZonaSeleccionada(null)}>Quitar selección</button></div>
        <p className="zonaDetalleResumen">Demanda total esperada: <b>{zonaDetalle.demanda_total.toFixed(1)}</b> casos en este bloque, dominada por <b>Clave {explicacionZona.codigoTop} ({explicacionZona.nombreTop})</b>.</p>
        <ul className="zonaRazones">{explicacionZona.razones.map((r,i)=><li key={i}>{r}</li>)}</ul>
        <div className="zonaDesglose">{explicacionZona.desglose.map(([cod,val])=><div key={cod} className="zonaDesgloseRow"><span>{cod} · {claves[cod]?.nombre??cod}</span><b>{val.toFixed(2)}</b></div>)}</div>
      </div>:<>
        <p className="resumenText">{resumenHeatmap}</p>
        <div className="alertsList">{alerts.length?alerts.map((a,i)=><div className="alertRow alertRowClickable" key={i} onClick={()=>setZonaSeleccionada(a.zonaId)}><AlertTriangle size={13}/><span>{a.text}</span></div>):<div className="alertRow"><span>{periodos.length?'Sin picos puntuales sobre el umbral de alerta en este momento.':'Cargando predicción del modelo…'}</span></div>}</div>
        {importanciaVariables.length>0 && <div className="importanciaBox">
          <div className="importanciaTitle">Cómo decide el modelo (real, no supuesto)</div>
          {importanciaVariables.map(v=><div className="importanciaRow" key={v.nombre}>
            <span>{v.nombre}</span>
            <div className="importanciaBarWrap"><div className="importanciaBar" style={{width:`${v.peso_pct}%`}}/></div>
            <b>{v.peso_pct}%</b>
          </div>)}
        </div>}
      </>}
      </div></div></section>
      <section className="singleRow"><div className="resourcesCard card"><div className="cardHead"><div><b>Recursos disponibles</b><span>Unidades consideradas por el algoritmo</span></div><button className="linkBtn" onClick={()=>setSection('Recursos')}>Ver todos</button></div><div className="resourceGrid">{resources.slice(0,4).map(r=><div className={`resource ${esDisponible(r)?'':'busy'}`} key={r.id}><div className="resIcon">{resourceIcon(r.type)}</div><div><b>{r.name}</b><span className={esDisponible(r)?'available':'busyText'}>{RADIO_LABELS[r.radioState]}</span><small>{r.distance} km {esDisponible(r)&&`· ${r.eta} min`}</small></div></div>)}</div></div></section>
      <section className="activity card"><div className="cardHead"><div><b>Actividad reciente</b><span>Últimos eventos del sistema</span></div><span className="liveText"><span/> actualización automática</span></div><div className="activityRows">{historial.length?historial.slice(0,5).map(h=><Activity key={h.id} icon={historialIcon(h.tipo)} title={historialTitle(h.tipo)} detail={h.texto} time={timeAgo(h.ts,now)}/>):<Activity icon={<Radio/>} title="Sistema iniciado" detail="Esperando primera asignación" time="ahora"/>}</div></section>
    </>}
    </main>{toast&&<div className="toast"><CheckCircle2 size={18}/>{toast}</div>}
 </div>
}
function Kpi({icon,label,value,meta}:{icon:React.ReactNode;label:string;value:string;meta:string}){return <div className="kpi card"><div className="kpiIcon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{meta}</small></div></div>}
function Activity({icon,title,detail,time}:{icon:React.ReactNode;title:string;detail:string;time:string}){return <div className="activityRow"><div className="activityIcon">{icon}</div><div><b>{title}</b><span>{detail}</span></div><time>{time}</time></div>}

createRoot(document.getElementById('root')!).render(<App/>);
