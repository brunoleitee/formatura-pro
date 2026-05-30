$ErrorActionPreference = "Stop"

if ($env:PATH -notmatch "C:\\Windows\\System32") {
    $env:PATH = "C:\Windows\System32;" + $env:PATH
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backendRoot = Join-Path $projectRoot "backend"
$spec = Join-Path $projectRoot "backend.spec"
$sidecarDir = Join-Path $projectRoot "src-tauri\binaries"
$runtimeBinDir = Join-Path $projectRoot "src-tauri\bin"
$thumbRoot = Join-Path $projectRoot "src-tauri"
$workDir = Join-Path $projectRoot "build-tauri-backend"

function Build-ThumbEngine {
    $cargoToml = Join-Path $thumbRoot "Cargo.toml"
    if (-not (Select-String -Path $cargoToml -Pattern 'FormaturaPRO-thumb-engine' -Quiet)) {
        Write-Host "Thumb engine Rust não configurado neste checkout; pulando."
        return
    }

    Push-Location $thumbRoot
    try {
        & cargo build --release --bin FormaturaPRO-thumb-engine
        if ($LASTEXITCODE -ne 0) {
            throw "Falha ao compilar o thumb engine."
        }
    } finally {
        Pop-Location
    }

    $builtThumb = Join-Path $thumbRoot "target\release\FormaturaPRO-thumb-engine.exe"
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

Write-Host "Limpando processos antigos..."
Get-Process "FormaturaPRO-backend*" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process "FormaturaPRO-thumb-engine*" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

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
& pyinstaller --clean --noconfirm $spec --distpath $sidecarDir --workpath $workDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "O PyInstaller falhou ao compilar o backend. Verifique as mensagens de erro acima."
    exit $LASTEXITCODE
}

Write-Host "Aguardando liberação do arquivo..."
Start-Sleep -Seconds 5

$pyInstallerDir = Join-Path $sidecarDir "backend"
$pyInstallerExe = Join-Path $pyInstallerDir "backend.exe"
$targetPath = Join-Path $runtimeBinDir "backend-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path $pyInstallerExe)) {
    Write-Error "O executável do backend não foi gerado pelo PyInstaller em $pyInstallerExe"
    exit 1
}

Write-Host "Publicando backend no diretório de runtime do Tauri..."
New-Item -ItemType Directory -Force -Path $runtimeBinDir | Out-Null
Remove-Item -LiteralPath (Join-Path $runtimeBinDir "_internal") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeBinDir "backend.exe") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $pyInstallerDir "_internal") -Destination (Join-Path $runtimeBinDir "_internal") -Recurse -Force
Copy-Item -LiteralPath $pyInstallerExe -Destination $targetPath -Force

if ($null -eq $prevInsightfaceHome) { Remove-Item Env:INSIGHTFACE_HOME -ErrorAction SilentlyContinue } else { $env:INSIGHTFACE_HOME = $prevInsightfaceHome }
if ($null -eq $prevPythonNoUsersite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $prevPythonNoUsersite }

Write-Host "Build do backend concluído com sucesso!"
