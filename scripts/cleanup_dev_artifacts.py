#!/usr/bin/env python3
"""
Cleanup script for FormaturaPRO development artifacts.
Removes temporary files, build caches, and debug outputs safely.

Usage:
    python scripts/cleanup_dev_artifacts.py          # dry-run (default)
    python scripts/cleanup_dev_artifacts.py --apply   # actually remove
    python scripts/cleanup_dev_artifacts.py --verbose # show all files
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

TARGETS = [
    # Build artifacts
    {"pattern": "dist", "type": "dir", "label": "frontend build"},
    {"pattern": "build", "type": "dir", "label": "build output", "skip_git_tracked": True},
    {"pattern": "release", "type": "dir", "label": "release output", "skip_git_tracked": True},
    # Python bytecode
    {"pattern": "**/__pycache__", "type": "dir", "label": "__pycache__"},
    {"pattern": "**/node_modules/__pycache__", "type": "dir", "label": "__pycache__ in node_modules"},
    {"pattern": "**/.pytest_cache", "type": "dir", "label": "pytest cache"},
    # Cache dirs (safe to remove, auto-regenerated)
    {"pattern": "node_modules/.vite", "type": "dir", "label": "Vite dep cache"},
    {"pattern": "**/.vite", "type": "dir", "label": "Vite cache", "skip_git_tracked": True},
    {"pattern": "backend/thumb_cache", "type": "dir", "label": "thumbnail cache"},
    # OCR debug crops
    {"pattern": "data/.cache/ocr_debug", "type": "dir", "label": "OCR debug crops"},
    {"pattern": "data/.cache", "type": "dir", "label": "data cache", "skip_git_tracked": True, "min_size_mb": 10},
    # Logs
    {"pattern": "*.log", "type": "file", "label": "root log files", "skip_git_tracked": True},
    {"pattern": "backend/*.log", "type": "file", "label": "backend log files", "skip_git_tracked": True},
    # Temp / backup
    {"pattern": "backend/backups/*.bak", "type": "file", "label": "auto-backup .bak"},
    {"pattern": "*.tmp", "type": "file", "label": "temp files", "skip_git_tracked": True},
    {"pattern": "*.old", "type": "file", "label": "old files", "skip_git_tracked": True},
    # Rust build artifacts
    {"pattern": "src-tauri/target", "type": "dir", "label": "Rust target (cargo build)", "min_size_mb": 50},
]

SAFETY_DIRS = {".git", "backend/catalogos", "data/catalogs", "data/cloud", "backend/binaries", ".insightface"}
SAFETY_FILES = {"*.db", "last_catalog.txt", "*.sqlite", "*.sqlite3"}


def format_bytes(size: int) -> str:
    if size > 1_000_000_000:
        return f"{size / 1_000_000_000:.2f} GB"
    if size > 1_000_000:
        return f"{size / 1_000_000:.2f} MB"
    if size > 1_000:
        return f"{size / 1_000:.1f} KB"
    return f"{size} B"


def size_of(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, dirs, files in os.walk(str(path)):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def is_safe(path: Path) -> bool:
    parts = set(path.resolve().parts)
    for safe in SAFETY_DIRS:
        if safe in parts:
            return False
    name = path.name
    for pat in SAFETY_FILES:
        if pat.startswith("*"):
            if name.endswith(pat[1:]):
                return False
        elif name == pat:
            return False
    # Also check if any parent is a catalog
    for parent in path.resolve().parents:
        if parent.name == "data" and (parent / "catalogs").exists():
            if "catalogs" in set(parent.resolve().parts):
                return False
    return True


def gather(apply: bool, verbose: bool) -> tuple[list[Path], int]:
    to_remove: list[Path] = []
    total_size = 0
    for target in TARGETS:
        skip_git = target.get("skip_git_tracked", False)
        min_mb = target.get("min_size_mb", 0)
        label = target["label"]
        for match in sorted(PROJECT_ROOT.glob(target["pattern"])):
            if not match.exists():
                continue
            if not is_safe(match):
                print(f"  [SKIP] {match} (protegido)")
                continue
            if skip_git:
                import subprocess
                r = subprocess.run(
                    ["git", "ls-files", "--error-unmatch", str(match.relative_to(PROJECT_ROOT))],
                    cwd=str(PROJECT_ROOT), capture_output=True, text=True
                )
                if r.returncode == 0:
                    if verbose:
                        print(f"  [SKIP] {match} (rastreado pelo git)")
                    continue
            sz = size_of(match)
            if min_mb and sz < min_mb * 1_000_000:
                if verbose:
                    print(f"  [SKIP] {match} ({format_bytes(sz)}, menor que {min_mb}MB)")
                continue
            to_remove.append(match)
            total_size += sz
            if verbose or not apply:
                print(f"  {'[REMOVE]' if apply else '[DRY]'} {match} ({format_bytes(sz)}, {label})")
    return to_remove, total_size


def main():
    parser = argparse.ArgumentParser(description="Clean up FormaturaPRO development artifacts")
    parser.add_argument("--apply", action="store_true", help="Actually remove files (default: dry-run)")
    parser.add_argument("--verbose", action="store_true", help="Show all files including skipped")
    args = parser.parse_args()

    print("=" * 60)
    print(f"  FormaturaPRO — Cleanup Dev Artifacts")
    print(f"  Modo: {'APPLY (removendo)' if args.apply else 'DRY-RUN (apenas listando)'}")
    print("=" * 60)

    to_remove, total_size = gather(apply=args.apply, verbose=args.verbose)
    total_size_removed = 0

    if not to_remove:
        print("\nNada para limpar. Projeto já está limpo!")
        return

    print(f"\nTotal: {len(to_remove)} itens, {format_bytes(total_size)} recuperáveis")

    if args.apply:
        confirm = input(f"\nRemover {len(to_remove)} itens permanentemente? (s/N): ")
        if confirm.lower() != "s":
            print("Cancelado.")
            return
        removed = 0
        for path in to_remove:
            try:
                sz = size_of(path)
                if path.is_dir():
                    shutil.rmtree(str(path))
                else:
                    path.unlink()
                removed += 1
                total_size_removed += sz
                print(f"  [OK] Removido: {path} ({format_bytes(sz)})")
            except Exception as e:
                print(f"  [ERRO] {path}: {e}")
        print(f"\n[CLEANUP] removido: {removed} itens")
        print(f"[CLEANUP] espaço recuperado: {format_bytes(total_size_removed)}")
    else:
        print(f"\nExecute com --apply para remover.")

    print("=" * 60)


if __name__ == "__main__":
    main()
