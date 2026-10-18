#!/usr/bin/env bash
# Levanta backend (FastAPI, segundo plano) y frontend (Vite, primer plano)
# desde una sola terminal. Ctrl+C detiene ambos.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo ""
    echo "Deteniendo backend (PID $BACKEND_PID)..."
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Motor de rutas real por calles (OSRM local, ver routing/README.md). Si no
# hay datos generados o Docker no esta disponible, se omite sin detener el
# resto: el backend cae de vuelta a linea recta en ese caso (ver /route).
DATA_DIR="$DIR/routing/data"
if [ -f "$DATA_DIR/valparaiso.osrm" ]; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^osrm-valparaiso$'; then
    docker start osrm-valparaiso >/dev/null 2>&1 || true
  else
    MSYS_NO_PATHCONV=1 docker run -d --name osrm-valparaiso -p 5001:5000 -v "$DATA_DIR:/data" \
      ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/valparaiso.osrm >/dev/null 2>&1 || true
  fi
  echo "Motor de rutas (OSRM) en :5001"
else
  echo "Aviso: sin datos de ruteo (routing/data/valparaiso.osrm no existe)."
  echo "  Corre ./routing/generar_datos.sh para que los carros sigan calles reales."
fi

echo "Iniciando backend (FastAPI) en segundo plano..."
(cd "$DIR/backend" && source .venv/Scripts/activate && uvicorn main:app --reload) &
BACKEND_PID=$!

sleep 1
echo "Iniciando frontend (Vite) en primer plano..."
cd "$DIR/frontend"
npm run dev
