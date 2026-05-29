import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
import zipfile
from datetime import datetime
from xml.sax.saxutils import escape

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


class ExportReq(BaseModel):
    ids: list[str]
    dest_path: str
    mode: str
    conflict_strategy: str = "copy"
    include_quality: bool = False
    include_descarte: bool = True
    organize_by_class: bool = False
    export_format: str = "original"


def load_export_history():
    path = _get("export_history_path")
    try:
        if not path or not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def append_export_history(record):
    path = _get("export_history_path")
    try:
        if not path:
            return
        history = load_export_history()
        history.insert(0, record)
        history = history[:100]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Falha salvando histórico de exportação: {e}")


def export_report_paths(dest_path: str):
    return [
        os.path.join(dest_path, "Relatorio_Exportacao_FormaturaPRO.xlsx"),
        os.path.join(dest_path, "Relatorio_Exportacao_FormaturaPRO.pdf"),
    ]


def find_export_reports(dest_path: str):
    result = {"report_path": "", "pdf_report_path": ""}
    if not dest_path or not os.path.isdir(dest_path):
        return result
    
    # Permitir buscar tanto no dest_path raiz quanto na subpasta "Exportação"
    paths_to_check = [dest_path]
    export_sub = os.path.join(dest_path, "Exportação")
    if os.path.isdir(export_sub):
        paths_to_check.append(export_sub)

    try:
        candidates = []
        for path_dir in paths_to_check:
            for name in os.listdir(path_dir):
                lower = name.lower()
                if not lower.startswith("relatorio_exportacao_formaturapro"):
                    continue
                if not (lower.endswith(".xlsx") or lower.endswith(".pdf")):
                    continue
                path = os.path.join(path_dir, name)
                candidates.append((os.path.getmtime(path), path, lower))
        for _mtime, path, lower in sorted(candidates, reverse=True):
            if lower.endswith(".xlsx") and not result["report_path"]:
                result["report_path"] = path
            elif lower.endswith(".pdf") and not result["pdf_report_path"]:
                result["pdf_report_path"] = path
            if result["report_path"] and result["pdf_report_path"]:
                break
    except Exception:
        return result
    return result


def count_export_destination(dest_path: str):
    counts = {}
    if not os.path.isdir(dest_path):
        return counts
    image_ext = _get("image_extensions", ())
    for entry in os.scandir(dest_path):
        if not entry.is_dir():
            continue
        total = 0
        for _root, _dirs, files in os.walk(entry.path):
            total += sum(1 for name in files if name.lower().endswith(image_ext))
        if total:
            counts[entry.name] = total
    return counts


def _iter_image_files(root_path, image_ext):
    if not root_path or not os.path.isdir(root_path):
        return
    for root, _dirs, files in os.walk(root_path):
        for name in files:
            if name.lower().endswith(image_ext):
                fpath = os.path.join(root, name)
                if os.path.exists(fpath):
                    yield fpath


def _collect_reference_dirs(conn):
    cur = conn.cursor()
    reference_dirs = set()
    try:
        thumb_cache_dir = _get("thumb_cache_dir")
        current_catalog = _get("get_current_catalog")
        if thumb_cache_dir and callable(current_catalog):
            catalog_name = current_catalog()
            full = os.path.join(thumb_cache_dir, catalog_name)
            if os.path.isdir(full):
                reference_dirs.add(os.path.abspath(full))
    except Exception:
        pass
    return sorted(reference_dirs)


def _is_base_reference_folder(folder_path: str) -> bool:
    """Detecta se uma pasta é de referência/base pelos nomes."""
    base_names = {"REFERENCIA", "REFERÊNCIA", "REFERENCIAS", "REFERÊNCIAS", "BASE", "#BASE", "REF"}
    folder_name = os.path.basename(os.path.normpath(folder_path)).strip().upper()
    return folder_name in base_names


def count_base_photos_from_catalog(catalog: str) -> int:
    """Conta fotos que estão em pastas de referência/base no catálogo.
    
    Detecta pastas por nomes: REFERENCIA, REFERÊNCIA, REFERENCIAS, 
    REFERÊNCIAS, BASE, #BASE, REF
    NÃO considera a pasta 'ID' como base/referência.
    """
    get_db = _get("get_db")
    log_info = _get("log_info", print)
    try:
        with get_db(catalog) as conn:
            cur = conn.cursor()
            # Buscar caminhos de pastas das ocorrencias
            cur.execute("""
                SELECT DISTINCT foto_path FROM ocorrencias
                WHERE aluno_id = ? OR aluno_id LIKE ?
            """, ("#BASE", "#BASE%"))
            all_base_paths = [r[0] for r in cur.fetchall() if r[0]]
            
            # Também buscar pastas de referência da tabela alunos
            try:
                cur.execute("SELECT face_cache_path FROM alunos WHERE face_cache_path IS NOT NULL AND face_cache_path != ''")
                ref_paths = [r[0] for r in cur.fetchall() if r[0]]
            except Exception:
                ref_paths = []
            
            # Contar fotos únicas de pastas base/referência
            base_photos = set()
            for path in all_base_paths:
                base_photos.add(path)
            
            # Detectar por caminho de pasta
            for path in ref_paths:
                dir_path = os.path.dirname(path) if path else ""
                if dir_path and _is_base_reference_folder(dir_path):
                    base_photos.add(path)
            
            log_info(f"[export-report] base_photos_count={len(base_photos)}")
            log_info(f"[export-report] base_detection_paths={list(base_photos)[:5]}")
            return len(base_photos)
    except Exception as e:
        log_info(f"[export-report] erro ao contar fotos base: {e}")
        return 0


def _clean_student_id(aid: str) -> str:
    if not aid:
        return aid
    if aid in ("#BASE", "#DESCARTE"):
        return aid
    
    # Se for uma person_key/identidade composta (ex: catalogo::classe::ref::aluno_id)
    if "::" in aid:
        parts = aid.split("::")
        cleaned = parts[-1]
    else:
        cleaned = aid
        
    import re
    cleaned = re.sub(r'^MAX_+', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'^SEM_TURMA_+', '', cleaned, flags=re.IGNORECASE)
    
    # Ex: 1772_1772 -> 1772
    parts = cleaned.split('_')
    if len(parts) >= 2 and parts[0] == parts[1] and parts[0].strip():
        cleaned = parts[0]
        
    return cleaned.strip()


