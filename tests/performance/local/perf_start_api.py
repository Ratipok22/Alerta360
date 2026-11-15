import os,sys,secrets,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
WORK=Path(os.environ.get('PERF_WORK_DIR',Path(__file__).resolve().parent/'lab')).resolve()
WORK.mkdir(parents=True,exist_ok=True)
os.environ.update(DATABASE_URL='postgresql://perf@127.0.0.1:55432/postgres',APP_ENV='test',PYTHON_DOTENV_DISABLED='1',JWT_SECRET_KEY=secrets.token_urlsafe(48),HISTORIAL_PATH=str(WORK/'perf-historial.json'),CORS_ORIGINS='http://127.0.0.1:5173,http://localhost:5173',OSRM_URL='http://127.0.0.1:59999',HTTP_PROXY='http://127.0.0.1:59999',HTTPS_PROXY='http://127.0.0.1:59999',NO_PROXY='127.0.0.1,localhost')
sys.path[:0]=[str(ROOT/'src/backend'),str(ROOT)]
(WORK/'perf-api-pid.json').write_text(json.dumps({'pid':os.getpid()}))
import uvicorn
uvicorn.run('main:app',host='127.0.0.1',port=8011,access_log=False)
