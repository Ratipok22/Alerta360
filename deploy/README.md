# Despliegue de Alerta360 desde main

La interfaz se publica en Vercel. La API, el historial de acciones y OSRM se ejecutan en un servidor Linux con Docker, un dominio que apunte a su IP y los puertos 80/443 disponibles. Supabase aloja el esquema PostgreSQL emergencia. Esta configuración parte de main (65577b2).

## Migración a un proyecto Supabase vacío

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

## Backend y rutas

En el servidor clona la rama con estos cambios. En deploy/model coloca el archivo confiable demand_model.joblib correspondiente al modelo activo. Copia todos los archivos preparados valparaiso.osrm* en deploy/routing y usa la misma versión de la imagen OSRM que los generó. Para dimensionar memoria considera el modelo de unos 621 MB más el proceso Python y el mapa de OSRM.

Crea deploy/.env con API_DOMAIN (el dominio público de la API sin https) y OSRM_IMAGE (imagen y versión del motor regional). Crea deploy/api.env con estos valores privados:

- DATABASE_URL: cadena postgres de Supabase con sslmode=require o verify-full con el certificado configurado. Codifica los caracteres reservados de la contraseña en la URI.
- CORS_ORIGINS: https://alerta360-zeta.vercel.app para el frontend actual. Se admiten varios separados por comas.
- JWT_SECRET_KEY: secreto aleatorio de al menos 32 caracteres.
- OPERADORES_BCRYPT_JSON: objeto JSON con los correos autorizados del catálogo actual y sus hashes bcrypt. En api.env usa comillas simples exteriores alrededor del JSON para que Docker no interpole los signos de dólar de bcrypt. Solo se habilitan las cuentas enumeradas. Para generar un hash local, ejecuta en el entorno Python del backend:

```sh
python -c "import bcrypt,getpass;print(bcrypt.hashpw(getpass.getpass().encode(),bcrypt.gensalt()).decode())"
```

Desde deploy ejecuta `docker compose up -d --build`. Verifica `https://DOMINIO-DE-LA-API/health`. Ese endpoint solo prueba el proceso HTTP. Prueba además el login, el catálogo y la predicción autenticados y una ruta con origen y destino dentro del mapa regional.

## Vercel

En el proyecto existente selecciona main, raíz src/frontend, preset Vite, build npm run build y salida dist. En Production añade VITE_API_URL con la URL pública HTTPS del backend. Vuelve a desplegar tras cambiar esa variable. Usa en CORS_ORIGINS la URL de producción estable que abres en el navegador. Los cambios de backend en el servidor Docker se publican actualizando el checkout y repitiendo docker compose up -d --build desde deploy.
