Coloque aqui os artefatos treinados do classificador de formatura.

Arquivos aceitos pelo runtime:
- `graduation_classifier.json` - checkpoint treinado pelo pipeline modular local.
- `graduation_classifier.onnx` - exportação ONNX opcional quando a dependência estiver disponível.

O `GraduationClassifier` carrega automaticamente o checkpoint JSON ou o ONNX quando um deles estiver presente.
