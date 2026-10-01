import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import {AlertTriangle, BarChart3, Bell, Building2, CheckCircle2, Clock3, Crosshair, Droplet, Eye, Flame, HardHat, History, Info, Layers3, Lock, LogOut, Mail, MapPin, Menu, Moon, Navigation, Radio, RefreshCw, Settings, ShieldCheck, Sun, Truck, TreePine, Users, XCircle, Zap} from 'lucide-react';

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
// Token de sesion actual (JWT), en una variable de modulo -- lo necesitan
// funciones sueltas fuera de React (como obtenerRutaReal) que no reciben
// props/estado directamente. Se mantiene sincronizada con el estado real
// de auth en App() mediante un efecto (ver mas abajo).
let currentToken:string|null=null;
function authHeaders():Record<string,string>{
  return currentToken?{Authorization:`Bearer ${currentToken}`}:{};
}

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
// Tramo que la unidad esta recorriendo ahora mismo (ida a la emergencia o
// vuelta al cuartel), usado para calcular su posicion real en el mapa en
// cada instante en vez de dejarla fija en su cuartel mientras se mueve.
// `puntos` es la ruta real por calles (motor de ruteo local OSRM, ver
// backend GET /route); mientras esa ruta no ha llegado (o si el servicio de
// rutas no esta disponible), se anima con una linea recta entre origen y
// destino como respaldo. `acumKm` es la distancia acumulada hasta cada
// punto de la ruta, precalculada una sola vez, para ubicar la posicion
// exacta segun cuanto se ha avanzado sin recalcular todo en cada cuadro.
type Tramo={
  origen:{lat:number;lng:number}; destino:{lat:number;lng:number};
  inicio:number; duracionMs:number;
  puntos?:{lat:number;lng:number}[]; acumKm?:number[];
};
type Resource={
  id:string; name:string; type:ResourceType; lat:number; lng:number;
  radioState:RadioState; eta:number; distance:number; capacity:string; crew:number;
  compania:string; sector:string;
  destino?:{emergenciaId:number; lat:number; lng:number; address:string};
  tramo?:Tramo;
  // Marca de tiempo de la ultima transmision real de estado (6-0..6-9) de
  // esta unidad -- usada para el timeout operacional (ver App): si una
  // unidad despachada no transmite dentro del umbral configurado, se
  // marca con una alerta visual para que la central la verifique.
  ultimaActualizacion?:number;
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

// Punto exacto sobre una ruta de varios tramos (segmentos reales de calle)
// segun la fraccion (0 a 1) del trayecto ya recorrida, usando la distancia
// acumulada precalculada — no un simple promedio entre inicio y fin.
function puntoEnFraccion(puntos:{lat:number;lng:number}[], acumKm:number[], fraccion:number):{lat:number;lng:number}{
  const total=acumKm[acumKm.length-1]||0;
  if(total<=0) return puntos[0];
  const objetivo=Math.max(0,Math.min(1,fraccion))*total;
  let i=1;
  while(i<acumKm.length-1 && acumKm[i]<objetivo) i++;
  const previo=puntos[i-1], actual=puntos[i];
  const segTotal=acumKm[i]-acumKm[i-1];
  const segFrac=segTotal>0?(objetivo-acumKm[i-1])/segTotal:0;
  return {lat:previo.lat+(actual.lat-previo.lat)*segFrac, lng:previo.lng+(actual.lng-previo.lng)*segFrac};
}

// Posicion real de la unidad en este instante: si esta en camino a una
// emergencia o regresando al cuartel, se interpola sobre su tramo actual
// segun cuanto tiempo ha pasado — siguiendo la ruta real por calles
// (r.tramo.puntos) cuando esta disponible, o una linea recta de respaldo
// si el motor de rutas no alcanzo a responder. Si esta en el cuartel,
// trabajando en la emergencia o fuera de servicio, es su posicion conocida.
function posicionActual(r:Resource, nowMs:number):{lat:number;lng:number}{
  if((r.radioState==='6-3'||r.radioState==='6-8') && r.tramo){
    const t=Math.min(1, Math.max(0, (nowMs-r.tramo.inicio)/r.tramo.duracionMs));
    if(r.tramo.puntos && r.tramo.acumKm && r.tramo.puntos.length>=2){
      return puntoEnFraccion(r.tramo.puntos, r.tramo.acumKm, t);
    }
    return {
      lat: r.tramo.origen.lat + (r.tramo.destino.lat-r.tramo.origen.lat)*t,
      lng: r.tramo.origen.lng + (r.tramo.destino.lng-r.tramo.origen.lng)*t,
    };
  }
  if(r.radioState==='6-7' && r.destino) return {lat:r.destino.lat, lng:r.destino.lng};
  return {lat:r.lat, lng:r.lng};
}

// Segmento (par de puntos consecutivos de la ruta real) que la unidad esta
// cruzando ahora mismo, usado solo para orientar el icono del vehiculo
// segun hacia donde dobla en ese tramo puntual (no el rumbo general del
// viaje completo).
function segmentoActual(r:Resource, nowMs:number):{origen:{lat:number;lng:number}; destino:{lat:number;lng:number}}|null{
  if(!((r.radioState==='6-3'||r.radioState==='6-8') && r.tramo)) return null;
  const {puntos,acumKm}=r.tramo;
  if(!puntos || !acumKm || puntos.length<2) return {origen:r.tramo.origen, destino:r.tramo.destino};
  const t=Math.min(1, Math.max(0, (nowMs-r.tramo.inicio)/r.tramo.duracionMs));
  const total=acumKm[acumKm.length-1]||0;
  const objetivo=t*total;
  let i=1;
  while(i<acumKm.length-1 && acumKm[i]<objetivo) i++;
  return {origen:puntos[i-1], destino:puntos[i]};
}

// Pide al backend la ruta real por calles (motor OSRM local, ver
// GET /route) entre dos puntos, y precalcula la distancia acumulada de
// cada tramo de la ruta. Si el servicio de rutas no responde (apagado,
// error de red), devuelve null y quien llama sigue usando la linea recta
// de respaldo — el mapa nunca se rompe por esto, solo se ve menos realista.
async function obtenerRutaReal(origen:{lat:number;lng:number}, destino:{lat:number;lng:number}):Promise<{puntos:{lat:number;lng:number}[]; acumKm:number[]}|null>{
  try{
    const url=`${API_BASE}/route?origen_lat=${origen.lat}&origen_lng=${origen.lng}&destino_lat=${destino.lat}&destino_lng=${destino.lng}`;
    const resp=await fetch(url,{credentials:'include', headers:authHeaders()});
    if(!resp.ok) return null;
    const data=await resp.json();
    const puntos:{lat:number;lng:number}[]=data.puntos;
    if(!Array.isArray(puntos) || puntos.length<2) return null;
    const acumKm=[0];
    for(let i=1;i<puntos.length;i++){
      acumKm.push(acumKm[i-1]+haversineKm(puntos[i-1].lat,puntos[i-1].lng,puntos[i].lat,puntos[i].lng));
    }
    return {puntos, acumKm};
  }catch{
    return null;
  }
}

// Distancia real (Haversine) y ETA, con la misma logica que el backend
// (core/eta.py): 35 km/h en tramos urbanos, 50 km/h en tramos forestales.
// Antes el frontend usaba un numero de distancia/ETA fijo por unidad,
// calculado una sola vez respecto a un punto de referencia; ahora se
// calcula en vivo para la emergencia real que se esta evaluando y desde la
// posicion actual de la unidad (no siempre su cuartel) — asi una unidad
// que va de regreso y es redirigida a otra emergencia se evalua desde
// donde esta en ese momento, no desde su cuartel de origen.
const VELOCIDAD_URBANO_KMH=35;
const VELOCIDAD_FORESTAL_KMH=50;
function haversineKm(lat1:number,lng1:number,lat2:number,lng2:number):number{
  const R=6371;
  const toRad=(d:number)=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function etaMinutos(distanciaKm:number, terreno:string):number{
  const velocidad=terreno==='forestal'?VELOCIDAD_FORESTAL_KMH:VELOCIDAD_URBANO_KMH;
  return (distanciaKm/velocidad)*60;
}
function distanciaYEtaHacia(r:Resource, destino:{lat:number;lng:number}, clave:Clave|undefined, nowMs:number):{distanciaKm:number; etaMin:number}{
  const origen=posicionActual(r, nowMs);
  const distanciaKm=haversineKm(origen.lat, origen.lng, destino.lat, destino.lng);
  const etaMin=etaMinutos(distanciaKm, clave?.terreno??'urbano');
  return {distanciaKm:Math.round(distanciaKm*100)/100, etaMin:Math.round(etaMin*10)/10};
}

// Rumbo real (0°=norte, 90°=este, sentido horario) entre dos puntos, para
// orientar el icono del vehiculo hacia donde va de verdad, no un icono fijo.
function rumboGrados(lat1:number,lng1:number,lat2:number,lng2:number):number{
  const toRad=(d:number)=>d*Math.PI/180, toDeg=(r:number)=>r*180/Math.PI;
  const y=Math.sin(toRad(lng2-lng1))*Math.cos(toRad(lat2));
  const x=Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lng2-lng1));
  return (toDeg(Math.atan2(y,x))+360)%360;
}

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
{id:'BF-15',name:'Autobomba Forestal BF-15',type:'Forestal',lat:-33.0582,lng:-71.5767,radioState:'6-0',eta:18.3,distance:10.69,capacity:'Incendios forestales',crew:6,compania:'15ª Cía. "Bomba Israel"',sector:'Av. Rodelillo s/n, esquina Jardín de Abadía, Cerro Rodelillo, Valparaíso'},
{id:'BF-16',name:'Autobomba Forestal BF-16',type:'Forestal',lat:-33.1076,lng:-71.6692,radioState:'6-0',eta:35.8,distance:20.87,capacity:'Incendios forestales',crew:6,compania:'16ª Cía. "Libertador Bernardo O\'Higgins"',sector:'Laguna Verde, Valparaíso'},
{id:'B-V1',name:'Carro Bomba B-V1',type:'Bomberos',lat:-33.0263,lng:-71.5549,radioState:'6-0',eta:12.0,distance:7.01,capacity:'Incendios estructurales',crew:5,compania:'1ª Cía. (Bomberos Viña del Mar)',sector:'Álvarez 562, Viña del Mar'},
{id:'B-V2',name:'Carro Bomba B-V2',type:'Bomberos',lat:-33.0251,lng:-71.5500,radioState:'6-0',eta:11.2,distance:6.55,capacity:'Incendios estructurales',crew:5,compania:'2ª Cía. (Bomberos Viña del Mar)',sector:'Av. Valparaíso 791, Viña del Mar'},
{id:'R-V3',name:'Unidad Rescate R-V3',type:'Rescate',lat:-33.0361,lng:-71.5266,radioState:'6-0',eta:9.7,distance:5.64,capacity:'Rescate vehicular',crew:4,compania:'3ª Cía. (Bomberos Viña del Mar)',sector:'Limache 3001, Viña del Mar'},
{id:'R-V4',name:'Unidad Rescate R-V4',type:'Rescate',lat:-33.0127,lng:-71.5417,radioState:'6-0',eta:9.0,distance:5.28,capacity:'Rescate vehicular',crew:4,compania:'4ª Cía. (Bomberos Viña del Mar)',sector:'12 Norte, Viña del Mar'},
{id:'BF-V5',name:'Autobomba Forestal BF-V5',type:'Forestal',lat:-32.9979,lng:-71.5181,radioState:'6-0',eta:4.8,distance:2.77,capacity:'Incendios forestales',crew:6,compania:'5ª Cía. (Bomberos Viña del Mar)',sector:'Pacífico 5215, Viña del Mar'},
{id:'B-V6',name:'Carro Bomba B-V6',type:'Bomberos',lat:-32.9262,lng:-71.5122,radioState:'6-0',eta:14.0,distance:8.16,capacity:'Incendios estructurales',crew:5,compania:'6ª Cía. (Bomberos Viña del Mar)',sector:'Vergara 1115, Concón'},
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

