# NASA CIR-0G: Microgravity Fire Risk Simulator

Interactive 3D/2D microgravity combustion simulator and NASA Physical Sciences Informatics (PSI) benchmark analyzer.

## Live Demo (Vercel)
- **URL:** https://express-plateau-7x4wz87.tmp.now *(claimable via Vercel dashboard / importable directly from this repo)*

## Local Run
```bash
.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

## Vercel Serverless Deployment
Configured via `vercel.json`, `api/index.py`, and `requirements.txt`:
- `/` serves the 3D/2D Three.js + Web Worker frontend (`frontend/`).
- `/api/*` runs the FastAPI serverless backend (`api/index.py`) backed by `nasa_fire.db`.
