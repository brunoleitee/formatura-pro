import os
import time

from fastapi import HTTPException
from pydantic import BaseModel

_cfg = {}


def configure(**kwargs):
    _cfg.update(kwargs)


def _get(name, default=None):
    return _cfg.get(name, default)


class SetCatalogReq(BaseModel):
    name: str


class RenameCatalogReq(BaseModel):
    old_name: str
    new_name: str


def list_catalogs():
    data_dir = _get("data_dir")
    catalog_dir = _get("catalog_dir")
    current_catalog = _get("get_current_catalog")
    log_path = os.path.join(data_dir, "debug_timing.txt")

    start = time.time()
    try:
        dbs = sorted(
            f.replace(".db", "")
            for f in os.listdir(catalog_dir)
            if f.endswith(".db") and f.replace(".db", "") != ""
        )
        list_time = time.time() - start
    except Exception:
        dbs = []
        list_time = 0

    if not current_catalog() and dbs:
        _get("set_current_catalog")(dbs[0])

    catalog_meta = {}
    meta_start = time.time()
    for name in dbs:
        path = os.path.join(catalog_dir, f"{name}.db")
        try:
            stat = os.stat(path)
            catalog_meta[name] = {
                "created_at": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(stat.st_ctime)),
                "updated_at": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime(stat.st_mtime)),
            }
        except Exception:
            catalog_meta[name] = {"created_at": "", "updated_at": ""}
    meta_time = time.time() - meta_start
    total_time = time.time() - start

    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"listdir: {list_time:.3f}s, metadata: {meta_time:.3f}s, total: {total_time:.3f}s\n")
    except Exception:
        pass

    return {
        "current": current_catalog(),
        "catalogs": dbs,
        "catalog_meta": catalog_meta,
        "_timing": {
            "listdir": round(list_time, 3),
            "metadata": round(meta_time, 3),
            "total": round(total_time, 3),
        },
    }


