# Despliegue de Alerta360: PC con Docker, ngrok, Vercel y Supabase

La configuración actual usa el frontend en Vercel, PostgreSQL en Supabase y
la API junto con OSRM en Docker Desktop en el PC. ngrok publica la API por HTTPS.
El PC, Docker y el túnel deben permanecer encendidos para que el frontend pueda
acceder al backend. Subir código a GitHub no actualiza por sí solo esos contenedores.

## Archivos y requisitos

| Archivo | Uso |
|---|---|
| `compose.pc.yaml` | Despliegue en PC; servicios API, OSRM y perfil ngrok. |
| `api.env.example` | Plantilla de conexión a Supabase, secreto JWT y hashes de operadores. |
| `ngrok.env.example` | Plantilla para el token de la cuenta ngrok. |
| `configurar_ngrok.py` | Solicita el token sin mostrarlo y crea `ngrok.env` si no existe. |
| `compose.yaml` y `Caddyfile` | Alternativa para servidor Linux con dominio propio, no utilizada por el despliegue del PC. |

Se requiere Docker Desktop iniciado y configurado para contenedores Linux,
el repositorio, un esquema `emergencia` ya preparado en Supabase y un modelo
confiable `src/backend/ml/artifacts/demand_model.joblib` compatible con las
dependencias fijadas en `Dockerfile.api`. El modelo no se descarga desde GitHub
ni se entrena automáticamente al levantar Docker; debe corresponder al modelo
registrado en la base. OSRM usa `fruna/osrm-valparaiso:valparaiso-v1`, con el mapa
regional incluido. No necesita la carpeta `deploy/routing` en esta modalidad.

## 1. Configuración privada

Desde PowerShell, entra en la carpeta `deploy` de tu copia del proyecto.
Si ya tienes `api.env` y `ngrok.env`, conserva esos archivos: no los sobrescribas.
Para una instalación nueva, copia las plantillas únicamente si no existen:

```powershell
if (!(Test-Path api.env)) { Copy-Item api.env.example api.env }
if (!(Test-Path ngrok.env)) { Copy-Item ngrok.env.example ngrok.env }
```

Edita localmente `api.env`:

- `DATABASE_URL`: URI PostgreSQL de Supabase. Usa conexión directa o Session
  pooler (puerto 5432), con `sslmode=require`; codifica los caracteres reservados
  de la contraseña. La base debe contener el esquema de la aplicación.
- `JWT_SECRET_KEY`: secreto aleatorio de al menos 32 caracteres.
- `OPERADORES_BCRYPT_JSON`: objeto JSON con correos existentes en el catálogo
  de `src/backend/core/auth.py` y sus hashes bcrypt. Es obligatorio porque
  Compose establece `APP_ENV=production`. Solo se habilitan las cuentas incluidas;
  sus roles proceden del catálogo del código. Usa comillas simples exteriores
  para evitar que Docker interprete los signos `$` de los hashes.

Con Python y las dependencias del backend instalados, puedes generar el secreto
y cada hash con estos comandos. El segundo solicita la contraseña sin mostrarla:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "import bcrypt,getpass; print(bcrypt.hashpw(getpass.getpass().encode(),bcrypt.gensalt()).decode())"
```

En `ngrok.env`, configura `NGROK_AUTHTOKEN` con el token de tu cuenta. Como
alternativa a copiar su plantilla, `python configurar_ngrok.py` crea el archivo
mediante una entrada oculta; no sobrescribe un archivo existente.

En `compose.pc.yaml`, revisa:

- `CORS_ORIGINS`: actualmente `https://alerta360-zeta.vercel.app`. Este valor
  sobrescribe el de `api.env`; si cambia el frontend, actualízalo aquí.
- La URL del servicio `ngrok`: actualmente
  `https://feminine-rope-sheath.ngrok-free.dev`. Debe estar asociada a la cuenta
  del token configurado. Si cambia, actualiza también `VITE_API_URL` en Vercel.

No subas `api.env`, `ngrok.env`, `.env`, respaldos de la base ni tokens al repositorio.
Las plantillas contienen marcadores y no son una configuración lista para iniciar.

## 2. Levantar el backend y el túnel

Ejecuta desde `deploy`:

```powershell
docker compose -f compose.pc.yaml --profile ngrok up -d --build
docker compose -f compose.pc.yaml --profile ngrok ps
docker compose -f compose.pc.yaml --profile ngrok logs --tail 50 api ngrok
```

El servicio ngrok apunta a `http://api:8000` dentro de Docker. La API también
está disponible en `http://127.0.0.1:8000` en el PC; no utiliza el puerto 8080.
OSRM es interno (`http://osrm:5000`). El historial de acciones persiste en el
volumen `historial_pc`; el modelo se monta en modo de solo lectura desde
`src/backend/ml/artifacts`. No elimines ese volumen para actualizar el código.

