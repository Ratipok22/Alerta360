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

echo "Iniciando backend (FastAPI) en segundo plano..."
(cd "$DIR/backend" && source .venv/Scripts/activate && uvicorn main:app --reload) &
BACKEND_PID=$!

sleep 1
echo "Iniciando frontend (Vite) en primer plano..."
cd "$DIR/frontend"
npm run dev