// Puntos reales de patrullaje: mismas coordenadas ya verificadas usadas en
// otras partes del sistema (companias, pool de emergencias, zonas del
// modelo de ML), reutilizadas aca para que las unidades "sueltas" circulen
// entre lugares reales y no coordenadas inventadas (que podrian caer en el
// mar o en un sitio inexistente, como ya paso antes en este proyecto).
// Los puntos de Valparaiso Centro tienen mas peso porque es el area que se
// ve por defecto al abrir el mapa — asi hay actividad visible ahi la
// mayor parte del tiempo, no solo ocasionalmente en el resto de la region.
const PUNTOS_PATRULLAJE:{nombre:string; lat:number; lng:number; peso:number}[]=[
  {nombre:'Plaza Sotomayor', lat:-33.0388, lng:-71.6286, peso:3},
  {nombre:'Av. Argentina / Almendral', lat:-33.0499, lng:-71.6031, peso:3},
  {nombre:'Cerro Alegre / Concepción', lat:-33.0423, lng:-71.6265, peso:3},
  {nombre:'Cerro Placeres', lat:-33.0366, lng:-71.5952, peso:3},
  {nombre:'Barrio Puerto', lat:-33.0383, lng:-71.6284, peso:3},
  {nombre:'Playa Ancha', lat:-33.0284, lng:-71.6379, peso:1},
  {nombre:'Viña del Mar Centro', lat:-33.0245, lng:-71.5518, peso:1},
  {nombre:'Reñaca', lat:-32.9730, lng:-71.5266, peso:1},
  {nombre:'Concón', lat:-32.9305, lng:-71.5030, peso:1},
  {nombre:'Placilla', lat:-33.1149, lng:-71.5680, peso:1},
];
function elegirPuntoPatrullaje(){
  const total=PUNTOS_PATRULLAJE.reduce((s,p)=>s+p.peso,0);
  let r=Math.random()*total;
  for(const p of PUNTOS_PATRULLAJE){
    if(r<p.peso) return p;
    r-=p.peso;
  }
  return PUNTOS_PATRULLAJE[0];
}
// Cuantas unidades disponibles como maximo circulan "sueltas" a la vez —
// una fraccion de la flota, no todas, para que el mapa se vea vivo sin
// perder la nocion de que la mayoria esta en su cuartel.
const MAX_EN_PATRULLAJE=5;

const CODIGO_TIPO_PREFERIDO:Record<string,ResourceType>={'10-0':'Bomberos','10-1':'Bomberos','10-2':'Forestal','10-3':'Rescate','10-4':'Rescate','10-5':'Hazmat'};
// Tiempo (ms, escalado para demo) que la unidad permanece "trabajando" en el
// lugar segun la clave — un incendio estructural o forestal toma mas tiempo
// en resolverse que un salvamento, por ejemplo. Mientras dura, el recurso
// queda excluido de nuevas recomendaciones (no vuelve a estar "disponible"
// hasta terminar este tiempo + el regreso a cuartel).
const TIEMPO_TRABAJO_MS:Record<string,number>={'10-0':26000,'10-1':14000,'10-2':32000,'10-3':16000,'10-4':17000,'10-5':22000};

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

// Disponible para una nueva recomendacion: en cuartel (6-0) o ya regresando
// de una emergencia anterior (6-8) — esta ultima puede ser redirigida a una
// emergencia nueva desde donde se encuentre en ese momento, en vez de
// obligarla a llegar primero al cuartel. Mientras esta en camino (6-3) o
// trabajando en el lugar (6-7) sigue comprometida y no se ofrece de nuevo.
function esDisponible(r:Resource){return r.radioState==='6-0' || r.radioState==='6-8';}

// Idoneidad real (0 a 1) de cada tipo de unidad para cada clave: no es
// blanco o negro (solo el tipo "ideal" sirve) — reconoce, por ejemplo, que
// un Carro Bomba puede apoyar un rescate vehicular liviano aunque lo ideal
// sea una unidad de Rescate, o que una Cisterna aporta bastante en un
// incendio (forestal o estructural) aunque no sea el tipo preferido. Cada
// punto de idoneidad se traduce directo en puntaje: mientras mas util es
// realmente ese tipo de unidad para ESTA clave, mas puntos suma.
const IDONEIDAD_TIPO_CLAVE:Record<string, Partial<Record<ResourceType, number>>>={
  '10-0':{Bomberos:1.0, Escala:0.5, Cisterna:0.45, Rescate:0.2, Hazmat:0.2, Forestal:0.25},
  '10-1':{Bomberos:1.0, Cisterna:0.5, Forestal:0.3, Rescate:0.25, Hazmat:0.2, Escala:0.15},
  '10-2':{Forestal:1.0, Cisterna:0.6, Bomberos:0.4, Rescate:0.1, Hazmat:0.15, Escala:0.1},
  '10-3':{Rescate:1.0, Bomberos:0.5, Escala:0.4, Hazmat:0.2, Cisterna:0.1, Forestal:0.1},
  '10-4':{Rescate:1.0, Bomberos:0.5, Escala:0.2, Hazmat:0.2, Cisterna:0.1, Forestal:0.1},
  '10-5':{Hazmat:1.0, Bomberos:0.4, Rescate:0.3, Cisterna:0.2, Escala:0.1, Forestal:0.1},
};
function idoneidadTipoPara(tipo:ResourceType, codigoClave:string|undefined):number{
  if(!codigoClave) return 0.4;
  return IDONEIDAD_TIPO_CLAVE[codigoClave]?.[tipo] ?? 0.15;
}

type ScoreDesglose={
  total:number; tipoPreferido:ResourceType; coincideTipo:boolean; idoneidadTipo:number; coincideTerreno:boolean;
  esCritica:boolean; dotacionBonus:number; disponibilidadBonus:number; penalizacionVelocidad:number;
};

// Asignacion multicriterio, con cada factor pesando segun que tan
// relacionado esta con la necesidad real de la emergencia:
// - Tipo/capacidad de la unidad (idoneidadTipoPara): el factor con mas peso
//   (hasta 45 pts), graduado segun que tan util es ese tipo para esta clave
//   especifica, no solo "es o no es el tipo ideal".
// - Terreno (urbano/forestal): bonifica o penaliza segun coincida con el
//   terreno real de la clave.
// - Dotacion: mas relevante mientras mas critica es la clave, porque en
//   incidentes graves se necesitan mas manos de inmediato.
// - Disponibilidad: una unidad ya en su cuartel (6-0) suma un poco mas que
//   una que hay que redirigir desde otra emergencia (6-8) — sigue siendo
//   elegible, pero a igualdad de lo demas se prefiere la que ya esta lista.
// - Velocidad de respuesta (ETA/distancia real, ver distanciaYEtaHacia):
//   penaliza mas fuerte en emergencias criticas/altas que en las de baja
//   prioridad, donde importa mas la idoneidad que la rapidez.
function scoreDetalle(r:Resource, clave:Clave|undefined, distanciaKm:number, etaMin:number):ScoreDesglose{
  const tipoPreferido=clave?(CODIGO_TIPO_PREFERIDO[clave.codigo]||'Bomberos'):'Bomberos';
  const prioridadNivel=clave?.prioridad_nivel??3;
  const terrenoClave=clave?.terreno??'urbano';
  const esCritica=prioridadNivel<=2;

  const coincideTipo=r.type===tipoPreferido;
  const idoneidadTipo=idoneidadTipoPara(r.type, clave?.codigo);
  const idoneidadBonus=Math.round(idoneidadTipo*45);

  const coincideTerreno=(terrenoClave==='forestal')===(r.type==='Forestal');
  const terrenoBonus=coincideTerreno?6:-6;

  const dotacionBonus=Math.min(r.crew,6)*(esCritica?1.4:0.8);

  const disponibilidadBonus=r.radioState==='6-0'?4:0;

  // Sin techo: antes esta penalizacion se limitaba con Math.min(...,25/18),
  // lo que hacia que, pasado cierto punto (~9 km), una unidad a 9 km y otra
  // a 90 km recibieran EXACTAMENTE la misma penalizacion — es decir, mas
  // alla de esa distancia dejaba de importar cuan lejos estuviera de verdad.
  // Eso podia hacer ganar a una unidad lejana con mejor tipo/dotacion por
  // sobre una mucho mas cercana. Sin techo, estar el doble de lejos siempre
  // pesa el doble, sin importar cuan lejos ya este.
  const pesoVelocidad=esCritica?1.2:0.85;
  const penalizacionVelocidad=(etaMin*1.5+distanciaKm*2)*pesoVelocidad;

  const total=25+idoneidadBonus+terrenoBonus+dotacionBonus+disponibilidadBonus-penalizacionVelocidad;
  return {total, tipoPreferido, coincideTipo, idoneidadTipo, coincideTerreno, esCritica, dotacionBonus, disponibilidadBonus, penalizacionVelocidad};
}

function score(r:Resource, clave:Clave|undefined, distanciaKm:number, etaMin:number):number{
  return scoreDetalle(r,clave,distanciaKm,etaMin).total;
}

// Texto legible de por que el algoritmo eligio esta unidad, a partir del
// mismo desglose que calcula el puntaje (no un texto aparte inventado).
function justificarRecomendacion(r:Resource, clave:Clave|undefined, distanciaKm:number, etaMin:number):string{
  const d=scoreDetalle(r,clave,distanciaKm,etaMin);
  const partes:string[]=[];
  partes.push(d.coincideTipo?`tipo ideal para esta clave (${d.tipoPreferido})`:`idoneidad ${Math.round(d.idoneidadTipo*100)}% para esta clave (tipo ${r.type}, ideal sería ${d.tipoPreferido})`);
  partes.push(d.coincideTerreno?'coincide con el terreno de la emergencia':'no es el terreno ideal, pero es la mejor opción disponible');
  partes.push(`dotación de ${r.crew} personas${d.esCritica?' (más relevante por ser clave crítica/alta)':''}`);
  partes.push(r.radioState==='6-0'?'ya disponible en su cuartel':'disponible tras redirigirla desde otra emergencia');
  partes.push(`${etaMin} min / ${distanciaKm} km${r.radioState==='6-8'?' desde su posición actual':' desde su cuartel'}${d.esCritica?' — la velocidad pesa más por la prioridad de esta clave':''}`);
  return partes.join(' · ');
}

// Una compania se considera "ocupada" si ya tiene alguna unidad en camino o
// trabajando en OTRA emergencia (6-3/6-7). Mientras eso ocurra, el resto de
// unidades de esa misma compania/cuartel tampoco se recomiendan, para que
// no se despache el mismo cuartel a dos emergencias distintas al mismo tiempo.
// Una unidad regresando (6-8) NO cuenta como "ocupada": ya termino su
// atencion anterior y esta libre para una nueva emergencia.
function companiaOcupada(resources:Resource[], compania:string):boolean{
  return resources.some(r=>r.compania===compania && (r.radioState==='6-3'||r.radioState==='6-7'));
}

