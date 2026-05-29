"""CLI modular para treino do classificador de formatura."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from .dataset import GraduationDatasetBuilder
from .export import export_checkpoint, export_checkpoint_to_onnx
from .model import GraduationModelTrainer


def _default_catalog() -> str:
    root = Path(__file__).resolve().parents[2]
    last_catalog_path = root / "last_catalog.txt"
    if last_catalog_path.exists():
        try:
            value = last_catalog_path.read_text(encoding="utf-8").strip()
            if value:
                return value
        except Exception:
            pass
    return ""


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Treina o classificador multi-label de itens de formatura.")
    parser.add_argument("--catalog", default=_default_catalog(), help="Nome do catálogo a usar no treino.")
    parser.add_argument("--limit", type=int, default=None, help="Limita o número de ocorrências usadas no dataset.")
    parser.add_argument("--output", default=None, help="Caminho do checkpoint JSON de saída.")
    parser.add_argument("--onnx-output", default=None, help="Caminho opcional para exportar ONNX.")
    parser.add_argument("--epochs", type=int, default=320, help="Número máximo de épocas.")
    parser.add_argument("--lr", type=float, default=0.15, help="Taxa de aprendizado.")
    parser.add_argument("--l2", type=float, default=0.0015, help="Regularização L2.")
    parser.add_argument("--include-unlabeled", action="store_true", help="Mantém amostras sem rótulo conhecido.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not args.catalog:
        parser.error("Informe --catalog ou configure backend/last_catalog.txt")

    dataset_builder = GraduationDatasetBuilder(args.catalog)
    samples = dataset_builder.build_samples(limit=args.limit, include_unlabeled=args.include_unlabeled)
    features, targets = dataset_builder.build_feature_matrix(samples)

    if features.shape[0] == 0:
        raise RuntimeError("Nenhuma amostra válida encontrada para treino.")

    trainer = GraduationModelTrainer(epochs=args.epochs, learning_rate=args.lr, l2=args.l2)
    model, report = trainer.train(features, targets)
    metadata = GraduationModelTrainer.build_metadata(catalog=args.catalog, samples=report.samples, report=report)
    checkpoint = model.to_checkpoint(metadata=metadata)

    root = Path(__file__).resolve().parents[1]
    output_path = args.output or str(root / "models" / "graduation_classifier.json")
    export_checkpoint(checkpoint, output_path)

    onnx_path = None
    if args.onnx_output:
        onnx_path = export_checkpoint_to_onnx(checkpoint, args.onnx_output)

    summary = {
        "checkpoint": output_path,
        "onnx": onnx_path,
        "samples": report.samples,
        "epochs": report.epochs,
        "loss_final": report.losses[-1] if report.losses else None,
        "positives": report.positives,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
