$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$backend = Join-Path $root "backend.py"
$main = Join-Path $root "main"
$thumbBinDir = Join-Path $main "src-tauri\binaries"
$thumbTarget = Join-Path $thumbBinDir "FormaturaPRO-thumb-engine-x86_64-pc-windows-msvc.exe"

$SKIP_THUMB_BUILD = $env:FORM_PRO_SKIP_THUMB_BUILD -eq "1"


function Copy-ThumbEngine-IfChanged {
    $builtThumb = Join-Path $main "src-tauri\target\debug\FormaturaPRO-thumb-engine.exe"
    
    if (-not (Test-Path $builtThumb)) {
        Write-Host "[THUMB] Executável de build não encontrado: $builtThumb"
        return $false
    }
    
    if (-not (Test-Path $thumbTarget)) {
        Write-Host "[THUMB] Copiando thumb-engine (primeira vez)..."
        New-Item -ItemType Directory -Force -Path $thumbBinDir | Out-Null
        Copy-Item -Path $builtThumb -Destination $thumbTarget -Force
        return $true
    }
    
    try {
        $hashOrigem = (Get-FileHash $builtThumb -Algorithm SHA256).Hash
        $hashDestino = (Get-FileHash $thumbTarget -Algorithm SHA256).Hash
        
        if ($hashOrigem -ne $hashDestino) {
            Write-Host "[THUMB] thumb-engine mudou, copiando..."
            Copy-Item -Path $builtThumb -Destination $thumbTarget -Force
            return $true
        } else {
            Write-Host "[THUMB] thumb-engine inalterado, mantendo existente."
            return $false
        }
    } catch {
        Write-Host "[THUMB] Erro ao comparar hash, copiando por segurança..."
        Copy-Item -Path $builtThumb -Destination $thumbTarget -Force
        return $true
    }
}


function Build-ThumbEngine {
    if ($SKIP_THUMB_BUILD) {
        Write-Host "[THUMB] Pulando build (FORM_PRO_SKIP_THUMB_BUILD=1)"
        return
    }
    
    Push-Location (Join-Path $main "src-tauri")
    try {
        & cargo build --bin FormaturaPRO-thumb-engine
        if ($LASTEXITCODE -ne 0) {
            throw "Falha ao compilar o thumb engine."
        }
    } finally {
        Pop-Location
    }

    Copy-ThumbEngine-IfChanged
}


function Wait-ForPort($port, $timeoutSeconds = 60, $bindHost = "127.0.0.1") {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $connect = $client.BeginConnect($bindHost, $port, $null, $null)
            $wait = $connect.AsyncWaitHandle.WaitOne(500, $false)
            if ($wait) {
                try {
                    $client.EndConnect($connect)
                    $client.Close()
                    Write-Host "[BACKEND] Porta $port disponível"
                    return $true
                } catch {
                    $client.Close()
                }
            }
            $client.Close()
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    return $false
}


function Stop-ProjectProcessOnPort($port) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) {
        Write-Host "[PORTA] Porta $port livre"
        return
    }
    
    foreach ($connection in $connections) {
        $processId = $connection.OwningProcess
        if (-not $processId -or $processId -eq 0) {
            continue
        }

        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        $commandLine = ""
        $executablePath = ""
        if ($process) {
            $commandLine = [string]$process.CommandLine
            $executablePath = [string]$process.ExecutablePath
        }

        $looksLikeThisProject =
            $commandLine.Contains("FormaturaPRO-Tauri") -or
            $commandLine.Contains("backend.py") -or
            $executablePath.Contains("FormaturaPRO")

        if ($looksLikeThisProject) {
            Write-Host "[PORTA] Terminando processo $processId na porta $port"
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        } else {
            Write-Host "[PORTA] Porta $port em uso por outro app, ignorando..."
        }
    }
}


Write-Host "[INIT] Verificando processos existentes..."
Stop-ProjectProcessOnPort 8000
Stop-ProjectProcessOnPort 5173

Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*FormaturaPRO*" } | Stop-Process -Force -ErrorAction SilentlyContinue


