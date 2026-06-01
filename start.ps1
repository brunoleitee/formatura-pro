$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Wait-ForBackend {
    param(
        [int]$Port = 8000,
        [int]$TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            try {
                Invoke-RestMethod "http://127.0.0.1:$Port/api/system/status" -TimeoutSec 2 *> $null
                return $true
            } catch {
                Start-Sleep -Milliseconds 500
            }
        } else {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Stop-ProcessOnPort {
    param(
        [int]$Port,
        [string]$Label
    )

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $processId = $listener.OwningProcess
        if ($processId -and $processId -ne $PID) {
            Write-Host "[Start] Encerrando $Label zumbi na porta $Port (PID: $processId)..." -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-OldTauriApp {
    $names = @("formatura-pro-2", "Formatura PRO 2.0", "Formatura PRO")
    foreach ($name in $names) {
        $processes = Get-Process -Name $name -ErrorAction SilentlyContinue
        foreach ($process in $processes) {
            if ($process.Id -ne $PID) {
                Write-Host "[Start] Encerrando janela antiga do Formatura PRO (PID: $($process.Id))..." -ForegroundColor Yellow
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# Limpeza automática de instâncias zumbis para evitar conflito entre runs do .\start.ps1
Stop-OldTauriApp
Stop-ProcessOnPort -Port 8000 -Label "backend FastAPI"
Stop-ProcessOnPort -Port 5173 -Label "frontend Vite"
Start-Sleep -Seconds 1

$pythonCmd = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3.10" } else { "python.exe" }
try {
    if ($pythonCmd -eq "py -3.10") {
        & py -3.10 --version *> $null
        if ($LASTEXITCODE -ne 0) { $pythonCmd = "python.exe" }
    }
} catch {
    $pythonCmd = "python.exe"
}
$backendProcess = Start-Process powershell -WorkingDirectory $root -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$root'; $pythonCmd backend/backend.py"

if (-not (Wait-ForBackend -Port 8000 -TimeoutSeconds 45)) {
    Write-Host "[Start] Backend não respondeu na porta 8000 dentro do tempo limite." -ForegroundColor Red
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
}

try {
    npm run tauri
} finally {
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