El perfil `publico` contiene una alternativa Cloudflare; no es necesario
activarlo cuando utilizas ngrok.

## 3. Configurar Vercel

En el proyecto de Vercel, configura la rama `main`, raíz `src/frontend`, preset
Vite, comando `npm run build` y directorio de salida `dist`.
En Production, establece:

```text
VITE_API_URL=https://feminine-rope-sheath.ngrok-free.dev
```

Vuelve a desplegar el frontend después de cambiar esa variable: Vite la incorpora
durante la compilación. Utiliza la URL HTTPS del backend, sin añadir `/docs`.
Vercel publica el frontend; el backend continúa ejecutándose en tu PC.

## 4. Comprobar el despliegue

Abre `http://127.0.0.1:8000/health` y después la misma ruta en el dominio público
de ngrok. `/health` comprueba que responde la API; no valida por sí solo Supabase,
el modelo predictivo ni OSRM. Desde el frontend comprueba también el inicio de
sesión, el catálogo de recursos, una predicción autenticada y una ruta dentro
de Valparaíso. Si las predicciones fallan, verifica el artefacto y el modelo
activo registrado en Supabase. Consulta los logs para identificar el error.

## 5. Aplicar cambios posteriores

Actualiza primero el código de la copia que Docker utiliza para construir la
imagen. Si esa copia es un clon Git sin cambios pendientes, desde la raíz:

```powershell
git pull --ff-only origin main
```

Una carpeta descargada como ZIP no puede usar `git pull`; actualiza los archivos
de código conservando los `.env` privados y el modelo. Luego, desde `deploy`:

```powershell
docker compose -f compose.pc.yaml up -d --build api
```

Esto aplica cambios del backend, incluida la corrección del login concurrente
PF08. No hace falta cambiar la URL de Vercel si el dominio ngrok sigue siendo el
mismo. Si cambias el token o el dominio, recrea también el servicio ngrok:

```powershell
docker compose -f compose.pc.yaml --profile ngrok up -d --force-recreate ngrok
```

Para detener temporalmente este despliegue sin borrar datos:

```powershell
docker compose -f compose.pc.yaml --profile ngrok stop
```

## Alternativa: servidor Linux con Caddy

`compose.yaml` conserva el despliegue para un servidor con dominio propio,
DNS apuntando al servidor y puertos 80/443 disponibles. No es el archivo que
debes ejecutar para la instalación con ngrok. En esa alternativa:

1. Configura `deploy/.env` con `API_DOMAIN` (sin `https://`) y `OSRM_IMAGE`.
2. Prepara `api.env` con las variables anteriores y `CORS_ORIGINS`.
3. Coloca el artefacto en `deploy/model/demand_model.joblib` y los archivos
   `valparaiso.osrm*` en `deploy/routing`, compatibles con la imagen OSRM elegida.
4. Ejecuta `docker compose -f compose.yaml up -d --build` desde `deploy`.
5. Configura Vercel con ese dominio HTTPS y realiza las comprobaciones anteriores.

## Migración opcional a un proyecto Supabase vacío

No ejecutes esta sección para actualizar una instalación cuya base ya funciona.

Con el PostgreSQL local encendido, desde PowerShell, ajusta el nombre de la base y el usuario. Guarda el archivo fuera del repositorio. Ejecuta la restauración solo si pg_dump termina con código 0 y pg_restore --list muestra TABLE DATA para registro_historico. Para datos en uso, detén temporalmente las escrituras antes de la exportación final.

```powershell
$bin = 'C:\Program Files\PostgreSQL\16\bin'
$backup = Join-Path $env:USERPROFILE 'alerta360-emergencia.dump'
& "$bin\pg_dump.exe" -h localhost -p 5432 -U postgres -d alerta360 -W -n emergencia -Fc --no-owner --no-acl -f $backup
if ($LASTEXITCODE -ne 0) { throw 'Falló la exportación' }
& "$bin\pg_restore.exe" --list $backup
```

En Supabase abre Connect. Copia host, usuario y puerto de la conexión directa o Session pooler con puerto 5432 si necesitas IPv4. Mantén el esquema emergencia privado para los clientes web. En la siguiente orden reemplaza HOST y USUARIO con los de Supabase. PostgreSQL solicitará la contraseña localmente. La transacción se revierte si hay un conflicto con objetos existentes.

```powershell
$env:PGSSLMODE = 'require'
& "$bin\pg_restore.exe" -h HOST -p 5432 -U USUARIO -d postgres -W --single-transaction --exit-on-error --no-owner --no-acl $backup
```

Compara en ambos servidores el resultado de estas consultas antes de cambiar la API:

```sql
SELECT count(*), sum(cantidad_emergencias), sum(recursos_utilizados) FROM emergencia.registro_historico;
SELECT count(*) FROM emergencia.zona;
SELECT id_modelo, datos_hasta FROM emergencia.modelo_demanda WHERE activo;
```
