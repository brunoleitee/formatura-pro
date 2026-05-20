---
name: run-formatura-pro
description: Run, start, build, screenshot, test, launch, drive the Formatura PRO app — React frontend + Python FastAPI backend photo management desktop app
---

# run-formatura-pro

Formatura PRO is a graduation photo management app: React/Vite frontend (port 5173) + Python FastAPI backend (port 8000). The driver is `.claude/skills/run-formatura-pro/driver.cjs`, driven via Playwright (already in devDependencies). No separate display server needed — headless Chromium works out of the box on Windows.

## Prerequisites

```
npm install           # installs playwright (already in devDependencies)
pip install fastapi uvicorn pillow opencv-python-headless numpy
```

The backend uses `faiss` (with NumPy 1.x). NumPy 2.x prints warnings but the backend continues. Do not try to fix the NumPy warning — the backend still starts.

## Build

No build step needed for dev mode. The Vite dev server hot-reloads on file change.

## Run (agent path)

Start backend in background:

```
cd backend
python backend.py --port 8000
```

Wait for the line `Iniciando servidor em http://127.0.0.1:8000` to confirm it's up.

Start frontend in background:

```
npx vite --port 5173
```

Wait for `VITE ... ready` to confirm.

Then drive with the driver:

```
# Screenshot (saves to ./screenshot.png by default)
node .claude/skills/run-formatura-pro/driver.cjs ss [path]

# Navigate sidebar (e.g. Catálogo, Formandos, Visão Geral)
node .claude/skills/run-formatura-pro/driver.cjs nav Catálogo

# Hit backend API and print JSON
node .claude/skills/run-formatura-pro/driver.cjs api api/catalogs
node .claude/skills/run-formatura-pro/driver.cjs api api/settings

# Set photo grid zoom (value: 100–400)
node .claude/skills/run-formatura-pro/driver.cjs zoom 200

# Print body text (for content assertions)
node .claude/skills/run-formatura-pro/driver.cjs text
```

Override ports with env vars:

```
BACKEND_PORT=8001 FRONTEND_PORT=5174 node .claude/skills/run-formatura-pro/driver.cjs ss
```

## Run (human path)

On Windows, `npm run dev:all` starts both in two PowerShell windows. Opens at http://localhost:5173. This is useless headless; use the driver above.

## Gotchas

- **Bash path mangling**: In Git Bash, `/api/catalogs` becomes a Windows path. Pass `api/catalogs` without the leading slash to the `api` command.
- **NumPy 2.x + faiss**: The backend prints `_ARRAY_API not found` on startup. This is a faiss/NumPy version mismatch warning — it falls back and continues. Do NOT downgrade NumPy or rebuild faiss; the app works fine.
- **Port 8000 already in use**: The backend has auto-kill logic for this port. If it hangs, use `--port 8001` and set `BACKEND_PORT=8001` for the driver.
- **Catalog required for photo grid**: The Catálogo view shows "Nenhum catálogo aberto" until a catalog is selected. Use `api api/catalogs` to list available catalogs, then select via the UI with the `catalog` command.
- **playwright package**: Installed as a devDependency. `node driver.cjs` resolves it from `node_modules/` when run from the project root.

## Troubleshooting

| Error | Fix |
|---|---|
| `ERR_MODULE_NOT_FOUND: playwright` | Run from project root, not `/tmp`; or `npm install` first |
| `Failed to parse URL` | Pass API paths without leading slash: `api/catalogs` not `/api/catalogs` |
| `Address already in use :8000` | Backend auto-kills; wait 2s and retry, or use `--port 8001` |
| `ImportError: _ARRAY_API not found` | Faiss/NumPy warning — backend still works, ignore it |