function pickRecommendation(resources:Resource[], emergencia:Emergency|null, rechazados:Set<string>, clave:Clave|undefined, nowMs:number):Resource|null{
  if(!emergencia) return null;
  const candidatos=resources.filter(r=>esDisponible(r) && !rechazados.has(r.id) && !companiaOcupada(resources, r.compania));
  if(!candidatos.length) return null;
  return candidatos.slice().sort((a,b)=>{
    const da=distanciaYEtaHacia(a,emergencia,clave,nowMs);
    const db=distanciaYEtaHacia(b,emergencia,clave,nowMs);
    return score(b,clave,db.distanciaKm,db.etaMin)-score(a,clave,da.distanciaKm,da.etaMin);
  })[0];
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

// Icono de vehiculo EN MOVIMIENTO: una silueta orientada segun el rumbo
// real de viaje (rumboGrados), en un contenedor que NO rota (para que la
// insignia con el tipo de unidad se mantenga siempre legible), con un
// anillo de color que lo distingue a simple vista del icono fijo del
// cuartel (iconoCuartel) -- este es "el carro andando", ese otro es "el
// cuartel", nunca se confunden ni se superponen en la misma idea visual.
function iconoVehiculo(color:string, letra:string, rumbo:number):string{
  return `<div style="position:relative;width:30px;height:30px;">
    <div style="position:absolute;inset:0;border-radius:50%;border:2px solid #29a9ff;box-shadow:0 0 6px #29a9ffaa;"></div>
    <div class="vehiculo-giro" style="position:absolute;inset:2px;transform:rotate(${rumbo}deg);transition:transform .3s linear;">
      <svg viewBox="0 0 24 24" width="26" height="26">
        <path d="M12 2 L19 15 L14.5 15 L14.5 22 L9.5 22 L9.5 15 L5 15 Z" fill="${color}" stroke="#12141a" stroke-width="1.4"/>
        <circle cx="12" cy="9" r="2" fill="#12141a" opacity="0.45"/>
      </svg>
    </div>
    <div style="position:absolute;bottom:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#12141a;border:1.5px solid ${color};color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;">${letra}</div>
  </div>`;
}

// Icono del CUARTEL: fijo, siempre en el mismo lugar (nunca se mueve ni se
// anima), a proposito distinto del vehiculo -- forma cuadrada/insignia en
// vez de flecha, sin anillo de movimiento, un color neutro que no depende
// del estado de radio de ninguna unidad puntual (representa el lugar, no
// una unidad especifica). Muestra las letras de todos los tipos de unidad
// que pertenecen a esa compania (algunas companias tienen mas de una).
function iconoCuartel(letras:string[]):string{
  const texto=Array.from(new Set(letras)).join('·');
  return `<div style="width:22px;height:22px;border-radius:5px;background:#1c2029;border:2px solid #5b6472;color:#cbd5e1;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;box-shadow:0 1px 4px #000a;">${texto}</div>`;
}

// Boton "asignar manualmente" dentro de un popup: solo aparece si hay una
// emergencia activa y la unidad realmente esta disponible (esDisponible) —
// el click real se maneja por delegacion de eventos en MapPanel (los
// popups de Leaflet son HTML plano, no componentes de React), identificando
// la unidad por el atributo data-asignar-id.
function botonAsignarManual(unidad:Resource, hayEmergenciaActiva:boolean, isAdmin:boolean):string{
  // RBAC: el rol "visualizador" (solo lectura) nunca ve el boton de
  // asignar en los popups del mapa, ni siquiera si hay una emergencia
  // activa -- el backend igual lo rechazaria (ver requiere_admin en
  // main.py), pero no tiene sentido mostrarle el boton en primer lugar.
  if(!isAdmin || !hayEmergenciaActiva || !esDisponible(unidad)) return '';
  return `<button data-asignar-id="${unidad.id}" style="margin-top:6px;width:100%;padding:6px 8px;border-radius:6px;border:none;background:#e5484d;color:#fff;font-weight:700;font-size:11px;cursor:pointer;">Asignar ${unidad.id} a la emergencia activa</button>`;
}

// Contenido HTML de la popup al hacer click en una unidad: detalle completo
// (no solo el nombre/estado del tooltip al pasar el mouse), mas el boton
// de asignacion manual si corresponde.
function popupVehiculo(r:Resource, hayEmergenciaActiva:boolean, isAdmin:boolean):string{
  const detalleTramo=r.destino
    ? `<br/>→ ${r.destino.address}`
    : '';
  return `<b>${r.name}</b><br/>${r.compania}<br/><span style="opacity:.75">${r.sector}</span><br/>
    Tipo: ${r.type} · Dotación: ${r.crew}<br/>
    Estado: <b>${RADIO_LABELS[r.radioState]}</b>${detalleTramo}
    ${botonAsignarManual(r, hayEmergenciaActiva, isAdmin)}`;
}

// Popup del cuartel: lista todas las unidades basadas ahi y su estado
// actual (un mismo cuartel puede tener mas de una), con un boton de
// asignacion manual por cada unidad que este realmente disponible.
function popupCuartel(compania:string, sector:string, unidades:Resource[], hayEmergenciaActiva:boolean, isAdmin:boolean):string{
  const filas=unidades.map(u=>
    `${u.id} (${u.type}) — <b>${RADIO_LABELS[u.radioState]}</b>${botonAsignarManual(u, hayEmergenciaActiva, isAdmin)}`
  ).join('<br/>');
  return `<b>${compania}</b><br/><span style="opacity:.75">${sector}</span><br/><br/>${filas}`;
}

function MapPanel({resources, emergencies, focus, center, onAsignarManual, isAdmin=true}:{resources:Resource[]; emergencies:Emergency[]; focus:{lat:number;lng:number}|null; center:{lat:number;lng:number}; onAsignarManual:(resourceId:string)=>void; isAdmin?:boolean}){
  const mapRef=useRef<L.Map|null>(null);
  // Refs para leer siempre el valor mas reciente desde callbacks que
  // Leaflet dispara mas tarde (popups, clicks) sin que queden desactualizados.
  const onAsignarManualRef=useRef(onAsignarManual);
  onAsignarManualRef.current=onAsignarManual;
  const emergenciesRef=useRef(emergencies);
  emergenciesRef.current=emergencies;
  const isAdminRef=useRef(isAdmin);
  isAdminRef.current=isAdmin;
  // Capa "estatica": emergencias, marcador de emergencia asignada y el
  // trazado de ruta -- se redibuja solo cuando cambian los datos (no en
  // cada tick), porque nada de esto se mueve cuadro a cuadro.
  const layerRef=useRef<L.LayerGroup|null>(null);
  // Marcadores de unidades: PERSISTENTES (no se destruyen y recrean cada
  // tick). Se mueven con marker.setLatLng() -- que junto con la transicion
  // CSS de .resource-marker se ve como un vehiculo deslizandose de verdad,
  // no "teletransportandose" entre posiciones sueltas.
  const marcadoresRef=useRef<Record<string, L.Marker>>({});
  const estadoIconoRef=useRef<Record<string, string>>({}); // para saber cuando reconstruir el icono (cambio de estado/tipo)
  // Ultimo dato conocido de cada unidad, leido por la popup al abrirse (el
  // marcador es persistente y no se recrea, asi que su closure inicial
  // quedaria desactualizada si no se lee desde aca en vez de capturarla).
  const datosRef=useRef<Record<string, Resource>>({});

  // Reloj de animacion propio del mapa (no el `now` general de la app, que
  // solo marca segundos completos): mueve las unidades cada 300ms para que
  // el recorrido de ida/vuelta se vea avanzar de a poco por su ruta.
  const [tick,setTick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>setTick(x=>x+1),300); return()=>clearInterval(t);},[]);

  // El mapa (tiles, zoom, paneo) se crea una sola vez por cada `center` nuevo
  // (p.ej. cuando resuelve la geolocalizacion). Así, mientras el operador hace
  // zoom o mueve el mapa, los cambios de estado de las unidades no lo reinician.
  useEffect(()=>{
    const map=L.map('map',{zoomControl:false}).setView([center.lat,center.lng],12);
    // OpenStreetMap estandar (gratuito, sin API key) con un filtro CSS
    // oscuro (ver #map en styles.css). Se probo CARTO Dark Matter, pero
    // ahora exige API key -- devuelve HTTP 200 igual, solo que con una
    // imagen de aviso en vez del mapa real, por eso se detecto recien al
    // revisar una captura de pantalla real y no solo el codigo de estado.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
    const layer=L.layerGroup().addTo(map);
    mapRef.current=map;
    layerRef.current=layer;
    marcadoresRef.current={};
    estadoIconoRef.current={};
    // Los popups de Leaflet son HTML plano (no componentes de React), asi
    // que el click del boton "Asignar manualmente" se maneja por
    // delegacion de eventos: cada vez que se abre un popup, se buscan
    // botones con data-asignar-id adentro y se conecta el callback real.
    map.on('popupopen', (e:any)=>{
      const el=e.popup?.getElement?.();
      if(!el) return;
      el.querySelectorAll('[data-asignar-id]').forEach((btn:Element)=>{
        btn.addEventListener('click', ()=>{
          const id=btn.getAttribute('data-asignar-id');
          if(id) onAsignarManualRef.current(id);
          map.closePopup();
        }, {once:true});
      });
    });
    const cleanupResize=fixMapSize(map);
    return()=>{cleanupResize(); map.remove(); mapRef.current=null; layerRef.current=null;};
  },[center]);

  // Capa estatica: emergencias, marcador "asignada" y trazado de ruta.
  // Se redibuja solo cuando cambian los datos, no en cada tick (nada de
  // esto se mueve cuadro a cuadro).
  useEffect(()=>{
    const layer=layerRef.current;
    if(!layer) return;
    layer.clearLayers();
    // Marcador de cuartel: FIJO, uno por compañía (varias unidades pueden
    // compartir el mismo cuartel), nunca se mueve -- independiente del
    // marcador de vehiculo (que si se anima) para que nunca parezca que
    // "el cuartel entero" se desplaza cuando en realidad sale un carro.
    const unidadesPorCompania=new Map<string, Resource[]>();
    resources.forEach(r=>{
      const arr=unidadesPorCompania.get(r.compania) || [];
      arr.push(r);
      unidadesPorCompania.set(r.compania, arr);
    });
    unidadesPorCompania.forEach((unidades, compania)=>{
      const {lat,lng,sector}=unidades[0];
      const letras=unidades.map(u=>RESOURCE_LETRA[u.type]);
      L.marker([lat,lng],{
        icon:L.divIcon({className:'cuartel-marker', html:iconoCuartel(letras), iconSize:[22,22], iconAnchor:[11,11]}),
        zIndexOffset:-100,
      }).addTo(layer).bindTooltip(`${compania} · ${sector}`).bindPopup(()=>popupCuartel(compania, sector, unidades, emergenciesRef.current.length>0, isAdminRef.current));
    });
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
      const enMovimiento=!!r.tramo && (r.radioState==='6-3'||r.radioState==='6-8');
      if(!r.tramo || !enMovimiento) return;
      // La ruta dibujada es la real por calles (r.tramo.puntos, motor OSRM
      // local) cuando ya llego del backend; mientras tanto, una linea recta
      // de respaldo entre origen y destino del tramo actual.
      const trazado:[number,number][]=(r.tramo.puntos && r.tramo.puntos.length>=2)
        ? r.tramo.puntos.map(p=>[p.lat,p.lng])
        : [[r.tramo.origen.lat,r.tramo.origen.lng],[r.tramo.destino.lat,r.tramo.destino.lng]];
      // className "ruta-viva" tiene una animacion CSS de guiones fluyendo,
      // para que se sienta una ruta activa y no una linea estatica.
      L.polyline(trazado,{color:'#29a9ff',weight:4,dashArray:'10 8',className:'ruta-viva'}).addTo(layer);
    });
  },[resources, emergencies]);

  // Unidades: marcadores persistentes, movidos suavemente cada tick (no
  // recreados) -- ver comentario de marcadoresRef mas arriba.
  useEffect(()=>{
    const map=mapRef.current;
    if(!map) return;
    const nowMs=Date.now();
    const idsVistos=new Set<string>();

    resources.forEach(r=>{
      datosRef.current[r.id]=r;
      // El marcador de vehiculo solo existe mientras la unidad esta
      // realmente fuera de su cuartel: en camino, trabajando en el lugar,
      // regresando, O en patrullaje (que mantiene radioState '6-0' a
      // proposito -- sigue "disponible" -- pero SI tiene un tramo activo,
      // por eso no basta con mirar el radioState solo). En 6-0 sin tramo o
      // en 6-9 esta fisicamente en el mismo punto que el marcador fijo del
      // cuartel -- no hace falta un segundo icono ahi encima.
      const enCuartelQuieto=(r.radioState==='6-0' && !r.tramo) || r.radioState==='6-9';
      const fueraDeCuartel=!enCuartelQuieto;
      if(!fueraDeCuartel){
        const existente=marcadoresRef.current[r.id];
        if(existente){existente.remove(); delete marcadoresRef.current[r.id]; delete estadoIconoRef.current[r.id];}
        return;
      }
      idsVistos.add(r.id);
      const pos=posicionActual(r, nowMs);
      const color=RADIO_COLORS[r.radioState];
      const segmento=segmentoActual(r, nowMs);
      const rumbo=segmento ? rumboGrados(segmento.origen.lat,segmento.origen.lng,segmento.destino.lat,segmento.destino.lng) : 0;
      const claveIcono=`${r.radioState}|${r.type}`;

      let m=marcadoresRef.current[r.id];
      if(!m){
        m=L.marker([pos.lat,pos.lng],{
          icon:L.divIcon({className:'resource-marker', html:iconoVehiculo(color, RESOURCE_LETRA[r.type], rumbo), iconSize:[30,30], iconAnchor:[15,15]}),
        }).addTo(map);
        m.bindTooltip(()=>{const d=datosRef.current[r.id]; return `${d.name} · ${RADIO_LABELS[d.radioState]}`;});
        m.bindPopup(()=>popupVehiculo(datosRef.current[r.id], emergenciesRef.current.length>0, isAdminRef.current));
        marcadoresRef.current[r.id]=m;
        estadoIconoRef.current[r.id]=claveIcono;
      }else{
        m.setLatLng([pos.lat,pos.lng]);
        if(estadoIconoRef.current[r.id]!==claveIcono){
          // Solo se reconstruye el icono cuando cambia el estado/tipo (poco
          // frecuente) -- la posicion/rotacion se actualiza aparte, sin
          // recrear el DOM, para que la transicion CSS se vea fluida.
          m.setIcon(L.divIcon({className:'resource-marker', html:iconoVehiculo(color, RESOURCE_LETRA[r.type], rumbo), iconSize:[30,30], iconAnchor:[15,15]}));
          estadoIconoRef.current[r.id]=claveIcono;
        }else{
          const el=m.getElement();
          const giro=el?.querySelector<HTMLElement>('.vehiculo-giro');
          if(giro) giro.style.transform=`rotate(${rumbo}deg)`;
        }
      }
    });

    // Unidades que ya no existen en el array (no deberia pasar en este
    // proyecto, la flota es fija, pero se limpia por robustez).
    Object.keys(marcadoresRef.current).forEach(id=>{
      if(!idsVistos.has(id)){
        marcadoresRef.current[id].remove();
        delete marcadoresRef.current[id];
        delete estadoIconoRef.current[id];
      }
    });
  },[resources, tick]);

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
        <td className="wrap">{e.address}</td>
        <td>{elapsedLabel(e.creadaEn,now)}</td>
        <td>{e.status}</td>
        <td><button className="linkBtn" onClick={()=>onAtender(e.id)}>Atender</button></td>
      </tr>;})}</tbody>
    </table></div>
  </div>;
}