def clean_student_display_id(raw_id: str, student_name: str | None = None, folder_name: str | None = None) -> str:
    """Limpa o ID interno do formando para exibição no relatório.
    
    Regras:
    1. Se student_name existir, usar student_name limpo
    2. Senão, quebrar raw_id por '::'
    3. Remover partes vazias, catalog id numérico, '__SEM_TURMA__', turma
    4. Remover duplicados consecutivos
    5. Retornar último nome válido
    """
    if student_name and student_name.strip():
        return student_name.strip()
    if folder_name and folder_name.strip() and "::" not in folder_name:
        return folder_name.strip()
    
    if "::" not in raw_id:
        return raw_id.strip()
    
    parts = raw_id.split("::")
    # Filtrar partes inválidas
    valid = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if p.isdigit() and len(p) <= 5:
            continue
        if p in ("__SEM_TURMA__", "__SEM_REFERENCIA__", "__SEM_CATALOGO__"):
            continue
        valid.append(p)
    
    # Remover duplicados consecutivos
    deduped = []
    for p in valid:
        if deduped and deduped[-1].lower() == p.lower():
            continue
        deduped.append(p)
    
    if not deduped:
        return raw_id.strip()
    return deduped[-1]


def _export_folder_name(aid, sanitize_folder_name):
    if aid == "#BASE":
        return "BASE_REF"
    if aid == "#DESCARTE":
        return "DESCARTE"
    return sanitize_folder_name(_clean_student_id(aid))


def _student_export_dir(dest_path: str, aid: str, class_name: str, sanitize_folder_name, organize_by_class: bool):
    student_dir = sanitize_folder_name(_clean_student_id(aid))
    export_base = os.path.join(dest_path, "Exportação")
    class_str = str(class_name or "").strip()

    # Sempre incluir turma no nome da pasta quando disponível, para evitar colisão
    if class_str and class_str not in ("Sem turma", "__SEM_TURMA__"):
        if organize_by_class:
            parts = class_str.replace("\\", "/").split("/")
            safe_parts = [sanitize_folder_name(p) for p in parts if p.strip()]
            if not safe_parts:
                safe_parts = ["Sem turma"]
            return os.path.join(export_base, *safe_parts, student_dir)
        else:
            # Nome da pasta: "9 A - ADRIANA"
            safe_class = sanitize_folder_name(class_str)
            return os.path.join(export_base, f"{safe_class} - {student_dir}")
    
    if organize_by_class:
        return os.path.join(export_base, "Sem turma", student_dir)
    return os.path.join(export_base, student_dir)


def detect_class_from_reference_path(reference_root: str, reference_path: str) -> str:
    if not reference_root or not reference_path:
        return "Sem turma"
    try:
        root = os.path.abspath(reference_root)
        path = os.path.abspath(reference_path)
        rel = os.path.relpath(path, root)
        parts = rel.replace("\\", "/").split("/")
        ignored_folders = {"#BASE", "BASE", "base", "referencias", "referências", "referencia", "referência"}
        valid_parts = [p for p in parts[:-1] if p.strip() and p.strip().casefold() not in {f.casefold() for f in ignored_folders}]
        return "/".join(valid_parts) if valid_parts else "Sem turma"
    except Exception:
        return "Sem turma"


def get_reference_root(conn) -> str:
    cur = conn.cursor()
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        if cur.fetchone() is not None:
            cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", ("system_catalog",))
            res = cur.fetchone()
            if res and res[0] and os.path.isdir(res[0]):
                return res[0]
    except Exception:
        pass
    cur.execute("SELECT ori_path, ref_path FROM scan_checkpoints LIMIT 1")
    row = cur.fetchone()
    if row and row[1]:
        return row[1]
    return ""


def build_class_map_from_reference_root(reference_root: str) -> dict:
    class_map = {}
    if not reference_root or not os.path.isdir(reference_root):
        return class_map

    ignored_folders = {"#BASE", "BASE", "base", "referencias", "referências", "referencia", "referência"}

    image_exts = (".jpg", ".jpeg", ".png", ".webp")
    for root, dirs, files in os.walk(reference_root):
        for filename in files:
            if not filename.lower().endswith(image_exts):
                continue
            full_path = os.path.join(root, filename)
            try:
                rel = os.path.relpath(full_path, reference_root)
                parts = rel.replace("\\", "/").split("/")
                valid_parts = [p for p in parts[:-1] if p.strip() and p.strip().casefold() not in {f.casefold() for f in ignored_folders}]
                class_name = "/".join(valid_parts) if valid_parts else "Sem turma"
                student_name = os.path.splitext(filename)[0].strip()
                class_map[student_name] = class_name
            except Exception:
                continue

    return class_map


