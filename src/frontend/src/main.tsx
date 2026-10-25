import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import {AlertTriangle, BarChart3, Building2, CheckCircle2, Clock3, Crosshair, Download, Droplet, Eye, FilePlus2, Flame, HardHat, History, Info, LifeBuoy, Lightbulb, Lock, LogOut, Mail, MapPin, Menu, Moon, Navigation, Paperclip, Phone, Radio, Send, Settings, ShieldCheck, Sun, Ticket, Truck, TreePine, Users, XCircle, Zap, Bug} from 'lucide-react';
import logoDark from "./assets/logo-alerta360-dark.png";
import logoLight from "./assets/logo-alerta360-light.png";

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
  id:string; name:string; type:ResourceType; lat:number; lng:number; codigo?: string;
  radioState:RadioState; eta:number; distance:number; capacity:string; crew:number;
  compania:string; sector:string;
  // Coordenadas fijas de la compañía.
  homeLat?: number; homeLng?: number;
  destino?:{emergenciaId:number; lat:number; lng:number; address:string};
  tramo?:Tramo;
  // Marca de tiempo de la ultima transmision real de estado (6-0..6-9) de
  // esta unidad -- usada para el timeout operacional (ver App): si una
  // unidad despachada no transmite dentro del umbral configurado, se
  // marca con una alerta visual para que la central la verifique.
  ultimaActualizacion?:number;
};
//-------------------------NUEVA BASE DE DATOS
type Emergency={
  id:number;
  codigo:string;
  address:string;
  lat:number;
  lng:number;
  status:'Activa'|'Asignada'|'PENDIENTE'|'ASIGNADA'|'EN_ATENCION'|'FINALIZADA'|'CANCELADA';
  creadaEn:number;
  prioridad:number;
};
//-------------------------
type ClimaEsperado={temperatura_c:number; viento_kmh:number; precipitacion_mm:number;};
type ZoneDemand={zona_id:string; nombre:string; bounds:{lat_min:number;lat_max:number;lng_min:number;lng_max:number}; centroid:{lat:number;lng:number}; demanda_total:number; desglose:Record<string,number>; clima_esperado?:ClimaEsperado;};
type Periodo={periodo_inicio:string; periodo_fin:string; zonas:ZoneDemand[];};
type VariableImportancia={nombre:string; peso_pct:number};
type Clave={codigo:string; nombre:string; prioridad:string; prioridad_nivel:number; terreno:string;};
type HistorialTipo='asignacion'|'rechazo'|'en_emergencia'|'liberacion'|'nueva_emergencia';
type HistorialEntry={id:number; ts:number; tipo:HistorialTipo; texto:string;};

// CONFIGURACION PARA SOPORTE TICKET //
type UserRole = 'admin' | 'visualizador' | 'soporte';

// Refleja 1:1 lo que ya devuelve GET /tickets en el backend, que a su vez
// sale directo de las tablas ya existentes en Postgres (ticket,
// respuesta_ticket, tipo_ticket, apartado_ticket) -- no se inventan campos
// que no esten en esas tablas.
type TicketRespuesta = {mensaje:string; tipo_respuesta:'Respuesta'|'Usuario'; fecha_respuesta:string; autor:string};
type SupportTicket = {
  id_ticket:number;
  id:string; // codigo_ticket, ej. "SOP-0004"
  tipo:string;
  apartado:string;
  titulo:string;
  descripcion:string;
  estado:'Abierto'|'En proceso'|'Resuelto';
  fecha:string;
  archivo:string;
  creadoPor:string;
  creadoPorEmail:string;
  prioridad:'Sin asignar'|'Baja'|'Media'|'Alta';
  respuestas:TicketRespuesta[];
  respuesta?:string;
  respuestaAutor?:string;
  respuestaUsuario?:string;
};
type CatalogoTicket={id_tipo:number; nombre_tipo:string};
type CatalogoApartado={id_apartado:number; nombre_apartado:string};
function mapearTicketBD(t:any):SupportTicket{
  const respuestas:TicketRespuesta[]=t.respuestas||[];
  const ultimaDe=(tipo:'Respuesta'|'Usuario')=>[...respuestas].reverse().find(r=>r.tipo_respuesta===tipo);
  const ultimaOficial=ultimaDe('Respuesta');
  return {
    id_ticket:t.id_ticket,
    id:t.codigo_ticket,
    tipo:t.tipo,
    apartado:t.apartado,
    titulo:t.titulo_ticket,
    descripcion:t.descripcion,
    estado:t.estado_ticket,
    fecha:new Date(t.fecha_creacion).toLocaleString('es-CL'),
    archivo:t.archivo_url??'',
    creadoPor:t.creado_por,
    creadoPorEmail:t.creado_por_email,
    prioridad:t.prioridad??'Sin asignar',
    respuestas,
    respuesta:ultimaOficial?.mensaje,
    respuestaAutor:ultimaOficial?.autor,
    respuestaUsuario:ultimaDe('Usuario')?.mensaje,
  };
}


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
function posicionActual(r: Resource,nowMs: number): { lat: number; lng: number } {
  if (
    r.tramo &&
    (r.radioState === '6-3' ||
      r.radioState === '6-8' ||
      r.radioState === '6-0')
  ) {
    const t = Math.min(
      1,
      Math.max(
        0,
        (nowMs - r.tramo.inicio) / r.tramo.duracionMs
      )
    );

    if (
      r.tramo.puntos &&
      r.tramo.acumKm &&
      r.tramo.puntos.length >= 2 &&
      r.tramo.acumKm.length === r.tramo.puntos.length
    ) {
      return puntoEnFraccion(
        r.tramo.puntos,
        r.tramo.acumKm,
        t
      );
    }

    // Si no hay ruta OSRM, no mover el vehículo.
    return r.tramo.origen;
  }

  if (r.radioState === '6-7' && r.destino) {
    return {
      lat: r.destino.lat,
      lng: r.destino.lng,
    };
  }

  return {
    lat: r.lat,
    lng: r.lng,
  };
}

