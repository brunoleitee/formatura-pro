"""
Serviço isolado e altamente modular para comunicação com a API local do Ollama
e execução de inferência visual avançada com o modelo Qwen2.5-VL.
"""

import os
import json
import base64
import time
import logging
from io import BytesIO
from typing import Dict, Any, Generator, Optional
import urllib.request
import urllib.error
from PIL import Image

logger = logging.getLogger("ollama_service")

OLLAMA_API_BASE = "http://localhost:11434"
# Canonical Ollama library name is "qwen2.5vl" (no hyphen). The /api/pull
# endpoint accepts the hyphenated alias too, but `ollama list` returns the
# canonical form (e.g. "qwen2.5vl:7b"), so we must compare without the hyphen.
QWEN_MODEL_NAME = "qwen2.5vl"
# Aliases we still want to recognize when scanning installed models.
_QWEN_MATCH_TOKENS = ("qwen2.5vl", "qwen2.5-vl", "qwen2_5vl")


def check_ollama_status() -> Dict[str, Any]:
    """
    Verifica se o Ollama está rodando localmente e se o modelo qwen2.5-vl está disponível.
    """
    status = {"running": False, "has_model": False, "version": None, "models": []}
    
    # 1. Verificar se a API está no ar
    try:
        req = urllib.request.Request(f"{OLLAMA_API_BASE}/api/tags")
        with urllib.request.urlopen(req, timeout=3.0) as res:
            if res.status == 200:
                status["running"] = True
                data = json.loads(res.read().decode("utf-8"))
                models = data.get("models") or []
                status["models"] = [m.get("name") for m in models]
                
                # Verificar se o modelo qwen2.5-vl está na lista.
                # Ollama armazena o modelo como "qwen2.5vl:<tag>" (sem hífen),
                # então normalizamos ambos os lados para tolerar aliases.
                for m in models:
                    name = str(m.get("name") or "").lower()
                    if any(tok in name for tok in _QWEN_MATCH_TOKENS):
                        status["has_model"] = True
                        logger.info("[ollama] modelo qwen2.5-vl detectado como %r", name)
                        break
    except Exception as e:
        logger.debug("[ollama] falha ao checar status da API: %s", e)
        return status

    # 2. Obter versão se estiver rodando
    if status["running"]:
        try:
            req = urllib.request.Request(f"{OLLAMA_API_BASE}/api/version")
            with urllib.request.urlopen(req, timeout=2.0) as res:
                if res.status == 200:
                    data = json.loads(res.read().decode("utf-8"))
                    status["version"] = data.get("version")
        except Exception:
            pass

    return status