def build_export_worklist(conn, req: ExportReq):
    cur = conn.cursor()
    image_ext = _get("image_extensions", ())
    log_info = _get("log_info", print)
    sanitize_folder_name = _get("sanitize_folder_name")

    organize_by_class = bool(getattr(req, "organize_by_class", False))
    reference_root = get_reference_root(conn)
    log_info(f"[export] organize_by_class = {organize_by_class}")
    log_info(f"[class-map] reference_root = {reference_root}")

    class_map = build_class_map_from_reference_root(reference_root)
    log_info(f"[class-map] built {len(class_map)} entries: {list(class_map.keys())[:20]}")

    students_data = {}
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
        if cur.fetchone() is not None:
            cur.execute("SELECT aluno_id, class_name, face_cache_path, person_key FROM alunos")
            for r in cur.fetchall():
                aid = r["aluno_id"]
                class_name = r["class_name"] or "Sem turma"
                ref_path = r["face_cache_path"] or ""
                person_key = r["person_key"] or ""

                if class_name == "Sem turma" and aid in class_map:
                    class_name = class_map[aid]
                    log_info(f"[export-class-final] student={aid} class_name={class_name} class_map_hit=True")
                elif class_name == "Sem turma" and ref_path and reference_root:
                    class_name = detect_class_from_reference_path(reference_root, ref_path)
                    log_info(f"[export-class-debug] student={aid} class_name={class_name} class_map_hit=False")

                students_data[aid] = {
                    "class_name": class_name,
                    "reference_path": ref_path,
                    "person_key": person_key,
                }
    except Exception:
        pass

    student_classes = {aid: data["class_name"] for aid, data in students_data.items()}
    log_info(f"[export] turmas detectadas: {dict(list(student_classes.items())[:10])}")

    cur.execute("SELECT foto_path FROM discarded_photos")
    discarded_manual = {r["foto_path"] for r in cur.fetchall()}

    cur.execute("SELECT ori_path FROM scan_checkpoints")
    source_dirs = {r["ori_path"] for r in cur.fetchall() if r["ori_path"] and os.path.isdir(r["ori_path"])}
    if not source_dirs:
        # Fallback: tentar pegar da tabela alunos onde salvamos o catalog_root
        try:
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
            if cur.fetchone() is not None:
                cur.execute("SELECT face_cache_path FROM alunos WHERE aluno_id = ?", ("system_catalog",))
                res = cur.fetchone()
            else:
                res = None
        except Exception:
            res = None
        if res and res[0] and os.path.isdir(res[0]):
            source_dirs.add(res[0])
        elif res and res[0]:
            # Pode ser que o path tenha mudado ou esteja em outra máquina, 
            # mas vamos tentar usar o que temos. Se for relativo ou inválido, source_dirs continuará vazio.
            pass

    reference_dirs = _collect_reference_dirs(conn)

    cur.execute("SELECT aluno_id, foto_path FROM ocorrencias")
    all_occ = cur.fetchall()

    photo_to_ids = {}
    for r in all_occ:
        pid, fpath = r["aluno_id"], r["foto_path"]
        if fpath not in photo_to_ids:
            photo_to_ids[fpath] = set()
        photo_to_ids[fpath].add(pid)

    worklist = []
    exported_paths = set()
    base_dir = os.path.join(req.dest_path, "#BASE")

# 1. Fotos de alunos selecionados (inclui "Pessoa X" se selecionado)
    organize_by_class = bool(getattr(req, "organize_by_class", False))
    for aid in req.ids:
        # Extrair person_key, person_name e class_name do identificador
        if "::" in aid:
            pk_parts = aid.split("::")
            student_pk = aid
            person_name = pk_parts[-1] if len(pk_parts) >= 1 else aid
            class_name = pk_parts[1] if len(pk_parts) >= 2 else (student_classes.get(aid, "Sem turma"))
            if class_name in ("__SEM_TURMA__",):
                class_name = "Sem turma"
        else:
            student_pk = students_data.get(aid, {}).get("person_key", "")
            person_name = aid
            class_name = student_classes.get(aid, "Sem turma")

        if student_pk:
            cur.execute(
                "SELECT DISTINCT foto_path FROM ocorrencias WHERE person_key = ?",
                (student_pk,),
            )
        else:
            cur.execute(
                "SELECT DISTINCT foto_path FROM ocorrencias WHERE aluno_id = ?",
                (aid,),
            )
        fotos = [r[0] for r in cur.fetchall() if r[0] and r[0] not in discarded_manual]
        p_al = _student_export_dir(req.dest_path, person_name, class_name, _get("sanitize_folder_name"), organize_by_class)
        log_info(f"[export] folder={os.path.basename(p_al)} person_key={student_pk} photos={len(fotos)} dest_dir={p_al}")
        for f in fotos:
            if os.path.exists(f):
                worklist.append((aid, f, p_al))
                exported_paths.add(f)

    for ref_ref in reference_dirs:
        if os.path.isdir(ref_ref):
            for f in _iter_image_files(ref_ref, image_ext):
                if f not in exported_paths:
                    worklist.append(("#BASE", f, base_dir))
                    exported_paths.add(f)
        elif os.path.isfile(ref_ref) and ref_ref.lower().endswith(image_ext):
            f = ref_ref
            if f not in exported_paths:
                worklist.append(("#BASE", f, base_dir))
                exported_paths.add(f)

    discard_dir = os.path.join(req.dest_path, "DESCARTE")

    if getattr(req, "include_descarte", True):
        # 2. Fotos descartadas manualmente (Botão Lixeira/X)
        for f in discarded_manual:
            if f and f not in exported_paths and os.path.exists(f):
                worklist.append(("#DESCARTE", f, discard_dir))
                exported_paths.add(f)

        # 3. Fotos de pessoas NÃO identificadas (Pessoa 1, Pessoa 2, etc.) que NÃO foram selecionadas explicitamente
        for fpath, ids in photo_to_ids.items():
            if not fpath or fpath in exported_paths or not os.path.exists(fpath):
                continue
            is_only_unidentified = all(
                not id_ or id_ == "Desconhecido" or str(id_).startswith("Pessoa ")
                for id_ in ids
            )
            if is_only_unidentified:
                worklist.append(("#DESCARTE", fpath, discard_dir))
                exported_paths.add(fpath)

        # 4. Fotos que sobraram na pasta original (não identificadas por ninguém e não processadas)
        normalized_exported = {os.path.normpath(p).lower() for p in exported_paths if p}
        for sdir in source_dirs:
            for root, _, files in os.walk(sdir):
                for name in files:
                    if name.lower().endswith(image_ext):
                        fpath = os.path.join(root, name)
                        if os.path.normpath(fpath).lower() not in normalized_exported:
                            worklist.append(("#DESCARTE", fpath, discard_dir))


    return worklist


def check_export_conflicts(req: ExportReq):
    validate_destination_path = _get("validate_destination_path")
    sanitize_folder_name = _get("sanitize_folder_name")
    get_db = _get("get_db")
    current_catalog = _get("get_current_catalog")

    validate_destination_path(req.dest_path)
    with get_db(current_catalog()) as conn:
        worklist = build_export_worklist(conn, req)
        conflicts = []
        for aid, f, p_al in worklist:
            safe_aid = _export_folder_name(aid, sanitize_folder_name)
            safe_p_al = p_al if aid not in ("#BASE", "#DESCARTE") else os.path.join(req.dest_path, safe_aid)

            dest_file = os.path.join(safe_p_al, _export_output_filename(f, req))
            if os.path.exists(dest_file):
                conflicts.append({
                    "aluno_id": aid,
                    "source": f,
                    "dest": dest_file,
                    "name": os.path.basename(dest_file),
                })
        export_base = os.path.join(req.dest_path, "Exportação")
        for report_path in export_report_paths(export_base):
            if os.path.exists(report_path):
                conflicts.append({
                    "aluno_id": "Relatorio",
                    "source": "",
                    "dest": report_path,
                    "name": os.path.basename(report_path),
                })
        return {"has_conflicts": bool(conflicts), "count": len(conflicts), "samples": conflicts[:8]}


