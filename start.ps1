$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; python backend/backend.py"
npm run dev
