"""Exportadores do pipeline de treino de formatura."""

from __future__ import annotations

import os
from typing import Any

from ..graduation_checkpoint import GraduationCheckpoint


def export_checkpoint(checkpoint: GraduationCheckpoint, output_path: str) -> str:
    checkpoint.save(output_path)
    return output_path


def export_checkpoint_to_onnx(checkpoint: GraduationCheckpoint, output_path: str) -> str:
    """Exportação opcional para ONNX.

    O projeto não traz a dependência `onnx` instalada por padrão neste ambiente.
    Mantemos o código isolado aqui para que o pipeline continue modular e possa
    ser ativado quando a dependência estiver disponível.
    """

    try:
        import onnx  # type: ignore
        from onnx import TensorProto, helper
    except Exception as exc:  # pragma: no cover - dependência opcional
        raise RuntimeError(
            "A exportação ONNX requer a dependência 'onnx'. "
            "Use o checkpoint JSON ou instale o pacote antes de exportar."
        ) from exc

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    feature_count = len(checkpoint.feature_names)
    label_count = len(checkpoint.labels)

    input_tensor = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, feature_count])
    output_tensor = helper.make_tensor_value_info("scores", TensorProto.FLOAT, [None, label_count])

    mean_tensor = helper.make_tensor(
        name="feature_mean",
        data_type=TensorProto.FLOAT,
        dims=checkpoint.feature_mean.shape,
        vals=checkpoint.feature_mean.astype(float).tolist(),
    )
    std_tensor = helper.make_tensor(
        name="feature_std",
        data_type=TensorProto.FLOAT,
        dims=checkpoint.feature_std.shape,
        vals=checkpoint.feature_std.astype(float).tolist(),
    )
    weights_tensor = helper.make_tensor(
        name="weights",
        data_type=TensorProto.FLOAT,
        dims=checkpoint.weights.T.shape,
        vals=checkpoint.weights.T.astype(float).ravel().tolist(),
    )
    bias_tensor = helper.make_tensor(
        name="bias",
        data_type=TensorProto.FLOAT,
        dims=checkpoint.bias.shape,
        vals=checkpoint.bias.astype(float).tolist(),
    )

    nodes = [
        helper.make_node("Sub", ["features", "feature_mean"], ["centered"]),
        helper.make_node("Div", ["centered", "feature_std"], ["normalized"]),
        helper.make_node("MatMul", ["normalized", "weights"], ["logits_raw"]),
        helper.make_node("Add", ["logits_raw", "bias"], ["logits"]),
        helper.make_node("Sigmoid", ["logits"], ["scores"]),
    ]

    graph = helper.make_graph(
        nodes=nodes,
        name="graduation_classifier",
        inputs=[input_tensor],
        outputs=[output_tensor],
        initializer=[mean_tensor, std_tensor, weights_tensor, bias_tensor],
    )
    model = helper.make_model(graph, producer_name="formatura-pro-graduation-trainer")
    onnx.save(model, output_path)
    return output_path