def export_quality(req: ExportReq):
    try:
        get_db = _get("get_db")
        current_catalog = _get("get_current_catalog")
        with get_db(current_catalog()) as conn:
            cur = conn.cursor()
            worklist = build_export_worklist(conn, req)
            selected_ids = set(req.ids)
            photo_paths = sorted({f for aid, f, _p_al in worklist if aid != "#DESCARTE" and os.path.exists(f)})
            discard_paths = sorted({f for aid, f, _p_al in worklist if aid == "#DESCARTE" and os.path.exists(f)})

            folders_with_photos = {aid for aid, f, _p_al in worklist if aid != "#DESCARTE" and os.path.exists(f)}
            empty_folders = sorted(selected_ids - folders_with_photos)
            low_photo_folders = []
            for aid in sorted(selected_ids, key=lambda x: x.lower()):
                count = sum(1 for item_aid, f, _p_al in worklist if item_aid == aid and os.path.exists(f))
                if 0 < count <= 2:
                    low_photo_folders.append({"id": aid, "photos": count})

            unknown_photo_count = 0
            blurry_count = 0
            attention_count = 0
            closed_eyes_count = 0

            if photo_paths:
                chunk_size = 900
                for i in range(0, len(photo_paths), chunk_size):
                    chunk = photo_paths[i:i + chunk_size]
                    placeholders = ",".join("?" for _ in chunk)

                    cur.execute(
                        f"""
                        SELECT DISTINCT foto_path
                        FROM ocorrencias
                        WHERE foto_path IN ({placeholders})
                          AND (aluno_id IS NULL OR aluno_id = 'Desconhecido' OR aluno_id LIKE 'Pessoa %')
                        """,
                        chunk,
                    )
                    unknown_photo_count += len({r["foto_path"] for r in cur.fetchall()})

                    if req.include_quality:
                        cur.execute(f"""
                            SELECT blur_status, MAX(closed_eyes) as has_closed_eyes
                            FROM ocorrencias
                            WHERE foto_path IN ({placeholders})
                            GROUP BY foto_path
                        """, chunk)
                        for r in cur.fetchall():
                            if r["blur_status"] == "blurry":
                                blurry_count += 1
                            elif r["blur_status"] == "attention":
                                attention_count += 1
                            if r["has_closed_eyes"]:
                                closed_eyes_count += 1

            return {
                "catalog": current_catalog(),
                "selected_folders": len(selected_ids),
                "folders_with_photos": len(folders_with_photos),
                "empty_folders": len(empty_folders),
                "empty_folder_samples": empty_folders[:8],
                "low_photo_folders": low_photo_folders[:8],
                "total_photos": len(photo_paths),
                "discarded_photos": len(discard_paths),
                "unknown_photos": unknown_photo_count,
                "blurry_photos": blurry_count,
                "attention_photos": attention_count,
                "closed_eyes_photos": closed_eyes_count,
                "blur_limited": False,
                "quality_skipped": not req.include_quality,
            }
    except Exception as e:
        log_info = _get("log_info", print)
        log_info(f"API: Erro fatal em export_quality: {str(e)}")
        raise HTTPException(500, detail=str(e))


def _format_duration(seconds):
    seconds = max(0, int(seconds))
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {sec}s"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


def _next_available_dest_file(folder, filename):
    stem, ext = os.path.splitext(filename)
    n = 2
    while True:
        candidate = os.path.join(folder, f"{stem}_{n}{ext}")
        if not os.path.exists(candidate):
            return candidate
        n += 1


def _unique_dest_file(folder, filename, conflict_strategy):
    dest = os.path.join(folder, filename)
    if conflict_strategy in ("replace", "overwrite", "recreate", "skip"):
        return dest
    if not os.path.exists(dest):
        return dest
    return _next_available_dest_file(folder, filename)


RAW_IMAGE_EXTENSIONS = {
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw",
}


def _normalized_export_format(req):
    value = str(getattr(req, "export_format", "original") or "original").strip().lower()
    return "jpg" if value in {"jpg", "jpeg"} else "original"


def _export_output_filename(source_path, req):
    filename = os.path.basename(source_path)
    if _normalized_export_format(req) != "jpg":
        return filename
    stem, _ext = os.path.splitext(filename)
    return f"{stem}.jpg"


def _save_as_jpeg(source_path, dest_file):
    ext = os.path.splitext(source_path)[1].lower()
    try:
        if ext in RAW_IMAGE_EXTENSIONS:
            try:
                import rawpy
            except Exception as e:
                raise RuntimeError("Conversor RAW nao disponivel (rawpy)") from e

            from PIL import Image

            with rawpy.imread(source_path) as raw:
                rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=True, output_bps=8)
            Image.fromarray(rgb).save(dest_file, "JPEG", quality=95, optimize=True)
            return

        from PIL import Image, ImageOps

        with Image.open(source_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.save(dest_file, "JPEG", quality=95, optimize=True)
    except Exception:
        if os.path.exists(dest_file):
            try:
                os.remove(dest_file)
            except Exception:
                pass
        raise


def _prepare_recreate_destination(req, catalog_name):
    backup_catalog_db = _get("backup_catalog_db")
    log_debug = _get("log_debug", lambda *_: None)
    log_info = _get("log_info", print)

    if req.conflict_strategy != "recreate":
        return
    backup_catalog_db(catalog_name, "antes_recriar_exportacao")

    dest_abs = os.path.abspath(req.dest_path)
    cleaned = 0
    errors = 0

    if not os.path.isdir(dest_abs):
        return

    for item in os.listdir(dest_abs):
        target = os.path.join(dest_abs, item)
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
            else:
                os.remove(target)
            cleaned += 1
            log_debug(f"Removido: {target}")
        except PermissionError as e:
            log_debug(f"Permissao negada ao limpar {target}: {e}")
            errors += 1
        except Exception as e:
            log_debug(f"Falha ao limpar {target}: {e}")
            errors += 1

    log_info(f"Recreate: {cleaned} item(ns) limpo(s), {errors} erro(s)")


def _xlsx_col_name(index):
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _xlsx_sheet_xml(rows):
    xml_rows = []
    for r_idx, row in enumerate(rows, start=1):
        cells = []
        for c_idx, value in enumerate(row):
            ref = f"{_xlsx_col_name(c_idx)}{r_idx}"
            text = "" if value is None else str(value)
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(text)}</t></is></c>')
        xml_rows.append(f'<row r="{r_idx}">{"".join(cells)}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>'
        + "".join(xml_rows) +
        '</sheetData></worksheet>'
    )


