import os
import json
import logging
import threading
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_QWEN_MODEL = None
_QWEN_PROCESSOR = None
_QWEN_LOCK = threading.Lock()
_QWEN_STATE: Dict[str, Any] = {
    "available": False,
    "message": "Qwen2.5-VL não carregado",
    "loading": False,
    "quantized": False,
}

_GRADUATION_PROMPT = """Analise esta foto de formatura e responda APENAS com um JSON válido (sem markdown, sem explicação):
{
  "graduation_context": true/false,
  "has_beca": true/false,
  "has_capelo": true/false,
  "has_canudo": true/false,
  "has_faixa": true/false,
  "has_jabor": true/false,
  "group_photo": true/false,
  "main_subject": "face_index_or_null",
  "description": "breve descrição do contexto"
}

Regras:
- graduation_context: true se for uma cerimônia/formatura
- has_beca: true se alguém estiver usando beca
- has_capelo: true se houver capelo (chapéu de formatura)
- has_canudo: true se houver canudo/diploma
- has_faixa: true se houver faixa de formatura
- has_jabor: true se houver jabor (planta/cravinho na lapela)
- group_photo: true se for foto em grupo (3+ pessoas)
- main_subject: "face_1", "face_2" etc ou null se não der para determinar
- description: texto curto descrevendo a cena"""


def load_qwen_model(quantize: bool = True) -> bool:
    global _QWEN_MODEL, _QWEN_PROCESSOR
    if _QWEN_MODEL is not None:
        return True
    with _QWEN_LOCK:
        if _QWEN_MODEL is not None:
            return True
        if _QWEN_STATE.get("loading"):
            return False
        _QWEN_STATE["loading"] = True
        try:
            import torch
            from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

            model_id = os.environ.get(
                "QWEN_MODEL_ID",
                "Qwen/Qwen2.5-VL-7B-Instruct",
            )

            kwargs: Dict[str, Any] = {
                "torch_dtype": torch.float16 if torch.cuda.is_available() else torch.float32,
                "device_map": "auto",
                "trust_remote_code": True,
            }
            if quantize and torch.cuda.is_available():
                try:
                    from transformers import BitsAndBytesConfig
                    kwargs["quantization_config"] = BitsAndBytesConfig(
                        load_in_4bit=True,
                        bnb_4bit_compute_dtype=torch.float16,
                    )
                    _QWEN_STATE["quantized"] = True
                except Exception:
                    pass

            _QWEN_MODEL = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                model_id,
                **kwargs,
            )
            _QWEN_PROCESSOR = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)

            _QWEN_STATE["available"] = True
            _QWEN_STATE["message"] = "Qwen2.5-VL carregado"
            _QWEN_STATE["loading"] = False
            print(f"[VLM] Qwen2.5-VL loaded (quantized={_QWEN_STATE['quantized']})")
            return True
        except Exception as e:
            _QWEN_STATE["available"] = False
            _QWEN_STATE["message"] = f"Qwen2.5-VL erro: {e}"
            _QWEN_STATE["loading"] = False
            print(f"[VLM] Qwen2.5-VL load error: {e}")
            return False


def is_qwen_available() -> bool:
    return bool(_QWEN_STATE["available"])


def get_qwen_status() -> Dict[str, Any]:
    return dict(_QWEN_STATE)


def analyze_graduation_image(image: np.ndarray) -> Optional[Dict[str, Any]]:
    if _QWEN_MODEL is None:
        if not load_qwen_model():
            print("[VLM] Qwen2.5-VL not available for analysis")
            return None
    try:
        import torch
        from PIL import Image

        pil_image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": pil_image},
                    {"type": "text", "text": _GRADUATION_PROMPT},
                ],
            }
        ]

        text = _QWEN_PROCESSOR.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = _QWEN_PROCESSOR(
            text=[text],
            images=[pil_image],
            padding=True,
            return_tensors="pt",
        )
        inputs = {k: v.to(_QWEN_MODEL.device) if hasattr(v, 'to') else v for k, v in inputs.items()}

        generated_ids = _QWEN_MODEL.generate(
            **inputs,
            max_new_tokens=256,
            temperature=0.1,
            do_sample=False,
        )
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)
        ]
        output_text = _QWEN_PROCESSOR.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]

        json_match = __import__("re").search(r"\{.*\}", output_text, __import__("re").DOTALL)
        if json_match:
            result = json.loads(json_match.group(0))
            print(f"[VLM] Qwen analysis completed: graduation={result.get('graduation_context')}")
            return result

        print(f"[VLM] Could not parse JSON from output: {output_text[:200]}")
        return None
    except Exception as e:
        print(f"[VLM] Qwen analysis error: {e}")
        return None


def analyze_graduation_image_batch(
    images: List[np.ndarray],
    max_batch: int = 4,
) -> List[Optional[Dict[str, Any]]]:
    results: List[Optional[Dict[str, Any]]] = []
    for img in images[:max_batch]:
        results.append(analyze_graduation_image(img))
    return results
