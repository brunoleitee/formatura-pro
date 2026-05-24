$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonCmd = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3.10" } else { "python.exe" }
try {
    if ($pythonCmd -eq "py -3.10") {
        & py -3.10 --version *> $null
        if ($LASTEXITCODE -ne 0) { $pythonCmd = "python.exe" }
    }
} catch {
    $pythonCmd = "python.exe"
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; $pythonCmd backend/backend.py"
npm run dev