def _write_export_report(path, summary_rows, per_person_rows):
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Resumo" sheetId="1" r:id="rId1"/>
<sheet name="Formandos" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", _xlsx_sheet_xml(summary_rows))
        z.writestr("xl/worksheets/sheet2.xml", _xlsx_sheet_xml(per_person_rows))


def _pdf_escape(value):
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _pdf_text_line(x, y, text, size=10):
    return f"BT /F1 {size} Tf {x} {y} Td ({_pdf_escape(text)}) Tj ET\n"


def _file_starts_with(path, prefix):
    try:
        with open(path, "rb") as f:
            return f.read(len(prefix)) == prefix
    except Exception:
        return False


def _write_simple_pdf(path, summary_rows, per_person_rows):
    # Otimização: limitar formandos no PDF para evitar lentidão
    max_pdf_rows = 150
    if len(per_person_rows) > max_pdf_rows:
        header = per_person_rows[0]
        data_rows = per_person_rows[1:]
        extra_count = len(data_rows) - (max_pdf_rows - 1)
        truncated_rows = [header] + data_rows[:max_pdf_rows - 1]
        truncated_rows.append([f"... e outros {extra_count} formandos no XLSX", "", ""])
        per_person_rows = truncated_rows

    lines = ["FORMATURA PRO", "RELATORIO DE EXPORTACAO", ""]
    lines.extend([f"{row[0]}: {row[1]}" for row in summary_rows[1:]])
    lines.extend(["", "FORMANDOS", "ID Formando   | Pasta Destino    | Qtd Fotos"])
    lines.extend([f"{str(row[0]):14s} | {str(row[1]):17s} | {str(row[2]):>9s}" for row in per_person_rows[1:]])

    page_chunks = [lines[i:i + 46] for i in range(0, len(lines), 46)] or [[]]
    objects = []
    page_refs = []

    objects.append("<< /Type /Catalog /Pages 2 0 R >>")
    objects.append("")
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for chunk in page_chunks:
        content = ""
        y = 800
        for idx, line in enumerate(chunk):
            if idx == 0 and line == "FORMATURA PRO":
                size = 18
            elif idx == 1 and line.startswith("RELATORIO"):
                size = 12
            else:
                size = 9
            content += _pdf_text_line(42, y, line[:115], size)
            y -= 16
        content_bytes = content.encode("latin-1", "replace")
        content_obj_num = len(objects) + 1
        objects.append(f"<< /Length {len(content_bytes)} >>\nstream\n{content}endstream")
        page_obj_num = len(objects) + 1
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj_num} 0 R >>")
        page_refs.append(f"{page_obj_num} 0 R")

    objects[1] = f"<< /Type /Pages /Kids [{' '.join(page_refs)}] /Count {len(page_refs)} >>"

    pdf = "%PDF-1.4\n"
    offsets = []
    for idx, obj in enumerate(objects, start=1):
        offsets.append(len(pdf.encode("latin-1", "replace")))
        pdf += f"{idx} 0 obj\n{obj}\nendobj\n"
    xref_pos = len(pdf.encode("latin-1", "replace"))
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for off in offsets:
        pdf += f"{off:010d} 00000 n \n"
    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF"
    with open(path, "wb") as f:
        f.write(pdf.encode("latin-1", "replace"))


