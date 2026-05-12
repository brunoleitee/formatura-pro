import os
import threading
import urllib.parse
import traceback

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


def _value(name, default=None):
    value = _get(name, default)
    return value() if callable(value) else value


from pydantic import BaseModel, Field, validator
import re

from typing import List, Optional
class ScanRequest(BaseModel):
    ref_path: Optional[str] = Field(default="", max_length=500)
    ori_path: str = Field(..., min_length=1, max_length=500)
    project_name: Optional[str] = Field(default="Scanner", max_length=100)
    extra_paths: List[str] = Field(default_factory=list, max_items=10)

    @validator('ref_path', 'ori_path', 'project_name', pre=True)
    def handle_none(cls, v):
        return v or ""

    @validator('ref_path', 'ori_path', 'project_name')
    def sanitize_strings(cls, v):
        if not isinstance(v, str):
            v = str(v or "")
        # Remover caracteres de controle
        v = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', v)
        # Prevenir path traversal básico
        v = re.sub(r'\.\./|\.\.\\', '', v)
        return v.strip()

    @validator('extra_paths', each_item=True)
    def sanitize_extra_paths(cls, v):
        v = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', v)
        v = re.sub(r'\.\./|\.\.\\', '', v)
        return v.strip()


def scan_precheck(req: ScanRequest):
    try:
        print(f"[DEBUG] Recebido precheck para o projeto: {req.project_name}")
        sanitize_catalog_name = _get("sanitize_catalog_name")
        catalog_dir = _get("catalog_dir")
        get_db = _get("get_db")
        image_extensions = _get("image_extensions", ())
        gpu_diagnostics = _get("gpu_diagnostics")

        checks = []
        warnings = []
        errors = []
        project_name = (req.project_name or "").strip()

        try:
            cname = sanitize_catalog_name(project_name)
            checks.append({"label": "Nome do catálogo", "ok": True, "detail": cname})
        except Exception:
            cname = ""
            errors.append("Informe um nome válido para o catálogo.")
            checks.append({"label": "Nome do catálogo", "ok": False, "detail": "Nome vazio ou inválido"})

        catalog_exists = False
        db_path = os.path.join(catalog_dir, f"{cname}.db") if cname else ""
        if db_path and os.path.exists(db_path):
            try:
                with get_db(cname) as conn:
                    if conn.conn:
                        cur = conn.cursor()
                        cur.execute("SELECT 1 FROM ocorrencias LIMIT 1")
                        has_occurrences = cur.fetchone() is not None
                        cur.execute("SELECT 1 FROM discarded_photos LIMIT 1")
                        has_discarded = cur.fetchone() is not None
                        cur.execute("SELECT 1 FROM alunos WHERE aluno_id != 'system_catalog' LIMIT 1")
                        has_alunos = cur.fetchone() is not None
                        catalog_exists = has_occurrences or has_discarded or has_alunos
            except Exception:
                catalog_exists = True
        if catalog_exists:
            warnings.append("Já existe um catálogo com esse nome. O scanner pode acrescentar novas ocorrências nele.")

        ori_ok = bool(req.ori_path and os.path.isdir(req.ori_path))
        checks.append({"label": "Pasta de fotos", "ok": ori_ok, "detail": req.ori_path or "Não selecionada"})
        if not ori_ok:
            errors.append("Selecione uma pasta válida de fotos do evento.")

        extra_paths = []
        extra_invalid = []
        seen_paths = set()
        for path in req.extra_paths or []:
            if not path:
                continue
            abs_path = os.path.abspath(path)
            if abs_path in seen_paths:
                continue
            seen_paths.add(abs_path)
            if os.path.isdir(abs_path):
                extra_paths.append(abs_path)
            else:
                extra_invalid.append(abs_path)
        if extra_paths:
            checks.append({"label": "Pastas adicionais", "ok": True, "detail": f"{len(extra_paths)} pasta(s)"})
        if extra_invalid:
            warnings.append(f"{len(extra_invalid)} pasta(s) adicional(is) não foram encontradas e serão ignoradas.")

        ref_selected = bool(req.ref_path)
        ref_ok = bool(req.ref_path and os.path.isdir(req.ref_path))
        checks.append({"label": "Pasta de referências", "ok": (not ref_selected) or ref_ok, "detail": req.ref_path or "Opcional"})
        if ref_selected and not ref_ok:
            warnings.append("A pasta de referências não foi encontrada. O scanner seguirá agrupando por semelhança.")
        elif not ref_selected:
            warnings.append("Sem referências selecionadas. O scanner criará grupos automáticos para conferência.")

        photo_count = 0
        ref_count = 0
        scan_roots = []
        seen_scan_roots = set()
        for root_path in [req.ori_path] + extra_paths:
            if not root_path:
                continue
            abs_root = os.path.abspath(root_path)
            if abs_root in seen_scan_roots:
                continue
            seen_scan_roots.add(abs_root)
            scan_roots.append(abs_root)
        for root_path in scan_roots:
            if not root_path or not os.path.isdir(root_path):
                continue
            for _root, _dirs, files in os.walk(root_path):
                photo_count += sum(1 for f in files if f.lower().endswith(image_extensions))
        if ref_ok:
            for _root, _dirs, files in os.walk(req.ref_path):
                ref_count += sum(1 for f in files if f.lower().endswith(image_extensions))
        checks.append({"label": "Fotos encontradas", "ok": photo_count > 0, "detail": f"{photo_count} imagem(ns)"})
        if ori_ok and photo_count == 0:
            errors.append("Nenhuma imagem JPG, JPEG ou PNG foi encontrada na pasta de fotos.")

        gpu = gpu_diagnostics()
        gpu_ok = bool(gpu.get("cuda_available") or gpu.get("directml_available"))
        provider_label = gpu.get("active_device")
        if not provider_label or provider_label == "Não inicializado":
            provider_label = {
                "CUDAExecutionProvider": "GPU NVIDIA",
                "DmlExecutionProvider": "GPU DirectML",
                "CPUExecutionProvider": "CPU",
            }.get(gpu.get("preferred_provider"), "CPU")
        checks.append({"label": "Placa de vídeo", "ok": gpu_ok, "detail": provider_label})
        if not gpu_ok:
            warnings.append("GPU não ativada. O processamento pode ficar mais lento.")

        return {
            "can_start": len(errors) == 0,
            "project_name": cname,
            "catalog_exists": catalog_exists,
            "photo_count": photo_count,
            "reference_count": ref_count,
            "device": provider_label,
            "gpu_error": gpu.get("gpu_error", ""),
            "checks": checks,
            "warnings": warnings,
            "errors": errors,
        }
    except Exception as e:
        print(f"ERRO em scan_precheck: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def quiet_external_output():
    return _get("quiet_external_output")()


def safe_path_join(*parts):
    try:
        return os.path.join(*parts)
    except Exception:
        return None


def imread_unicode(path):
    return _get("imread_unicode")(path)


def ensure_face_engine():
    return _get("ensure_face_engine")()


def load_references(ref_path):
    return _get("load_references")(ref_path)


def find_best_reference(emb):
    return _get("find_best_reference")(emb)


def find_or_create_cluster(emb):
    return _get("find_or_create_cluster")(emb)


def clear_checkpoints(req: dict):
    try:
        sanitize_catalog_name = _get("sanitize_catalog_name")
        get_db = _get("get_db")
        app_state = _get("app_state")
        cname = sanitize_catalog_name(req.get("catalog_name", app_state.current_catalog))
        with get_db(cname) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM scan_checkpoints")
            conn.commit()
        return {"status": "ok", "message": "Checkpoints limpos. Proximo scan sera completo."}
    except Exception as e:
        print(f"ERRO em clear_checkpoints: {e}")
        traceback.print_exc()
        raise HTTPException(400, f"Erro ao limpar checkpoints: {str(e)}")


def _safe_scanner_worker(se, req, log_info, scan_state):
    try:
        se.run_scanner_worker(req)
    except Exception as e:
        err_msg = traceback.format_exc()
        log_info(f"[ERRO CRÍTICO] Falha no worker do scanner: {err_msg}")
        scan_state["status_text"] = "Erro ao iniciar scanner."
        scan_state["gpu_error"] = str(e)
        scan_state["is_scanning"] = False


def start_scan(req: ScanRequest):
    try:
        scan_state = _get("scan_state")
        sanitize_catalog_name = _get("sanitize_catalog_name")
        log_info = _get("log_info")
        se = _get("scanner_engine")
        if scan_state["is_scanning"]:
            raise HTTPException(status_code=400, detail="Scanner em andamento.")
        try:
            sanitize_catalog_name(req.project_name)
        except Exception as e:
            raise HTTPException(400, f"Nome de catálogo inválido: {e}")
        if not req.ori_path or not os.path.isdir(req.ori_path):
            raise HTTPException(status_code=400, detail="Selecione uma pasta válida de fotos brutas.")
        scan_state["is_scanning"] = True
        scan_state["status_text"] = "Iniciando scanner..."
        scan_state["progress"] = 0.0
        scan_state["total_processadas"] = 0
        scan_state["total_files"] = 0
        scan_state["eta_seconds"] = 0
        scan_state["gpu_error"] = ""
        scan_state["scan_summary"] = None
        log_info(f"[SCAN] Iniciando scanner: project={req.project_name}, ref={req.ref_path}, ori={req.ori_path}")
        threading.Thread(target=_safe_scanner_worker, args=(se, req, log_info, scan_state), daemon=True).start()
        return {"message": "Scanner Batch iniciado."}
    except HTTPException:
        raise
    except Exception as e:
        print(f"ERRO em start_scan: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def get_scan_status():
    return _get("scan_state")


def clear_scan_summary():
    scan_state = _get("scan_state")
    scan_state["scan_summary"] = None
    return {"status": "ok"}


def stop_scan():
    scan_state = _get("scan_state")
    scan_state["is_scanning"] = False
    return {"message": "Sinal abort enviado."}


def start_quality_audit(req: dict):
    quality_audit_state = _get("quality_audit_state")
    se = _get("scanner_engine")
    app_state = _get("app_state")
    if quality_audit_state["is_auditing"]:
        return {"status": "already_running"}
    cname = req.get("catalog", app_state.current_catalog)
    threading.Thread(target=se.run_quality_audit_worker, args=(cname,), daemon=True).start()
    return {"status": "started"}


def get_quality_audit_status():
    return _get("quality_audit_state")


def exit_app():
    scan_state = _get("scan_state")
    export_state = _get("export_state")
    scan_state["is_scanning"] = False
    export_state["is_exporting"] = False
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"status": "closing"}
