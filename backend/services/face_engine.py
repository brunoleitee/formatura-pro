import threading
import os
import traceback
import contextlib
import io
from onnx_provider_utils import get_onnx_providers, get_session_providers

_FACE_ENGINE_LOCK = threading.Lock()
FACE_INFERENCE_LOCK = threading.RLock()

# State variables
app_face = None
face_engine_device = ""
face_engine_provider = ""
face_engine_label = ""
face_engine_gpu_error = ""

# Configuration variables
runtime_dir = ""
det_size = (640, 640)

def _default_log(msg, *args):
    pass

log_info = _default_log
log_debug = _default_log

@contextlib.contextmanager
def _default_quiet_external_output():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield

quiet_external_output = _default_quiet_external_output

def configure(**kwargs):
    global runtime_dir, det_size, log_info, log_debug, quiet_external_output
    if "runtime_dir" in kwargs and kwargs["runtime_dir"] is not None:
        runtime_dir = kwargs["runtime_dir"]
    if "det_size" in kwargs and kwargs["det_size"] is not None:
        det_size = kwargs["det_size"]
    if "log_info" in kwargs and kwargs["log_info"] is not None:
        log_info = kwargs["log_info"]
    if "log_debug" in kwargs and kwargs["log_debug"] is not None:
        log_debug = kwargs["log_debug"]
    if "quiet_external_output" in kwargs and kwargs["quiet_external_output"] is not None:
        quiet_external_output = kwargs["quiet_external_output"]

AI_PROVIDER_LABELS = {
    "CUDAExecutionProvider": "GPU NVIDIA",
    "DmlExecutionProvider": "GPU DirectML",
    "CPUExecutionProvider": "CPU",
}

def _provider_label(provider_name):
    return AI_PROVIDER_LABELS.get(provider_name, provider_name or "CPU")

def get_available_ai_provider():
    provider_info = get_onnx_providers(log_debug=log_debug)
    available = provider_info["available_providers"]
    return {
        "available_providers": available,
        "provider_error": provider_info.get("provider_error", ""),
        "preload_error": "",
        "selected_provider": provider_info["provider"],
        "selected_label": provider_info["label"],
        "selected_providers": provider_info["selected_providers"],
        "provider_options": provider_info["provider_options"],
        "ctx_id": provider_info["ctx_id"],
        "provider": provider_info["provider"],
        "label": provider_info["label"],
        "device": provider_info["device"],
        "cuda_failed": provider_info["cuda_failed"],
    }

def ensure_face_engine():
    global app_face, face_engine_device, face_engine_provider, face_engine_label, face_engine_gpu_error
    if app_face is not None:
        log_info("[AI] reutilizando InsightFace global")
        return

    with _FACE_ENGINE_LOCK:
        if app_face is not None:
            log_info("[AI] reutilizando InsightFace global")
            return

        log_info("[AI] inicializando InsightFace global...")
        provider_info = get_available_ai_provider()
        selected_provider = provider_info["selected_provider"]
        selected_providers = provider_info["selected_providers"]
        provider_options = provider_info["provider_options"]
        ctx_id = provider_info["ctx_id"]

        model_root = runtime_dir if os.path.isdir(os.path.join(runtime_dir, "models", "buffalo_l")) else "~/.insightface"

        import signal
        _orig_signal = signal.signal
        def _safe_signal(sig, handler):
            try:
                return _orig_signal(sig, handler)
            except ValueError as e:
                if "signal only works in main thread" in str(e):
                    return None
                raise

        signal.signal = _safe_signal
        try:
            from insightface.app import FaceAnalysis

            try:
                with quiet_external_output():
                    app_face_instance = FaceAnalysis(
                        name="buffalo_l",
                        root=model_root,
                        providers=selected_providers,
                        provider_options=provider_options,
                        allowed_modules=["detection", "recognition"],
                    )
                    app_face_instance.prepare(ctx_id=ctx_id, det_size=det_size)

                real_providers = get_session_providers(app_face_instance)
                real_provider = real_providers[0] if real_providers else selected_provider
                log_info(f"[AI] Sessao ONNX providers reais: {real_providers}")
                face_engine_device = "GPU" if real_provider in {"CUDAExecutionProvider", "DmlExecutionProvider"} else "CPU"
                face_engine_provider = real_provider
                face_engine_label = _provider_label(real_provider)
                face_engine_gpu_error = provider_info.get("provider_error", "")
                if face_engine_device == "GPU":
                    log_info(f"[AI] {face_engine_label} ativo")
                else:
                    log_info(f"[AI] GPU indisponivel, usando CPU (solicitado={selected_provider})")
                log_info(f"[AI] Provider ativo: {real_provider}")
            except Exception as e:
                log_info(f"[AI] Falha ao carregar engine de IA: {e}")
                log_info(f"[AI] Traceback completo:\n{traceback.format_exc()}")
                if selected_provider == "CPUExecutionProvider":
                    raise

                log_info(f"[AI] {selected_provider} falhou, fallback para CPU")
                with quiet_external_output():
                    app_face_instance = FaceAnalysis(
                        name="buffalo_l",
                        root=model_root,
                        providers=["CPUExecutionProvider"],
                        provider_options=None,
                        allowed_modules=["detection", "recognition"],
                    )
                    app_face_instance.prepare(ctx_id=-1, det_size=det_size)
                real_providers = get_session_providers(app_face_instance)
                real_provider = real_providers[0] if real_providers else "CPUExecutionProvider"
                face_engine_device = "CPU"
                face_engine_provider = real_provider
                face_engine_label = _provider_label(real_provider)
                face_engine_gpu_error = str(e)
                log_info(f"[AI] Provider ativo: {real_provider}")

            app_face = app_face_instance
            log_info(f"[Face] model loaded device={face_engine_device} provider={face_engine_provider} label={face_engine_label}")
        finally:
            signal.signal = _orig_signal

def get_app_face():
    return app_face

def get_face_engine_device():
    return face_engine_device

def get_face_engine_provider():
    return face_engine_provider

def get_face_engine_label():
    return face_engine_label or face_engine_device

def get_face_engine_gpu_error():
    return face_engine_gpu_error
