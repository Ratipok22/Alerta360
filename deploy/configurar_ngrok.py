"""Guarda el authtoken localmente sin imprimirlo ni incluirlo en comandos."""
import getpass
import re
from pathlib import Path

def main():
    destino = Path(__file__).resolve().parent / "ngrok.env"
    if destino.exists():
        raise SystemExit("ngrok.env ya existe. Se conserva; no se sobrescribio.")
    token = getpass.getpass("Pega tu authtoken de ngrok (no se mostrara): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", token):
        raise SystemExit("Formato no valido: pega solo el authtoken, no el comando completo.")
    with destino.open("x", encoding="utf-8") as f:
        f.write("NGROK_AUTHTOKEN=" + token + "\n")
    print("Token guardado en deploy/ngrok.env, excluido de Git. No compartas ese archivo.")

if __name__ == "__main__":
    main()
