# Pipeline de treino da formatura

Este diretório mantém o pipeline modular do classificador multi-label sem misturar com Scanner, Pessoas ou Exportação.

Fluxo:
1. `dataset.py` lê o banco e monta amostras com rótulos fracos/fortes.
2. `model.py` treina um classificador linear multi-label em `numpy`.
3. `export.py` salva o checkpoint JSON e, opcionalmente, exporta ONNX quando a dependência `onnx` estiver disponível.
4. `train.py` é a CLI: `python -m ai.training.train --catalog <nome>`.

Artefatos gerados:
- `backend/ai/models/graduation_classifier.json`
- `backend/ai/models/graduation_classifier.onnx` quando a exportação ONNX estiver habilitada e a dependência existir