def _write_reportlab_pdf(path, summary_rows, per_person_rows):
    # Otimização: limitar formandos no PDF para evitar lentidão exponencial do ReportLab
    max_pdf_rows = 150
    if len(per_person_rows) > max_pdf_rows:
        header = per_person_rows[0]
        data_rows = per_person_rows[1:]
        extra_count = len(data_rows) - (max_pdf_rows - 1)
        truncated_rows = [header] + data_rows[:max_pdf_rows - 1]
        truncated_rows.append([f"... e outros {extra_count} formandos no XLSX", "", ""])
        per_person_rows = truncated_rows

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.graphics.shapes import Drawing, Rect
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate
    from reportlab.platypus import Table, TableStyle, Paragraph, Spacer

    bold_font = "Helvetica-Bold"

    def table_from_rows(rows, col_widths, dark_labels=None):
        dark_labels = set(dark_labels or [])
        table = Table(rows, colWidths=col_widths)
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e1e1e")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), bold_font),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d0d0d0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f7fa")]),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        for row_idx, row in enumerate(rows):
            if row and str(row[0]).strip().lower() in dark_labels:
                style.extend([
                    ("BACKGROUND", (0, row_idx), (-1, row_idx), colors.HexColor("#1e1e1e")),
                    ("TEXTCOLOR", (0, row_idx), (-1, row_idx), colors.white),
                    ("FONTNAME", (0, row_idx), (-1, row_idx), bold_font),
                ])
        table.setStyle(TableStyle(style))
        return table

    page_width, page_height = A4
    bottom_margin = 8 * mm
    doc = BaseDocTemplate(path, pagesize=A4, title="Relatório de Exportação - Formatura PRO")
    frame = Frame(0, bottom_margin, page_width, page_height - bottom_margin, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="full_page", frames=[frame])])
    report_width = page_width - (12 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("FormaturaTitle", parent=styles["Title"], fontName=bold_font, fontSize=18, textColor=colors.white, spaceAfter=0, leading=22)
    section_style = ParagraphStyle("SectionTitle", parent=styles["Heading2"], fontName=bold_font, fontSize=12, textColor=colors.HexColor("#111111"), spaceBefore=12, spaceAfter=6)
    centered_section_style = ParagraphStyle("CenteredSectionTitle", parent=section_style, alignment=1)
    brand_style = ParagraphStyle("Brand", fontSize=20, textColor=colors.white, leading=24, wordWrap=None)

    story = []
    
    logo_size = 14 * mm
    logo = Drawing(logo_size, logo_size)
    logo.add(Rect(0, 0, logo_size, logo_size, rx=3 * mm, ry=3 * mm, fillColor=colors.HexColor("#f7f7f7"), strokeColor=None))
    inner_margin = 3 * mm
    inner_size = logo_size - (inner_margin * 2)
    logo.add(Rect(inner_margin, inner_margin, inner_size, inner_size, rx=1.8 * mm, ry=1.8 * mm, fillColor=colors.HexColor("#111111"), strokeColor=None))
    brand = Paragraph(f'Formatura <font name="{bold_font}">PRO</font>', brand_style)
    brand_group = Table([[logo, brand]], colWidths=[18 * mm, 82 * mm])
    brand_group.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    header_band = Table([[brand_group]], colWidths=[page_width], rowHeights=[40 * mm])
    header_band.hAlign = "CENTER"
    header_band.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1e1e1e")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    
    story.append(header_band)
    story.append(Spacer(1, 10))
    title_band = Table([[Paragraph("Relatório de Exportação", title_style)]], colWidths=[report_width])
    title_band.hAlign = "CENTER"
    title_band.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1e1e1e")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(title_band)
    story.append(Spacer(1, 8))
    story.append(table_from_rows(summary_rows, [54 * mm, report_width - (54 * mm)], dark_labels={"destino"}))
    story.append(Paragraph("Formandos", centered_section_style))
    story.append(table_from_rows(per_person_rows, [report_width * 0.35, report_width * 0.35, report_width * 0.30]))
    doc.build(story)


def _parse_existing_xlsx_report(xlsx_path: str) -> list[list[str]]:
    import zipfile
    import xml.etree.ElementTree as ET
    try:
        if not os.path.exists(xlsx_path):
            return []
        with zipfile.ZipFile(xlsx_path, 'r') as z:
            sheet2_xml = z.read('xl/worksheets/sheet2.xml')
            
        root = ET.fromstring(sheet2_xml)
        ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        
        rows = []
        for row_elem in root.findall('.//ns:row', ns):
            row_cells = []
            cells = row_elem.findall('ns:c', ns)
            cells_sorted = sorted(cells, key=lambda c: c.get('r', ''))
            for cell in cells_sorted:
                t_elem = cell.find('.//ns:t', ns)
                val = t_elem.text if t_elem is not None else ""
                row_cells.append(val or "")
            if row_cells:
                rows.append(row_cells)
        return rows
    except Exception as e:
        print(f"Error parsing existing xlsx report: {e}")
        return []


def _count_image_files(folder_path: str) -> int:
    if not folder_path or not os.path.isdir(folder_path):
        return 0
    image_ext = _get("image_extensions", ())
    count = 0
    for root, _dirs, files in os.walk(folder_path):
        count += sum(1 for name in files if name.lower().endswith(image_ext))
    return count


def run_export_worker(req: ExportReq, catalog_name: str):
    export_state = _get("export_state")
    log_info = _get("log_info", print)
    get_db = _get("get_db")
    sanitize_folder_name = _get("sanitize_folder_name")
    backup_catalog_db = _get("backup_catalog_db")

    export_state["is_exporting"] = True
    export_state["progress"] = 0.0
    export_state["status_text"] = "Preparando diretórios..."
    export_state["total_files"] = 0
    export_state["processed_files"] = 0
    export_state["eta_seconds"] = 0
    export_state["export_summary"] = None
    export_state["export_dir"] = ""
    export_state["pdf_path"] = ""
    log_info(f"Worker: Iniciando exportacao para o catalogo: {catalog_name}")
    log_info(f"Worker: Iniciando exportacao para {catalog_name}. Destino: {req.dest_path}")

    try:
        os.makedirs(req.dest_path, exist_ok=True)
        _prepare_recreate_destination(req, catalog_name)
        
        # 1. Abre a conexão apenas para extrair a lista de trabalho rápida, e já fecha imediatamente!
        with get_db(catalog_name) as conn:
            worklist = build_export_worklist(conn, req)

        export_base = os.path.join(req.dest_path, "Exportação")
        os.makedirs(export_base, exist_ok=True)

        safe_p_al_map = {}
        organize_by_class = bool(getattr(req, "organize_by_class", False))
        log_info(f"[export] export_base={export_base} organize_by_class={organize_by_class}")
        for aid, _f, p_al in worklist:
            if aid not in safe_p_al_map:
                if aid in ("#BASE", "#DESCARTE"):
                    safe_aid = _export_folder_name(aid, sanitize_folder_name)
                    safe_p_al_map[aid] = os.path.join(req.dest_path, safe_aid)
                else:
                    safe_p_al_map[aid] = p_al
                    log_info(f"[export-folder] student={aid} p_al={p_al}")
                try:
                    os.makedirs(safe_p_al_map[aid], exist_ok=True)
                except Exception as e:
                    log_info(f"Erro ao criar pasta para {aid}: {e}")

        log_info(f"[export] safe_p_al_map (amostra): {dict(list(safe_p_al_map.items())[:5])}")

        total = len(worklist)
        export_state["total_files"] = total
        if total == 0:
            export_state["status_text"] = "Nenhuma foto selecionada para exportar!"
            export_state["is_exporting"] = False
            return

        from concurrent.futures import ThreadPoolExecutor, as_completed

        start_time = time.time()
        exported_files = 0
        exported_folders = set()
        per_person_counts = {}
        base_copy_count = 0
        files_copied_this_export = []
        incremental_mode = req.conflict_strategy == "incremental"
        existing_dest_keys = set()
        for aid, f, _p_al in worklist:
            p_al_safe = safe_p_al_map.get(aid)
            if p_al_safe:
                dest_path_check = os.path.join(p_al_safe, _export_output_filename(f, req))
                if os.path.exists(dest_path_check):
                    existing_dest_keys.add(dest_path_check.lower())

        state_lock = threading.Lock()
        results = [None] * total
        processed_count = 0

        def process_copy(idx, aid, f):
            if not export_state["is_exporting"]:
                return idx, aid, os.path.basename(f), f, "", "Cancelado", None, False, False

            p_al = safe_p_al_map.get(aid)
            if not p_al:
                return idx, aid, os.path.basename(f), f, "", "Erro: Pasta de destino invalida", None, False, False

            try:
                if os.path.exists(f):
                    output_filename = _export_output_filename(f, req)
                    with state_lock:
                        dest_file = _unique_dest_file(p_al, output_filename, req.conflict_strategy)
                        
                        # Se for estratégia skip (mesclar) e o arquivo já existe no destino, pulamos a cópia
                        if (req.conflict_strategy == "skip" or incremental_mode) and os.path.exists(dest_file):
                            return idx, aid, output_filename, f, dest_file, "Ignorado (mesclar)", None, False, True
                            
                        existing_dest_keys.add(dest_file.lower())
                        copied_path = dest_file
                        file_copied = True

                    export_format = _normalized_export_format(req)
                    is_copy_only = aid == "#BASE" or export_format == "jpg"
                    if export_format == "jpg":
                        ext = os.path.splitext(f)[1].lower()
                        if ext in (".jpg", ".jpeg"):
                            shutil.copy2(f, dest_file)
                            status = "Copiado JPG"
                        else:
                            _save_as_jpeg(f, dest_file)
                            status = "Convertido JPG"
                    elif req.mode == "move" and not is_copy_only:
                        shutil.move(f, dest_file)
                        status = "Movido"
                    else:
                        shutil.copy2(f, dest_file)
                        status = "Copiado"

                    return idx, aid, output_filename, f, dest_file, status, copied_path, file_copied, True
                else:
                    return idx, aid, os.path.basename(f), f, "", "Erro: Fonte nao encontrada", None, False, False
            except Exception as e:
                return idx, aid, os.path.basename(f), f, "", f"Erro: {str(e)}", None, False, False

        # Usar ThreadPoolExecutor para paralelizar a gravação de arquivos (I/O) - Concorrência livre de banco!
        max_workers = 8
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(process_copy, idx, aid, f): idx for idx, (aid, f, _) in enumerate(worklist)}
            for future in as_completed(futures):
                if not export_state["is_exporting"]:
                    for fut in futures:
                        fut.cancel()
                    break
                
                try:
                    res = future.result()
                    idx, aid, filename, f, dest_file, status, copied_path, file_copied, success = res
                    results[idx] = res

                    with state_lock:
                        processed_count += 1
                        if file_copied and copied_path:
                            exported_files += 1
                            files_copied_this_export.append(copied_path)

                        p_al = safe_p_al_map.get(aid)
                        if success and p_al:
                            if aid == "#BASE":
                                base_copy_count += 1
                                exported_folders.add(p_al)
                            elif aid != "#DESCARTE":
                                per_person_counts[aid] = per_person_counts.get(aid, 0) + 1
                                exported_folders.add(p_al)

                        export_state["processed_files"] = processed_count
                        if processed_count % 5 == 0 or processed_count == total:
                            elapsed = time.time() - start_time
                            avg = elapsed / processed_count
                            export_state["eta_seconds"] = int(avg * (total - processed_count))
                            export_state["progress"] = round((processed_count / total) * 100, 1)
                except Exception as e:
                    log_info(f"Worker: Erro no processamento concorrente do arquivo: {e}")

        # Reconstruir o file_report_rows na ordem sequencial original
        file_report_rows = [["Formando/Pasta", "Arquivo", "Origem", "Destino", "Status"]]
        for idx in range(total):
            res = results[idx]
            if res is None:
                aid, f, _ = worklist[idx]
                file_report_rows.append([aid, os.path.basename(f), f, "", "Erro: Cancelado ou Nao Processado"])
            else:
                idx, aid, filename, f, dest_file, status, copied_path, file_copied, success = res
                file_report_rows.append([aid, filename, f, dest_file, status])

        export_uuid = str(uuid.uuid4())
        
        # 2. Abre a conexão apenas para inserir o histórico final curto de forma rápida e segura!
        with get_db(catalog_name) as conn:
            cur = conn.cursor()
            try:
                cur.execute("SELECT 1 FROM export_history LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS export_history (
                        uuid TEXT PRIMARY KEY,
                        dest_path TEXT,
                        mode TEXT,
                        files_json TEXT,
                        folders_json TEXT,
                        timestamp TEXT,
                        created_at REAL DEFAULT (strftime('%s','now'))
                    )
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_export_history_dest ON export_history(dest_path)")
            
            cur.execute(
                """
                INSERT INTO export_history (uuid, dest_path, mode, files_json, folders_json, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    export_uuid,
                    req.dest_path,
                    req.mode,
                    json.dumps(files_copied_this_export),
                    json.dumps(list(exported_folders)),
                    datetime.now().isoformat(),
                ),
            )
            conn.commit()

        export_state["status_text"] = "Exportacao concluida com sucesso!"
        elapsed_total = time.time() - start_time

        try:
            all_reports = export_report_paths(export_base)
            
            # Determinar se vamos mesclar ou sobrescrever o relatório existente
            incremental_report_merge = (req.conflict_strategy == "skip" and os.path.exists(all_reports[0]))
            
            if req.conflict_strategy == "skip":
                report_path = all_reports[0]
                pdf_report_path = all_reports[1]
            elif req.conflict_strategy in ("overwrite", "replace", "recreate"):
                report_path = all_reports[0]
                pdf_report_path = all_reports[1]
            else:
                # "copy" (Renomear automaticamente) -> gera arquivos com sufixo _2, _3 etc.
                report_path = _unique_dest_file(export_base, os.path.basename(all_reports[0]), "copy")
                pdf_report_path = _unique_dest_file(export_base, os.path.basename(all_reports[1]), "copy")

            base_photos_total = count_base_photos_from_catalog(catalog_name)
            
            per_person_rows = [["ID Formando", "Pasta Destino", "Qtd Fotos"]]
            existing_map = {}
            
            if incremental_report_merge:
                # Carregar registros do relatório anterior
                existing_rows = _parse_existing_xlsx_report(report_path)
                if len(existing_rows) > 1:
                    for row in existing_rows[1:]:
                        if len(row) >= 3:
                            display_name, folder_display, count_str = row[0], row[1], row[2]
                            existing_map[folder_display] = {
                                "display_name": display_name,
                                "count": int(count_str) if str(count_str).isdigit() else 0
                            }
            
            # Mesclar ou adicionar novos dados desta sessão
            for aid in per_person_counts.keys():
                p_al_path = safe_p_al_map.get(aid, aid)
                display_name = clean_student_display_id(aid, student_name=str(p_al_path).rsplit(os.sep, 1)[-1] if p_al_path else aid)
                folder_display = str(p_al_path).rsplit(os.sep, 1)[-1] if p_al_path else display_name
                
                # Para evitar duplicidade e ter a contagem real, buscamos a contagem no disco se disponível
                actual_count = _count_image_files(p_al_path) if p_al_path else per_person_counts[aid]
                existing_map[folder_display] = {
                    "display_name": display_name,
                    "count": actual_count
                }
                
            # Atualizar contagem física em disco de TODAS as pastas registradas
            for folder_display, info in existing_map.items():
                full_path = os.path.normpath(os.path.join(export_base, folder_display))
                if os.path.isdir(full_path):
                    info["count"] = _count_image_files(full_path)
            
            # Construir per_person_rows final ordenado por nome do formando
            for folder_display in sorted(existing_map.keys(), key=lambda x: existing_map[x]["display_name"].lower()):
                info = existing_map[folder_display]
                per_person_rows.append([info["display_name"], folder_display, str(info["count"])])
                
            # Recalcular totais e construir resumo
            destination_photo_total = sum(int(row[2]) for row in per_person_rows[1:])
            folder_count = len(per_person_rows) - 1
            
            summary_rows = [
                ["Relatorio de Exportacao", ""],
                ["Catalogo", catalog_name],
                ["Data/Hora", datetime.now().strftime("%d/%m/%Y %H:%M:%S")],
                ["Formato", "JPEG convertido" if _normalized_export_format(req) == "jpg" else "Original"],
                ["Fotos Exportadas", str(destination_photo_total)],
                ["Fotos Base", str(base_photos_total)],
                ["Pastas Criadas", str(folder_count)],
                ["Tempo Total", _format_duration(elapsed_total)],
                ["Destino", req.dest_path],
            ]

            try:
                _write_export_report(report_path, summary_rows, per_person_rows)
            except Exception as e:
                log_info(f"Worker: Erro write_export_report: {e}")
                report_path = ""
            try:
                _write_reportlab_pdf(pdf_report_path, summary_rows, per_person_rows)
            except Exception as e:
                log_info(f"Worker: Erro write_reportlab_pdf: {e}")
                try:
                    _write_simple_pdf(pdf_report_path, summary_rows, per_person_rows)
                    log_info("Worker: PDF simples gerado como fallback.")
                except Exception as fallback_error:
                    log_info(f"Worker: Erro write_simple_pdf fallback: {fallback_error}")
                    pdf_report_path = ""

            export_state["export_summary"] = {
                "export_id": export_state.get("export_id", ""),
                "export_dir": req.dest_path,
                "pdf_path": pdf_report_path,
                "dest_path": req.dest_path,
                "report_path": report_path,
                "pdf_report_path": pdf_report_path,
                "time_seconds": int(elapsed_total),
                "time_str": _format_duration(elapsed_total),
                "folder_count": folder_count,
                "photo_count": destination_photo_total,
                "mode": req.mode,
                "export_format": _normalized_export_format(req),
            }
            export_state["export_dir"] = req.dest_path
            export_state["pdf_path"] = pdf_report_path

            append_export_history({
                "catalog": catalog_name,
                "export_id": export_state.get("export_id", ""),
                "dest_path": req.dest_path,
                "export_dir": req.dest_path,
                "mode": req.mode,
                "export_format": _normalized_export_format(req),
                "time_str": _format_duration(elapsed_total),
                "time_seconds": int(elapsed_total),
                "folder_count": folder_count,
                "photo_count": destination_photo_total,
                "report_path": report_path,
                "pdf_report_path": pdf_report_path,
                "pdf_path": pdf_report_path,
                "created_at": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
            })
        except Exception as e:
            log_info(f"Worker: Erro ao gerar resumo/relatorios: {e}")
            export_state["export_summary"] = {
                "export_id": export_state.get("export_id", ""),
                "export_dir": req.dest_path,
                "pdf_path": "",
                "dest_path": req.dest_path,
                "report_path": "",
                "pdf_report_path": "",
                "time_seconds": int(elapsed_total),
                "time_str": _format_duration(elapsed_total),
                "folder_count": 0,
                "photo_count": exported_files,
                "mode": req.mode,
                "export_format": _normalized_export_format(req),
            }

        log_info(f"Worker: Exportacao concluida com sucesso. arquivos={exported_files} pastas={len(exported_folders)} tempo={elapsed_total:.2f}s")
    except Exception as e:
        log_info(f"Worker: Erro fatal durante a exportacao: {str(e)}")
        export_state["status_text"] = f"Erro fatal: {str(e)}"
    finally:
        export_state["is_exporting"] = False


def start_export(req: ExportReq):
    export_state = _get("export_state")
    current_catalog = _get("get_current_catalog")
    log_info = _get("log_info", print)
    validate_destination_path = _get("validate_destination_path")
    backup_catalog_db = _get("backup_catalog_db")

    log_info(f"API: Recebido pedido de exportacao. IDs: {len(req.ids)}, Modo: {req.mode}, Formato: {_normalized_export_format(req)}")
    if export_state["is_exporting"]:
        raise HTTPException(400, "Exportação em andamento.")
    validate_destination_path(req.dest_path)
    catalog_name = current_catalog()
    log_info(f"API: Exportacao validada catalogo={catalog_name} destino={req.dest_path}")
    backup_catalog_db(catalog_name, "antes_exportar")
    export_state["is_exporting"] = True
    export_state["progress"] = 0
    export_id = str(uuid.uuid4())
    export_state["export_id"] = export_id
    export_state["export_dir"] = ""
    export_state["pdf_path"] = ""
    export_state["export_summary"] = None
    threading.Thread(target=run_export_worker, args=(req, catalog_name), daemon=True).start()
    return {"message": "Export iniciada."}


def get_export_status():
    return _get("export_state")


def clear_export_summary():
    export_state = _get("export_state")
    export_state["export_summary"] = None
    return {"status": "ok"}
