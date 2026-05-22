$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonCmd = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3.10" } else { "python" }
try {
    if ($pythonCmd -eq "py -3.10") {
        & py -3.10 --version *> $null
        if ($LASTEXITCODE -ne 0) { $pythonCmd = "python" }
    }
} catch {
    $pythonCmd = "python"
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; $pythonCmd backend/backend.py"
npm run dev