def pull_qwen_model_stream() -> Generator[Dict[str, Any], None, None]:
    """
    Envia comando para baixar (pull) o modelo qwen2.5-vl da biblioteca oficial do Ollama,
    retornando um gerador que fornece o status e progresso do download em tempo real.

    O Ollama envia progresso por camada (não pelo modelo inteiro), então acumulamos
    totals/completed por digest para reportar progresso global confiável e só
    sinalizamos success quando o status "success" chega de verdade.
    """
    payload = json.dumps({"name": QWEN_MODEL_NAME}).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_API_BASE}/api/pull",
        data=payload,
        headers={"Content-Type": "application/json"}
    )

    layer_totals: Dict[str, int] = {}
    layer_completed: Dict[str, int] = {}
    saw_success = False

    try:
        with urllib.request.urlopen(req) as res:
            buffer = ""
            decoder_errors = 0
            while True:
                chunk = res.read(4096)
                if not chunk:
                    break
                try:
                    buffer += chunk.decode("utf-8")
                except UnicodeDecodeError:
                    decoder_errors += 1
                    if decoder_errors > 5:
                        raise
                    continue

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue

                    # Erro estruturado: aborta
                    if "error" in data:
                        yield {
                            "status": "error",
                            "message": f"Erro do Ollama: {data['error']}",
                            "percent": 0.0,
                        }
                        return

                    status_text = str(data.get("status", ""))

                    if status_text == "success":
                        saw_success = True
                        yield {"status": "success", "message": "Modelo baixado com sucesso!", "percent": 100.0}
                        return

                    # Atualiza acumuladores por camada (digest)
                    digest = str(data.get("digest") or "")
                    total = int(data.get("total") or 0)
                    completed = int(data.get("completed") or 0)
                    if digest and total > 0:
                        layer_totals[digest] = total
                        layer_completed[digest] = min(completed, total)

                    grand_total = sum(layer_totals.values())
                    grand_done = sum(layer_completed.values())
                    # Cap em 99% durante o download — só vira 100% quando o
                    # Ollama mandar "success".
                    if grand_total > 0:
                        percent = round((grand_done / grand_total) * 100.0, 2)
                        percent = min(percent, 99.0)
                    else:
                        percent = 0.0

                    yield {
                        "status": "downloading",
                        "message": status_text or "Baixando...",
                        "percent": percent,
                        "completed": grand_done,
                        "total": grand_total,
                    }

        # Stream encerrou sem "success" — não fingir sucesso.
        if not saw_success:
            yield {
                "status": "error",
                "message": "A conexão com o Ollama foi interrompida antes do download terminar. Tente novamente.",
                "percent": 0.0,
            }
    except Exception as e:
        logger.error("[ollama] erro no download do modelo: %s", e)
        yield {"status": "error", "message": f"Erro de download: {str(e)}", "percent": 0.0}


def _prepare_image_base64(photo_path: str, max_size: int = 1024) -> Optional[str]:
    """
    Carrega a imagem, redimensiona para tamanho compacto (otimizando VRAM/Tempo de processamento)
    e converte para string codificada em Base64.
    """
    if not os.path.exists(photo_path):
        return None
    try:
        with Image.open(photo_path) as img:
            # Converter para RGB se necessário
            if img.mode != "RGB":
                img = img.convert("RGB")
                
            # Redimensionamento inteligente mantendo proporção
            width, height = img.size
            if max(width, height) > max_size:
                if width > height:
                    new_w = max_size
                    new_h = int(height * (max_size / width))
                else:
                    new_h = max_size
                    new_w = int(width * (max_size / height))
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                
            # Salvar em bytes buffer de forma compacta (JPEG)
            buffered = BytesIO()
            img.save(buffered, format="JPEG", quality=82, optimize=True)
            return base64.b64encode(buffered.getvalue()).decode("utf-8")
    except Exception as e:
        logger.error("[ollama] falha ao preparar imagem base64: %s", e)
        return None