def set_catalog(req: SetCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_db_path = _get("catalog_db_path")
    get_db = _get("get_db")
    set_current_catalog = _get("set_current_catalog")
    try:
        cname = sanitize_catalog_name(req.name)
    except Exception:
        cname = "Novo_Catalogo"
    set_current_catalog(cname)
    db_path = catalog_db_path(cname)
    if os.path.exists(db_path):
        return {"status": "ok", "current": cname}
    with get_db() as conn:
        pass
    return {"status": "ok", "current": cname}


def rename_catalog(req: RenameCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_dir = _get("catalog_dir")
    get_current_catalog = _get("get_current_catalog")
    set_current_catalog = _get("set_current_catalog")

    old_name = sanitize_catalog_name(req.old_name)
    new_name = sanitize_catalog_name(req.new_name)
    if old_name == new_name:
        return {"status": "ok", "current": get_current_catalog()}
    old_p = os.path.join(catalog_dir, f"{old_name}.db")
    new_p = os.path.join(catalog_dir, f"{new_name}.db")
    if os.path.exists(new_p):
        raise HTTPException(409, "Ja existe um catalogo com esse nome")
    if os.path.exists(old_p):
        os.rename(old_p, new_p)
    if get_current_catalog() == old_name:
        set_current_catalog(new_name)
    return {"status": "ok", "current": get_current_catalog()}


def delete_catalog(req: SetCatalogReq):
    sanitize_catalog_name = _get("sanitize_catalog_name")
    catalog_dir = _get("catalog_dir")
    get_current_catalog = _get("get_current_catalog")
    set_current_catalog = _get("set_current_catalog")

    cname = sanitize_catalog_name(req.name)
    
    # 1. Se o catálogo a ser removido for o atual, definimos o catálogo atual como vazio
    # ANTES de tentar remover os arquivos, para liberar quaisquer conexões e locks ativos no sidecar.
    if get_current_catalog() == cname:
        set_current_catalog("")
        
    # 2. Forçar a coleta de lixo ativamente para que o Python destrua referências
    # órfãs ou conexões do sqlite3 que ainda possam estar em cache na memória.
    import gc
    gc.collect()
    
    # Adicionar uma breve pausa de 100ms para que o sistema de arquivos do Windows
    # libere completamente o descritor de arquivo.
    time.sleep(0.1)

    p = os.path.join(catalog_dir, f"{cname}.db")
    p_wal = os.path.join(catalog_dir, f"{cname}.db-wal")
    p_shm = os.path.join(catalog_dir, f"{cname}.db-shm")

    # Função robusta para tentar deletar um arquivo com fallback de renomeação no Windows
    def try_remove_or_rename(file_path):
        if not os.path.exists(file_path):
            return True
        try:
            os.remove(file_path)
            return True
        except Exception as e:
            # Fallback robusto para Windows: se estiver trancado por outro processo/thread,
            # renomeamos o arquivo para que ele mude de nome e suma da lista de catálogos do usuário.
            # O arquivo físico será limpo posteriormente ou no próximo boot.
            try:
                temp_path = file_path + f".deleted.{int(time.time())}"
                os.rename(file_path, temp_path)
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
                return True
            except Exception as rename_err:
                print(f"[delete_catalog] Falha ao remover e ao renomear {file_path}: {e} / {rename_err}")
                return False

    success = True
    success = try_remove_or_rename(p) and success
    try_remove_or_rename(p_wal)
    try_remove_or_rename(p_shm)
    
    # Tenta remover silenciosamente quaisquer arquivos temporários de exclusões anteriores no diretório
    try:
        for f in os.listdir(catalog_dir):
            if any(s in f for s in (".db.deleted.", ".db-wal.deleted.", ".db-shm.deleted.")):
                try:
                    os.remove(os.path.join(catalog_dir, f))
                except Exception:
                    pass
    except Exception:
        pass

    if not success:
        raise HTTPException(500, "Não foi possível apagar o catálogo porque o arquivo está bloqueado permanentemente pelo Windows.")

    return {"status": "ok"}


def catalog_folder_stats(catalog: str):
    get_db = _get("get_db")
    get_current_catalog = _get("get_current_catalog")
    
    cat = catalog or (get_current_catalog() if get_current_catalog else "")
    if not cat:
        return {
            "activeFolders": 0, "totalPhotos": 0, "recognizedPhotos": 0, "newPhotos": 0,
            "lastScanAt": None, "totalFaces": 0, "photosWithFaces": 0, "knownPersons": 0
        }
    try:
        with get_db(cat) as conn:
            cur = conn.cursor()
            
            # Verificar se tabelas existem no banco
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ocorrencias'")
            has_ocorrencias = cur.fetchone() is not None
            
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='alunos'")
            has_alunos = cur.fetchone() is not None

            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_folders'")
            has_folders = cur.fetchone() is not None

            active_folders = 0
            last_scan_at = None
            if has_folders:
                cur.execute("SELECT COUNT(*), MAX(last_scan_at) FROM catalog_folders WHERE catalog_name = ? AND status = 'active'", (cat,))
                row = cur.fetchone()
                if row:
                    active_folders = row[0] or 0
                    last_scan_at = row[1]

            total_photos = 0
            recognized_photos = 0
            new_photos = 0
            total_faces = 0
            photos_with_faces = 0
            if has_ocorrencias:
                cur.execute("""
                    SELECT
                        COUNT(*) AS total_faces,
                        COUNT(DISTINCT foto_path) AS photos_with_faces,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias
                         WHERE aluno_id NOT LIKE 'Pessoa %'
                           AND aluno_id != 'system_catalog'
                           AND aluno_id != 'Desconhecido'
                           AND aluno_id != '') AS recognized_photos,
                        (SELECT COUNT(DISTINCT foto_path) FROM ocorrencias
                         WHERE aluno_id LIKE 'Pessoa %'
                            OR aluno_id = 'Desconhecido'
                            OR aluno_id = '') AS new_photos
                    FROM ocorrencias
                """)
                row = cur.fetchone()
                if row:
                    total_faces = row["total_faces"] or 0
                    photos_with_faces = row["photos_with_faces"] or 0
                    recognized_photos = row["recognized_photos"] or 0
                    new_photos = row["new_photos"] or 0
                total_photos = photos_with_faces

            known_persons = 0
            if has_alunos:
                cur.execute("SELECT COUNT(*) FROM alunos WHERE aluno_id != 'system_catalog' AND aluno_id NOT LIKE 'Pessoa%'")
                row = cur.fetchone()
                if row:
                    known_persons = row[0] or 0

            return {
                "activeFolders": active_folders,
                "totalPhotos": total_photos,
                "recognizedPhotos": recognized_photos,
                "newPhotos": new_photos,
                "lastScanAt": last_scan_at,
                "totalFaces": total_faces,
                "photosWithFaces": photos_with_faces,
                "knownPersons": known_persons
            }
    except Exception as e:
        print(f"Erro em catalog_folder_stats: {e}")
        return {
            "activeFolders": 0, "totalPhotos": 0, "recognizedPhotos": 0, "newPhotos": 0,
            "lastScanAt": None, "totalFaces": 0, "photosWithFaces": 0, "knownPersons": 0
        }