const TODOS='todos' as const;
function RecursosView({resources,alertaTimeoutIds}:{resources:Resource[];alertaTimeoutIds:Set<string>}){
  const [busqueda,setBusqueda]=useState('');
  const [filtroTipo,setFiltroTipo]=useState<typeof TODOS|ResourceType>(TODOS);
  const [filtroEstado,setFiltroEstado]=useState<typeof TODOS|RadioState>(TODOS);
  const texto=busqueda.trim().toLowerCase();
  const filtrados=resources.filter(r=>
    (filtroTipo===TODOS||r.type===filtroTipo) &&
    (filtroEstado===TODOS||r.radioState===filtroEstado) &&
    (!texto || r.name.toLowerCase().includes(texto) || r.compania.toLowerCase().includes(texto) || r.sector.toLowerCase().includes(texto))
  );
  const tipos=Array.from(new Set(resources.map(r=>r.type)));
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Flota de Bomberos</b><span>{filtrados.length} de {resources.length} unidades · Cuerpos de Bomberos de Valparaíso y Viña del Mar</span></div></div>
    <div className="filterRow">
      <input placeholder="Buscar por unidad, compañía o sector…" value={busqueda} onChange={e=>setBusqueda(e.target.value)}/>
      <select value={filtroTipo} onChange={e=>setFiltroTipo(e.target.value as typeof TODOS|ResourceType)}>
        <option value={TODOS}>Todos los tipos</option>
        {tipos.map(t=><option key={t} value={t}>{t}</option>)}
      </select>
      <select value={filtroEstado} onChange={e=>setFiltroEstado(e.target.value as typeof TODOS|RadioState)}>
        <option value={TODOS}>Todos los estados</option>
        {(Object.keys(RADIO_LABELS) as RadioState[]).map(s=><option key={s} value={s}>{RADIO_LABELS[s]}</option>)}
      </select>
    </div>
    <div className="tableWrap"><table className="dataTable">
      <thead><tr><th></th><th>Unidad</th><th>Compañía</th><th>Sector</th><th>Tipo</th><th>Dotación</th><th>Distancia</th><th>ETA</th><th>Estado</th></tr></thead>
      <tbody>{filtrados.length?filtrados.map(r=><tr key={r.id}>
        <td className="resIconCell">{resourceIcon(r.type)}</td>
        <td>{r.name}</td>
        <td>{r.compania}</td>
        <td>{r.sector}</td>
        <td>{r.type}</td>
        <td>{r.crew}</td>
        <td>{r.distance} km</td>
        <td>{r.eta} min</td>
        <td><span className={`estado estado-${r.radioState.replace('6-','')}`}>{r.radioState} · {RADIO_LABELS[r.radioState]}</span>{alertaTimeoutIds.has(r.id)&&<span className="timeoutBadge" title="Sin transmisión de estado dentro del umbral configurado"><AlertTriangle size={11}/> sin transmisión</span>}</td>
      </tr>):<tr><td colSpan={9}><p className="emptyState">Ninguna unidad coincide con el filtro.</p></td></tr>}</tbody>
    </table></div>
  </div>;
}

const TIPOS_HISTORIAL:HistorialTipo[]=['asignacion','rechazo','en_emergencia','liberacion','nueva_emergencia'];
function HistorialView({historial,now}:{historial:HistorialEntry[];now:number}){
  const [filtroTipo,setFiltroTipo]=useState<typeof TODOS|HistorialTipo>(TODOS);
  const filtrado=filtroTipo===TODOS?historial:historial.filter(h=>h.tipo===filtroTipo);
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Historial de acciones</b><span>{filtrado.length} de {historial.length} eventos registrados esta sesión</span></div></div>
    <div className="filterRow">
      <select value={filtroTipo} onChange={e=>setFiltroTipo(e.target.value as typeof TODOS|HistorialTipo)}>
        <option value={TODOS}>Todos los eventos</option>
        {TIPOS_HISTORIAL.map(t=><option key={t} value={t}>{historialTitle(t)}</option>)}
      </select>
    </div>
    <div className="activityRows">{filtrado.length?filtrado.map(h=><Activity key={h.id} icon={historialIcon(h.tipo)} title={historialTitle(h.tipo)} detail={h.texto} time={timeAgo(h.ts,now)}/>):<p className="emptyState">{historial.length?'Ningún evento coincide con el filtro.':'Aún no hay acciones registradas. Asigna o rechaza una recomendación desde el Dashboard para empezar a construir el historial.'}</p>}</div>
  </div>;
}

// Login sin registro publico: solo los operadores fijos que existen en el
// backend (core/auth.py) pueden entrar. Mismo estandar visual "Tech
// Corporativo Nocturno" del resto de la app (misma marca, mismos colores),
// sin elementos de mas -- correo, contraseña, listo.
function LoginView({onLogin,theme,onToggleTheme}:{onLogin:(token:string, nombre:string, email:string, rol:'admin'|'visualizador')=>void; theme:'dark'|'light'; onToggleTheme:()=>void}){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const [cargando,setCargando]=useState(false);

  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();
    if(cargando) return;
    setError('');
    setCargando(true);
    try{
      const resp=await fetch(`${API_BASE}/auth/login`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body:JSON.stringify({email,password}),
      });
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok){
        setError(data.detail || 'Correo o contraseña incorrectos.');
        return;
      }
      onLogin(data.token, data.nombre, data.email, data.rol==='admin'?'admin':'visualizador');
    }catch{
      setError(`No se pudo conectar con el servidor (${API_BASE}). ¿Está corriendo el backend?`);
    }finally{
      setCargando(false);
    }
  };

  return <div className="loginPage">
    <div className="loginCard">
      <button className="themeToggleLogin" onClick={onToggleTheme} title={theme==='dark'?'Cambiar a tema claro':'Cambiar a tema oscuro'}>{theme==='dark'?<Sun size={18}/>:<Moon size={18}/>}</button>
      <div className="brand"><div className="brandIcon"><Zap size={20}/></div><div><b>ALERTA360</b><span>BOMBEROS · VALPARAÍSO</span></div></div>
      <p className="loginSubtitle">Acceso de operadores</p>
      <form onSubmit={submit}>
        <label className="loginLabel"><Mail size={13}/> Correo</label>
        <input className="loginInput" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="nombre@bomberos.cl" autoComplete="username" required autoFocus/>
        <label className="loginLabel"><Lock size={13}/> Contraseña</label>
        <input className="loginInput" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required/>
        {error && <p className="loginError">{error}</p>}
        <button className="loginSubmit" type="submit" disabled={cargando}>{cargando?'Ingresando…':'Ingresar'}</button>
      </form>
      <p className="loginFooter">Acceso restringido a operadores autorizados del Cuerpo de Bomberos. Sin registro público.</p>
    </div>
  </div>;
}

function ReportesView({historial}:{historial:HistorialEntry[]}){
  const asignaciones=historial.filter(h=>h.tipo==='asignacion').length;
  const rechazos=historial.filter(h=>h.tipo==='rechazo').length;
  const liberaciones=historial.filter(h=>h.tipo==='liberacion').length;
  return <div className="sectionGrid">
    <div className="kpis">
      <Kpi icon={<Navigation/>} label="Asignaciones realizadas" value={String(asignaciones)} meta="esta sesión" tone="acento"/>
      <Kpi icon={<XCircle/>} label="Recomendaciones rechazadas" value={String(rechazos)} meta="esta sesión" tone="azul"/>
      <Kpi icon={<Truck/>} label="Unidades liberadas" value={String(liberaciones)} meta="regresaron a cuartel" tone="acento"/>
    </div>
    <div className="card sectionCard"><div className="cardHead"><div><b>Nota</b></div></div><p className="emptyState">Estos indicadores se calculan en vivo a partir de las acciones tomadas en esta sesión (asignar/rechazar recomendaciones). Al recargar la página el historial se reinicia, ya que aún no hay persistencia en base de datos.</p></div>
  </div>;
}