def analyze_graduation_with_qwen(photo_path: str) -> Dict[str, Any]:
    """
    Executa a inferência visual avançada no Qwen2.5-VL para classificar os itens de formatura.
    Retorna o payload de classificação com os campos booleanos de forma 100% precisa.
    """
    t0 = time.perf_counter()
    
    # 1. Preparar a imagem
    base64_img = _prepare_image_base64(photo_path)
    if not base64_img:
        return {"error": "Falha ao ler ou converter imagem para processamento"}
        
    # 2. Montar prompt semântico direcionado
    prompt = (
        "Analyze this graduation photo. Detect if the student is wearing or holding these items. "
        "Return a JSON object with EXACTLY the following boolean fields: "
        "has_gown (true if wearing a graduation gown/beca), "
        "has_diploma (true if holding a graduation diploma/canudo), "
        "has_sash (true if wearing a sash/faixa), "
        "has_cap (true if wearing a cap/capelo), "
        "has_jabor (true if wearing a collar/jabor). "
        "Do not return any conversational text or markdown, just the clean JSON."
    )
    
    payload = {
        "model": QWEN_MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64_img]
            }
        ],
        "stream": False,
        "format": "json"
    }
    
    # 3. Enviar requisição para o Ollama
    req = urllib.request.Request(
        f"{OLLAMA_API_BASE}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30.0) as res:
            if res.status == 200:
                data = json.loads(res.read().decode("utf-8"))
                message_content = data.get("message", {}).get("content", "")
                
                # Fazer o parsing da resposta JSON da IA
                result = json.loads(message_content.strip())
                
                # Sanitizar campos booleanos na resposta
                cleaned_result = {
                    "has_gown": bool(result.get("has_gown")),
                    "has_diploma": bool(result.get("has_diploma")),
                    "has_sash": bool(result.get("has_sash")),
                    "has_cap": bool(result.get("has_cap")),
                    "has_jabor": bool(result.get("has_jabor")),
                    "source": "qwen2.5-vl",
                    "latency_ms": round((time.perf_counter() - t0) * 1000, 2)
                }
                
                logger.info("[ollama] analise bem sucedida para %s em %dms. Resultado: %s", 
                            os.path.basename(photo_path), cleaned_result["latency_ms"], cleaned_result)
                return cleaned_result
                
    except Exception as e:
        logger.error("[ollama] falha na requisição de chat para %s: %s", os.path.basename(photo_path), e)
        return {"error": f"Erro de comunicação com o modelo VLM: {str(e)}"}
        
    return {"error": "Falha desconhecida no processamento de visão"}


def download_and_run_ollama_installer_stream() -> Generator[Dict[str, Any], None, None]:
    """
    Baixa o OllamaSetup.exe diretamente do site oficial e o executa em segundo plano no Windows.
    Fornece feedback do progresso de download em tempo real.
    """
    url = "https://ollama.com/download/OllamaSetup.exe"
    dest_dir = os.path.join(os.environ.get("USERPROFILE", ""), "Downloads")
    if not os.path.exists(dest_dir):
        dest_dir = os.path.dirname(os.path.abspath(__file__))  # Fallback
        
    dest_path = os.path.join(dest_dir, "OllamaSetup.exe")
    
    yield {"status": "starting", "message": "Iniciando download do instalador...", "percent": 0.0}
    
    try:
        # Requisição com cabeçalho de navegador comum para evitar bloqueios de CDN
        req = urllib.request.Request(
            url, 
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        
        with urllib.request.urlopen(req) as response:
            total_size = int(response.headers.get('content-length', 0))
            
            # O instalador do Ollama para Windows tem cerca de 180MB. 
            # Se a CDN/rede retornar um tamanho bizarro (ex: > 350MB ou <= 0), fixamos em 182MB para uma UX estável.
            if total_size <= 0 or total_size > 350 * 1024 * 1024:
                total_size = 182 * 1024 * 1024
                
            block_size = 1024 * 512  # 512 KB
            downloaded = 0
            
            with open(dest_path, 'wb') as f:
                while True:
                    buffer = response.read(block_size)
                    if not buffer:
                        break
                    downloaded += len(buffer)
                    f.write(buffer)
                    
                    percent = 0.0
                    if total_size > 0:
                        percent = round((downloaded / total_size) * 100.0, 2)
                        # Limitar percentual de download físico a 98.9% para reservar o fim da barra para execução do instalador
                        percent = min(98.9, percent)
                        
                    yield {
                        "status": "downloading",
                        "message": f"Baixando OllamaSetup.exe: {round(downloaded / (1024*1024), 1)}MB / {round(total_size / (1024*1024), 1)}MB",
                        "percent": percent
                    }
                    
        yield {"status": "running", "message": "Iniciando o instalador do Ollama...", "percent": 99.0}
        
        # Executa de forma nativa e assíncrona no Windows
        import subprocess
        subprocess.Popen([dest_path], shell=True)
        
        yield {
            "status": "success", 
            "message": "Instalador iniciado! Siga as instruções da janela do instalador que abriu na sua barra de tarefas.", 
            "percent": 100.0
        }
        
    except Exception as e:
        logger.error("[ollama] erro ao baixar ou executar o instalador do Ollama: %s", e)
        yield {
            "status": "error", 
            "message": f"Falha no download automático do instalador: {str(e)}. Recomendamos baixar manualmente se persistir.", 
            "percent": 0.0
        }