Write-Host "[THUMB] Construindo thumb-engine (apenas se necessário)..."
if (-not (Test-Path $thumbTarget)) {
    Build-ThumbEngine
} else {
    Write-Host "[THUMB] Thumb-engine já existe, pulando build."
}


Write-Host "[BACKEND] Iniciando Python backend..."
$env:NODE_OPTIONS = "--dns-result-order=ipv4first"
$env:FORM_PRO_NO_BROWSER = "1"
$backendProcess = Start-Process -FilePath "python" -ArgumentList "`"$backend`"" -WorkingDirectory $root -WindowStyle Normal -PassThru


Write-Host "[BACKEND] Aguardando porta 8000..."
if (-not (Wait-ForPort 8000 45)) {
    Write-Host "[BACKEND] ERRO - Backend não iniciou na porta 8000"
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    throw "Backend indisponível na porta 8000"
}


Write-Host "[FRONTEND] Iniciando Vite dev server..."
$mainPath = Join-Path $root "main"
Push-Location $mainPath

$devProcess = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy Bypass", "-Command", "cd '$mainPath'; npm run dev:frontend" -WindowStyle Normal -PassThru

function Get-CdpErrors($port, $sec) {
    $err = @()
    try {
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ct = [Threading.CancellationToken]::None
        $ws.ConnectAsync((Invoke-RestMethod "http://localhost:$port/json" -TimeoutSec 3)[0].webSocketDebuggerUrl, $ct).Wait()
        '{"id":1,"method":"Runtime.enable"}','{"id":2,"method":"Log.enable"}' | % { $ws.SendAsync([ArraySegment[byte]][Text.Encoding]::UTF8.GetBytes($_), 'Text', $true, $ct).Wait() }
        $buf = [byte[]]::new(32768); $end = (Get-Date).AddSeconds($sec)
        while ((Get-Date) -lt $end -and $ws.State -eq 'Open') {
            $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct)
            if ($r.Wait(500) -and $r.Result.Count -gt 0) {
                $j = [Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count) | ConvertFrom-Json -EA SilentlyContinue
                if ($j.method -match "exceptionThrown|consoleAPICalled|entryAdded" -and ($j.method -eq "Runtime.exceptionThrown" -or $j.params.type -eq "error" -or $j.params.entry.level -eq "error")) { $err += $j }
            }
        }
        $ws.CloseAsync('NormalClosure', "", $ct).Wait()
    } catch { }
    $err
}

$waited = 0
$frontendReady = $false
while ($waited -lt 30 -and -not $frontendReady) {
    Start-Sleep -Milliseconds 500
    $waited += 0.5
    try {
        Invoke-RestMethod "http://127.0.0.1:5173" -TimeoutSec 1 | Out-Null
        $frontendReady = $true
    } catch { }
}

if (-not $frontendReady) {
    Write-Host "[FRONTEND] ERRO - Frontend não iniciou"
    if ($devProcess -and -not $devProcess.HasExited) { Stop-Process -id $devProcess.Id -Force }
    if ($backendProcess -and -not $backendProcess.HasExited) { Stop-Process -id $backendProcess.Id -Force }
    throw "Frontend não iniciou na porta 5173"
}

Write-Host "[READY] Backend e Frontend iniciados com sucesso!"
Write-Host ""
Write-Host "========================================"
Write-Host "  FormaturaPRO Dev Mode Iniciado"
Write-Host "  Frontend: http://127.0.0.1:5173"
Write-Host "  Backend:  http://127.0.0.1:8000"
Write-Host "========================================"
Write-Host ""

$null = $Host.UI.RawUI.WindowTitle
$Host.UI.RawUI.WindowTitle = "FormaturaPRO - Dev Mode (Ctrl+C para sair)"

try {
    $devProcess.WaitForExit()
} finally {
    Pop-Location
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($devProcess -and -not $devProcess.HasExited) {
        Stop-Process -Id $devProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