function ConfiguracionView({soundOn,onToggleSound,autoRefreshSec,onChangeAutoRefresh,onNotify,auth,onLogout,isAdmin,timeoutMinutos,onChangeTimeout}:{soundOn:boolean;onToggleSound:(v:boolean)=>void;autoRefreshSec:number;onChangeAutoRefresh:(v:number)=>void;onNotify:(s:string)=>void;auth:{nombre:string;email:string;rol:'admin'|'visualizador'};onLogout:()=>void;isAdmin:boolean;timeoutMinutos:number;onChangeTimeout:(v:number)=>void}){
  return <div className="sectionGrid">
    <div className="card sectionCard">
      <div className="cardHead"><div><b>Cuenta</b><span>Sesión iniciada</span></div></div>
      <div className="configBody">
        <label className="configRow">Nombre<input value={auth.nombre} disabled/></label>
        <label className="configRow">Correo<input value={auth.email} disabled/></label>
        <label className="configRow">Rol<input value={isAdmin?'Administrador / Despachador':'Visualizador (solo lectura)'} disabled/></label>
        <div className="configNote">Nombre, correo y rol vienen de la cuenta real verificada por el backend (login con JWT) — no son editables, ni hay registro público: solo los operadores autorizados del equipo pueden entrar.</div>
        <button className="locateBtn logoutBtn" onClick={onLogout}><LogOut size={14}/> Cerrar sesión</button>
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
    <div className="card sectionCard">
      <div className="cardHead"><div><b>Administración</b><span>Parámetros operacionales{!isAdmin?' · solo lectura':''}</span></div></div>
      <div className="configBody">
        <label className="configRow">Alertar si una unidad despachada no transmite estado en
          <select value={timeoutMinutos} disabled={!isAdmin} onChange={e=>{onChangeTimeout(Number(e.target.value)); onNotify(`Umbral de timeout actualizado a ${e.target.value} min`);}}>
            <option value={1}>1 minuto</option>
            <option value={2}>2 minutos</option>
            <option value={5}>5 minutos (por defecto)</option>
            <option value={10}>10 minutos</option>
            <option value={15}>15 minutos</option>
          </select>
        </label>
        <div className="configNote">{isAdmin?'Se evalúa sobre unidades en camino, en el lugar o regresando (6-3/6-7/6-8). Al superar este umbral sin un cambio real de estado, se muestra una alerta en Recursos y una notificación emergente.':'Solo el rol Administrador / Despachador puede modificar este parámetro.'}</div>
      </div>
    </div>
  </div>;
}