// Segmento (par de puntos consecutivos de la ruta real) que la unidad esta
// cruzando ahora mismo, usado solo para orientar el icono del vehiculo
// segun hacia donde dobla en ese tramo puntual (no el rumbo general del
// viaje completo).
function segmentoActual(r:Resource, nowMs:number):{origen:{lat:number;lng:number}; destino:{lat:number;lng:number}}|null{
  if (!r.tramo ||!['6-0', '6-3', '6-8'].includes(r.radioState)) {return null;}
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
type RutaOSRM = {puntos: {lat:number;lng:number}[];acumKm: number[];};
async function obtenerRutaReal(origen: {lat:number;lng:number},destino: {lat:number;lng:number}): Promise<RutaOSRM> {

  const params = new URLSearchParams({
    origen_lat: String(origen.lat),
    origen_lng: String(origen.lng),
    destino_lat: String(destino.lat),
    destino_lng: String(destino.lng),
  });

  const resp = await fetch(
    `${API_BASE}/route?${params.toString()}`,
    {
      credentials: 'include',
      headers: authHeaders(),
    }
  );

  if (!resp.ok) {
    throw new Error(
      `OSRM no disponible: HTTP ${resp.status}`
    );
  }

  const data = await resp.json();

  // El backend debe marcar explícitamente las rutas
  // calculadas mediante el contenedor OSRM.
  if (data.fuente !== 'osrm_local') {
    throw new Error(
      'Ruta rechazada: no proviene de OSRM Docker'
    );
  }

  const puntos = data.puntos as {
    lat:number;
    lng:number;
  }[];

  if (
    !Array.isArray(puntos) ||
    puntos.length < 2 ||
    !puntos.every(p =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng)
    )
  ) {
    throw new Error(
      'OSRM devolvió una geometría inválida'
    );
  }

  const acumKm = [0];

  for (let i = 1; i < puntos.length; i++) {
    acumKm.push(
      acumKm[i - 1] +
      haversineKm(
        puntos[i - 1].lat,
        puntos[i - 1].lng,
        puntos[i].lat,
        puntos[i].lng
      )
    );
  }

  if (acumKm[acumKm.length - 1] <= 0) {
    throw new Error('OSRM devolvió una ruta sin distancia');
  }

  return {puntos, acumKm};
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
// Los recursos se obtienen exclusivamente desde PostgreSQL mediante GET /resources.
// No existe una flota precargada en el frontend.

function tipoRecursoBD(tipo: unknown, codigo: string): ResourceType {
  const valor = String(tipo ?? '').trim().toLowerCase();
  const prefijo = codigo.toUpperCase().split('-')[0];
  if (['forestal', 'bf'].includes(valor) || prefijo === 'BF') return 'Forestal';
  if (['rescate', 'r'].includes(valor) || prefijo === 'R') return 'Rescate';
  if (['hazmat', 'h', 'materiales peligrosos'].includes(valor) || prefijo === 'H') return 'Hazmat';
  if (['escala', 'q'].includes(valor) || prefijo === 'Q') return 'Escala';
  if (['cisterna', 'z', 'aljibe'].includes(valor) || prefijo === 'Z') return 'Cisterna';
  return 'Bomberos';
}

function nombreRecursoBD(fila: any, codigo: string, tipo: ResourceType): string {
  const nombre = String(fila.nombre ?? fila.nombre_recurso ?? '').trim();
  if (nombre) return nombre;
  const etiquetas: Record<ResourceType, string> = {
    Bomberos: 'Carro Bomba', Forestal: 'Autobomba Forestal',
    Rescate: 'Unidad Rescate', Hazmat: 'Unidad HazMat',
    Escala: 'Escala Mecánica', Cisterna: 'Carro Aljibe',
  };
  return `${etiquetas[tipo]} ${codigo}`;
}

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

// Persistencia del despacho en curso: todo el ciclo (ida/atencion/vuelta) se
// maneja con window.setTimeout, que vive solo mientras la pestana sigue
// abierta. Si se recarga la pagina a mitad de camino, esos temporizadores se
// pierden y la emergencia queda "pegada" en Postgres en el estado en que iba
// (Activa/Asignada/En atencion), aunque el vehiculo ya haya vuelto a su
// cuartel. Para que esto sea resistente a un F5, se guarda en localStorage
// el momento exacto (epoch ms) en que debe ocurrir cada transicion, y al
// cargar la pagina se retoma el ciclo desde donde corresponda (ver
// reanudarDespachoDesdeReload en App).
type DespachoPersistido={
  emergenciaId:number; codigo:string; address:string;
  destLat:number; destLng:number; homeLat:number; homeLng:number;
  llegaEn:number; finalizaEn:number; regresaEn:number;
};
const DESPACHO_LS_PREFIX='alerta360_despacho_';
const claveDespachoLS=(resourceId:string)=>`${DESPACHO_LS_PREFIX}${resourceId}`;
function guardarDespachoLS(resourceId:string, registro:DespachoPersistido):void{
  try{ localStorage.setItem(claveDespachoLS(resourceId), JSON.stringify(registro)); }catch{ /* localStorage no disponible: se pierde la resistencia a reload, pero no rompe el despacho en curso. */ }
}
function limpiarDespachoLS(resourceId:string):void{
  try{ localStorage.removeItem(claveDespachoLS(resourceId)); }catch{ /* ignorar */ }
}

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
  const clima=zona.clima_esperado;
  if(clima){
    if(codigoTop==='10-2') razones.push(`Condiciones climáticas esperadas: ${clima.temperatura_c}°C y viento de ${clima.viento_kmh} km/h${clima.precipitacion_mm>0.5?` (con algo de lluvia, ${clima.precipitacion_mm} mm, lo que reduce el riesgo)`:' y sin lluvia reciente'}, factor que el modelo usa para el riesgo de incendio forestal.`);
    else if(codigoTop==='10-4' && (clima.precipitacion_mm>1||clima.viento_kmh>22)) razones.push(`Se espera ${clima.precipitacion_mm>1?`lluvia (${clima.precipitacion_mm} mm)`:`viento fuerte (${clima.viento_kmh} km/h)`}, condición asociada a mayor riesgo de rescate vehicular.`);
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

// Limite de unidades despachadas a la vez a UNA MISMA emergencia. En una
// central real no se manda media flota a un incendio domiciliario comun --
// 2 o 3 unidades es lo razonable. Se deja como constante unica por ahora
// (no se distingue aun "mega incendio" de area extendida, que ameritaria
// permitir mas); cuando exista esa clasificacion, este valor puede variar
// segun la clave/prioridad de la emergencia en vez de ser fijo.
const LIMITE_UNIDADES_POR_EMERGENCIA = 3;

function unidadesEnCaminoA(resources:Resource[], emergenciaId:number):number{
  return resources.filter(r =>
    r.destino?.emergenciaId === emergenciaId &&
    (r.radioState === '6-3' || r.radioState === '6-7')
  ).length;
}

function pickRecommendation(resources:Resource[], emergencia:Emergency|null, rechazados:Set<string>, clave:Clave|undefined, nowMs:number):Resource|null{
  if(!emergencia) return null;
  if(unidadesEnCaminoA(resources, emergencia.id) >= LIMITE_UNIDADES_POR_EMERGENCIA) return null;
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
  const entries:{text:string;value:number;zonaId:string;centroid:{lat:number;lng:number}}[]=[];
  periodos.forEach(p=>{
    const hora=formatHour(p.periodo_inicio);
    p.zonas.forEach(z=>{
      Object.entries(z.desglose).forEach(([codigo,valor])=>{
        if(valor>=0.5){
          const clave=claves[codigo];
          const etiqueta=clave?`Clave ${codigo} (${clave.nombre})`:codigo;
          entries.push({text:`${hora} · ${etiqueta} — aumenta la probabilidad en ${z.nombre} (${valor.toFixed(1)} casos esperados)`,value:valor,zonaId:z.zona_id,centroid:z.centroid});
        }
      });
    });
  });
  return entries.sort((a,b)=>b.value-a.value).slice(0,5);
}

// Fuerza a Leaflet a remedir su contenedor: evita mapas gigantes/desalineados
// cuando el contenedor cambia de tamaño (ventana redimensionada, layout
// flexible, o el propio arranque del mapa antes de que el layout se asiente).
// Ademas del resize de ventana, observamos el propio contenedor del mapa:
// las tarjetas del panel lateral (.sideCards) cargan datos de forma asincrona
// y, al crecer, estiran la fila del grid (y por flex:1 tambien el mapa) sin
// disparar un evento "resize" de ventana -- sin este observer, Leaflet se
// queda con el tamano medido al arrancar y la parte nueva del mapa queda en
// blanco.
function fixMapSize(map:L.Map):()=>void{
  const invalidate=()=>map.invalidateSize();
  const t=window.setTimeout(invalidate,0);
  window.addEventListener('resize',invalidate);
  const container=map.getContainer();
  const observer=new ResizeObserver(invalidate);
  observer.observe(container);
  return()=>{
    window.clearTimeout(t);
    window.removeEventListener('resize',invalidate);
    observer.disconnect();
  };
}

// Mapa minimo y propio del formulario de "Nueva emergencia" -- a diferencia
// de MapPanel (cuarteles, unidades animadas, asignacion), aca solo importa
// una cosa: donde hace clic el operador. El click pone/mueve un marcador y
// entrega lat/lng en crudo; el operador NUNCA digita coordenadas a mano,
// tal como pide la especificacion del formulario CAD.
function MapaSeleccionUbicacion({lat, lng, onSeleccionar}:{lat:number|null; lng:number|null; onSeleccionar:(lat:number, lng:number)=>void}){
  const mapRef=useRef<L.Map|null>(null);
  const markerRef=useRef<L.Marker|null>(null);
  const onSeleccionarRef=useRef(onSeleccionar);
  onSeleccionarRef.current=onSeleccionar;

  useEffect(()=>{
    const map=L.map('form-map',{zoomControl:true}).setView(
      [lat??VALPARAISO_CENTER.lat, lng??VALPARAISO_CENTER.lng], 13
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
    map.on('click',(e:L.LeafletMouseEvent)=>{ onSeleccionarRef.current(e.latlng.lat, e.latlng.lng); });
    mapRef.current=map;
    const cleanupResize=fixMapSize(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return()=>{ cleanupResize(); map.remove(); mapRef.current=null; markerRef.current=null; };
  },[]);

  // El marcador se mueve/crea por separado del mapa (que solo se crea una
  // vez) -- asi un punto elegido por el buscador de direcciones tambien
  // actualiza el pin sin tener que recrear el mapa entero.
  useEffect(()=>{
    const map=mapRef.current;
    if(!map) return;
    if(lat==null || lng==null){
      markerRef.current?.remove();
      markerRef.current=null;
      return;
    }
    if(markerRef.current){
      markerRef.current.setLatLng([lat,lng]);
    }else{
      markerRef.current=L.marker([lat,lng]).addTo(map);
    }
    map.setView([lat,lng], map.getZoom());
  },[lat,lng]);

  return <div id="form-map" className="formMapaUbicacion"/>;
}

// Combobox con filtrado dinamico de claves radiales (10-0, 10-1, ...) --
// reutiliza el mismo catalogo real (`claves`, desde GET /catalog/claves)
// que ya usa el resto del dashboard, no una lista propia que se pueda
// desincronizar de la base de datos.
function ComboCodigoEmergencia({claves, onElegir}:{claves:Record<string,Clave>; onElegir:(codigo:string)=>void}){
  const [texto,setTexto]=useState('');
  const [abierto,setAbierto]=useState(false);
  const [indiceActivo,setIndiceActivo]=useState(0);

  // Orden NUMERICO, no alfabetico -- "10-10".localeCompare("10-2") los
  // ordenaba como texto (1 < 2, asi que 10-10 quedaba antes que 10-2).
  // Se extrae el ultimo segmento numerico de cada codigo para comparar.
  const numeroClave=(codigo:string)=>Number(codigo.split('-').pop());
  const listaClaves=useMemo(
    ()=>Object.values(claves).sort((a,b)=>numeroClave(a.codigo)-numeroClave(b.codigo)),
    [claves]
  );
  const filtradas=useMemo(()=>{
    const q=texto.trim().toLowerCase();
    if(!q) return listaClaves;
    return listaClaves.filter(c=>c.codigo.toLowerCase().includes(q) || c.nombre.toLowerCase().includes(q));
  },[listaClaves, texto]);

  const elegir=(c:Clave)=>{
    setTexto(`${c.codigo} · ${c.nombre}`);
    onElegir(c.codigo);
    setAbierto(false);
  };

  return (
    <div className="comboClave">
      <input
        type="text"
        value={texto}
        onChange={e=>{ setTexto(e.target.value); setAbierto(true); setIndiceActivo(0); }}
        onFocus={()=>setAbierto(true)}
        onBlur={()=>window.setTimeout(()=>setAbierto(false),150)}
        onKeyDown={e=>{
          if(e.key==='ArrowDown'){ e.preventDefault(); setIndiceActivo(i=>Math.min(i+1, filtradas.length-1)); }
          else if(e.key==='ArrowUp'){ e.preventDefault(); setIndiceActivo(i=>Math.max(i-1,0)); }
          else if(e.key==='Enter'){ e.preventDefault(); if(filtradas[indiceActivo]) elegir(filtradas[indiceActivo]); }
        }}
        placeholder="Buscar clave (ej: 10-0 o incendio)"
      />
      {abierto && filtradas.length>0 && (
        <ul className="comboClaveLista">
          {filtradas.map((c,i)=>(
            <li
              key={c.codigo}
              className={i===indiceActivo?'activo':''}
              onMouseDown={()=>elegir(c)}
            >
              <strong>{c.codigo}</strong> {c.nombre}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Busqueda de direcciones contra Nominatim (API publica de OpenStreetMap,
// sin API key). No hay geocodificacion propia en el proyecto -- OSRM solo
// calcula rutas, no busca direcciones. Debounce de 500ms para no pasarse
// del limite de uso de Nominatim (1 solicitud/seg) mientras el operador
// sigue escribiendo.
function useBuscadorDirecciones(){
  const [sugerencias,setSugerencias]=useState<{display_name:string; lat:string; lon:string}[]>([]);
  // Estado visible del buscador -- antes, mientras no habia resultados, no
  // se mostraba nada y parecia que el autocompletado no hacia nada (aunque
  // si estaba funcionando, solo que en silencio).
  const [estado,setEstado]=useState<'inactivo'|'buscando'|'sin_resultados'|'error'>('inactivo');
  const temporizadorRef=useRef<number|null>(null);

  const buscar=(texto:string)=>{
    if(temporizadorRef.current) window.clearTimeout(temporizadorRef.current);
    const q=texto.trim();
    if(q.length<3){ setSugerencias([]); setEstado('inactivo'); return; }
    setEstado('buscando');
    temporizadorRef.current=window.setTimeout(async()=>{
      try{
        const params=new URLSearchParams({
          format:'json',
          q,
          countrycodes:'cl',
          // Caja aproximada de la Region de Valparaiso, para priorizar
          // resultados locales (formato Nominatim: min_lon,max_lat,max_lon,min_lat).
          viewbox:'-71.75,-32.60,-71.30,-33.30',
          bounded:'1',
          limit:'5',
        });
        const resp=await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
        if(!resp.ok) throw new Error('Nominatim no respondió');
        const datos=await resp.json();
        setSugerencias(datos);
        setEstado(datos.length?'inactivo':'sin_resultados');
      }catch(error){
        console.error('No se pudo buscar la dirección en Nominatim:', error);
        setSugerencias([]);
        setEstado('error');
      }
    },500);
  };

  return {sugerencias, estado, buscar, limpiar:()=>{ setSugerencias([]); setEstado('inactivo'); }};
}

// Formulario "Nueva emergencia" (CAD) -- solo visible para admin (ver nav
// del sidebar). Codigo (typeahead sobre el catalogo real), direccion (texto
// + autocompletado Nominatim) y georreferenciacion (clic en el mapa, nunca
// coordenadas digitadas a mano). La prioridad ya no se pide ni se muestra
// como campo: se calcula sola desde el codigo elegido y se envia asi nomas.
function NuevaEmergenciaView({claves, onCrear}:{
  claves:Record<string,Clave>;
  onCrear:(payload:{codigo_emergencia:string; direccion_emergencia:string; latitud_emergencia:number; longitud_emergencia:number; prioridad_emergencia:number})=>Promise<{id_emergencia:number; codigo_emergencia:string}>;
}){
  const [codigo,setCodigo]=useState('');
  const [direccion,setDireccion]=useState('');
  const [lat,setLat]=useState<number|null>(null);
  const [lng,setLng]=useState<number|null>(null);
  // La prioridad ya NO la elige el operador: se detecta sola a partir del
  // código de emergencia (catalogo real, GET /catalog/claves). Sin código
  // elegido todavia no hay prioridad que mostrar.
  const [prioridad,setPrioridad]=useState<number|null>(null);
  const [enviando,setEnviando]=useState(false);
  const {sugerencias, estado:estadoBusquedaDireccion, buscar, limpiar}=useBuscadorDirecciones();

  const elegirCodigo=(cod:string)=>{
    setCodigo(cod);
    const clave=claves[cod];
    setPrioridad(clave?Number(clave.prioridad):null);
  };

  const elegirDireccionSugerida=(s:{display_name:string; lat:string; lon:string})=>{
    setDireccion(s.display_name.toUpperCase());
    setLat(Number(s.lat));
    setLng(Number(s.lon));
    limpiar();
  };

  // Geocodificacion INVERSA: al marcar un punto directo en el mapa (sin
  // pasar por el buscador de texto), se completa sola la direccion con lo
  // que haya en ese punto segun OpenStreetMap -- el operador puede seguir
  // editandola a mano despues si el nombre no calza exacto.
  const seleccionarEnMapa=async(la:number, lo:number)=>{
    setLat(la);
    setLng(lo);
    try{
      const params=new URLSearchParams({format:'json', lat:String(la), lon:String(lo)});
      const resp=await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`);
      if(!resp.ok) return;
      const datos=await resp.json();
      if(datos?.display_name) setDireccion(String(datos.display_name).toUpperCase());
    }catch(error){
      console.error('No se pudo obtener la dirección del punto marcado:', error);
    }
  };

  const crear=async()=>{
    if(!codigo || prioridad==null){ alert('Selecciona un código de emergencia.'); return; }
    if(!direccion.trim()){ alert('Ingresa la dirección.'); return; }
    if(lat==null || lng==null){ alert('Marca la ubicación en el mapa (clic sobre el punto real).'); return; }
    setEnviando(true);
    try{
      await onCrear({
        codigo_emergencia:codigo,
        direccion_emergencia:direccion.trim(),
        latitud_emergencia:lat,
        longitud_emergencia:lng,
        prioridad_emergencia:prioridad,
      });
      setCodigo(''); setDireccion(''); setLat(null); setLng(null); setPrioridad(null);
    }catch(error){
      alert(error instanceof Error?error.message:'No se pudo crear la emergencia.');
    }finally{
      setEnviando(false);
    }
  };

  return (
    <div className="card sectionCard nuevaEmergenciaCard">
      <div className="cardHead"><div><b>Nueva emergencia</b><span>Ingreso rápido para despacho (CAD)</span></div></div>

      <div className="nuevaEmergenciaGrid">

        <label className="nuevaEmergenciaCampo">
          1. Código de emergencia
          <ComboCodigoEmergencia claves={claves} onElegir={elegirCodigo}/>
        </label>

        <label className="nuevaEmergenciaCampo">
          2. Dirección / ubicación
          <input
            type="text"
            value={direccion}
            onChange={e=>{ const v=e.target.value.toUpperCase(); setDireccion(v); buscar(v); }}
            placeholder="AV. ARGENTINA, BARRIO ALMENDRAL, VALPARAÍSO"
          />
          {sugerencias.length>0 && (
            <ul className="comboDireccionLista">
              {sugerencias.map((s,i)=>(
                <li key={i} onMouseDown={()=>elegirDireccionSugerida(s)}>{s.display_name}</li>
              ))}
            </ul>
          )}
          {estadoBusquedaDireccion==='buscando' && <small className="estadoBusquedaDireccion">Buscando direcciones…</small>}
          {estadoBusquedaDireccion==='sin_resultados' && <small className="estadoBusquedaDireccion">Sin resultados para esa búsqueda. Prueba solo con el nombre de la calle (ej. "Pedro Montt").</small>}
          {estadoBusquedaDireccion==='error' && <small className="estadoBusquedaDireccion error">No se pudo conectar al buscador de direcciones. Puedes seguir marcando el punto directo en el mapa.</small>}
        </label>

        <div className="nuevaEmergenciaCampo nuevaEmergenciaCampoMapa">
          3. Georreferenciación (toca el mapa para marcar el punto)
          <MapaSeleccionUbicacion lat={lat} lng={lng} onSeleccionar={seleccionarEnMapa}/>
          {lat!=null && lng!=null && <small className="nuevaEmergenciaCoords">Lat {lat.toFixed(5)}, Lng {lng.toFixed(5)}</small>}
          <button className="nuevaEmergenciaCrearBtn" onClick={crear} disabled={enviando}>
            {enviando?'Creando…':'Crear y generar recomendación'}
          </button>
        </div>

      </div>
    </div>
  );
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
  // Incluye el numero de la emergencia (no solo la direccion) para que
  // quede claro a cual alerta esta sirviendo este vehiculo -- sin esto, un
  // camion "En trayecto"/"Regresando" de una emergencia que no es la que
  // esta en pantalla da la impresion de que esa alerta nunca se atendio.
  const detalleTramo=r.destino
    ? `<br/>→ Emergencia #${r.destino.emergenciaId} · ${r.destino.address}`
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

function MapPanel({resources, emergencies, focus, center, onAsignarManual, onSelectEmergencia, isAdmin=true}:{resources:Resource[]; emergencies:Emergency[]; focus:{lat:number;lng:number}|null; center:{lat:number;lng:number}; onAsignarManual:(resourceId:string)=>void; onSelectEmergencia?:(id:number)=>void; isAdmin?:boolean}){
  const mapRef=useRef<L.Map|null>(null);
  // Refs para leer siempre el valor mas reciente desde callbacks que
  // Leaflet dispara mas tarde (popups, clicks) sin que queden desactualizados.
  const onAsignarManualRef=useRef(onAsignarManual);
  onAsignarManualRef.current=onAsignarManual;
  const onSelectEmergenciaRef=useRef(onSelectEmergencia);
  onSelectEmergenciaRef.current=onSelectEmergencia;
  const emergenciesRef=useRef(emergencies);
  emergenciesRef.current=emergencies;
  const isAdminRef=useRef(isAdmin);
  isAdminRef.current=isAdmin;
  // Que popup de emergencia esta abierto ahora mismo (si hay uno). La capa
  // de emergencias/cuarteles se destruye y reconstruye entera cada vez que
  // cambian los datos (p.ej. el refresco automatico de la cola cada 10s),
  // lo que cierra cualquier popup abierto sobre ella -- esto deja registro
  // de cual estaba abierta para volver a abrirla justo despues de recrear
  // los marcadores, en vez de que se cierre sola sin que el operador la cerrara.
  const emergenciaPopupAbiertaRef=useRef<number|null>(null);
  // Capa "estatica": emergencias, marcador de emergencia asignada y el
  // trazado de ruta -- se redibuja solo cuando cambian los datos (no en
  // cada tick), porque nada de esto se mueve cuadro a cuadro.
  const layerRef=useRef<L.LayerGroup|null>(null);
  // Capa aparte para el anillo de resaltado temporal (ver "Recentrar" mas
  // abajo): separada de layerRef para no interferir con su redibujado
  // normal (cuarteles/emergencias/ruta), que se limpia y arma de cero cada
  // vez que cambian los datos.
  const highlightLayerRef=useRef<L.LayerGroup|null>(null);
  const highlightTimeoutRef=useRef<number|null>(null);
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
    const highlightLayer=L.layerGroup().addTo(map);
    mapRef.current=map;
    layerRef.current=layer;
    highlightLayerRef.current=highlightLayer;
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
    return()=>{cleanupResize(); map.remove(); mapRef.current=null; layerRef.current=null; highlightLayerRef.current=null;};
  },[center]);

  // Capa estatica: emergencias, marcador "asignada" y trazado de ruta.
  // Se redibuja solo cuando cambian los datos, no en cada tick (nada de
  // esto se mueve cuadro a cuadro).
  useEffect(()=>{
    const layer=layerRef.current;
    if(!layer) return;
    // Se congela ANTES de clearLayers(): si clearLayers() dispara
    // "popupclose" sobre el marcador que se esta destruyendo, el ref ya
    // quedaria en null antes de llegar al forEach de abajo, y el marcador
    // nuevo de esa misma emergencia nunca se reabriria.
    const idPopupAbiertaAntes=emergenciaPopupAbiertaRef.current;
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
      const {sector}=unidades[0];
      // La compañía es fija: su ubicación proviene de emergencia.compania,
      // nunca de la posición móvil de emergencia.recurso.
      const lat=unidades[0].homeLat;
      const lng=unidades[0].homeLng;
      if(lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const letras=unidades.map(u=>RESOURCE_LETRA[u.type]);
      L.marker([lat,lng],{
        icon:L.divIcon({className:'cuartel-marker', html:iconoCuartel(letras), iconSize:[22,22], iconAnchor:[11,11]}),
        zIndexOffset:-100,
      }).addTo(layer).bindTooltip(`${compania} · ${sector}`).bindPopup(()=>popupCuartel(compania, sector, unidades, emergenciesRef.current.length>0, isAdminRef.current));
    });
    emergencies.forEach(e=>{
      const marker=L.marker([e.lat,e.lng],{icon:L.divIcon({className:'emergency-marker',html:'<div>!</div>',iconSize:[36,36],iconAnchor:[18,18]})})
        .addTo(layer)
        .bindPopup(`<b>Emergencia #${e.id}</b><br/>Clave ${e.codigo}<br/>${e.address}`)
        .on('click', ()=>onSelectEmergenciaRef.current?.(e.id))
        .on('popupopen', ()=>{ emergenciaPopupAbiertaRef.current=e.id; })
        .on('popupclose', ()=>{ if(emergenciaPopupAbiertaRef.current===e.id) emergenciaPopupAbiertaRef.current=null; });
      if(idPopupAbiertaAntes===e.id) marker.openPopup();
    });
    // Emergencias ya asignadas (fuera de la cola) pero que aun tienen una unidad
    // en camino o trabajando: se mantienen marcadas para que la ruta apunte a
    // un incidente real y no a un punto vacio del mapa.
    const destinosMostrados=new Set<number>();
    resources.forEach(r=>{
      if(r.destino && (r.radioState==='6-3'||r.radioState==='6-7') && !destinosMostrados.has(r.destino.emergenciaId)){
        destinosMostrados.add(r.destino.emergenciaId);
        const idEmergenciaDestino=r.destino.emergenciaId;
        const markerAsignada=L.marker([r.destino.lat,r.destino.lng],{icon:L.divIcon({className:'emergency-marker emergency-marker-asignada',html:'<div>✓</div>',iconSize:[34,34],iconAnchor:[17,17]})})
          .addTo(layer)
          .bindPopup(`<b>Emergencia #${idEmergenciaDestino}</b><br/>${r.destino.address}<br/><i>Asignada</i>`)
          .on('click', ()=>onSelectEmergenciaRef.current?.(idEmergenciaDestino))
          .on('popupopen', ()=>{ emergenciaPopupAbiertaRef.current=idEmergenciaDestino; })
          .on('popupclose', ()=>{ if(emergenciaPopupAbiertaRef.current===idEmergenciaDestino) emergenciaPopupAbiertaRef.current=null; });
        if(idPopupAbiertaAntes===idEmergenciaDestino) markerAsignada.openPopup();
      }
    });
    resources.forEach(r=>{
      const enMovimiento=!!r.tramo && (r.radioState==='6-3'||r.radioState==='6-8');
      if(!enMovimiento || !r.tramo?.puntos || r.tramo.puntos.length<2) return;
      // Dibujar exclusivamente geometrías verificadas de OSRM.
      const trazado:[number,number][]=r.tramo.puntos.map(p=>[p.lat,p.lng]);
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
      // Mostrar TODOS los recursos que devuelve PostgreSQL, también los
      // disponibles (6-0) y fuera de servicio (6-9). El cuartel se mantiene
      // como un marcador independiente y fijo en la capa inferior.
      const fueraDeCuartel=true;
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
          zIndexOffset:200,
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
  // ("Ver en el mapa", "Atender", tocar una compañia en Recursos), no en
  // cada actualizacion de datos. Zoom fijo (no "al menos X"): siempre
  // acerca a nivel de calle para que se identifique con precision el punto
  // exacto, sin importar en que nivel de zoom haya quedado el mapa antes.
  // Ademas dibuja un anillo que pulsa sobre el punto exacto por unos
  // segundos, para distinguirlo de otros marcadores cercanos (p.ej. varios
  // cuarteles juntos) que el centrado solo no alcanza a diferenciar.
  useEffect(()=>{
    if(focus && mapRef.current){
      mapRef.current.setView([focus.lat,focus.lng], 17);
      const hl=highlightLayerRef.current;
      if(hl){
        hl.clearLayers();
        if(highlightTimeoutRef.current) window.clearTimeout(highlightTimeoutRef.current);
        L.marker([focus.lat,focus.lng],{
          icon:L.divIcon({className:'focus-ping', html:'<span></span><span></span>', iconSize:[1,1], iconAnchor:[0,0]}),
          interactive:false,
          zIndexOffset:1000,
        }).addTo(hl);
        highlightTimeoutRef.current=window.setTimeout(()=>{hl.clearLayers();}, 4000);
      }
    }
    // Si el mapa se desmonta (ej. se cambia de seccion) antes de que pasen
    // los 4 segundos, el setTimeout quedaba vivo apuntando a una capa que ya
    // no existe -- al volver a montar el mapa esa capa nueva nunca se
    // limpiaba, dejando el anillo pegado para siempre en el punto anterior.
    return ()=>{
      if(highlightTimeoutRef.current){ window.clearTimeout(highlightTimeoutRef.current); highlightTimeoutRef.current=null; }
      highlightLayerRef.current?.clearLayers();
    };
  },[focus]);

  return <div id="map"/>
}

// Verde/amarillo/rojo segun demanda esperada (mismos umbrales usados en el
// backend para "exactitud de nivel de riesgo").
function demandColor(v:number){return v<0.8?'#2fae66':v<1.8?'#e0b23c':'#e0483f';}

function HeatMapPanel({zonas, seleccionadaId, onSelectZona, focus}:{zonas:ZoneDemand[]; seleccionadaId:string|null; onSelectZona:(zona:ZoneDemand)=>void; focus?:{lat:number;lng:number}|null}){
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

  // Al elegir una zona desde una alerta predictiva (o el resumen de "mayor
  // demanda esperada"), el mapa de calor se centra y hace zoom sobre su
  // centroide, para que la zona señalada quede visible sin que el usuario
  // tenga que desplazarse manualmente.
  useEffect(()=>{
    if(focus && mapRef.current){
      mapRef.current.setView(
        [focus.lat, focus.lng],
        Math.max(mapRef.current.getZoom(), 13),
        {animate:true}
      );
    }
  },[focus]);

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

function EmergenciasView({queue,claves,now,onAtender,onVerUbicacion,isAdmin}:{queue:Emergency[];claves:Record<string,Clave>;now:number;onAtender:(id:number)=>void;onVerUbicacion:(id:number)=>void;isAdmin:boolean}){
  return <div className="card sectionCard">
    <div className="cardHead"><div><b>Emergencias activas</b><span>{queue.length} en cola de atención · toca una fila o "Ver ubicación" para verla en el mapa</span></div></div>
    <div className="tableWrap"><table className="dataTable">
      <thead><tr><th>ID</th><th>Clave</th><th>Prioridad</th><th>Dirección</th><th>Tiempo</th><th>Estado</th><th></th>{isAdmin && <th></th>}</tr></thead>
      <tbody>{[...queue].sort((a, b) => a.id - b.id).map(e => {const c = claves[e.codigo];return <tr key={e.id} className="emergenciaRow" onClick={()=>onVerUbicacion(e.id)}>
        <td>#{e.id}</td>
        <td>{e.codigo} · {c?.nombre??'—'}</td>
        <td>
          <span
            className={`prioridad-badge ${obtenerClasePrioridad(e.prioridad)}`}
          >
            {obtenerNivelPrioridad(e.prioridad)}
          </span>
        </td>
        <td className="wrap">{e.address}</td>
        <td>{elapsedLabel(e.creadaEn,now)}</td>
        <td>{e.status}</td>
        <td><button className="linkBtn" onClick={ev=>{ev.stopPropagation(); onVerUbicacion(e.id);}}><Crosshair size={13}/> Ver ubicación</button></td>
        {isAdmin && <td><button className="atenderBtn" onClick={ev=>{ev.stopPropagation(); onAtender(e.id);}}>Atender</button></td>}
      </tr>;})}</tbody>
    </table></div>
  </div>;
}

const TODOS='todos' as const;
function RecursosView({resources,alertaTimeoutIds,onVerCuartelEnMapa,isAdmin,puedeCambiarEstado,onCambiarFueraDeServicio}:{resources:Resource[];alertaTimeoutIds:Set<string>;onVerCuartelEnMapa:(lat:number,lng:number)=>void;isAdmin:boolean;puedeCambiarEstado:boolean;onCambiarFueraDeServicio:(resource:Resource, nuevoEstado:'6-0'|'6-9')=>void}){
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
      <thead><tr><th></th><th>Unidad</th><th>Compañía</th><th>Sector</th><th>Tipo</th><th>Dotación</th><th>Distancia</th><th>ETA</th><th>Estado</th>{puedeCambiarEstado && <th></th>}</tr></thead>
      <tbody>{filtrados.length?filtrados.map(r=><tr key={r.id}>
        <td className="resIconCell">{resourceIcon(r.type)}</td>
        <td className="wrap resNombreCell">{r.name}</td>
        <td className="wrap"><button className="linkBtn" title="Ver cuartel en el mapa" onClick={()=>onVerCuartelEnMapa(r.lat,r.lng)}>{r.compania}</button></td>
        <td className="wrap">{r.sector}</td>
        <td>{r.type}</td>
        <td>{r.crew}</td>
        <td>{r.distance} km</td>
        <td>{r.eta} min</td>
        <td className="wrap resEstadoCell"><span className={`estado estado-${r.radioState.replace('6-','')}`}>{r.radioState} · {RADIO_LABELS[r.radioState]}</span>{alertaTimeoutIds.has(r.id)&&<span className="timeoutBadge" title="Sin transmisión de estado dentro del umbral configurado"><AlertTriangle size={11}/> sin transmisión</span>}</td>
        {puedeCambiarEstado && <td>
          {r.radioState==='6-9'
            ?<button className="reactivarBtn" onClick={()=>onCambiarFueraDeServicio(r,'6-0')}>Reactivar</button>
            :r.radioState==='6-0'
              ?<button className="fueraServicioBtn" onClick={()=>onCambiarFueraDeServicio(r,'6-9')}>Fuera de servicio</button>
              :null}
        </td>}
      </tr>):<tr><td colSpan={puedeCambiarEstado?10:9}><p className="emptyState">Ninguna unidad coincide con el filtro.</p></td></tr>}</tbody>
    </table></div>
  </div>;
}

const TIPOS_HISTORIAL:HistorialTipo[]=['asignacion','rechazo','en_emergencia','liberacion','nueva_emergencia'];
// Dice si el EVENTO (no la emergencia en vivo) representa el cierre de una
// emergencia o el que sigue en curso -- a partir de lo que el propio texto
// ya cuenta (tipo + palabras clave), nunca comparando contra el estado
// actual: la base se reinicia seguido durante las pruebas y los IDs se
// reciclan, asi que "Emergencia #5 de hace 20 minutos" y "Emergencia #5 de
// ahora" pueden ser filas completamente distintas -- cruzarlo contra la
// cola en vivo daba estados erroneos. Null para eventos genericos que no
// mencionan ninguna emergencia en particular (ej. "unidad regreso a su
// cuartel" sin numero de emergencia).
function estadoEmergenciaDeEvento(tipo:HistorialTipo, texto:string):{texto:string; clase:string}|null{
  if(!/Emergencia #\d+/.test(texto)) return null;
  const esCierre = tipo==='liberacion' && (texto.includes('finalizó la atención') || texto.includes('finalizada en PostgreSQL'));
  return esCierre
    ? {texto:'Finalizada', clase:'historialEstado-finalizada'}
    : {texto:'Activa', clase:'historialEstado-activa'};
}

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
    <div className="activityRows">{filtrado.length?filtrado.map(h=><Activity key={h.id} icon={historialIcon(h.tipo)} title={historialTitle(h.tipo)} detail={h.texto} time={timeAgo(h.ts,now)} estado={estadoEmergenciaDeEvento(h.tipo,h.texto)}/>):<p className="emptyState">{historial.length?'Ningún evento coincide con el filtro.':'Aún no hay acciones registradas. Asigna o rechaza una recomendación desde el Dashboard para empezar a construir el historial.'}</p>}</div>
  </div>;
}

// Login sin registro publico: solo los operadores fijos que existen en el
// backend (core/auth.py) pueden entrar. Mismo estandar visual "Tech
// Corporativo Nocturno" del resto de la app (misma marca, mismos colores),
// sin elementos de mas -- correo, contraseña, listo.
function LoginView({onLogin,theme,onToggleTheme}:{onLogin:(token:string, nombre:string, email:string, rol:UserRole)=>void; theme:'dark'|'light'; onToggleTheme:()=>void}){
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
      const rol:UserRole = data.rol==='soporte' ? 'soporte' : data.rol==='admin' ? 'admin' : 'visualizador';
      onLogin(data.token,data.nombre,data.email,rol);
    }catch{
      setError(`No se pudo conectar con el servidor (${API_BASE}). ¿Está corriendo el backend?`);
    }finally{
      setCargando(false);
    }
  };

  return <div className="loginPage">
    <div className="loginCard">
      <button className="themeToggleLogin" onClick={onToggleTheme} title={theme==='dark'?'Cambiar a tema claro':'Cambiar a tema oscuro'}>{theme==='dark'?<Sun size={18}/>:<Moon size={18}/>}</button>
      <div className="brand"><div className="brandIcon"><img src={logoDark} className="logoDark" alt="ALERTA360"/><img src={logoLight} className="logoLight" alt="ALERTA360"/></div><div><b>ALERTA360</b><span>BOMBEROS · VALPARAÍSO</span></div></div>
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

function prioridadClase(p:'Sin asignar'|'Baja'|'Media'|'Alta'):string{
  return p==='Alta' ? 'ticketPrioridad-alta'
    : p==='Media' ? 'ticketPrioridad-media'
    : p==='Baja' ? 'ticketPrioridad-baja'
    : 'ticketPrioridad-sinasignar';
}

// Hilo completo de la conversacion de un ticket (respuestas oficiales de
// soporte y seguimientos del usuario que lo creo), en orden cronologico --
// antes solo se mostraba la ULTIMA respuesta de cada lado, perdiendo el
// resto del historial de la conversacion.
function TicketThread({respuestas}:{respuestas:TicketRespuesta[]}){
  if(!respuestas.length) return null;
  return <div className="ticketThread">
    {respuestas.map((r,i)=>
      <div key={i} className={`ticketThreadMsg ${r.tipo_respuesta==='Respuesta'?'esSoporte':'esUsuario'}`}>
        <strong>{r.tipo_respuesta==='Respuesta'?'Soporte':'Usuario'} · {r.autor}</strong>
        <p>{r.mensaje}</p>
        <small>{new Date(r.fecha_respuesta).toLocaleString('es-CL')}</small>
      </div>
    )}
  </div>;
}

// Los tickets antiguos guardan un link externo en archivo_url; los nuevos
// guardan la imagen ya codificada como data URI (ver crearTicketBD). Un
// mismo campo sirve para ambos casos: si empieza con "data:image" se
// renderiza como <img>, si no, como enlace de texto (comportamiento previo).
function esImagenAdjunta(url:string){
  return url.startsWith('data:image');
}

// Extensión real del archivo a partir del mime type (para el nombre que
// se ofrece al descargar: "adjunto-ticket.png", no "adjunto-ticket.data").
function extensionImagen(dataUri:string){
  const mime = dataUri.slice(5, dataUri.indexOf(';'));
  return mime.split('/')[1] || 'png';
}

// Overlay a pantalla completa con la imagen ampliada. Los navegadores
// Chromium (Chrome, Brave, Edge) bloquean la navegacion a una URL "data:"
// en una pestaña nueva (pantalla en blanco, "Sin titulo") por seguridad
// anti-phishing -- por eso esto se abre dentro de la misma pagina en vez
// de usar <a target="_blank">.
function LightboxImagenTicket({url, onCerrar}:{url:string; onCerrar:()=>void}){
  return (
    <div className="ticketImagenLightbox" onClick={onCerrar}>
      <img src={url} alt="Imagen adjunta ampliada"/>
    </div>
  );
}

function AdjuntoTicket({url}:{url:string}){
  const [ampliada,setAmpliada]=useState(false);
  if(esImagenAdjunta(url)){
    return <>
      <button type="button" onClick={()=>setAmpliada(true)} className="ticketAdjuntoImagenLink">
        <img src={url} alt="Captura adjunta al ticket" className="ticketAdjuntoImagen"/>
      </button>
      {ampliada && <LightboxImagenTicket url={url} onCerrar={()=>setAmpliada(false)}/>}
    </>;
  }
  return <a href={url} target="_blank" rel="noreferrer">{url}</a>;
}

// Bloque dedicado para mostrar la imagen adjunta en grande, con marco y
// boton de descarga -- separado del renglon de metadatos (Fecha/Estado)
// porque una imagen no cabe bien ahi como un dato mas en linea.
function ImagenAdjuntaTicket({url}:{url:string}){
  const [ampliada,setAmpliada]=useState(false);
  return (
    <div className="ticketAdjuntoBox">
      <span className="ticketAdjuntoLabel"><Paperclip size={13}/> Imagen adjunta</span>
      <button type="button" onClick={()=>setAmpliada(true)} className="ticketAdjuntoImagenBtn">
        <img src={url} alt="Imagen adjunta al ticket" className="ticketAdjuntoImagenGrande"/>
      </button>
      <a href={url} download={`adjunto-ticket.${extensionImagen(url)}`} className="ticketAdjuntoDescargar">
        <Download size={14}/> Descargar imagen
      </a>
      {ampliada && <LightboxImagenTicket url={url} onCerrar={()=>setAmpliada(false)}/>}
    </div>
  );
}

function AdminTicketsView({
  tickets,
  onResponder,
  onCambiarEstado,
  onCambiarPrioridad,
}:{
  tickets:SupportTicket[];
  onResponder:(idTicket:number, mensaje:string)=>Promise<void>;
  onCambiarEstado:(idTicket:number, estado:'Abierto'|'En proceso'|'Resuelto')=>Promise<void>;
  onCambiarPrioridad:(idTicket:number, prioridad:'Baja'|'Media'|'Alta')=>Promise<void>;
}){
  const [filtro,setFiltro]=useState('Todos');
  const [filtroPrioridad,setFiltroPrioridad]=useState('Todas');
  const [busqueda,setBusqueda]=useState('');
  const [ticketSeleccionadoId,setTicketSeleccionadoId]=useState<string|null>(null);
  const [respuesta,setRespuesta]=useState('');
  const [enviando,setEnviando]=useState(false);
  const detalleRef=useRef<HTMLElement>(null);

  // Al elegir un ticket de la lista, el panel de detalle recien aparece debajo
  // (antes no existia en el DOM), asi que hay que esperar a que React lo
  // renderice para poder hacerle scroll -- por eso va en un efecto que
  // reacciona al id seleccionado, no directo en el onClick de la fila.
  useEffect(()=>{
    if(ticketSeleccionadoId){
      detalleRef.current?.scrollIntoView({behavior:'smooth', block:'start'});
    }
  },[ticketSeleccionadoId]);

  const ticketsFiltrados=tickets.filter(ticket=>{
    const coincideEstado=filtro==='Todos' || ticket.estado===filtro;
    const coincidePrioridad=filtroPrioridad==='Todas' || ticket.prioridad===filtroPrioridad;

    const textoBusqueda=busqueda.trim().toLowerCase();

    const coincideBusqueda=
      !textoBusqueda ||
      ticket.id.toLowerCase().includes(textoBusqueda) ||
      ticket.titulo.toLowerCase().includes(textoBusqueda) ||
      ticket.tipo.toLowerCase().includes(textoBusqueda) ||
      ticket.apartado.toLowerCase().includes(textoBusqueda);

    return coincideEstado && coincidePrioridad && coincideBusqueda;
  });

  const pendientes=tickets.filter(ticket=>ticket.estado==='Abierto').length;
  const enProceso=tickets.filter(ticket=>ticket.estado==='En proceso').length;
  const resueltos=tickets.filter(ticket=>ticket.estado==='Resuelto').length;

  const ticketSeleccionado=tickets.find(
    ticket=>ticket.id===ticketSeleccionadoId
  );

  const abrirTicket=(ticket:SupportTicket)=>{
    setTicketSeleccionadoId(ticket.id);
    setRespuesta('');
  };

  // El estado solo cambia junto con una respuesta real -- no tiene sentido
  // marcar "En proceso" o "Resuelto" sin dejar constancia de que se hizo
  // algo, asi que ambos botones exigen el mensaje y lo envian como parte de
  // la misma accion (en vez de dos acciones sueltas e independientes).
  const responderYCambiarEstado=async(nuevoEstado:'En proceso'|'Resuelto')=>{
    if(!ticketSeleccionado){
      return;
    }

    if(!respuesta.trim()){
      alert('Escribe una respuesta antes de cambiar el estado del ticket.');
      return;
    }

    setEnviando(true);
    try{
      await onResponder(ticketSeleccionado.id_ticket, respuesta.trim());
      await onCambiarEstado(ticketSeleccionado.id_ticket, nuevoEstado);
      setRespuesta('');
      alert(`Respuesta enviada y ticket ${ticketSeleccionado.id} marcado como "${nuevoEstado}".`);
    }catch(error){
      alert(error instanceof Error?error.message:'No se pudo actualizar el ticket.');
    }finally{
      setEnviando(false);
    }
  };


  return (
    <div className="adminTicketsPage">

      <section className="adminTicketsStats">

        <div className="adminTicketStat">
          <span>Pendientes</span>
          <strong>{pendientes}</strong>
        </div>

        <div className="adminTicketStat">
          <span>En proceso</span>
          <strong>{enProceso}</strong>
        </div>

        <div className="adminTicketStat">
          <span>Resueltos</span>
          <strong>{resueltos}</strong>
        </div>

      </section>

      <section className="card adminTicketsPanel">

        <div className="cardHead">
          <div>
            <b>Tickets recibidos</b>
            <span>Solicitudes generadas desde el apartado de soporte</span>
          </div>

          <Ticket size={20}/>
        </div>

        <div className="adminTicketsToolbar">

          <input
            type="text"
            value={busqueda}
            onChange={e=>setBusqueda(e.target.value)}
            placeholder="Buscar ticket..."
          />

          <select
            value={filtro}
            onChange={e=>setFiltro(e.target.value)}
          >
            <option value="Todos">Todos los estados</option>
            <option value="Abierto">Pendientes</option>
            <option value="En proceso">En proceso</option>
            <option value="Resuelto">Resueltos</option>
          </select>

          <select
            value={filtroPrioridad}
            onChange={e=>setFiltroPrioridad(e.target.value)}
          >
            <option value="Todas">Toda prioridad</option>
            <option value="Sin asignar">Sin asignar</option>
            <option value="Alta">Alta</option>
            <option value="Media">Media</option>
            <option value="Baja">Baja</option>
          </select>

        </div>

        <div className="adminTicketsList">

          {ticketsFiltrados.length===0 ? (

            <div className="emptyState">
              <Ticket size={30}/>
              <strong>No hay tickets registrados</strong>
              <span>
                Los tickets generados por los usuarios aparecerán aquí.
              </span>
            </div>

          ) : (

            ticketsFiltrados.map(ticket=>(

              <button
                key={ticket.id}
                type="button"
                className="adminTicketRow"
                onClick={()=>abrirTicket(ticket)}
              >

                <div className="adminTicketId">
                  <strong>{ticket.id}</strong>
                  <span>{ticket.fecha}</span>
                </div>

                <div className="adminTicketInfo">
                  <strong>{ticket.titulo}</strong>
                  <div className="adminTicketMetaRow">
                    <span>{ticket.tipo} · {ticket.apartado}</span>
                    <span className={`ticketPrioridad ${prioridadClase(ticket.prioridad)}`}>{ticket.prioridad}</span>
                  </div>
                </div>

                <span className={`adminTicketStatus status-${ticket.estado.toLowerCase().replace(' ','-')}`}>
                  {ticket.estado}
                </span>

              </button>

            ))

          )}

        </div>

      </section>

      {ticketSeleccionado && (

        <section className="card adminTicketsPanel adminTicketDetail" ref={detalleRef}>

          <div className="cardHead">

            <div>
              <b>{ticketSeleccionado.id} · {ticketSeleccionado.titulo}</b>
              <span className="adminTicketHeadMeta">
                <span><Users size={12}/> {ticketSeleccionado.creadoPor} · {ticketSeleccionado.creadoPorEmail}</span>
                <span>Tipo: <b>{ticketSeleccionado.tipo}</b></span>
                <span>Apartado: <b>{ticketSeleccionado.apartado}</b></span>
                <span>
                  Prioridad:
                  <select
                    className={`ticketPrioridadSelect ${prioridadClase(ticketSeleccionado.prioridad)}`}
                    value={ticketSeleccionado.prioridad}
                    onClick={ev=>ev.stopPropagation()}
                    onChange={e=>onCambiarPrioridad(ticketSeleccionado.id_ticket, e.target.value as 'Baja'|'Media'|'Alta')}
                    title="Solo soporte puede ajustar que tan urgente es este ticket"
                  >
                    {ticketSeleccionado.prioridad==='Sin asignar' && (
                      <option value="Sin asignar" disabled>Sin asignar</option>
                    )}
                    <option value="Baja">Baja</option>
                    <option value="Media">Media</option>
                    <option value="Alta">Alta</option>
                  </select>
                </span>
              </span>
            </div>

            <button
              type="button"
              className="linkBtn"
              onClick={()=>{
                setTicketSeleccionadoId(null);
                setRespuesta('');
              }}
            >
              Cerrar
            </button>

          </div>

          <div className="adminTicketDetailBody">

            <div className="adminTicketMeta">

              <span>
                <b>Fecha:</b> {ticketSeleccionado.fecha}
              </span>

              <span>
                <b>Estado:</b> {ticketSeleccionado.estado}
              </span>

              {ticketSeleccionado.archivo && !esImagenAdjunta(ticketSeleccionado.archivo) && (
                <span>
                  <Paperclip size={13}/>
                  <b>Archivo:</b> <AdjuntoTicket url={ticketSeleccionado.archivo}/>
                </span>
              )}

            </div>

            {ticketSeleccionado.archivo && esImagenAdjunta(ticketSeleccionado.archivo) && (
              <ImagenAdjuntaTicket url={ticketSeleccionado.archivo}/>
            )}

            <div className="adminTicketDescription">
              <span>Descripción</span>
              <p>{ticketSeleccionado.descripcion}</p>
            </div>

            <TicketThread respuestas={ticketSeleccionado.respuestas}/>

            {ticketSeleccionado.estado==='Resuelto' ? (
              <div className="adminTicketActions">
                <button
                  type="button"
                  className="adminTicketBtn"
                  onClick={()=>onCambiarEstado(ticketSeleccionado.id_ticket,'En proceso')}
                  title="Vuelve a dejar el ticket En proceso, por si se cerró por error"
                >
                  Reabrir ticket
                </button>
              </div>
            ) : <>
            <label className="adminTicketResponse">
              Responder ticket

              <textarea
                value={respuesta}
                onChange={e=>setRespuesta(e.target.value)}
                placeholder="Escribe la respuesta para el usuario... (obligatoria para cambiar el estado)"
                rows={5}
              />
            </label>

            <div className="adminTicketActions">

              <button
                type="button"
                className="adminTicketBtn"
                onClick={()=>responderYCambiarEstado('En proceso')}
                disabled={enviando}
                title="Envía la respuesta de arriba y marca el ticket como En proceso"
              >
                <Send size={15}/>
                {enviando?'Enviando…':'Responder y marcar en proceso'}
              </button>

              <button
                type="button"
                className="adminTicketBtn primary"
                onClick={()=>responderYCambiarEstado('Resuelto')}
                disabled={enviando}
                title="Envía la respuesta de arriba y marca el ticket como Resuelto"
              >
                <Send size={15}/>
                {enviando?'Enviando…':'Responder y marcar resuelto'}
              </button>

            </div>
            </>}

          </div>

        </section>

      )}

    </div>
  );
}

function SoporteView({
  tickets,
  catalogos,
  onCrear,
  onResponderUsuario,
}:{
  tickets:SupportTicket[];
  catalogos:{tipos:CatalogoTicket[]; apartados:CatalogoApartado[]};
  onCrear:(idTipo:number, idApartado:number|null, titulo:string, descripcion:string, archivoUrl:string|null)=>Promise<unknown>;
  onResponderUsuario:(idTicket:number, mensaje:string)=>Promise<void>;
}){

  const [idTipo,setIdTipo] = useState<number|''>('');
  const [idApartado,setIdApartado] = useState<number|''>('');
  const [titulo,setTitulo] = useState('');
  const [descripcion,setDescripcion] = useState('');
  const [archivoUrl,setArchivoUrl] = useState('');
  const [archivoError,setArchivoError] = useState('');
  const [enviando,setEnviando] = useState(false);
  // Borrador de respuesta del usuario por ticket (antes de enviarla al
  // backend) -- se guarda por codigo_ticket, no se pisa con la respuesta ya
  // persistida mientras se esta escribiendo una nueva.
  const [borradores,setBorradores] = useState<Record<string,string>>({});
  const [enviandoRespuesta,setEnviandoRespuesta] = useState<string|null>(null);

  // Primer tipo/apartado activo como valor por defecto del select, una vez
  // que el catalogo real (tipo_ticket/apartado_ticket) termina de cargar.
  useEffect(()=>{
    if(idTipo==='' && catalogos.tipos.length) setIdTipo(catalogos.tipos[0].id_tipo);
  },[catalogos.tipos, idTipo]);
  useEffect(()=>{
    if(idApartado==='' && catalogos.apartados.length) setIdApartado(catalogos.apartados[0].id_apartado);
  },[catalogos.apartados, idApartado]);

  // Limite de tamaño del archivo original (antes de codificar a base64,
  // que agrega ~33% de peso) para no mandar imagenes gigantes al backend.
  const LIMITE_ADJUNTO_BYTES = 3*1024*1024;

  const seleccionarArchivo = (archivo:File|undefined) => {
    setArchivoError('');
    if(!archivo) return;
    if(!archivo.type.startsWith('image/')){
      setArchivoError('Solo se permiten imágenes (PNG, JPG, GIF, WEBP).');
      return;
    }
    if(archivo.size > LIMITE_ADJUNTO_BYTES){
      setArchivoError('La imagen pesa demasiado (máximo 3 MB).');
      return;
    }
    const lector = new FileReader();
    lector.onload = () => setArchivoUrl(typeof lector.result==='string'?lector.result:'');
    lector.onerror = () => setArchivoError('No se pudo leer la imagen.');
    lector.readAsDataURL(archivo);
  };

  const crearTicket = async () => {
    if(!titulo.trim() || !descripcion.trim()){
      alert('Completa el título y la descripción del problema.');
      return;
    }
    if(idTipo===''){
      alert('Selecciona un tipo de solicitud.');
      return;
    }

    setEnviando(true);
    try{
      // La prioridad la decide soporte al revisar el ticket, no quien lo
      // reporta -- el ticket entra "Sin asignar" (lo fija el backend) y
      // soporte la ajusta despues (ver selector en AdminTicketsView).
      const creado=await onCrear(idTipo, idApartado===''?null:idApartado, titulo.trim(), descripcion.trim(), archivoUrl.trim()||null);
      setTitulo('');
      setDescripcion('');
      setArchivoUrl('');
      setArchivoError('');
      alert(`Ticket ${(creado as {codigo_ticket:string}).codigo_ticket} creado correctamente.`);
    }catch(error){
      alert(error instanceof Error?error.message:'No se pudo crear el ticket.');
    }finally{
      setEnviando(false);
    }
  };

  const enviarRespuestaUsuario = async (ticket:SupportTicket) => {
    const mensaje=(borradores[ticket.id]||'').trim();
    if(!mensaje){
      alert('Escribe una respuesta antes de enviarla.');
      return;
    }
    setEnviandoRespuesta(ticket.id);
    try{
      await onResponderUsuario(ticket.id_ticket, mensaje);
      setBorradores(prev=>({...prev, [ticket.id]:''}));
      alert(`Respuesta enviada al soporte para ${ticket.id}.`);
    }catch(error){
      alert(error instanceof Error?error.message:'No se pudo enviar la respuesta.');
    }finally{
      setEnviandoRespuesta(null);
    }
  };

  return (
    <div className="sectionGrid supportSection">

      {/* =========================
          CONTACTO DE SOPORTE
          ========================= */}

      <section className="panel supportPanel">

        <div className="supportPanelHead">
          <div>
            <h2>Contacto de soporte</h2>
            <p>Asistencia técnica y atención rápida</p>
          </div>

          <LifeBuoy size={20}/>
        </div>

        <div className="supportPanelBody">

          <div className="supportContactGrid">

            <div className="supportContactCard">
              <div className="supportContactIcon">
                <Mail size={20}/>
              </div>

              <div>
                <span>Correo de asistencia</span>
                <strong>soporte@alerta360.cl</strong>
              </div>
            </div>

            <div className="supportContactCard">
              <div className="supportContactIcon">
                <Phone size={20}/>
              </div>

              <div>
                <span>Anexo de asistencia rápida</span>
                <strong>Anexo 1234</strong>
              </div>
            </div>

          </div>

        </div>

      </section>


      {/* =========================
          REPORTAR INCIDENCIA
          ========================= */}

      <section className="panel supportPanel">

        <div className="supportPanelHead">
          <div>
            <h2>Reportar incidencia</h2>
            <p>Errores, bugs y propuestas de mejora</p>
          </div>

          <Bug size={20}/>
        </div>

        <div className="supportPanelBody">

          <div className="supportForm">

            <div className="formGrid">

              <label>
                Tipo de solicitud

                <select
                  value={idTipo}
                  onChange={e=>setIdTipo(Number(e.target.value))}
                >
                  {catalogos.tipos.map(t=><option key={t.id_tipo} value={t.id_tipo}>{t.nombre_tipo}</option>)}
                </select>
              </label>


              <label>
                Apartado afectado

                <select
                  value={idApartado}
                  onChange={e=>setIdApartado(Number(e.target.value))}
                >
                  {catalogos.apartados.map(a=><option key={a.id_apartado} value={a.id_apartado}>{a.nombre_apartado}</option>)}
                </select>
              </label>

            </div>


            <label>
              Título del reporte

              <input
                type="text"
                value={titulo}
                onChange={e=>setTitulo(e.target.value)}
                placeholder="Ej: No se muestran las unidades disponibles"
              />
            </label>


            <label>
              Descripción

              <textarea
                value={descripcion}
                onChange={e=>setDescripcion(e.target.value)}
                placeholder="Describe detalladamente el problema o propuesta..."
                rows={5}
              />
            </label>


              <label>
                Imagen adjunta (opcional, máx. 3 MB)

                <input
                  type="file"
                  accept="image/*"
                  onChange={e=>seleccionarArchivo(e.target.files?.[0])}
                />
              </label>

            {archivoError && (
              <div className="supportFileError">{archivoError}</div>
            )}

            {archivoUrl.trim() && !archivoError && (
              <div className="supportFile">
                <img src={archivoUrl} alt="Vista previa de la imagen adjunta" className="supportFilePreview"/>
                <button type="button" className="supportFileRemove" onClick={()=>setArchivoUrl('')}>
                  Quitar imagen
                </button>
              </div>
            )}


            <div className="supportActions">

              <button
                className="supportSubmit"
                onClick={crearTicket}
                disabled={enviando}
              >
                <Ticket size={17}/>
                {enviando?'Generando…':'Generar ticket'}
              </button>

            </div>

          </div>

        </div>

      </section>


      {/* =========================
          TICKETS GENERADOS
          ========================= */}

      <section className="panel supportPanel">

        <div className="supportPanelHead">
          <div>
            <h2>Tickets generados</h2>
            <p>Seguimiento de solicitudes de soporte y mantenimiento</p>
          </div>

          <Ticket size={20}/>
        </div>


        <div className="supportPanelBody">

          {tickets.length === 0 ? (

            <div className="emptyState">
              <LifeBuoy size={30}/>
              <strong>No hay tickets registrados</strong>
              <span>
                Los tickets generados desde el formulario aparecerán aquí.
              </span>
            </div>

          ) : (

            <div className="ticketList">

              {tickets.map(ticket => (

                <div className="ticketCard" key={ticket.id}>

                  <div className="ticketTop">

                    <strong>{ticket.id}</strong>

                    <div className="ticketTopBadges">
                      <span className={`ticketPrioridad ${prioridadClase(ticket.prioridad)}`}>{ticket.prioridad}</span>
                      <span>{ticket.estado}</span>
                    </div>

                  </div>


                  <h3>{ticket.titulo}</h3>

                  <p>{ticket.descripcion}</p>


                  <div className="ticketMeta">

                    <span>{ticket.tipo}</span>

                    <span>{ticket.apartado}</span>

                  </div>


                  {ticket.archivo && !esImagenAdjunta(ticket.archivo) && (
                    <div className="ticketAttachment">
                      <Paperclip size={13}/>
                      <AdjuntoTicket url={ticket.archivo}/>
                    </div>
                  )}

                  {ticket.archivo && esImagenAdjunta(ticket.archivo) && (
                    <ImagenAdjuntaTicket url={ticket.archivo}/>
                  )}

                  <TicketThread respuestas={ticket.respuestas}/>

                  {ticket.estado==='En proceso' && (
                    <div className="ticketUserReply">

                      <strong>Responder al soporte</strong>

                      <textarea
                        value={borradores[ticket.id] ?? ''}
                        onChange={e=>{
                          const texto=e.target.value;
                          setBorradores(prev=>({...prev, [ticket.id]:texto}));
                        }}
                        placeholder="Escribe una respuesta para el equipo de soporte..."
                        rows={4}
                      />

                      <button
                        type="button"
                        onClick={()=>enviarRespuestaUsuario(ticket)}
                        disabled={enviandoRespuesta===ticket.id}
                      >
                        <Send size={14}/>
                        {enviandoRespuesta===ticket.id?'Enviando…':'Enviar respuesta'}
                      </button>

                    </div>
                  )}

                  <small>{ticket.fecha}</small>

                </div>

              ))}

            </div>

          )}

        </div>

      </section>

    </div>
  );
}

function ConfiguracionView({soundOn,onToggleSound,autoRefreshSec,onChangeAutoRefresh,onNotify,auth,onLogout,isAdmin,timeoutMinutos,onChangeTimeout}:{soundOn:boolean;onToggleSound:(v:boolean)=>void;autoRefreshSec:number;onChangeAutoRefresh:(v:number)=>void;onNotify:(s:string)=>void;auth:{nombre:string;email:string;rol:UserRole};onLogout:()=>void;isAdmin:boolean;timeoutMinutos:number;onChangeTimeout:(v:number)=>void}){
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

// Sesion persistida en localStorage para que F5/recargar la pagina no pida
// login de nuevo. La version anterior de esto validaba el token guardado
// de forma ASINCRONA al montar la app (un fetch a /auth/me antes de fijar
// `auth`), y esa espera causaba una carrera real con el patrullaje: varios
// efectos que dependen de `auth` arrancaban con `auth` todavia en null,
// disparando llamadas (p.ej. /route) sin el header Authorization y
// recibiendo 401 sueltos justo al reiniciar. La solucion aca es NO validar
// nada de forma asincrona: el token guardado se confia de entrada (se lee
// de forma SINCRONA en el useState inicial, antes de que corra ningun
// efecto), y si en realidad ya vencio (dura 12h, ver EXPIRACION_HORAS en
// core/auth.py), el primer fetch real que haga la app devuelve 401 y el
// usuario simplemente tiene que loguearse de nuevo -- no distinto a lo que
// ya pasaba antes si alguien dejaba la sesion abierta mas de 12 horas.
const SESION_KEY='alerta360-sesion';
const SECCION_KEY='alerta360-seccion';
type Auth={token:string; nombre:string; email:string; rol:UserRole};
function leerSesionGuardada():Auth|null{
  try{
    const raw=localStorage.getItem(SESION_KEY);
    return raw?JSON.parse(raw):null;
  }catch{ return null; }
}

function App(){
 const [auth,setAuth]=useState<Auth|null>(leerSesionGuardada);

 // currentToken (variable de modulo) es lo que leen las funciones sueltas
 // fuera de React (obtenerRutaReal) para mandar el header Authorization.
 useEffect(()=>{ currentToken=auth?.token ?? null; },[auth]);

const handleLogin=(
  token:string,
  nombre:string,
  email:string,
  rol:UserRole
)=>{
  const sesion={token,nombre,email,rol};
  setAuth(sesion);
  try{ localStorage.setItem(SESION_KEY, JSON.stringify(sesion)); }catch{ /* localStorage no disponible (modo incognito, etc.) -- la sesion sigue funcionando, solo no sobrevive a un F5 */ }
  // Admin entra directo al formulario de ingreso rapido de emergencias
  // (CAD) -- visualizador y soporte mantienen su landing de siempre.
  setSection(rol==='soporte'?'Tickets':rol==='admin'?'Formulario':'Dashboard');
};

 const handleLogout=()=>{
   setAuth(null);
   try{ localStorage.removeItem(SESION_KEY); localStorage.removeItem(SECCION_KEY); }catch{ /* ignorar */ }
 };
 // RBAC: "admin" (coordinacion/despacho, puede asignar/rechazar y editar
 // configuracion administrativa) vs "visualizador" (solo lectura -- puede
 // ver mapas/tableros y usar el filtro de cuartel, pero no despachar). El
 // backend vuelve a exigir esto por su cuenta en /assignment/recommend
 // (ver requiere_admin en main.py); esto de aca es solo para la UI.
 const isAdmin=auth?.rol==='admin';

const isAdminSoporte=auth?.rol==='soporte';

 //-------------------NUEVA BASE DE DATOS
useEffect(()=>{
  if(!auth) return;

  let cancelado=false;

  const cargarEmergencias=async()=>{
    try{
      const emergencias=await obtenerEmergenciasBD();

      if(cancelado) return;

      setQueue(emergencias);

      setApiError(null);

    }catch(error){
      if(cancelado) return;

      console.error('Error cargando emergencias:',error);

      setApiError(
        error instanceof Error
          ? error.message
          : 'No se pudieron cargar las emergencias'
      );
    }
  };

  cargarEmergencias();
  // Sin este repoleo, si la emergencia cambiaba de estado por otra via
  // (otra pestaña, un reinicio de la base en pruebas, etc.) esta pestaña
  // se quedaba para siempre con el estado viejo (ej. "Asignada" aunque el
  // vehiculo ya habia vuelto a su cuartel en la base real).
  const intervalo=window.setInterval(()=>{ void cargarEmergencias(); },10000);

  return()=>{
    cancelado=true;
    window.clearInterval(intervalo);
  };
},[auth]);

// Historial persistido en el backend (archivo local, NO en Postgres -- ver
// /historial en main.py). Antes el historial vivia solo en memoria del
// navegador (useState inicial en []) y se perdia con cada F5; esto lo
// recupera al entrar y lo mantiene sincronizado entre pestañas/roles.
useEffect(()=>{
  if(!auth) return;
  let cancelado=false;
  const cargarHistorial=async()=>{
    try{
      const respuesta=await fetch(`${API_BASE}/historial`, {credentials:'include', headers:{...authHeaders()}});
      if(!respuesta.ok || cancelado) return;
      const datos=await respuesta.json();
      if(cancelado) return;
      const entradas:HistorialEntry[]=(datos.historial||[]).map((e:any)=>({
        id:e.id, ts:e.ts, tipo:e.tipo as HistorialTipo, texto:e.texto,
      }));
      setHistorial(entradas);
      const maxId=entradas.reduce((m,e)=>Math.max(m,e.id),0);
      if(maxId>=historialIdRef.current) historialIdRef.current=maxId+1;
    }catch(error){
      if(!cancelado) console.error('No se pudo cargar el historial persistido:', error);
    }
  };
  cargarHistorial();
  const intervalo=window.setInterval(()=>{ void cargarHistorial(); },10000);
  return()=>{ cancelado=true; window.clearInterval(intervalo); };
},[auth]);

// Tickets de Soporte: ya vienen de verdad desde Postgres (ticket,
// respuesta_ticket, tipo_ticket, apartado_ticket -- ver /tickets en
// main.py), no de un useState local que se perdia con cada F5.
//
// Ademas, cada vez que se repolea se avisa (toast) al creador del ticket
// si le llego una respuesta OFICIAL nueva de soporte desde la ultima vez
// -- antes no se enteraba hasta entrar el solo a mirar.
const ultimasRespuestasOficialesRef=useRef<Record<string,number>>({});
const primerCargaTicketsRef=useRef(true);
const cargarTickets=async()=>{
  try{
    const respuesta=await fetch(`${API_BASE}/tickets`, {credentials:'include', headers:authHeaders()});
    if(!respuesta.ok) return;
    const datos=await respuesta.json();
    const nuevos:SupportTicket[]=(datos.tickets||[]).map(mapearTicketBD);

    if(!primerCargaTicketsRef.current && auth){
      for(const t of nuevos){
        const cantidadOficiales=t.respuestas.filter(r=>r.tipo_respuesta==='Respuesta').length;
        const anterior=ultimasRespuestasOficialesRef.current[t.id];
        if(
          t.creadoPorEmail===auth.email &&
          anterior!==undefined &&
          cantidadOficiales>anterior
        ){
          notify(`Soporte respondió tu ticket ${t.id}: "${t.titulo}"`);
        }
      }
    }
    nuevos.forEach(t=>{
      ultimasRespuestasOficialesRef.current[t.id]=t.respuestas.filter(r=>r.tipo_respuesta==='Respuesta').length;
    });
    primerCargaTicketsRef.current=false;

    setTickets(nuevos);
  }catch(error){
    console.error('No se pudieron cargar los tickets:', error);
  }
};
useEffect(()=>{
  if(!auth) return;
  void cargarTickets();
  const intervalo=window.setInterval(()=>{ void cargarTickets(); },10000);
  return()=>{ window.clearInterval(intervalo); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
},[auth]);

useEffect(()=>{
  if(!auth) return;
  let cancelado=false;
  (async()=>{
    try{
      const respuesta=await fetch(`${API_BASE}/tickets/catalogos`, {credentials:'include', headers:authHeaders()});
      if(!respuesta.ok || cancelado) return;
      const datos=await respuesta.json();
      if(!cancelado) setCatalogoTickets({tipos:datos.tipos||[], apartados:datos.apartados||[]});
    }catch(error){
      if(!cancelado) console.error('No se pudo cargar el catálogo de tickets:', error);
    }
  })();
  return()=>{cancelado=true;};
},[auth]);

 //--------------------------------------------

 // Tambien se restaura el apartado que se estaba viendo (no solo la
 // sesion): si no, un F5 dejaba logueado pero igual "interrumpia" saltando
 // siempre de vuelta al Dashboard/Formulario por defecto en vez de seguir
 // donde estaba el operador.
 const [section,setSection]=useState<string>(()=>{
   try{ return localStorage.getItem(SECCION_KEY) || 'Dashboard'; }catch{ return 'Dashboard'; }
 });
 useEffect(()=>{
   try{ localStorage.setItem(SECCION_KEY, section); }catch{ /* ignorar */ }
 },[section]);
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
 const [resources,setResources]=useState<Resource[]>([]);
 const [recursosCargados,setRecursosCargados]=useState(false); 


 //--------------NUEVA BASE DE DATOS----------------
 const [queue,setQueue]=useState<Emergency[]>([]); 
 //-------------------------------------------------


 const [rechazadosPorEmergencia,setRechazadosPorEmergencia]=useState<Record<number,Set<string>>>({});
 const [historial,setHistorial]=useState<HistorialEntry[]>([]);
 const [tickets,setTickets]=useState<SupportTicket[]>([]);
 const [catalogoTickets,setCatalogoTickets]=useState<{tipos:CatalogoTicket[]; apartados:CatalogoApartado[]}>({tipos:[],apartados:[]});
 // ETA real e idoneidad de tipo de cada asignacion hecha esta sesion —
 // base para "Tiempo promedio" y "Cobertura estimada" del dashboard,
 // calculados de verdad en vez de numeros fijos.
 const [metricasAsignacion,setMetricasAsignacion]=useState<{etaMin:number; idoneidadTipo:number; compania:string}[]>([]);
 const [focus,setFocus]=useState<{lat:number;lng:number}|null>(null);
 // Centro a usar por el mapa de calor cuando se elige una zona desde una
 // alerta predictiva o el resumen de "mayor demanda esperada" (independiente
 // del "focus" del mapa operacional, que es para emergencias/recursos).
 const [focusHeatmap,setFocusHeatmap]=useState<{lat:number;lng:number}|null>(null);
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
 // Emergencia elegida a mano al tocar su marcador en el mapa (cualquier
 // rol, incluido visualizador) -- tiene prioridad sobre la seleccion
 // automatica (ver currentEmergencia) para que la tarjeta lateral pueda
 // mostrar cualquier alerta activa, no solo la que toca despachar primero.
 const [emergenciaSeleccionadaId,setEmergenciaSeleccionadaId]=useState<number|null>(null);

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
 const resourcesCargadosRef=useRef(false);
 const despachosReanudadosRef=useRef(false);
 const catalogoBDRef=useRef<Resource[]>([]);
 const operacionesPendientesRef=useRef<Set<string>>(new Set());
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
 // Carga inicial desde PostgreSQL.
// Los códigos B-1, R-5, BF-V10, etc. son la identidad
// estable de cada vehículo en el frontend.
 useEffect(() => {
  if (!auth) {
    setRecursosCargados(false);
    resourcesCargadosRef.current = false;
    catalogoBDRef.current = [];
    setResources([]);
    return;
  }

  let cancelado = false;

  const cargarRecursos = async () => {
    try {
      const resp = await fetch(`${API_BASE}/resources`, {
        credentials: 'include',
        headers: authHeaders(),
      });

      if (!resp.ok) {
        throw new Error(`Error HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const filas = data.resources;

      if (!Array.isArray(filas)) {
        throw new Error('Respuesta de recursos inválida');
      }

      const recursosBD: Resource[] = filas.map((fila: any) => {
        const codigo = String(fila.codigo ?? fila.codigo_recurso ?? '').trim();
        if (!codigo) throw new Error('PostgreSQL devolvió un recurso sin código');

        const lat = Number(fila.lat ?? fila.latitud_recurso);
        const lng = Number(fila.lng ?? fila.longitud_recurso);
        const homeLat = Number(fila.lat_compania ?? fila.latitud_compania);
        const homeLng = Number(fila.lng_compania ?? fila.longitud_compania);
        if (
          fila.lat == null && fila.latitud_recurso == null ||
          fila.lng == null && fila.longitud_recurso == null ||
          !Number.isFinite(lat) || !Number.isFinite(lng) ||
          !Number.isFinite(homeLat) || !Number.isFinite(homeLng) ||
          (fila.lat_compania == null && fila.latitud_compania == null) ||
          (fila.lng_compania == null && fila.longitud_compania == null)
        ) throw new Error(`Coordenadas incompletas en PostgreSQL para ${codigo}`);

        const estado = String(fila.estado ?? fila.estado_radio ?? '').trim() as RadioState;
        if (!(estado in RADIO_LABELS)) {
          throw new Error(`Estado radial inválido en PostgreSQL para ${codigo}: ${estado}`);
        }
        const tipo = tipoRecursoBD(fila.tipo ?? fila.tipo_recurso, codigo);
        return {
          id: codigo,
          codigo,
          name: nombreRecursoBD(fila, codigo, tipo),
          type: tipo,
          lat, lng, homeLat, homeLng,
          radioState: estado,
          crew: Number(fila.dotacion ?? fila.dotacion_recurso ?? 0),
          capacity: String(fila.capacidad ?? fila.capacitacion ?? fila.capacitacion_recurso ?? tipo),
          compania: String(fila.compania ?? fila.nombre_compania ?? 'Sin compañía'),
          sector: String(fila.sector ?? fila.sector_compania ?? 'Sin sector'),
          eta: Number(fila.eta ?? 0),
          distance: Number(fila.distance ?? 0),
          tramo: undefined,
          destino: undefined,
        };
      });

      if (new Set(recursosBD.map(r => r.id)).size !== recursosBD.length) {
        throw new Error('PostgreSQL devolvió códigos de recurso duplicados');
      }

      if (cancelado) return;

      catalogoBDRef.current = recursosBD;
      setResources(anteriores => {
        // PostgreSQL manda siempre el estado (radioState, datos descriptivos).
        // Solo se conserva la animacion local (tramo/destino) cuando la base
        // CONFIRMA que sigue siendo el mismo despacho en curso -- si la base
        // ya no coincide (ej. quedo "pegado" en memoria pero la base dice
        // 6-0), se descarta la simulacion local y se usa el dato real, para
        // que un carro nunca quede atascado visualmente despues de recargar.
        // Orden del trayecto en curso. El poll cada 10s puede llegar ANTES
        // de que guardarPosiciones (cada 2s) haya alcanzado a persistir el
        // ultimo avance local (ej. 6-3->6-7 recien ocurrido) -- si en ese
        // caso se exige que coincidan exactamente, la base "vieja" (6-3)
        // pisa el avance local (6-7) y el destino se pierde, dejando el
        // carro pegado para siempre en "En trayecto". Por eso se conserva
        // lo local tambien cuando la base solo esta un paso atras.
        const ORDEN_TRAYECTO: Record<string, number> = { '6-3': 0, '6-7': 1, '6-8': 2 };
        const previos = new Map(anteriores.map(r => [r.id, r]));
        const resultado = recursosBD.map(db => {
          const anterior = previos.get(db.id);
          if (
            anterior?.destino &&
            anterior.radioState in ORDEN_TRAYECTO &&
            db.radioState in ORDEN_TRAYECTO &&
            ORDEN_TRAYECTO[db.radioState] <= ORDEN_TRAYECTO[anterior.radioState]
          ) {
            return { ...db, radioState: anterior.radioState, lat: anterior.lat, lng: anterior.lng,
              tramo: anterior.tramo, destino: anterior.destino,
              ultimaActualizacion: anterior.ultimaActualizacion };
          }
          return db;
        });
        resourcesRef.current = resultado;
        return resultado;
      });
      resourcesCargadosRef.current = true;
      setRecursosCargados(true);
      setApiError(null);

      console.log(
        `${recursosBD.length} recursos cargados desde PostgreSQL`
      );

    } catch (error) {
      if (cancelado) return;

      console.error('Error cargando recursos:', error);
      resourcesCargadosRef.current = false;
      setRecursosCargados(false);
      setApiError(
        'No se pudo cargar la flota desde PostgreSQL.'
      );
    }
  };

  void cargarRecursos();
  // Actualiza altas, bajas y cambios de la BD sin recargar la página.
  const intervalo = window.setInterval(() => { void cargarRecursos(); }, 10000);
  return () => {
    cancelado = true;
    window.clearInterval(intervalo);
  };
 }, [auth, isAdmin]);
 // Sincroniza periódicamente las posiciones de la flota con PostgreSQL.
 // Solo el administrador publica posiciones; los visualizadores no escriben.
 useEffect(() => {
  if (!auth || !isAdmin || !recursosCargados) return;

  let cancelado = false;
  let enviando = false;

  const guardarPosiciones = async () => {
    if (cancelado || enviando) return;

    enviando = true;

    try {
      const ahora = Date.now();

      await Promise.all(
        resourcesRef.current.filter(recurso =>
          recurso.destino && (recurso.radioState === '6-3' || recurso.radioState === '6-7' || recurso.radioState === '6-8')
        ).map(async (recurso) => {
          const posicion = posicionActual(recurso, ahora);
          const codigo = recurso.codigo ?? recurso.id;

          const respuesta = await fetch(
            `${API_BASE}/resources/${encodeURIComponent(codigo)}/position`,
            {
              method: 'PATCH',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
              },
              body: JSON.stringify({
                lat: posicion.lat,
                lng: posicion.lng,
                estado: recurso.radioState,
              }),
            }
          );

          if (!respuesta.ok) {
            console.error(
              `Error guardando posición de ${codigo}:`,
              respuesta.status
            );
          }
        })
      );
    } catch (error) {
      console.error(
        'No se pudieron sincronizar las posiciones:',
        error
      );
    } finally {
      enviando = false;
    }
  };

  const intervalo = window.setInterval(guardarPosiciones, 2000);

  return () => {
    cancelado = true;
    window.clearInterval(intervalo);
  };
 }, [auth, isAdmin, recursosCargados]);
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
 const prepararTramoOSRM = async (resourceId: string,origen: { lat: number; lng: number },destino: { lat: number; lng: number },duracionMs: number): Promise<Tramo> => {
  const ruta = await obtenerRutaReal(origen, destino);
  return {
    origen,
    destino,
    inicio: Date.now(),
    duracionMs,
    puntos: ruta.puntos,
    acumKm: ruta.acumKm,
  };
 };

const intentarPatrullaje = async () => {
  if (!resourcesCargadosRef.current) return;

  if (enPatrullajeRef.current.size >= MAX_EN_PATRULLAJE) {
    return;
  }

  const libres = resourcesRef.current.filter(
    r =>
      r.radioState === '6-0' &&
      !r.tramo &&
      !enPatrullajeRef.current.has(r.id) &&
      !operacionesPendientesRef.current.has(r.id)
  );

  if (!libres.length) return;

  const elegido = libres[Math.floor(Math.random() * libres.length)];
  const punto = elegirPuntoPatrullaje();
  const resourceId = elegido.id;

  const latCuartel = elegido.homeLat;
  const lngCuartel = elegido.homeLng;

  if (
    latCuartel == null ||
    lngCuartel == null ||
    !Number.isFinite(latCuartel) ||
    !Number.isFinite(lngCuartel)
  ) {
    console.error(`Cuartel sin coordenadas: ${resourceId}`);
    return;
  }

  const cuartel: { lat: number; lng: number } = {
    lat: latCuartel,
    lng: lngCuartel,
  };

  const origen = posicionActual(elegido, Date.now());

  const destinoPatrullaje = {
    lat: punto.lat,
    lng: punto.lng,
  };

  const distanciaKm = haversineKm(
    origen.lat,
    origen.lng,
    destinoPatrullaje.lat,
    destinoPatrullaje.lng
  );

  const duracionMs = Math.round(
    Math.max(
      20000,
      Math.min(
        etaMinutos(distanciaKm, 'urbano') * 3200,
        70000
      )
    )
  );

  // Reservar temporalmente la unidad mientras OSRM responde.
  operacionesPendientesRef.current.add(resourceId);

  try {
    // IDA: obtener primero la ruta por calles.
    const tramoIda = await prepararTramoOSRM(
      resourceId,
      origen,
      destinoPatrullaje,
      duracionMs
    );

    const vigente = resourcesRef.current.find(
      r => r.id === resourceId
    );

    if (
      !vigente ||
      vigente.radioState !== '6-0' ||
      vigente.tramo ||
      enPatrullajeRef.current.has(resourceId)
    ) {
      return;
    }

    // Solo ahora comienza el patrullaje.
    enPatrullajeRef.current.add(resourceId);
    clearResourceTimers(resourceId);

    setResources(rs =>
      rs.map(r =>
        r.id === resourceId
          ? { ...r, tramo: tramoIda }
          : r
      )
    );

    const tLlegada = window.setTimeout(() => {
      const alLlegar = resourcesRef.current.find(
        r => r.id === resourceId
      );

      if (
        !alLlegar ||
        alLlegar.radioState !== '6-0' ||
        alLlegar.tramo?.inicio !== tramoIda.inicio ||
        !enPatrullajeRef.current.has(resourceId)
      ) {
        return;
      }

      setResources(rs =>
        rs.map(r =>
          r.id === resourceId &&
          r.radioState === '6-0' &&
          r.tramo?.inicio === tramoIda.inicio
            ? {
                ...r,
                lat: destinoPatrullaje.lat,
                lng: destinoPatrullaje.lng,
                tramo: undefined,
              }
            : r
        )
      );

      const dwellMs = 6000 + Math.random() * 8000;

      const tRegreso = window.setTimeout(async () => {
        const antesDeVolver = resourcesRef.current.find(
          r => r.id === resourceId
        );

        if (
          !antesDeVolver ||
          antesDeVolver.radioState !== '6-0' ||
          !enPatrullajeRef.current.has(resourceId)
        ) {
          return;
        }

        try {
          // VUELTA: solicitar una nueva ruta OSRM.
          const tramoVuelta = await prepararTramoOSRM(
            resourceId,
            destinoPatrullaje,
            cuartel,
            duracionMs
          );

          const vigenteVuelta = resourcesRef.current.find(
            r => r.id === resourceId
          );

          if (
            !vigenteVuelta ||
            vigenteVuelta.radioState !== '6-0' ||
            vigenteVuelta.tramo ||
            !enPatrullajeRef.current.has(resourceId)
          ) {
            return;
          }

          setResources(rs =>
            rs.map(r =>
              r.id === resourceId &&
              r.radioState === '6-0'
                ? {
                    ...r,
                    tramo: tramoVuelta,
                  }
                : r
            )
          );

          const tFin = window.setTimeout(() => {
            const alFinal = resourcesRef.current.find(
              r => r.id === resourceId
            );

            if (
              !alFinal ||
              alFinal.radioState !== '6-0' ||
              alFinal.tramo?.inicio !== tramoVuelta.inicio
            ) {
              return;
            }

            setResources(rs =>
              rs.map(r =>
                r.id === resourceId &&
                r.radioState === '6-0' &&
                r.tramo?.inicio === tramoVuelta.inicio
                  ? {
                      ...r,
                      lat: cuartel.lat,
                      lng: cuartel.lng,
                      tramo: undefined,
                    }
                  : r
              )
            );

            enPatrullajeRef.current.delete(resourceId);
          }, tramoVuelta.duracionMs);

          registerResourceTimer(resourceId, tFin);

        } catch (error) {
          console.error(
            `OSRM no pudo calcular el regreso de patrullaje de ${resourceId}`,
            error
          );

          // La unidad permanece en el punto de patrullaje.
          // No se simula un regreso en línea recta.
          notify(
            `${resourceId}: no se pudo calcular el regreso por OSRM.`
          );
        }
      }, dwellMs);

      registerResourceTimer(resourceId, tRegreso);
    }, tramoIda.duracionMs);

    registerResourceTimer(resourceId, tLlegada);

  } catch (error) {
    console.error(
      `No se pudo iniciar patrullaje de ${resourceId}:`,
      error
    );
  } finally {
    operacionesPendientesRef.current.delete(resourceId);
  }
 };

 // Patrullaje automático DESACTIVADO: una unidad solo comienza a moverse
 // cuando se le asigna explícitamente una emergencia. Se conserva la
 // función intentarPatrullaje para una posible activación futura, pero
 // no existe ningún temporizador que la ejecute espontáneamente.


 // Publicar estado (solo admin): cada 2s manda al backend una foto del
 // despacho tal como esta en este instante en su navegador, para que las
 // cuentas visualizador vean lo mismo en vivo (ver /state en main.py).
 // Los Set no son serializables a JSON directo, por eso rechazados se
 // manda como arreglo de ids.
 useEffect(()=>{
   if(!auth || !isAdmin || !recursosCargados) return;
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
 },[auth, isAdmin, recursosCargados]);

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
         // /state solo aporta movimientos de unidades que siguen existiendo
         // en PostgreSQL; jamás puede introducir vehículos del catálogo viejo.
         if(Array.isArray(data.resources) && resourcesCargadosRef.current) {
           const remotos = new Map<string, Resource>(
             (data.resources as Resource[]).map(r => [String(r.codigo ?? r.id), r])
           );
           setResources(() => catalogoBDRef.current.map(db => {
             const remoto = remotos.get(db.codigo ?? db.id);
             if (!remoto) return db;
             return { ...db,
               lat: Number.isFinite(Number(remoto.lat)) ? Number(remoto.lat) : db.lat,
               lng: Number.isFinite(Number(remoto.lng)) ? Number(remoto.lng) : db.lng,
               radioState: remoto.radioState in RADIO_LABELS ? remoto.radioState : db.radioState,
               tramo: remoto.tramo,
               destino: remoto.destino,
               ultimaActualizacion: remoto.ultimaActualizacion,
             };
           }));
         }
         // La cola de emergencias YA se trae directo de Postgres cada 10s
         // (ver el otro efecto mas arriba, corre para cualquier rol) -- esa
         // fuente es la real y confiable. Si ademas se pisara aca con la
         // "foto" que publico el admin cada 2s, y esa foto estuviera vieja o
         // vacia (ej. el admin recien abrio su pestaña y su propia cola
         // todavia no cargaba), el visualizador veia las alertas aparecer y
         // desaparecer cada 2 segundos por esta carrera entre ambas fuentes.
         // Mismo motivo para no pisar "historial": ya se trae persistido
         // desde el backend (GET /historial, cada 10s, cualquier rol).
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
 // Orden NUMERICO por el numero de compañia ("1ª Cía...", "2ª Cía...",
 // "10ª Cía..."), no alfabetico -- .sort() por defecto compara como texto
 // y dejaba "10ª" antes que "1ª" (el caracter despues del "1" en "10ª" es
 // "0", que es menor que "ª" en "1ª").
 const numeroCompania=(nombre:string)=>Number(nombre.match(/^(\d+)/)?.[1] ?? Infinity);
 const companiasDisponibles=useMemo(
   ()=>Array.from(new Set(resources.map(r=>r.compania))).sort((a,b)=>numeroCompania(a)-numeroCompania(b)),
   [resources]
 );
 const resourcesFiltrados=useMemo(
   ()=>filtroCuartel==='todos'?resources:resources.filter(r=>r.compania===filtroCuartel),
   [resources, filtroCuartel]
 );

 // Si se eligio una emergencia a mano desde el mapa, esa manda sobre la
 // seleccion automatica (mientras siga activa -- si ya se resolvio y
 // desaparecio de la cola, cae sola de vuelta al criterio automatico).
 // Ese criterio automatico prioriza una emergencia Activa (sin despachar
 // todavia); si no hay ninguna, muestra la siguiente que siga en curso
 // (Asignada o En atencion) en vez de dejar el panel vacio -- siempre hay
 // algo que mostrar mientras quede una emergencia sin finalizar.
 const currentEmergencia=
   (emergenciaSeleccionadaId!=null ? queue.find(e=>e.id===emergenciaSeleccionadaId) : undefined) ??
   queue.find(e=>e.status==='Activa')??
   queue.find(e=>e.status==='Asignada'||e.status==='ASIGNADA')??
   queue.find(e=>e.status==='EN_ATENCION')??
   null;
 const claveActual=currentEmergencia?claves[currentEmergencia.codigo]:undefined;
 // La recomendacion se calcula SOLO sobre las unidades del cuartel elegido
 // en el filtro (si hay uno activo) -- asi "RECURSO RECOMENDADO" refleja
 // que unidad de ESA compañia respondería, no la mejor de toda la flota.
 // Ademas, solo se sugiere una unidad cuando la emergencia en pantalla
 // sigue "Activa" (sin despachar todavia) -- si ya tiene alguien respondiendo
 // (Asignada/En atencion) y se sigue mostrando aca solo porque no quedaba
 // ninguna otra Activa, no tiene sentido insistir con recomendar otro
 // carro para ella.
 const recommendation=useMemo(
   ()=>currentEmergencia?.status==='Activa'
     ? pickRecommendation(resourcesFiltrados,currentEmergencia,rechazadosPorEmergencia[currentEmergencia?.id??-1]||new Set(), claveActual, now)
     : null,
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

 const cambiarEstadoEmergenciaBD = async (
   id: number,
   estado: 'ASIGNADA' | 'EN_ATENCION' | 'FINALIZADA'
 ): Promise<void> => {
   const respuesta = await fetch(`${API_BASE}/emergencies/${id}/status`, {
     method: 'PATCH',
     credentials: 'include',
     headers: {'Content-Type': 'application/json', ...authHeaders()},
     body: JSON.stringify({estado}),
   });
   if (!respuesta.ok) {
     const detalle = await respuesta.text();
     throw new Error(`No se pudo cambiar la emergencia #${id} a ${estado}: ${respuesta.status} ${detalle}`);
   }
 };

 const pushHistorial=(tipo:HistorialTipo, texto:string)=>{
   setHistorial(h=>[{id:historialIdRef.current++, ts:Date.now(), tipo, texto}, ...h].slice(0,200));
   // Se persiste en el backend (archivo local, NO en Postgres) para que el
   // historial sobreviva a un F5 y se vea igual desde cualquier cuenta --
   // antes vivia solo en memoria del navegador y se perdia con cada recarga.
   void fetch(`${API_BASE}/historial`, {
     method: 'POST', credentials: 'include',
     headers: {'Content-Type': 'application/json', ...authHeaders()},
     body: JSON.stringify({tipo, texto}),
   }).catch(error => console.error('No se pudo guardar el evento en el historial persistente:', error));
 };


  //--------------------------NUEVA BASE DE DATOS
const spawnEmergencia = (): Emergency => {
  const seed =
    POOL_EMERGENCIAS[
      poolIndexRef.current % POOL_EMERGENCIAS.length
    ];

  poolIndexRef.current += 1;

  const id = emergenciaIdRef.current++;

  return {
    ...seed,
    id,
    status: 'Activa',
    creadaEn: Date.now(),
    prioridad: 3,
  };
};

 const advanceQueue=(resolvedId:number)=>{
  setQueue(q=>q.filter(e=>e.id!==resolvedId));

  setRechazadosPorEmergencia(r=>{
    const c={...r};
    delete c[resolvedId];
    return c;
  });
};

//--------------------------

 // El tramo de vuelta (6-8) usa la misma duracion que la ida: mismo
 // trayecto recorrido en sentido inverso, misma velocidad estimada.
 const scheduleResourceLifecycle = (
  resourceId: string,
  emergenciaSnap: Emergency,
  unidadInicial: Resource,
  duracionTramoMs: number
) => {
  // Cancelar temporizadores anteriores de esta unidad.
  clearResourceTimers(resourceId);
  enPatrullajeRef.current.delete(resourceId);

  const tiempoTrabajo =
    TIEMPO_TRABAJO_MS[emergenciaSnap.codigo] ?? 18000;

  // Coordenadas REALES del cuartel, cargadas desde PostgreSQL.
  const latCuartel = unidadInicial.homeLat;
  const lngCuartel = unidadInicial.homeLng;

  if (
    latCuartel == null ||
    lngCuartel == null ||
    !Number.isFinite(latCuartel) ||
    !Number.isFinite(lngCuartel)
  ) {
    console.error(`La unidad ${resourceId} no tiene coordenadas válidas de compañía`);
    notify(`No se pudo configurar el regreso de ${resourceId}: cuartel sin coordenadas`);
    return;
  }

  const home: { lat: number; lng: number } = {
    lat: latCuartel,
    lng: lngCuartel,
  };

  // Guarda cuando deberia ocurrir cada transicion (epoch ms) para poder
  // retomar el ciclo si la pagina se recarga antes de que termine -- ver
  // comentario de DespachoPersistido mas arriba.
  const horaInicio = Date.now();
  const llegaEn = horaInicio + duracionTramoMs;
  const finalizaEn = llegaEn + tiempoTrabajo;
  const regresaEn = finalizaEn + duracionTramoMs;
  guardarDespachoLS(resourceId, {
    emergenciaId: emergenciaSnap.id,
    codigo: emergenciaSnap.codigo,
    address: emergenciaSnap.address,
    destLat: emergenciaSnap.lat,
    destLng: emergenciaSnap.lng,
    homeLat: home.lat,
    homeLng: home.lng,
    llegaEn, finalizaEn, regresaEn,
  });

  // 1. Esperar hasta que termine el trayecto de ida.
  const tLlegada = window.setTimeout(() => {
    const actual = resourcesRef.current.find(
      r => r.id === resourceId
    );

    // Si fue redirigida o cambió de estado, no ejecutar
    // la llegada correspondiente a una misión anterior.
    if (
      !actual ||
      actual.radioState !== '6-3' ||
      actual.destino?.emergenciaId !== emergenciaSnap.id
    ) {
      return;
    }

    void cambiarEstadoEmergenciaBD(emergenciaSnap.id, 'EN_ATENCION')
      .then(() => setQueue(q => q.map(e => e.id === emergenciaSnap.id ? {...e, status: 'EN_ATENCION'} : e)))
      .catch(error => { console.error(error); notify(`Error guardando atención de emergencia #${emergenciaSnap.id}`); });

    // La unidad llegó a la emergencia.
    setResources(rs =>
      rs.map(r =>
        r.id === resourceId &&
        r.radioState === '6-3' &&
        r.destino?.emergenciaId === emergenciaSnap.id
          ? {
              ...r,
              radioState: '6-7' as RadioState,
              lat: emergenciaSnap.lat,
              lng: emergenciaSnap.lng,
              tramo: undefined,
              ultimaActualizacion: Date.now(),
            }
          : r
      )
    );

    pushHistorial(
      'en_emergencia',
      `${resourceId} llegó a la Emergencia #${emergenciaSnap.id} (${emergenciaSnap.address})`
    );

    // 2. Permanecer atendiendo la emergencia.
    const tTrabajo = window.setTimeout(async () => {
      const vigente = resourcesRef.current.find(
        r => r.id === resourceId
      );

      if (
        !vigente ||
        vigente.radioState !== '6-7' ||
        vigente.destino?.emergenciaId !== emergenciaSnap.id
      ) {
        return;
      }

      // Resolver en PostgreSQL al terminar la atención, aunque OSRM falle
      // después al calcular la ruta de regreso.
      try {
        await cambiarEstadoEmergenciaBD(emergenciaSnap.id, 'FINALIZADA');
        advanceQueue(emergenciaSnap.id);
        pushHistorial('liberacion', `Emergencia #${emergenciaSnap.id} finalizada en PostgreSQL`);
      } catch (error) {
        console.error('No se pudo finalizar la emergencia:', error);
        notify(error instanceof Error ? error.message : `No se pudo cerrar la emergencia #${emergenciaSnap.id} en PostgreSQL`);
        return;
      }

      const origenVuelta = {
        lat: emergenciaSnap.lat,
        lng: emergenciaSnap.lng,
      };

      const destinoVuelta = {
        lat: home.lat,
        lng: home.lng,
      };

      try {
        // 3. Pedir ruta de regreso al contenedor OSRM.
        // No se inicia ningún movimiento hasta recibirla.
        const tramoVuelta = await prepararTramoOSRM(
          resourceId,
          origenVuelta,
          destinoVuelta,
          duracionTramoMs
        );

        // Verificar nuevamente el estado, porque OSRM
        // puede tardar y la unidad podría haber cambiado.
        const antesDeRegresar = resourcesRef.current.find(
          r => r.id === resourceId
        );

        if (
          !antesDeRegresar ||
          antesDeRegresar.radioState !== '6-7' ||
          antesDeRegresar.destino?.emergenciaId !== emergenciaSnap.id
        ) {
          return;
        }

        // 4. Iniciar regreso siguiendo los puntos de OSRM.
        setResources(rs =>
          rs.map(r =>
            r.id === resourceId &&
            r.radioState === '6-7' &&
            r.destino?.emergenciaId === emergenciaSnap.id
              ? {
                  ...r,
                  radioState: '6-8' as RadioState,
                  tramo: tramoVuelta,
                  ultimaActualizacion: Date.now(),
                }
              : r
          )
        );

        pushHistorial(
          'liberacion',
          `${resourceId} finalizó la atención de la Emergencia #${emergenciaSnap.id} y regresa a su cuartel por OSRM`
        );

        // 5. Esperar hasta completar el regreso.
        const tFin = window.setTimeout(() => {
          // La actualización funcional evita depender de una referencia de React
          // que puede quedar desfasada respecto del último render/polling.
          setResources(rs => {
            const resultado = rs.map(r => {
              if (r.id !== resourceId || r.radioState !== '6-8' ||
                  r.destino?.emergenciaId !== emergenciaSnap.id ||
                  r.tramo?.inicio !== tramoVuelta.inicio) return r;
              return { ...r, radioState: '6-0' as RadioState,
                lat: home.lat, lng: home.lng, destino: undefined,
                tramo: undefined, ultimaActualizacion: Date.now() };
            });
            resourcesRef.current = resultado;
            return resultado;
          });
          // Persistir 6-0 también: el polling solo refleja el estado
          // de PostgreSQL y no debe volver a mostrar 6-8.
          void fetch(`${API_BASE}/resources/${encodeURIComponent(unidadInicial.codigo ?? resourceId)}/position`, {
            method: 'PATCH', credentials: 'include',
            headers: {'Content-Type': 'application/json', ...authHeaders()},
            body: JSON.stringify({lat: home.lat, lng: home.lng, estado: '6-0'}),
          }).then(async respuesta => {
            if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
          }).catch(error => {
            console.error(`No se pudo guardar 6-0 de ${resourceId}:`, error);
            notify(`Error guardando regreso a cuartel de ${resourceId}`);
          });
          pushHistorial('liberacion', `${resourceId} regresó a su cuartel y está disponible (6-0)`);
          limpiarDespachoLS(resourceId);
        }, tramoVuelta.duracionMs);

        registerResourceTimer(resourceId, tFin);

      } catch (error) {
        console.error(
          `OSRM no pudo calcular el regreso de ${resourceId}:`,
          error
        );

        // No crear un tramo alternativo en línea recta.
        // La unidad permanece en estado 6-7.
        notify(
          `${resourceId}: OSRM Docker no está disponible. El vehículo permanece en la emergencia.`
        );
      }

    }, tiempoTrabajo);

    registerResourceTimer(resourceId, tTrabajo);

  }, duracionTramoMs);

  registerResourceTimer(resourceId, tLlegada);
 };

 // Retoma un despacho que quedo en curso en localStorage (ver
 // DespachoPersistido) cuando la pagina se recarga a mitad de camino. No usa
 // OSRM ni anima el regreso punto a punto -- en esta ruta de recuperacion
 // (que solo ocurre tras un F5/cierre de pestana) lo que importa es que la
 // emergencia SIEMPRE termine finalizada y el vehiculo SIEMPRE vuelva a su
 // cuartel, no la fidelidad visual del trayecto.
 const reanudarDespachoDesdeReload = (resourceId: string, registro: DespachoPersistido) => {
  const ahora = Date.now();
  const home = { lat: registro.homeLat, lng: registro.homeLng };
  const destino = {
    emergenciaId: registro.emergenciaId,
    lat: registro.destLat,
    lng: registro.destLng,
    address: registro.address,
  };

  const volverACuartel = async () => {
    setResources(rs => {
      const resultado = rs.map(r => r.id === resourceId
        ? { ...r, radioState: '6-0' as RadioState, lat: home.lat, lng: home.lng,
            destino: undefined, tramo: undefined, ultimaActualizacion: Date.now() }
        : r);
      resourcesRef.current = resultado;
      return resultado;
    });
    try {
      const respuesta = await fetch(`${API_BASE}/resources/${encodeURIComponent(resourceId)}/position`, {
        method: 'PATCH', credentials: 'include',
        headers: {'Content-Type': 'application/json', ...authHeaders()},
        body: JSON.stringify({lat: home.lat, lng: home.lng, estado: '6-0'}),
      });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
    } catch (error) {
      console.error(`No se pudo guardar 6-0 de ${resourceId} al reanudar tras recargar:`, error);
    }
    pushHistorial('liberacion', `${resourceId} regresó a su cuartel (ciclo retomado tras recargar la página)`);
    limpiarDespachoLS(resourceId);
  };

  const finalizarYRegresar = async (msHastaRegreso: number) => {
    try {
      await cambiarEstadoEmergenciaBD(registro.emergenciaId, 'FINALIZADA');
      advanceQueue(registro.emergenciaId);
      pushHistorial('liberacion', `Emergencia #${registro.emergenciaId} finalizada en PostgreSQL (ciclo retomado tras recargar la página)`);
    } catch (error) {
      // Puede ya estar finalizada (otro intento, otra pestana) -- no es fatal.
      console.warn(`Emergencia #${registro.emergenciaId}: no se pudo finalizar al reanudar (puede que ya lo estuviera):`, error);
    }
    // Se pide una ruta OSRM nueva (origen=emergencia, destino=cuartel) para
    // el tiempo que falte -- antes se dejaba tramo:undefined y, sin ruta
    // que animar, posicionActual() devolvia la ultima posicion conocida sin
    // moverse: con un F5 a mitad de regreso, el vehiculo parecia ya haber
    // llegado (o seguir pegado en el incidente) en vez de seguir viajando.
    const msRestantes = Math.max(1000, msHastaRegreso);
    setResources(rs => rs.map(r => r.id === resourceId
      ? { ...r, radioState: '6-8' as RadioState, destino, ultimaActualizacion: Date.now() }
      : r));
    try {
      const tramoVuelta = await prepararTramoOSRM(resourceId, destino, home, msRestantes);
      setResources(rs => rs.map(r => r.id === resourceId && r.radioState === '6-8'
        ? { ...r, tramo: tramoVuelta }
        : r));
    } catch (error) {
      console.error(`No se pudo recalcular la ruta de vuelta de ${resourceId} al reanudar:`, error);
    }
    const t = window.setTimeout(() => { void volverACuartel(); }, msRestantes);
    registerResourceTimer(resourceId, t);
  };

  if (ahora >= registro.regresaEn) {
    // Todo el ciclo deberia haber terminado mientras la pagina estaba
    // cerrada o recargando -- cerrar la emergencia y dejar el vehiculo en
    // su cuartel de inmediato, sin animar nada.
    void (async () => {
      try {
        await cambiarEstadoEmergenciaBD(registro.emergenciaId, 'FINALIZADA');
        advanceQueue(registro.emergenciaId);
      } catch (error) {
        console.warn(`Emergencia #${registro.emergenciaId}: probablemente ya estaba finalizada:`, error);
      }
      await volverACuartel();
    })();
    return;
  }

  if (ahora >= registro.finalizaEn) {
    // Ya deberia estar de regreso.
    void finalizarYRegresar(registro.regresaEn - ahora);
    return;
  }

  if (ahora >= registro.llegaEn) {
    // Deberia estar atendiendo en el lugar.
    setResources(rs => rs.map(r => r.id === resourceId
      ? { ...r, radioState: '6-7' as RadioState, lat: destino.lat, lng: destino.lng,
          destino, tramo: undefined, ultimaActualizacion: Date.now() }
      : r));
    void cambiarEstadoEmergenciaBD(registro.emergenciaId, 'EN_ATENCION').catch(()=>{});
    const t = window.setTimeout(
      () => { void finalizarYRegresar(registro.regresaEn - registro.finalizaEn); },
      Math.max(0, registro.finalizaEn - ahora)
    );
    registerResourceTimer(resourceId, t);
    return;
  }

  // Todavia deberia estar en camino -- se pide una ruta OSRM nueva
  // (cuartel -> emergencia) para el tiempo que falte hasta llegaEn, por la
  // misma razon que en finalizarYRegresar: sin tramo, el vehiculo quedaba
  // congelado en su ultima posicion conocida (normalmente el cuartel, que
  // es como ya habia salido pero sin moverse, o a veces se leia como si ya
  // hubiera llegado).
  const msRestantesIda = Math.max(1000, registro.llegaEn - ahora);
  setResources(rs => rs.map(r => r.id === resourceId
    ? { ...r, radioState: '6-3' as RadioState, destino, ultimaActualizacion: Date.now() }
    : r));
  void (async () => {
    try {
      const tramoIda = await prepararTramoOSRM(resourceId, home, destino, msRestantesIda);
      setResources(rs => rs.map(r => r.id === resourceId && r.radioState === '6-3'
        ? { ...r, tramo: tramoIda }
        : r));
    } catch (error) {
      console.error(`No se pudo recalcular la ruta de ida de ${resourceId} al reanudar:`, error);
    }
  })();
  const tLlegadaReanudado = window.setTimeout(() => {
    setResources(rs => rs.map(r => r.id === resourceId
      ? { ...r, radioState: '6-7' as RadioState, lat: destino.lat, lng: destino.lng,
          destino, tramo: undefined, ultimaActualizacion: Date.now() }
      : r));
    void cambiarEstadoEmergenciaBD(registro.emergenciaId, 'EN_ATENCION').catch(()=>{});
    const tTrabajoReanudado = window.setTimeout(
      () => { void finalizarYRegresar(registro.regresaEn - registro.finalizaEn); },
      Math.max(0, registro.finalizaEn - registro.llegaEn)
    );
    registerResourceTimer(resourceId, tTrabajoReanudado);
  }, msRestantesIda);
  registerResourceTimer(resourceId, tLlegadaReanudado);
 };

 // Al cargar la pagina (login o F5), revisa si quedo algun despacho a medio
 // camino guardado en localStorage (ver DespachoPersistido) y lo retoma --
 // una sola vez por carga, cuando ya se tiene la flota real desde Postgres
 // (para saber el cuartel/home de cada unidad y no pisar un estado que haya
 // cambiado por otra via mientras tanto).
 useEffect(() => {
   if (!auth || !recursosCargados || despachosReanudadosRef.current) return;
   despachosReanudadosRef.current = true;

   let claves: string[] = [];
   try {
     claves = Object.keys(localStorage).filter(k => k.startsWith(DESPACHO_LS_PREFIX));
   } catch {
     return;
   }

   for (const clave of claves) {
     const resourceId = clave.slice(DESPACHO_LS_PREFIX.length);
     try {
       const crudo = localStorage.getItem(clave);
       if (!crudo) continue;
       const registro: DespachoPersistido = JSON.parse(crudo);
       const existe = resourcesRef.current.some(r => r.id === resourceId);
       if (!existe) { limpiarDespachoLS(resourceId); continue; }
       pushHistorial('en_emergencia', `${resourceId}: ciclo de despacho retomado tras recargar la página`);
       reanudarDespachoDesdeReload(resourceId, registro);
     } catch (error) {
       console.error(`No se pudo reanudar el despacho guardado de ${resourceId}:`, error);
       limpiarDespachoLS(resourceId);
     }
   }
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [auth, recursosCargados]);

 // Nucleo compartido del despacho real: lo usan tanto la asignacion
 // automatica (el boton ASIGNAR sobre la recomendacion) como la asignacion
 // MANUAL (elegida por el operador desde el mapa) -- misma logica real de
 // movimiento/ruta/registro en ambos casos, solo cambia quien eligio la
 // unidad.
 const despacharUnidad = async (unidad: Resource,emergenciaSnap: Emergency,manual: boolean) => {
  if (!resourcesCargadosRef.current) {
    notify('La flota todavía no está cargada desde PostgreSQL.');
    return;
  }

  const resourceId = unidad.id;

  if (operacionesPendientesRef.current.has(resourceId)) {
    return;
  }

  operacionesPendientesRef.current.add(resourceId);

  try {
    const actual = resourcesRef.current.find(
      r => r.id === resourceId
    );

    if (!actual || !esDisponible(actual)) {
      notify('La unidad ya no está disponible.');
      return;
    }

    const nombreClave =
      claves[emergenciaSnap.codigo]?.nombre ??
      emergenciaSnap.codigo;

    const fueRedirigida = actual.radioState === '6-8';

    const origen = posicionActual(actual, Date.now());

    const destinoEmergencia = {
      lat: emergenciaSnap.lat,
      lng: emergenciaSnap.lng,
    };

    const info = distanciaYEtaHacia(
      actual,
      destinoEmergencia,
      claves[emergenciaSnap.codigo],
      Date.now()
    );

    const duracionMs = Math.max(
      25000,
      Math.min(info.etaMin * 3200, 90000)
    );

    // No modifica el vehículo hasta tener la ruta.
    const tramo = await prepararTramoOSRM(
      resourceId,
      origen,
      destinoEmergencia,
      duracionMs
    );

    // Comprobar nuevamente que la unidad no cambió
    // mientras esperábamos la respuesta de OSRM.
    const vigente = resourcesRef.current.find(
      r => r.id === resourceId
    );

    if (!vigente || !esDisponible(vigente)) {
      notify('La unidad cambió de estado durante el cálculo.');
      return;
    }

    // Confirmar la asignación en PostgreSQL antes de iniciar la simulación.
    await cambiarEstadoEmergenciaBD(emergenciaSnap.id, 'ASIGNADA');
    setQueue(q => q.map(e => e.id === emergenciaSnap.id ? {...e, status: 'Asignada'} : e));

    // Si esta era la emergencia elegida a mano (clic en el mapa o recien
    // creada desde el formulario), se suelta esa seleccion manual apenas
    // se le asigna un recurso -- si no, "RECURSO RECOMENDADO" se quedaba
    // pegado en ella mostrando "ya tiene una unidad respondiendo" para
    // siempre, en vez de pasar sola a la siguiente emergencia Activa que
    // todavia necesita despacho (ver currentEmergencia).
    setEmergenciaSeleccionadaId(id => id === emergenciaSnap.id ? null : id);

    // Solo ahora comienza el desplazamiento.
    clearResourceTimers(resourceId);
    enPatrullajeRef.current.delete(resourceId);

    setResources(rs => rs.map(r =>
      r.id === resourceId
        ? {
            ...r,
            radioState: '6-3',
            destino: {
              emergenciaId: emergenciaSnap.id,
              lat: emergenciaSnap.lat,
              lng: emergenciaSnap.lng,
              address: emergenciaSnap.address,
            },
            tramo,
            ultimaActualizacion: Date.now(),
          }
        : r
    ));

    setMetricasAsignacion(m => [...m, {
      etaMin: info.etaMin,
      idoneidadTipo: scoreDetalle(
        actual,
        claves[emergenciaSnap.codigo],
        info.distanciaKm,
        info.etaMin
      ).idoneidadTipo,
      compania: actual.compania,
    }]);

    pushHistorial(
      'asignacion',
      `${actual.name} asignada a Emergencia #${emergenciaSnap.id} · Clave ${emergenciaSnap.codigo} (${nombreClave})${fueRedirigida ? ' · Redirigida en ruta' : ''}`
    );

    notify(
      `${actual.name} despachada por ruta OSRM${manual ? ' (manual)' : ''}`
    );

    setFocus(destinoEmergencia);

    scheduleResourceLifecycle(
      resourceId,
      emergenciaSnap,
      actual,
      tramo.duracionMs
    );


  } catch (error) {
    console.error('Error de ruta OSRM:', error);
    notify(error instanceof Error ? error.message : 'No se pudo despachar la unidad.');
  } finally {
    operacionesPendientesRef.current.delete(resourceId);
  }
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
   if(unidadesEnCaminoA(resources, currentEmergencia.id) >= LIMITE_UNIDADES_POR_EMERGENCIA){
     notify(`Ya hay ${LIMITE_UNIDADES_POR_EMERGENCIA} unidades despachadas a esta emergencia (límite para emergencias regulares).`);
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

 // Solo ubicar en el mapa una emergencia puntual (desde la tabla de
 // Emergencias) sin tocar el orden de la cola ni forzarla como la
 // emergencia "en curso" del panel de asignacion -- a diferencia de
 // atenderEmergencia, esto es solo para mirar donde esta ocurriendo.
 const verEmergenciaEnMapa=(id:number)=>{
   const target=queue.find(e=>e.id===id);
   if(!target) return;
   setFocus({lat:target.lat,lng:target.lng});
   setSection('Dashboard');
 };

 // Desde Recursos, tocar el nombre de una compañia lleva al Dashboard con
 // el mapa centrado y acercado (zoom 16, ver MapPanel) en ese cuartel.
 const verCuartelEnMapa=(lat:number, lng:number)=>{
   setFocus({lat,lng});
   setSection('Dashboard');
 };

 // Marcar/quitar "Fuera de servicio" (6-9) manualmente desde Recursos --
 // solo admin, y solo sobre unidades realmente quietas (6-0 o 6-9): no
 // tiene sentido sacar de servicio a un carro a mitad de un despacho real.
 // Reusa el mismo PATCH de posicion que ya usa el resto del despacho, sin
 // mover al vehiculo (mismas coordenadas), solo cambia el estado_radio.
 // Fuera de servicio/Reactivar: abierto a admin Y visualizador (a
 // diferencia del resto del despacho/asignacion, que sigue siendo solo de
 // admin) -- por eso usa /estado, no /position, que ademas mueve el
 // vehiculo y se mantiene exclusivo de admin en el backend.
 const cambiarFueraDeServicio=async(resource:Resource, nuevoEstado:'6-0'|'6-9')=>{
   if(isAdminSoporte) return;
   try{
     const respuesta=await fetch(`${API_BASE}/resources/${encodeURIComponent(resource.codigo ?? resource.id)}/estado`,{
       method:'PATCH', credentials:'include',
       headers:{'Content-Type':'application/json', ...authHeaders()},
       body:JSON.stringify({estado:nuevoEstado}),
     });
     if(!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
     setResources(rs=>{
       const resultado=rs.map(r=>r.id===resource.id?{...r, radioState:nuevoEstado, ultimaActualizacion:Date.now()}:r);
       resourcesRef.current=resultado;
       return resultado;
     });
     pushHistorial('liberacion', `${resource.id} marcada ${nuevoEstado==='6-9'?'Fuera de servicio':'Disponible'} manualmente`);
     notify(`${resource.id} ahora está ${nuevoEstado==='6-9'?'fuera de servicio':'disponible'}.`);
   }catch(error){
     console.error('No se pudo cambiar el estado del recurso:', error);
     notify(error instanceof Error?error.message:'No se pudo cambiar el estado del recurso.');
   }
 };

 // Formulario "Nueva emergencia" (admin) -- POST /emergencies ya existia en
 // el backend sin usar desde el frontend; esto lo conecta. Tras crearla se
 // refresca `queue` de inmediato (sin esperar el poll de 10s), se manda al
 // operador al Dashboard, y se fuerza esa emergencia como la seleccionada
 // (mismo mecanismo que tocar su marcador en el mapa) para que la
 // recomendacion de recurso aparezca de inmediato sobre la que acaba de crear.
 const recargarEmergenciasAhora=async()=>{
   try{
     const emergencias=await obtenerEmergenciasBD();
     setQueue(emergencias);
     setApiError(null);
   }catch(error){
     console.error('No se pudieron recargar las emergencias:', error);
   }
 };

 const crearEmergenciaBD=async(payload:{codigo_emergencia:string; direccion_emergencia:string; latitud_emergencia:number; longitud_emergencia:number; prioridad_emergencia:number})=>{
   const respuesta=await fetch(`${API_BASE}/emergencies`,{
     method:'POST', credentials:'include',
     headers:{'Content-Type':'application/json', ...authHeaders()},
     body:JSON.stringify(payload),
   });
   if(!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
   const creada=await respuesta.json();
   await recargarEmergenciasAhora();
   setSection('Dashboard');
   setEmergenciaSeleccionadaId(creada.id_emergencia);
   pushHistorial('nueva_emergencia', `Emergencia #${creada.id_emergencia} (${creada.codigo_emergencia}) creada manualmente desde el formulario`);
   return creada;
 };

 // Tickets de Soporte contra Postgres real (ticket/respuesta_ticket/
 // tipo_ticket/apartado_ticket -- ver /tickets en main.py). Cada mutacion
 // vuelve a pedir la lista completa en vez de actualizar el estado local a
 // mano, para que tipo/apartado/autor/respuestas queden siempre resueltos
 // tal como los devuelve el backend.
 const crearTicketBD=async(idTipo:number, idApartado:number|null, titulo:string, descripcion:string, archivoUrl:string|null)=>{
   const respuesta=await fetch(`${API_BASE}/tickets`,{
     method:'POST', credentials:'include',
     headers:{'Content-Type':'application/json', ...authHeaders()},
     body:JSON.stringify({id_tipo:idTipo, id_apartado:idApartado, titulo_ticket:titulo, descripcion, archivo_url:archivoUrl}),
   });
   if(!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
   const creado=await respuesta.json();
   await cargarTickets();
   return creado;
 };

 const responderTicketBD=async(idTicket:number, mensaje:string, tipoRespuesta:'Respuesta'|'Usuario')=>{
   const respuesta=await fetch(`${API_BASE}/tickets/${idTicket}/respuestas`,{
     method:'POST', credentials:'include',
     headers:{'Content-Type':'application/json', ...authHeaders()},
     body:JSON.stringify({mensaje, tipo_respuesta:tipoRespuesta}),
   });
   if(!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
   await cargarTickets();
 };

 const cambiarEstadoTicketBD=async(idTicket:number, estado:'Abierto'|'En proceso'|'Resuelto')=>{
   const respuesta=await fetch(`${API_BASE}/tickets/${idTicket}/estado`,{
     method:'PATCH', credentials:'include',
     headers:{'Content-Type':'application/json', ...authHeaders()},
     body:JSON.stringify({estado}),
   });
   if(!respuesta.ok) throw new Error(`HTTP ${respuesta.status}: ${await respuesta.text()}`);
   await cargarTickets();
 };

 const cambiarPrioridadTicketBD=async(idTicket:number, prioridad:'Baja'|'Media'|'Alta')=>{
   const respuesta=await fetch(`${API_BASE}/tickets/${idTicket}/prioridad`,{
     method:'PATCH', credentials:'include',
     headers:{'Content-Type':'application/json', ...authHeaders()},
     body:JSON.stringify({prioridad}),
   });
   if(!respuesta.ok){
     notify(`No se pudo cambiar la prioridad: ${await respuesta.text()}`);
     return;
   }
   await cargarTickets();
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
 // Zona con mayor demanda esperada en el bloque actual, para destacarla en
 // un resumen fijo arriba de la lista de alertas predictivas (en vez de
 // que el usuario tenga que encontrarla entre todas las alertas sueltas).
 const zonaMayorDemanda=useMemo(
  ()=>currentZonas.length
    ? currentZonas.reduce((mayor,zona)=>
        zona.demanda_total>mayor.demanda_total ? zona : mayor
      )
    : undefined,
  [currentZonas]
 );
 const alerts=useMemo(()=>buildAlerts(periodos, claves),[periodos, claves]);
 const infoMayorDemanda=useMemo(
  ()=>zonaMayorDemanda && periodoActual
    ? explicarZona(periodoActual, zonaMayorDemanda, claves)
    : undefined,
  [zonaMayorDemanda, periodoActual, claves]
 );
 const infoBloqueActual=useMemo(
  ()=>periodoActual
    ? periodoInfo(periodoActual.periodo_inicio)
    : undefined,
  [periodoActual]
 );
 const disponibles=resourcesFiltrados.filter(esDisponible).length;
 // Metricas de asignacion (para "Tiempo promedio"/"Cobertura estimada"),
 // acotadas al cuartel filtrado cuando corresponde.
 const metricasFiltradas=filtroCuartel==='todos'?metricasAsignacion:metricasAsignacion.filter(m=>m.compania===filtroCuartel);
 // El filtro de cuartel acota SOLO los recursos (que unidades se muestran,
 // cuales se consideran para la recomendacion) -- las alertas activas son
 // reales independientemente de que cuartel este filtrado, asi que tanto el
 // conteo como el mapa siempre muestran todas, nunca se ocultan por el
 // filtro de cuartel.
 const emergenciasMapaDashboard=queue;
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
    <div className="brand"><div className="brandIcon"><img src={logoDark} className="logoDark" alt="ALERTA360"/><img src={logoLight} className="logoLight" alt="ALERTA360"/></div>{!sidebarCollapsed && <div><b>ALERTA360</b><span>BOMBEROS · VALPARAÍSO</span></div>}</div>
  <nav>
  {isAdminSoporte ? (
    <>
      <button
        className={section==='Tickets'?'active':''}
        onClick={()=>{setSection('Tickets');setMobileNavOpen(false);}}
        title="Tickets"
      >
        <Ticket size={18}/>
        {!sidebarCollapsed && <span>Tickets</span>}
      </button>
      <button
        className={section==='Configuración'?'active':''}
        onClick={()=>{setSection('Configuración');setMobileNavOpen(false);}}
        title="Configuración"
      >
        <Settings size={18}/>
        {!sidebarCollapsed && <span>Configuración</span>}
      </button>
    </>
  ) : (
    <>
      {[
        // "Formulario" (ingreso rapido de emergencias, CAD) solo para admin
        // -- cambia el orden y el flujo de navegacion unicamente en esa
        // vista; visualizador mantiene exactamente el menu de siempre.
        ...(isAdmin ? [['Formulario',FilePlus2]] : []),
        ['Dashboard',BarChart3],
        ['Emergencias',AlertTriangle],
        ['Recursos',Truck],
        ['Historial',History],
        ['Soporte',LifeBuoy],
        ['Configuración',Settings]
      ].map(([label,Icon]:any)=>(
        <button
          key={label}
          className={section===label?'active':''}
          onClick={()=>{setSection(label);setMobileNavOpen(false);}}
          title={label}
        >
          <Icon size={18}/>
          {!sidebarCollapsed && <span>{label}</span>}
        </button>
      ))}
    </>
  )}
</nav>    {!sidebarCollapsed && <div className="sidebarBottom"><div className="online"><span></span>Sistema operativo</div><small>Última sincronización<br/><b>hace 18 segundos</b></small></div>}
   </aside>
   <main className={`main${sidebarCollapsed?' sidebarCollapsed':''}`}><header><button className="mobileMenu" onClick={()=>setMobileNavOpen(o=>!o)}><Menu/></button><div><h1>{section}</h1><p>
  {isAdminSoporte
    ? 'Gestión de tickets de soporte'
    : <>Central de coordinación · Valparaíso{!isAdmin?' · Acceso de solo lectura':''}{!isAdmin && esperandoEstadoRemoto?' · Esperando datos en vivo del operador…':''}{!isAdmin && estadoRemoto?` · En vivo (operador: ${estadoRemoto.publicadoPor})`:''}</>
  }
</p></div><div className="headerActions">{!isAdmin && !isAdminSoporte && <div className="readOnlyBadge" title="Tu cuenta solo puede visualizar, no asignar recursos"><Eye size={13}/> Solo lectura</div>}{isAdmin && <div className="readOnlyBadge" title="Tu cuenta puede asignar recursos y despachar"><Eye size={13}/> Admin</div>}<button onClick={()=>setTheme(t=>t==='dark'?'light':'dark')} title={theme==='dark'?'Cambiar a tema claro':'Cambiar a tema oscuro'}>{theme==='dark'?<Sun size={17}/>:<Moon size={17}/>}</button><div className="live"><span/> EN VIVO</div><button className="avatar" onClick={()=>setSection('Configuración')} title={`${auth.nombre} · Ver perfil`}>{iniciales}</button></div></header>
    {section==='Formulario' && isAdmin && <NuevaEmergenciaView claves={claves} onCrear={crearEmergenciaBD}/>}
    {section==='Emergencias' && !isAdminSoporte && <EmergenciasView queue={queue} claves={claves} now={now} onAtender={atenderEmergencia} onVerUbicacion={verEmergenciaEnMapa} isAdmin={isAdmin}/>}
    {section==='Recursos' && !isAdminSoporte && <RecursosView resources={resources} alertaTimeoutIds={unidadesConAlertaTimeout} onVerCuartelEnMapa={verCuartelEnMapa} isAdmin={isAdmin} puedeCambiarEstado={!isAdminSoporte} onCambiarFueraDeServicio={cambiarFueraDeServicio}/>}
    {section==='Historial' && !isAdminSoporte && <HistorialView historial={historial} now={now}/>}
    {section==='Configuración' && <ConfiguracionView soundOn={soundOn} onToggleSound={setSoundOn} autoRefreshSec={autoRefreshSec} onChangeAutoRefresh={setAutoRefreshSec} onNotify={notify} auth={auth} onLogout={handleLogout} isAdmin={isAdmin} timeoutMinutos={timeoutMinutos} onChangeTimeout={setTimeoutMinutos}/>}
    {section==='Soporte' && (
      <SoporteView
        tickets={tickets}
        catalogos={catalogoTickets}
        onCrear={crearTicketBD}
        onResponderUsuario={(id,mensaje)=>responderTicketBD(id,mensaje,'Usuario')}
      />
    )}

    {section==='Tickets' && isAdminSoporte && (
      <AdminTicketsView
        tickets={tickets}
        onResponder={(id,mensaje)=>responderTicketBD(id,mensaje,'Respuesta')}
        onCambiarEstado={cambiarEstadoTicketBD}
        onCambiarPrioridad={cambiarPrioridadTicketBD}
      />
    )}
    {section==='Dashboard' && !isAdminSoporte && <>
    <div className="cuartelFilterRow">
      <label><Building2 size={16}/> Filtrar por cuartel<select value={filtroCuartel} onChange={e=>setFiltroCuartel(e.target.value)}>
        <option value="todos">Todos los cuarteles</option>
        {companiasDisponibles.map(c=><option key={c} value={c}>{c}</option>)}
      </select></label>
      {filtroCuartel!=='todos' && <button className="linkBtn" onClick={()=>setFiltroCuartel('todos')}>Quitar filtro</button>}
    </div>
    <section className="kpis"><Kpi icon={<AlertTriangle/>} label="Emergencias activas" value={String(queue.length)} meta={currentEmergencia?`atendiendo clave ${currentEmergencia.codigo}`:'sin emergencia activa'} tone="acento"/><Kpi icon={<Truck/>} label="Recursos disponibles" value={String(disponibles)} meta={filtroCuartel==='todos'?`de ${resources.length} unidades`:`de ${resourcesFiltrados.length} unidades de ${filtroCuartel}`} tone="azul"/><Kpi icon={<Clock3/>} label="Tiempo promedio" value={tiempoPromedioLabel} meta={tiempoPromedioMeta} tone="acento"/><Kpi icon={<ShieldCheck/>} label="Cobertura estimada" value={coberturaLabel} meta={coberturaMeta} tone="azul"/></section>
    <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa operacional</b><span>Emergencias y recursos en tiempo real{isAdmin?' · toca un cuartel o vehículo para asignarlo manualmente':' · modo solo lectura'}</span></div></div><MapPanel resources={resourcesFiltrados} emergencies={emergenciasMapaDashboard} focus={focus} center={operationalCenter} onAsignarManual={handleAsignarManual} onSelectEmergencia={setEmergenciaSeleccionadaId} isAdmin={isAdmin}/><div className="legend"><span><i className="dot green"/> Disponible</span><span><i className="dot red"/> En misión</span><span><i className="dot blue"/> Ruta recomendada</span></div></div>
      <div className="sideCards">
      {currentEmergencia?<div className="emergencyCard"><div className="emergencyHeadRow"><div className="emergencyTitle"><div className="danger"><AlertTriangle/></div><div><b>Emergencia #{currentEmergencia.id}</b><span>{claveActual?.nombre??currentEmergencia.codigo}</span></div></div><div
  className={`tag prioridad-badge ${obtenerClasePrioridad(currentEmergencia.prioridad)}`}>{obtenerNivelPrioridad(currentEmergencia.prioridad)} PRIORIDAD</div></div><div className="details"><p><MapPin size={18}/><span>{currentEmergencia.address}</span></p><p><Clock3 size={18}/><span>Tiempo transcurrido: <b>{elapsedLabel(currentEmergencia.creadaEn,now)}</b></span></p><p><Radio size={18}/><span>Estado: <b>{currentEmergencia.status}</b></span></p></div><div className="infoTipRow"><InfoTip texto={explicarEmergenciaActual(currentEmergencia.codigo, now)}/></div><button className="locateBtn" onClick={()=>setFocus({lat:currentEmergencia.lat,lng:currentEmergencia.lng})}><Crosshair size={13}/> Ver en el mapa</button></div>:<div className="emergencyCard"><p className="emptyState">Sin emergencias activas por el momento.</p></div>}
      <div className="recommend"><div className="recHead"><div><span>RECURSO RECOMENDADO</span><small>{filtroCuartel==='todos'?'Asignación multicriterio':`Asignación multicriterio · solo ${filtroCuartel}`}</small></div>{recommendation && recomendacionInfo && <div className="score" style={{color:scoreColor(Math.round(score(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin)))}}>{Math.round(score(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin))}<small>/100</small></div>}</div>
      {recommendation && recomendacionInfo?<>
       <div className="recBody"><div className="vehicleIcon">{resourceIcon(recommendation.type)}</div><div><b>{recommendation.name}</b><span className="recBodyCia">{recommendation.compania} · {recommendation.sector}</span><p><Clock3 size={17}/><span>ETA estimado: <strong>{recomendacionInfo.etaMin} min</strong></span></p><p><Navigation size={17}/><span>Distancia: <strong>{recomendacionInfo.distanciaKm} km</strong></span></p><p><CheckCircle2 size={17}/><span>Disponibilidad: <strong>{recommendation.radioState==='6-8'?'Regresando (redirigida a esta emergencia)':'Disponible en cuartel'}</strong></span></p><p><ShieldCheck size={17}/><span>Capacidad: <strong>{recommendation.capacity}</strong></span></p><p><Users size={17}/><span>Dotación: <strong>{recommendation.crew} personas</strong></span></p></div></div>
       <div className="infoTipRow"><InfoTip texto={`Por qué esta unidad: ${justificarRecomendacion(recommendation,claveActual,recomendacionInfo.distanciaKm,recomendacionInfo.etaMin)}.`}/></div>
       <button className="locateBtn" onClick={()=>{const pos=posicionActual(recommendation,now); setFocus({lat:pos.lat,lng:pos.lng});}}><Crosshair size={13}/> Ver en el mapa</button>
       {isAdmin
         ?<div className="actions"><button className="assign" onClick={handleAsignar}>ASIGNAR</button><button className="reject" onClick={handleRechazar}>RECHAZAR</button></div>
         :<p className="emptyState readOnlyNote"><Lock size={12}/> Tu cuenta es de solo lectura: no puede asignar ni rechazar unidades.</p>}
      </>:<p className="emptyState">{currentEmergencia && currentEmergencia.status!=='Activa'?'Esta emergencia ya tiene una unidad respondiendo.':(filtroCuartel==='todos'?'Sin unidades disponibles para esta emergencia en este momento — todas las compatibles están en misión.':`Sin unidades disponibles de ${filtroCuartel} para esta emergencia en este momento.`)}</p>}
      </div></div></section>
      <section className="workspace"><div className="mapCard"><div className="cardHead"><div><b>Mapa de calor · Demanda de Bomberos</b><span>Predicción ML · próximas {(periodos.length||4)*3} horas · toca una zona para ver el detalle</span></div><span className="mlBadge">ML</span></div><HeatMapPanel zonas={currentZonas} seleccionadaId={zonaSeleccionada} focus={focusHeatmap} onSelectZona={z=>{setZonaSeleccionada(z.zona_id);setFocusHeatmap(z.centroid);}}/><div className="legend heatLegend"><span><i className="dot green"/> Baja</span><span><i className="dot yellow"/> Media</span><span><i className="dot red"/> Alta</span></div></div>
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
        {zonaMayorDemanda && infoMayorDemanda && infoBloqueActual &&(
          <div className="predictiveMainAlert">
            <div className="predictiveMainAlertHeader">
              <AlertTriangle size={16}/>
              <div>
                <strong>Mayor demanda esperada</strong>
                <span>{zonaMayorDemanda.nombre}</span>
              </div>
            </div>

            <div className="predictiveMainAlertInfo">
              <span>
                Demanda estimada:
                <strong>
                  {zonaMayorDemanda.demanda_total.toFixed(1)} casos
                </strong>
              </span>

              <span>
                Nivel:
                <strong>
                  {zonaMayorDemanda.demanda_total<0.8
                    ? 'Bajo'
                    : zonaMayorDemanda.demanda_total<1.8
                      ? 'Medio'
                      : 'Alto'}
                </strong>
              </span>

              <span>
                Bloque actual:
                  <strong>
                    {String(infoBloqueActual.hora).padStart(2,'0')}:00–
                    {String((infoBloqueActual.hora+3)%24).padStart(2,'0')}:00
                  </strong>
              </span>

              <span>
                Día:
                  <strong>
                    {DIA_NOMBRES[infoBloqueActual.dow]}
                  </strong>
              </span>

              <span>
                Clave:
                  <strong>
                    {infoMayorDemanda.codigoTop} (
                    {infoMayorDemanda.nombreTop})
                  </strong>
              </span>

            </div>

            <button
              className="predictiveMapButton"
              onClick={()=>{
                setZonaSeleccionada(zonaMayorDemanda.zona_id);
                setFocusHeatmap(zonaMayorDemanda.centroid);
              }}
            >
              <Crosshair size={14}/>
              Ver en el mapa
            </button>
          </div>
        )}
        <div className="alertsList">{alerts.length?alerts.map((a,i)=><div className="alertRow alertRowClickable" key={i} onClick={()=>{setZonaSeleccionada(a.zonaId);setFocusHeatmap(a.centroid);}}><AlertTriangle size={13}/><span>{a.text}</span></div>):<div className="alertRow"><span>{periodos.length?'Sin picos puntuales sobre el umbral de alerta en este momento.':'Cargando predicción del modelo…'}</span></div>}</div>
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
function Activity({icon,title,detail,time,estado}:{icon:React.ReactNode;title:string;detail:string;time:string;estado?:{texto:string; clase:string}|null}){return <div className="activityRow"><div className="activityIcon">{icon}</div><div><b>{title}</b><span>{detail}</span></div>{estado && <span className={`historialEstado ${estado.clase}`}>{estado.texto}</span>}<time>{time}</time></div>}

createRoot(document.getElementById('root')!).render(<App/>);


//-------------------------------NUeva para la base de datos
async function obtenerEmergenciasBD():Promise<Emergency[]>{
  const response=await fetch(
    `${API_BASE}/emergencies`,
    {
      headers:{
        ...authHeaders(),
      },
    }
  );

  if(!response.ok){
    throw new Error(`No se pudieron obtener las emergencias (${response.status})`);
  }

  const data=await response.json();

  return (data.emergencies||[]).filter((e:any)=>['ACTIVA','ASIGNADA','EN_ATENCION'].includes(String(e.estado_emergencia).toUpperCase())).map((e:any)=>({
    id:e.id_emergencia,
    codigo:e.codigo_emergencia,
    address:e.direccion_emergencia??'Dirección no registrada',
    lat:Number(e.latitud_emergencia??0),
    lng:Number(e.longitud_emergencia??0),
    status: (String(e.estado_emergencia).toUpperCase()==='ASIGNADA' ? 'Asignada' : String(e.estado_emergencia).toUpperCase()==='EN_ATENCION' ? 'EN_ATENCION' : 'Activa'),
    creadaEn:e.fecha_creacion_emergencia
      ? new Date(e.fecha_creacion_emergencia).getTime()
      : Date.now(),
    prioridad:Number(e.prioridad_emergencia??3),
  }));
}

function obtenerNivelPrioridad(
  prioridad: string | number | null | undefined
): string {
  const valor = String(prioridad ?? "").trim().toUpperCase();

  const niveles: Record<string, string> = {
    "1": "CRÍTICA",
    "2": "ALTA",
    "3": "MEDIA",
    "4": "BAJA",
    "CRITICA": "CRÍTICA",
    "CRÍTICA": "CRÍTICA",
    "ALTA": "ALTA",
    "MEDIA": "MEDIA",
    "BAJA": "BAJA",
  };

  return niveles[valor] ?? valor;
}

function obtenerClasePrioridad(
  prioridad: string | number | null | undefined
): string {
  const nivel = obtenerNivelPrioridad(prioridad);

  const clases: Record<string, string> = {
    "CRÍTICA": "prioridad-critica",
    "ALTA": "prioridad-alta",
    "MEDIA": "prioridad-media",
    "BAJA": "prioridad-baja",
  };

  return clases[nivel] ?? "";
}



//-------------------------------
