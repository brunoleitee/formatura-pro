$ErrorActionPreference = "Stop"

if ($env:PATH -notmatch "C:\\Windows\\System32") {
    $env:PATH = "C:\Windows\System32;" + $env:PATH
}
$root = Split-Path $PSScriptRoot -Parent
$main = Join-Path $root "main"
$spec = Join-Path $root "FormaturaPRO-backend.spec"
$sidecarDir = Join-Path $main "src-tauri\binaries"
$workDir = Join-Path $root "build-tauri-backend"

function Build-ThumbEngine {
    Push-Location (Join-Path $main "src-tauri")
    try {
        & cargo build --release --bin FormaturaPRO-thumb-engine
        if ($LASTEXITCODE -ne 0) {
            throw "Falha ao compilar o thumb engine."
        }
    } finally {
        Pop-Location
    }

    $builtThumb = Join-Path $main "src-tauri\target\release\FormaturaPRO-thumb-engine.exe"
    $targetThumb = Join-Path $sidecarDir "FormaturaPRO-thumb-engine-x86_64-pc-windows-msvc.exe"
    if (Test-Path $builtThumb) {
        New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
        Copy-Item -Path $builtThumb -Destination $targetThumb -Force
    }
}

function Import-VsDevEnvironment {
    $batCandidates = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Community\VC\Auxiliary\Build\vcvars64.bat"
    )

    $batPath = $batCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $batPath) {
        # Tenta encontrar via vswhere se o caminho fixo falhar
        $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vswhere) {
            $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($installPath) {
                $batPath = Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat"
            }
        }
    }

    if (-not (Test-Path $batPath)) {
        return $false
    }

    Write-Host "Carregando ambiente do Visual Studio: $batPath"
    $cmdExe = "C:\Windows\System32\cmd.exe"
    $envLines = & $cmdExe /c "`"$batPath`" && set"
    foreach ($line in $envLines) {
        if ($line -match '^([^=]+)=(.*)$') {
            $name = $matches[1]
            $value = $matches[2]
            if ($name -ieq "Path") {
                $env:Path = $value + ";" + $env:Path
            } else {
                Set-Item -Path "Env:$name" -Value $value
            }
        }
    }
    return $true
}

# Terminar processos antigos se existirem para evitar erro de arquivo em uso
Write-Host "Limpando processos antigos..."
Get-Process "FormaturaPRO-backend*" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process "FormaturaPRO-thumb-engine*" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Push-Location $main
Write-Host "Instalando dependências do frontend..."
& npm.cmd install
Write-Host "Compilando frontend..."
& npm.cmd run build
Pop-Location
if ($LASTEXITCODE -ne 0) {
    throw "Falha no build do frontend (npm run build)."
}

try {
    Write-Host "Compilando Thumb Engine (Rust)..."
    Build-ThumbEngine
} catch {
    Write-Warning "Não foi possível compilar o thumb engine em Rust; o backend continuará com o fallback em Python. Detalhe: $($_.Exception.Message)"
}

New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
$emptyInsightfaceHome = Join-Path $workDir "insightface-home"

$prevInsightfaceHome = $env:INSIGHTFACE_HOME
$prevPythonNoUsersite = $env:PYTHONNOUSERSITE
New-Item -ItemType Directory -Force -Path $emptyInsightfaceHome | Out-Null
$env:INSIGHTFACE_HOME = $emptyInsightfaceHome
$env:PYTHONNOUSERSITE = "1"

Write-Host "Iniciando compilação do backend com PyInstaller (Modo OneFile)..."
# Usamos --noconfirm para rodar sem travar
& pyinstaller --clean --noconfirm $spec --distpath $sidecarDir --workpath $workDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "O PyInstaller falhou ao compilar o backend. Verifique as mensagens de erro acima."
    exit $LASTEXITCODE
}

Write-Host "Aguardando liberação do arquivo..."
Start-Sleep -Seconds 5

# Nome do sidecar com o target triplet para o Tauri
$targetPath = Join-Path $sidecarDir "FormaturaPRO-backend-x86_64-pc-windows-msvc.exe"
if (Test-Path "$sidecarDir\FormaturaPRO-backend.exe") {
    Write-Host "Renomeando backend para o formato sidecar do Tauri..."
    Move-Item -Path "$sidecarDir\FormaturaPRO-backend.exe" -Destination $targetPath -Force
} else {
    Write-Error "O executável do backend não foi gerado pelo PyInstaller em $sidecarDir\FormaturaPRO-backend.exe"
    exit 1
}

Write-Host "Iniciando build final do Tauri..."
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    if (-not (Import-VsDevEnvironment) -or -not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
        Write-Warning "O linker do MSVC (link.exe) não foi encontrado no PATH. O Tauri pode tentar localizar sozinho ou falhar."
    }
}

Push-Location $main
& npx.cmd tauri build
Pop-Location
if ($LASTEXITCODE -ne 0) {
    throw "Falha no build do Tauri."
}

if ($null -eq $prevInsightfaceHome) { Remove-Item Env:INSIGHTFACE_HOME -ErrorAction SilentlyContinue } else { $env:INSIGHTFACE_HOME = $prevInsightfaceHome }
if ($null -eq $prevPythonNoUsersite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $prevPythonNoUsersite }

Write-Host "Build concluído com sucesso!"