function App(){
 // La sesion vive SOLO en memoria (no en localStorage a proposito): cada
 // vez que se recarga la pagina o se reinicia el servidor de desarrollo,
 // se pide login de nuevo. De paso, esto elimina la validacion asincrona
 // de un token guardado al montar la app -- que era la causa de una
 // carrera con el patrullaje (401 sueltos en /route justo al reiniciar).
 const [auth,setAuth]=useState<{token:string; nombre:string; email:string; rol:'admin'|'visualizador'}|null>(null);

 // currentToken (variable de modulo) es lo que leen las funciones sueltas
 // fuera de React (obtenerRutaReal) para mandar el header Authorization.
 useEffect(()=>{ currentToken=auth?.token ?? null; },[auth]);

 const handleLogin=(token:string, nombre:string, email:string, rol:'admin'|'visualizador')=>{
   setAuth({token,nombre,email,rol});
 };
 const handleLogout=()=>{
   setAuth(null);
 };
 // RBAC: "admin" (coordinacion/despacho, puede asignar/rechazar y editar
 // configuracion administrativa) vs "visualizador" (solo lectura -- puede
 // ver mapas/tableros y usar el filtro de cuartel, pero no despachar). El
 // backend vuelve a exigir esto por su cuenta en /assignment/recommend
 // (ver requiere_admin en main.py); esto de aca es solo para la UI.
 const isAdmin=auth?.rol==='admin';

 const [section,setSection]=useState('Dashboard');
 const [toast,setToast]=useState('');
 const [refresh,setRefresh]=useState(0);
 const [operationalCenter,setOperationalCenter]=useState(VALPARAISO_CENTER);
 const [periodos,setPeriodos]=useState<Periodo[]>([]);
 const [claves,setClaves]=useState<Record<string,Clave>>({});
 const [apiError,setApiError]=useState<string|null>(null);
 // Info de "estado en vivo" para el rol visualizador: quien lo esta
 // publicando (el admin al mando del despacho) y si ya llego algun dato
 // real o todavia esta esperando la primera publicacion.
 const [estadoRemoto,setEstadoRemoto]=useState<{publicadoPor:string; publicadoEn:string}|null>(null);
 const [esperandoEstadoRemoto,setEsperandoEstadoRemoto]=useState(false);
 const [importanciaVariables,setImportanciaVariables]=useState<VariableImportancia[]>([]);
 const [resources,setResources]=useState<Resource[]>(RESOURCES_INICIALES);
 const [queue,setQueue]=useState<Emergency[]>(()=>POOL_EMERGENCIAS.slice(0,4).map((e,i)=>({...e,id:1258+i,status:'Activa',creadaEn:Date.now()})));
 const [rechazadosPorEmergencia,setRechazadosPorEmergencia]=useState<Record<number,Set<string>>>({});
 const [historial,setHistorial]=useState<HistorialEntry[]>([]);
 // ETA real e idoneidad de tipo de cada asignacion hecha esta sesion —
 // base para "Tiempo promedio" y "Cobertura estimada" del dashboard,
 // calculados de verdad en vez de numeros fijos.
 const [metricasAsignacion,setMetricasAsignacion]=useState<{etaMin:number; idoneidadTipo:number; compania:string}[]>([]);
 const [focus,setFocus]=useState<{lat:number;lng:number}|null>(null);
 const [now,setNow]=useState(Date.now());
 const [soundOn,setSoundOn]=useState(false);
 const [autoRefreshSec,setAutoRefreshSec]=useState(0);
 const [zonaSeleccionada,setZonaSeleccionada]=useState<string|null>(null);
 const [mobileNavOpen,setMobileNavOpen]=useState(false);
 // Nombre/correo ya no viven aca -- son los de la cuenta real (auth), no
 // editables. Lo unico que es una preferencia local de verdad es el
 // telefono de contacto.
 // Filtro global por cuartel/compañía, solo para el Dashboard: no toca el
 // estado de Mapa/Recursos/Emergencias (paneles independientes). 'todos'
 // = sin filtro.
 const [filtroCuartel,setFiltroCuartel]=useState<string>('todos');

 // Menu lateral colapsable (mas espacio para mapas/paneles). Preferencia de
 // UI pura, sin dato sensible -- se guarda en localStorage para que no
 // "salte" cada vez que se recarga la pagina.
 const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>{
   try{ return localStorage.getItem('alerta360-sidebar-collapsed')==='1'; }catch{ return false; }
 });
 useEffect(()=>{ try{ localStorage.setItem('alerta360-sidebar-collapsed', sidebarCollapsed?'1':'0'); }catch{} },[sidebarCollapsed]);

 // Tema claro/oscuro. Igual que el colapso del menu, es una preferencia de
 // interfaz (no un dato de sesion), asi que persiste en localStorage sin
 // problema aunque la sesion de login sea solo en memoria.
 const [theme,setTheme]=useState<'dark'|'light'>(()=>{
   try{ return (localStorage.getItem('alerta360-theme') as 'dark'|'light')||'dark'; }catch{ return 'dark'; }
 });
 useEffect(()=>{ try{ localStorage.setItem('alerta360-theme', theme); }catch{} },[theme]);
 // El tema se aplica en <html> (no solo en .app) para que tambien alcance
 // a LoginView, que se renderiza ANTES de iniciar sesion y por lo tanto
 // fuera del div .app -- si no, el login se quedaba siempre oscuro sin
 // importar la preferencia guardada.
 useEffect(()=>{ document.documentElement.setAttribute('data-theme', theme); },[theme]);

 // Umbral de timeout operacional (minutos sin transmision de estado antes
 // de alertar sobre una unidad despachada) -- parametrizable desde
 // Configuracion, solo por el rol admin (ver ConfiguracionView).
 const [timeoutMinutos,setTimeoutMinutos]=useState(5);

 const emergenciaIdRef=useRef(1258+4);
 const poolIndexRef=useRef(4%POOL_EMERGENCIAS.length);
 const historialIdRef=useRef(1);
 const timeoutsRef=useRef<number[]>([]);
 // Temporizadores pendientes POR unidad (llegada, fin de trabajo, llegada a
 // cuartel). Se necesitan por separado del listado global de arriba porque,
 // si una unidad que va de regreso (6-8) es redirigida a otra emergencia,
 // hay que cancelar su temporizador de "llegada a cuartel" pendiente antes
 // de programar el nuevo ciclo — si no, ese temporizador viejo terminaria
 // pisando el nuevo estado (la dejaria en 6-0 aunque ya vaya a otro lado).
 const resourceTimersRef=useRef<Record<string, number[]>>({});
 // Unidades "sueltas" circulando en patrullaje ahora mismo (ver
 // intentarPatrullaje), para no exceder MAX_EN_PATRULLAJE ni elegir dos
 // veces a la misma unidad.
 const enPatrullajeRef=useRef<Set<string>>(new Set());
 // Espejo de `resources` para leer el valor mas reciente desde el
 // setInterval de patrullaje sin recrearlo en cada cambio de estado (mismo
 // patron que soundOnRef mas abajo).
 const resourcesRef=useRef(resources);
 const soundOnRef=useRef(soundOn);
 // Espejos del resto del estado simulado, para publicarlo tal cual esta
 // en este instante desde el setInterval de "publicar estado" (ver mas
 // abajo) sin tener que recrear ese interval cada vez que algo cambia.
 const queueRef=useRef(queue);
 const historialRef=useRef(historial);
 const metricasAsignacionRef=useRef(metricasAsignacion);
 const rechazadosPorEmergenciaRef=useRef(rechazadosPorEmergencia);

 useEffect(()=>{soundOnRef.current=soundOn;},[soundOn]);
 useEffect(()=>{resourcesRef.current=resources;},[resources]);
 useEffect(()=>{queueRef.current=queue;},[queue]);
 useEffect(()=>{historialRef.current=historial;},[historial]);
 useEffect(()=>{metricasAsignacionRef.current=metricasAsignacion;},[metricasAsignacion]);
 useEffect(()=>{rechazadosPorEmergenciaRef.current=rechazadosPorEmergencia;},[rechazadosPorEmergencia]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000); return()=>clearInterval(t);},[]);
 useEffect(()=>()=>{timeoutsRef.current.forEach(id=>clearTimeout(id));},[]);

 const clearResourceTimers=(resourceId:string)=>{
   (resourceTimersRef.current[resourceId]||[]).forEach(id=>window.clearTimeout(id));
   resourceTimersRef.current[resourceId]=[];
 };
 const registerResourceTimer=(resourceId:string, id:number)=>{
   resourceTimersRef.current[resourceId]=[...(resourceTimersRef.current[resourceId]||[]), id];
   timeoutsRef.current.push(id);
 };

 // Envia una unidad disponible (6-0), elegida al azar entre las que no
 // estan ya en misión ni en patrullaje, a circular hacia un punto real de
 // la ciudad y de vuelta — usa el mismo mecanismo de tramo/posicionActual
 // que un despacho real, asi que si le toca ser recomendada a mitad de
 // camino, se la redirige correctamente desde donde este en ese momento
 // (ver esDisponible/pickRecommendation, que ya aceptan unidades en ruta).
 // Pide la ruta real por calles para el tramo que acaba de empezar, y la
 // aplica SOLO si esa unidad sigue en el mismo tramo cuando la respuesta
 // llega (compara `inicio`) — si mientras tanto fue redirigida a otro
 // lado, el tramo viejo ya no existe y no corresponde pisarlo.
 const aplicarRutaCuandoLlegue=(resourceId:string, inicio:number, origen:{lat:number;lng:number}, destino:{lat:number;lng:number})=>{
   obtenerRutaReal(origen, destino).then(ruta=>{
     if(!ruta) return;
     setResources(rs=>rs.map(x=>x.id===resourceId && x.tramo && x.tramo.inicio===inicio
       ? {...x, tramo:{...x.tramo, puntos:ruta.puntos, acumKm:ruta.acumKm}}
       : x));
   });
 };

 const intentarPatrullaje=()=>{
   if(enPatrullajeRef.current.size>=MAX_EN_PATRULLAJE) return;
   const libres=resourcesRef.current.filter(r=>r.radioState==='6-0' && !r.tramo && !enPatrullajeRef.current.has(r.id));
   if(!libres.length) return;
   const elegido=libres[Math.floor(Math.random()*libres.length)];
   const punto=elegirPuntoPatrullaje();
   const resourceId=elegido.id;
   const home={lat:elegido.lat, lng:elegido.lng};
   const destinoPatrullaje={lat:punto.lat, lng:punto.lng};
   const distanciaKm=haversineKm(home.lat,home.lng,punto.lat,punto.lng);
   // Recorrido lento a proposito (no es la velocidad real): se ve circular
   // de a poco por el mapa, no llegar de un salto.
   const duracionMs=Math.round(Math.max(20000, Math.min(etaMinutos(distanciaKm,'urbano')*3200, 70000)));

   enPatrullajeRef.current.add(resourceId);
   clearResourceTimers(resourceId);
   const inicioIda=Date.now();
   setResources(rs=>rs.map(x=>x.id===resourceId?{...x,tramo:{origen:home, destino:destinoPatrullaje, inicio:inicioIda, duracionMs}}:x));
   aplicarRutaCuandoLlegue(resourceId, inicioIda, home, destinoPatrullaje);

   const tLlegada=window.setTimeout(()=>{
     const dwellMs=6000+Math.random()*8000;
     const tRegreso=window.setTimeout(()=>{
       // Si mientras tanto fue despachada a una emergencia real, ya no esta
       // en 6-0 y no le corresponde este regreso de patrullaje.
       const inicioVuelta=Date.now();
       setResources(rs=>rs.map(x=>x.id===resourceId && x.radioState==='6-0'
         ?{...x,tramo:{origen:destinoPatrullaje, destino:home, inicio:inicioVuelta, duracionMs}}
         :x));
       aplicarRutaCuandoLlegue(resourceId, inicioVuelta, destinoPatrullaje, home);
       const tFin=window.setTimeout(()=>{
         setResources(rs=>rs.map(x=>x.id===resourceId && x.radioState==='6-0'?{...x,tramo:undefined}:x));
         enPatrullajeRef.current.delete(resourceId);
       }, duracionMs);
       registerResourceTimer(resourceId, tFin);
     }, dwellMs);
     registerResourceTimer(resourceId, tRegreso);
   }, duracionMs);
   registerResourceTimer(resourceId, tLlegada);
 };

 useEffect(()=>{
   // No arranca el patrullaje (ni sus llamadas a /route) hasta que haya
   // sesion iniciada -- antes del login no deberia haber ninguna unidad
   // "trabajando" de fondo. Tampoco corre para el rol visualizador: ese
   // rol no simula nada por su cuenta, solo observa el estado que publica
   // el admin (ver efecto de publicar/consultar /state mas abajo) -- si
   // ambos simularan de forma independiente, cada uno terminaria viendo
   // datos distintos en vez de "lo mismo en vivo".
   if(!auth || !isAdmin) return;
   const t=setInterval(intentarPatrullaje, 6000);
   return()=>clearInterval(t);
 },[auth, isAdmin]);

 // Publicar estado (solo admin): cada 2s manda al backend una foto del
 // despacho tal como esta en este instante en su navegador, para que las
 // cuentas visualizador vean lo mismo en vivo (ver /state en main.py).
 // Los Set no son serializables a JSON directo, por eso rechazados se
 // manda como arreglo de ids.
 useEffect(()=>{
   if(!auth || !isAdmin) return;
   const publicar=()=>{
     const rechazadosPlano=Object.fromEntries(
       Object.entries(rechazadosPorEmergenciaRef.current).map(([id,set])=>[id, Array.from(set)])
     );
     fetch(`${API_BASE}/state`,{
       method:'POST', credentials:'include',
       headers:{'Content-Type':'application/json', ...authHeaders()},
       body:JSON.stringify({
         resources:resourcesRef.current, queue:queueRef.current,
         historial:historialRef.current.slice(0,50),
         metricasAsignacion:metricasAsignacionRef.current,
         rechazadosPorEmergencia:rechazadosPlano,
       }),
     }).catch(()=>{}); // si falla un envio puntual, se reintenta solo en el siguiente tick
   };
   publicar();
   const t=setInterval(publicar, 2000);
   return()=>clearInterval(t);
 },[auth, isAdmin]);

 // Consultar estado (solo visualizador): en vez de simular nada por su
 // cuenta, cada 2s trae lo ultimo que publico el admin y lo usa
 // directamente como su propio estado -- por eso el patrullaje y el resto
 // de la simulacion quedan apagados para este rol (ver efecto anterior).
 useEffect(()=>{
   if(!auth || isAdmin) return;
   let cancelado=false;
   const consultar=()=>{
     fetch(`${API_BASE}/state`,{credentials:'include', headers:authHeaders()})
       .then(r=>r.ok?r.json():null)
       .then(data=>{
         if(cancelado || !data) return;
         if(!data.publicado){ setEsperandoEstadoRemoto(true); setEstadoRemoto(null); return; }
         setEsperandoEstadoRemoto(false);
         setEstadoRemoto({publicadoPor:data.publicadoPor, publicadoEn:data.publicadoEn});
         if(Array.isArray(data.resources)) setResources(data.resources);
         if(Array.isArray(data.queue)) setQueue(data.queue);
         if(Array.isArray(data.historial)) setHistorial(data.historial);
         if(Array.isArray(data.metricasAsignacion)) setMetricasAsignacion(data.metricasAsignacion);
         if(data.rechazadosPorEmergencia){
           const reconstruido:Record<number,Set<string>>={};
           Object.entries(data.rechazadosPorEmergencia).forEach(([id,arr])=>{reconstruido[Number(id)]=new Set(arr as string[]);});
           setRechazadosPorEmergencia(reconstruido);
         }
       }).catch(()=>{});
   };
   consultar();
   const t=setInterval(consultar, 2000);
   return()=>{cancelado=true; clearInterval(t);};
 },[auth, isAdmin]);

 // Filtro global por cuartel (solo Dashboard): lista de companias reales
 // disponibles y el subconjunto de recursos de la compañia elegida. Con
 // 'todos' no se filtra nada -- se usa el listado completo de siempre.
 const companiasDisponibles=useMemo(()=>Array.from(new Set(resources.map(r=>r.compania))).sort(),[resources]);
 const resourcesFiltrados=useMemo(
   ()=>filtroCuartel==='todos'?resources:resources.filter(r=>r.compania===filtroCuartel),
   [resources, filtroCuartel]
 );

 const currentEmergencia=queue[0]??null;
 const claveActual=currentEmergencia?claves[currentEmergencia.codigo]:undefined;
 // La recomendacion se calcula SOLO sobre las unidades del cuartel elegido
 // en el filtro (si hay uno activo) -- asi "RECURSO RECOMENDADO" refleja
 // que unidad de ESA compañia respondería, no la mejor de toda la flota.
 const recommendation=useMemo(
   ()=>pickRecommendation(resourcesFiltrados,currentEmergencia,rechazadosPorEmergencia[currentEmergencia?.id??-1]||new Set(), claveActual, now),
   [resourcesFiltrados,currentEmergencia,rechazadosPorEmergencia,claveActual,now]
 );
 // Distancia/ETA reales para la recomendacion actual: se recalculan segun
 // la posicion vigente de la unidad (cuartel, o su posicion actual si va
 // de regreso de otra emergencia) y la ubicacion real de esta emergencia.
 const recomendacionInfo=useMemo(
   ()=>(recommendation && currentEmergencia)?distanciaYEtaHacia(recommendation, currentEmergencia, claveActual, now):null,
   [recommendation, currentEmergencia, claveActual, now]
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

 // El tramo de vuelta (6-8) usa la misma duracion que la ida: mismo
 // trayecto recorrido en sentido inverso, misma velocidad estimada.
 const scheduleResourceLifecycle=(resourceId:string, emergenciaSnap:Emergency, home:{lat:number;lng:number}, duracionTramoMs:number)=>{
   // Cancela cualquier temporizador pendiente de un ciclo anterior de esta
   // MISMA unidad (p.ej. si iba de regreso y fue redirigida a esta nueva
   // emergencia antes de llegar a su cuartel, o si estaba en patrullaje).
   clearResourceTimers(resourceId);
   enPatrullajeRef.current.delete(resourceId);
   const tiempoTrabajo=TIEMPO_TRABAJO_MS[emergenciaSnap.codigo]??18000;
   const t1=window.setTimeout(()=>{
     setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-7',ultimaActualizacion:Date.now()}:r));
     pushHistorial('en_emergencia',`${resourceId} llegó a la Emergencia #${emergenciaSnap.id} (${emergenciaSnap.address})`);
     const t2=window.setTimeout(()=>{
       const origenVuelta={lat:emergenciaSnap.lat,lng:emergenciaSnap.lng};
       const inicioVuelta=Date.now();
       setResources(rs=>rs.map(r=>r.id===resourceId?{
         ...r,radioState:'6-8',
         tramo:{origen:origenVuelta, destino:home, inicio:inicioVuelta, duracionMs:duracionTramoMs},
         ultimaActualizacion:Date.now(),
       }:r));
       aplicarRutaCuandoLlegue(resourceId, inicioVuelta, origenVuelta, home);
       pushHistorial('liberacion',`${resourceId} finalizó la atención de la Emergencia #${emergenciaSnap.id}, regresando a cuartel`);
       const t3=window.setTimeout(()=>{
         setResources(rs=>rs.map(r=>r.id===resourceId?{...r,radioState:'6-0',destino:undefined,tramo:undefined,ultimaActualizacion:Date.now()}:r));
         pushHistorial('liberacion',`${resourceId} disponible nuevamente en cuartel`);
       }, duracionTramoMs);
       registerResourceTimer(resourceId, t3);
     }, tiempoTrabajo);
     registerResourceTimer(resourceId, t2);
   }, duracionTramoMs);
   registerResourceTimer(resourceId, t1);
 };

 // Nucleo compartido del despacho real: lo usan tanto la asignacion
 // automatica (el boton ASIGNAR sobre la recomendacion) como la asignacion
 // MANUAL (elegida por el operador desde el mapa) -- misma logica real de
 // movimiento/ruta/registro en ambos casos, solo cambia quien eligio la
 // unidad.
 const despacharUnidad=(unidad:Resource, emergenciaSnap:Emergency, manual:boolean)=>{
   const resourceId=unidad.id;
   const nombreClave=claves[emergenciaSnap.codigo]?.nombre??emergenciaSnap.codigo;
   const fueRedirigida=unidad.radioState==='6-8';
   // Origen del viaje: si la unidad va de regreso de otra emergencia, se usa
   // su posicion actual en la ruta (no su cuartel) — se la redirige desde
   // donde esta en este instante.
   const origen=posicionActual(unidad, now);
   const destinoEmergencia={lat:emergenciaSnap.lat,lng:emergenciaSnap.lng};
   const info=distanciaYEtaHacia(unidad, destinoEmergencia, claveActual, now);
   // Duracion del recorrido animado: proporcional al ETA real, pero mas
   // lenta que "tiempo real x1" para que se vea circular de verdad por el
   // mapa (con el reloj de 300ms de MapPanel) en vez de saltar de golpe.
   const duracionMs=Math.max(25000, Math.min(info.etaMin*3200, 90000));
   const inicioIda=Date.now();
   setResources(rs=>rs.map(r=>r.id===resourceId?{
     ...r,
     radioState:'6-3',
     destino:{emergenciaId:emergenciaSnap.id,lat:emergenciaSnap.lat,lng:emergenciaSnap.lng,address:emergenciaSnap.address},
     tramo:{origen, destino:destinoEmergencia, inicio:inicioIda, duracionMs},
     ultimaActualizacion:Date.now(),
   }:r));
   aplicarRutaCuandoLlegue(resourceId, inicioIda, origen, destinoEmergencia);
   // Se guarda el ETA real, la idoneidad de tipo y la compañía de ESTA
   // asignacion puntual (mismo desglose que ya usa el puntaje/justificacion)
   // para calcular "Tiempo promedio" y "Cobertura estimada" del dashboard
   // con datos reales de la sesion (y poder filtrarlos por cuartel).
   setMetricasAsignacion(m=>[...m, {
     etaMin: info.etaMin,
     idoneidadTipo: scoreDetalle(unidad, claveActual, info.distanciaKm, info.etaMin).idoneidadTipo,
     compania: unidad.compania,
   }]);
   pushHistorial('asignacion',`${unidad.name} asignada${manual?' MANUALMENTE por el operador':''} a Emergencia #${emergenciaSnap.id} · Clave ${emergenciaSnap.codigo} (${nombreClave}) — score ${Math.round(score(unidad,claveActual,info.distanciaKm,info.etaMin))}/100${fueRedirigida?' (redirigida mientras regresaba a cuartel)':''}`);
   notify(`${unidad.name} asignada${manual?' manualmente':''} a la Emergencia #${emergenciaSnap.id}${fueRedirigida?' (redirigida en ruta)':''}`);
   setFocus({lat:emergenciaSnap.lat,lng:emergenciaSnap.lng});
   scheduleResourceLifecycle(resourceId, emergenciaSnap, {lat:unidad.lat,lng:unidad.lng}, duracionMs);
   advanceQueue(emergenciaSnap.id);
 };

 const handleAsignar=()=>{
   if(!isAdmin){ notify('Tu cuenta es de solo lectura: no puede asignar unidades.'); return; }
   if(!currentEmergencia || !recommendation || !recomendacionInfo) return;
   despacharUnidad(recommendation, currentEmergencia, false);
 };

 // Asignacion manual: el operador elige una unidad especifica desde el
 // mapa (boton en el popup de un vehiculo o de un cuartel), en vez de
 // aceptar la recomendacion automatica. Solo se exige que la unidad este
 // realmente disponible (no se puede "asignar" algo que ya va en camino a
 // otra emergencia) -- a diferencia del algoritmo automatico, aqui no se
 // filtra por "compania ocupada" ni por rechazos previos, porque es una
 // decision deliberada del operador, no un ciclo de recomendacion.
 const handleAsignarManual=(resourceId:string)=>{
   if(!isAdmin){ notify('Tu cuenta es de solo lectura: no puede asignar unidades.'); return; }
   if(!currentEmergencia) return;
   const unidad=resources.find(r=>r.id===resourceId);
   if(!unidad || !esDisponible(unidad)){
     notify('Esa unidad ya no está disponible para asignar.');
     return;
   }
   despacharUnidad(unidad, currentEmergencia, true);
 };

 const handleRechazar=()=>{
   if(!isAdmin){ notify('Tu cuenta es de solo lectura: no puede rechazar recomendaciones.'); return; }
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
   if(!auth) return;
   fetch(`${API_BASE}/prediction/demand?horizon=4`, {credentials:'include', headers:authHeaders()})
     .then(r=>{if(!r.ok)throw new Error(`API respondió ${r.status}`); return r.json();})
     .then(d=>{setPeriodos(d.periodos||[]); setImportanciaVariables(Object.values(d.importancia_variables||{})); setApiError(null);})
     .catch(err=>{setPeriodos([]); setApiError(`No se pudo conectar a ${API_BASE}: ${err.message||err}`);});
 },[refresh, auth]);

 useEffect(()=>{
   if(!auth) return;
   fetch(`${API_BASE}/catalog/claves`, {credentials:'include', headers:authHeaders()})
     .then(r=>{if(!r.ok)throw new Error(`API respondió ${r.status}`); return r.json();})
     .then(d=>{
       const porCodigo:Record<string,Clave>={};
       (d.claves||[]).forEach((c:Clave)=>{porCodigo[c.codigo]=c;});
       setClaves(porCodigo);
     })
     .catch(err=>{setClaves({}); setApiError(`No se pudo conectar a ${API_BASE}: ${err.message||err}`);});
 },[auth]);

 useEffect(()=>{
   if(!autoRefreshSec) return;
   const t=setInterval(()=>setRefresh(x=>x+1), autoRefreshSec*1000);
   return()=>clearInterval(t);
 },[autoRefreshSec]);

 const periodoActual=periodos[0];
 const currentZonas=periodoActual?.zonas||[];
 const alerts=useMemo(()=>buildAlerts(periodos, claves),[periodos, claves]);
 const disponibles=resourcesFiltrados.filter(esDisponible).length;
 // Metricas de asignacion (para "Tiempo promedio"/"Cobertura estimada"),
 // acotadas al cuartel filtrado cuando corresponde.
 const metricasFiltradas=filtroCuartel==='todos'?metricasAsignacion:metricasAsignacion.filter(m=>m.compania===filtroCuartel);
 // Emergencias "de este cuartel": aquellas cuya unidad asignada pertenece a
 // la compañia filtrada (una emergencia sin unidad asignada aun no es "de"
 // ningun cuartel en particular).
 const queueFiltrada=useMemo(()=>{
   if(filtroCuartel==='todos') return queue;
   const companiaPorEmergencia=new Map<number,string>();
   resources.forEach(r=>{ if(r.destino) companiaPorEmergencia.set(r.destino.emergenciaId, r.compania); });
   return queue.filter(e=>companiaPorEmergencia.get(e.id)===filtroCuartel);
 },[queue, resources, filtroCuartel]);
 // Emergencias mostradas en el mapa del Dashboard cuando hay un cuartel
 // filtrado: las asignadas a ese cuartel, mas la emergencia actual (la que
 // esta en el tope de la cola y necesita despacho) para que siempre se vea
 // que es lo proximo a atender, sea cual sea el cuartel elegido.
 const emergenciasMapaDashboard=useMemo(()=>{
   if(filtroCuartel==='todos') return queue;
   const porId=new Map<number,Emergency>(queueFiltrada.map(e=>[e.id,e]));
   if(currentEmergencia) porId.set(currentEmergencia.id, currentEmergencia);
   return Array.from(porId.values());
 },[queue, queueFiltrada, currentEmergencia, filtroCuartel]);
 // "Tiempo promedio": promedio real del ETA calculado en cada asignacion
 // hecha esta sesion (metricasAsignacion), no un numero fijo. Sin
 // asignaciones aun, se muestra "—" en vez de inventar un valor.
 const tiempoPromedioLabel=metricasFiltradas.length?(()=>{
   const avg=metricasFiltradas.reduce((s,m)=>s+m.etaMin,0)/metricasFiltradas.length;
   const mm=Math.floor(avg), ss=Math.round((avg-mm)*60);
   return `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
 })():'—';
 const tiempoPromedioMeta=metricasFiltradas.length?`promedio de ${metricasFiltradas.length} asignación${metricasFiltradas.length===1?'':'es'} · esta sesión`:'sin asignaciones aún';
 // "Cobertura estimada": % de asignaciones con idoneidad de tipo >= 0.5 —
 // misma definicion exacta que "cobertura_tipo_adecuado_pct" del benchmark
 // (backend/evaluacion/benchmark_asignacion.py), no un numero aparte.
 const coberturaPct=metricasFiltradas.length?Math.round(metricasFiltradas.filter(m=>m.idoneidadTipo>=0.5).length/metricasFiltradas.length*100):null;
 const coberturaLabel=coberturaPct===null?'—':`${coberturaPct}%`;
 const coberturaMeta=coberturaPct===null?'sin asignaciones aún':'con tipo de unidad adecuado';
 // Timeout operacional: unidades despachadas (6-3/6-7/6-8) que llevan mas
 // del umbral configurado sin transmitir un cambio real de estado. `now`
 // ya se actualiza cada segundo (ver arriba), asi que esto se re-evalua solo.
 const unidadesConAlertaTimeout=useMemo(()=>{
   const umbralMs=timeoutMinutos*60000;
   return new Set(
     resources
       .filter(r=>(r.radioState==='6-3'||r.radioState==='6-7'||r.radioState==='6-8') && r.ultimaActualizacion && (now-r.ultimaActualizacion)>umbralMs)
       .map(r=>r.id)
   );
 },[resources, now, timeoutMinutos]);
 const timeoutNotificadosRef=useRef<Set<string>>(new Set());
 useEffect(()=>{
   unidadesConAlertaTimeout.forEach(id=>{
     if(!timeoutNotificadosRef.current.has(id)){
       timeoutNotificadosRef.current.add(id);
       const u=resources.find(r=>r.id===id);
       notify(`⚠ ${u?.name??id} no transmite su estado hace más de ${timeoutMinutos} min — verificar unidad`);
     }
   });
   // Limpia el registro de las que ya se recuperaron, para poder volver a
   // avisar si vuelven a quedar sin transmitir mas adelante.
   Array.from(timeoutNotificadosRef.current).forEach(id=>{ if(!unidadesConAlertaTimeout.has(id)) timeoutNotificadosRef.current.delete(id); });
   // eslint-disable-next-line react-hooks/exhaustive-deps
 },[unidadesConAlertaTimeout]);
 const resumenHeatmap=useMemo(()=>resumenGeneral(periodoActual, currentZonas, claves),[periodoActual, currentZonas, claves]);
 const zonaDetalle=zonaSeleccionada?currentZonas.find(z=>z.zona_id===zonaSeleccionada):undefined;
 const explicacionZona=(zonaDetalle && periodoActual)?explicarZona(periodoActual, zonaDetalle, claves):undefined;

 // Nada de la app real se muestra sin sesion iniciada -- ni siquiera el
 // dashboard simulado. La sesion no se persiste (ver useState de auth mas
 // arriba), asi que esto se cumple en cada recarga/reinicio, no solo la
 // primera vez.
 if(!auth) return <LoginView onLogin={handleLogin} theme={theme} onToggleTheme={()=>setTheme(t=>t==='dark'?'light':'dark')}/>;

 const iniciales=auth.nombre.split(' ').filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('')||'OP';

 return <div className="app" data-theme={theme}>
   {mobileNavOpen && <div className="navBackdrop" onClick={()=>setMobileNavOpen(false)}/>}
   <aside className={`sidebar${mobileNavOpen?' open':''}${sidebarCollapsed?' collapsed':''}`}>
    <button className="sidebarToggleBtn" onClick={()=>setSidebarCollapsed(c=>!c)} title={sidebarCollapsed?'Expandir menú':'Colapsar menú'}><Menu size={20}/></button>
    <div className="brand"><div className="brandIcon"><Zap size={20}/></div>{!sidebarCollapsed && <div><b>ALERTA360</b><span>BOMBEROS · VALPARAÍSO</span></div>}</div>
    <nav>{[['Dashboard',BarChart3],['Emergencias',AlertTriangle],['Recursos',Truck],['Historial',History],['Reportes',Layers3],['Configuración',Settings]].map(([label,Icon]:any)=><button key={label} className={section===label?'active':''} onClick={()=>{setSection(label);setMobileNavOpen(false);}} title={label}><Icon size={18}/>{!sidebarCollapsed && <span>{label}</span>}</button>)}</nav>
    {!sidebarCollapsed && <div className="sidebarBottom"><div className="online"><span></span>Sistema operativo</div><small>Última sincronización<br/><b>hace 18 segundos</b></small></div>}
   </aside>
   <main className={`main${sidebarCollapsed?' sidebarCollapsed':''}`}><header><button className="mobileMenu" onClick={()=>setMobileNavOpen(o=>!o)}><Menu/></button><div><h1>{section}</h1><p>Central de coordinación · Valparaíso{!isAdmin?' · Acceso de solo lectura':''}{!isAdmin && esperandoEstadoRemoto?' · Esperando datos en vivo del operador…':''}{!isAdmin && estadoRemoto?` · En vivo (operador: ${estadoRemoto.publicadoPor})`:''}</p></div><div className="headerActions">{!isAdmin && <div className="readOnlyBadge" title="Tu cuenta solo puede visualizar, no asignar recursos"><Eye size={13}/> Solo lectura</div>}<button onClick={()=>setTheme(t=>t==='dark'?'light':'dark')} title={theme==='dark'?'Cambiar a tema claro':'Cambiar a tema oscuro'}>{theme==='dark'?<Sun size={17}/>:<Moon size={17}/>}</button><div className="live"><span/> EN VIVO</div><button onClick={()=>{setRefresh(x=>x+1);notify('Datos actualizados')}}><RefreshCw size={17}/></button><button onClick={()=>notify(`${queue.length} emergencias en cola`)}><Bell size={18}/></button><button className="avatar" onClick={()=>setSection('Configuración')} title={`${auth.nombre} · Ver perfil`}>{iniciales}</button></div></header>
    {section==='Emergencias' && <EmergenciasView queue={queue} claves={claves} now={now} onAtender={atenderEmergencia}/>}
    {section==='Recursos' && <RecursosView resources={resources} alertaTimeoutIds={unidadesConAlertaTimeout}/>}
    {section==='Historial' && <HistorialView historial={historial} now={now}/>}
    {section==='Reportes' && <ReportesView historial={historial}/>}
    {section==='Configuración' && <ConfiguracionView soundOn={soundOn} onToggleSound={setSoundOn} autoRefreshSec={autoRefreshSec} onChangeAutoRefresh={setAutoRefreshSec} onNotify={notify} auth={auth} onLogout={handleLogout} isAdmin={isAdmin} timeoutMinutos={timeoutMinutos} onChangeTimeout={setTimeoutMinutos}/>}
    {section==='Dashboard' && <>
    <div className="cuartelFilterRow">
      <label><Building2 size={16}/> Filtrar por cuartel<select value={filtroCuartel} onChange={e=>setFiltroCuartel(e.target.value)}>
        <option value="todos">Todos los cuarteles</option>
        {companiasDisponibles.map(c=><option key={c} value={c}>{c}</option>)}
      </select></label>
      {filtroCuartel!=='todos' && <button className="linkBtn" onClick={()=>setFiltroCuartel('todos')}>Quitar filtro</button>}
    </div>
    <section className="kpis"><Kpi icon={<AlertTriangle/>} label="Emergencias activas" value={String(filtroCuartel==='todos'?queue.length:queueFiltrada.length)} meta={currentEmergencia?`atendiendo clave ${currentEmergencia.codigo}`:'sin emergencia activa'} tone="acento"/><Kpi icon={<Truck/>} label="Recursos disponibles" value={String(disponibles)} meta={filtroCuartel==='todos'?`de ${resources.length} unidades`:`de ${resourcesFiltrados.length} unidades de ${filtroCuartel}`} tone="azul"/><Kpi icon={<Clock3/>} label="Tiempo promedio" value={tiempoPromedioLabel} meta={tiempoPromedioMeta} tone="acento"/><Kpi icon={<ShieldCheck/>} label="Cobertura estimada" value={coberturaLabel} meta={coberturaMeta} tone="azul"/></section>
    <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa operacional</b><span>Emergencias y recursos en tiempo real{isAdmin?' · toca un cuartel o vehículo para asignarlo manualmente':' · modo solo lectura'}</span></div></div><MapPanel resources={resourcesFiltrados} emergencies={emergenciasMapaDashboard} focus={focus} center={operationalCenter} onAsignarManual={handleAsignarManual} isAdmin={isAdmin}/><div className="legend"><span><i className="dot green"/> Disponible</span><span><i className="dot red"/> En misión</span><span><i className="dot blue"/> Ruta recomendada</span></div></div>
      <div className="sideCards">
      {currentEmergencia?<div className="emergencyCard"><div className={`tag prio prio-${claveActual?.prioridad_nivel??4}`}>{claveActual?`${claveActual.prioridad.toUpperCase()} PRIORIDAD`:'PRIORIDAD'}</div><div className="emergencyTitle"><div className="danger"><AlertTriangle/></div><div><b>Emergencia #{currentEmergencia.id}</b><span>{claveActual?.nombre??currentEmergencia.codigo}</span></div></div><div className="details"><p><MapPin size={18}/><span>{currentEmergencia.address}</span></p><p><Clock3 size={18}/><span>Tiempo transcurrido: <b>{elapsedLabel(currentEmergencia.creadaEn,now)}</b></span></p><p><Radio size={18}/><span>Estado: <b>{currentEmergencia.status}</b></span></p></div><div className="infoTipRow"><InfoTip texto={explicarEmergenciaActual(currentEmergencia.codigo, now)}/></div><button className="locateBtn" onClick={()=>setFocus({lat:currentEmergencia.lat,lng:currentEmergencia.lng})}><Crosshair size={13}/> Ver en el mapa</button></div>:<div className="emergencyCard"><p className="emptyState">Sin emergencias activas por el momento.</p></div>}
      <div className="recommend"><div className="recHead"><div><span>RECURSO RECOMENDADO</span><small>{filtroCuartel==='todos'?'Asignación multicriterio':`Asignación multicriterio · solo ${filtroCuartel}`}</small></div>{recommendation && recomendacionInfo && <div className="score" style={{color:scoreColor(Math.round(score(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin)))}}>{Math.round(score(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin))}<small>/100</small></div>}</div>
      {recommendation && recomendacionInfo?<>
       <div className="recBody"><div className="vehicleIcon">{resourceIcon(recommendation.type)}</div><div><b>{recommendation.name}</b><span className="recBodyCia">{recommendation.compania} · {recommendation.sector}</span><p><Clock3 size={17}/><span>ETA estimado: <strong>{recomendacionInfo.etaMin} min</strong></span></p><p><Navigation size={17}/><span>Distancia: <strong>{recomendacionInfo.distanciaKm} km</strong></span></p><p><CheckCircle2 size={17}/><span>Disponibilidad: <strong>{recommendation.radioState==='6-8'?'Regresando (redirigida a esta emergencia)':'Disponible en cuartel'}</strong></span></p><p><ShieldCheck size={17}/><span>Capacidad: <strong>{recommendation.capacity}</strong></span></p><p><Users size={17}/><span>Dotación: <strong>{recommendation.crew} personas</strong></span></p></div></div>
       <div className="infoTipRow"><InfoTip texto={`Por qué esta unidad: ${justificarRecomendacion(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin)}.`}/></div>
       <button className="locateBtn" onClick={()=>{const pos=posicionActual(recommendation,now); setFocus({lat:pos.lat,lng:pos.lng});}}><Crosshair size={13}/> Ver en el mapa</button>
       {isAdmin
         ?<div className="actions"><button className="assign" onClick={handleAsignar}>ASIGNAR</button><button className="reject" onClick={handleRechazar}>RECHAZAR</button></div>
         :<p className="emptyState readOnlyNote"><Lock size={12}/> Tu cuenta es de solo lectura: no puede asignar ni rechazar unidades.</p>}
      </>:<p className="emptyState">{filtroCuartel==='todos'?'Sin unidades disponibles para esta emergencia en este momento — todas las compatibles están en misión.':`Sin unidades disponibles de ${filtroCuartel} para esta emergencia en este momento.`}</p>}
      </div></div></section>
      <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa de calor · Demanda de Bomberos</b><span>Predicción ML · próximas {(periodos.length||4)*3} horas · toca una zona para ver el detalle</span></div><span className="mlBadge">ML</span></div><HeatMapPanel zonas={currentZonas} seleccionadaId={zonaSeleccionada} onSelectZona={z=>setZonaSeleccionada(z.zona_id)}/><div className="legend heatLegend"><span><i className="dot green"/> Baja</span><span><i className="dot yellow"/> Media</span><span><i className="dot red"/> Alta</span></div></div>
      <div className="sideCards"><div className="card alertsCard"><div className="cardHead"><div><b>Alertas predictivas</b><span>Zonas y horarios de mayor riesgo</span></div></div>
      <div className="alertsBody">
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
      </div></div></div></section>
      <section className="singleRow"><div className="resourcesCard card"><div className="cardHead"><div><b>Recursos disponibles</b><span>{filtroCuartel==='todos'?'Unidades consideradas por el algoritmo':`Unidades de ${filtroCuartel}`}</span></div><button className="linkBtn" onClick={()=>setSection('Recursos')}>Ver todos</button></div><div className="resourceGrid">{resourcesFiltrados.length?resourcesFiltrados.slice(0,4).map(r=><div className={`resource ${esDisponible(r)?'':'busy'}`} key={r.id}><div className="resIcon">{resourceIcon(r.type)}</div><div><b>{r.name}</b><span className={esDisponible(r)?'available':'busyText'}>{RADIO_LABELS[r.radioState]}</span><small>{r.distance} km {esDisponible(r)&&`· ${r.eta} min`}</small></div></div>):<p className="emptyState">Sin unidades para este cuartel.</p>}</div></div></section>
      <section className="activity card"><div className="cardHead"><div><b>Actividad reciente</b><span>Últimos eventos del sistema</span></div><span className="liveText"><span/> actualización automática</span></div><div className="activityRows">{historial.length?historial.slice(0,5).map(h=><Activity key={h.id} icon={historialIcon(h.tipo)} title={historialTitle(h.tipo)} detail={h.texto} time={timeAgo(h.ts,now)}/>):<Activity icon={<Radio/>} title="Sistema iniciado" detail="Esperando primera asignación" time="ahora"/>}</div></section>
    </>}
    </main>{toast&&<div className="toast"><CheckCircle2 size={18}/>{toast}</div>}
 </div>
}
function Kpi({icon,label,value,meta,tone='acento'}:{icon:React.ReactNode;label:string;value:string;meta:string;tone?:'acento'|'azul'}){return <div className="kpi card"><div className={`kpiIcon${tone==='azul'?' kpiIcon-azul':''}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{meta}</small></div></div>}
// Icono de informacion: el detalle solo aparece al pasar el mouse por
// encima (sin boton ni clic), para no ocupar espacio fijo en pantalla con
// parrafos largos que casi nadie necesita leer todo el tiempo.
function InfoTip({texto}:{texto:string}){return <span className="infoTip" tabIndex={0}><Info size={20}/><span className="infoTipBubble">{texto}</span></span>;}
function Activity({icon,title,detail,time}:{icon:React.ReactNode;title:string;detail:string;time:string}){return <div className="activityRow"><div className="activityIcon">{icon}</div><div><b>{title}</b><span>{detail}</span></div><time>{time}</time></div>}

createRoot(document.getElementById('root')!).render(<App/>);
