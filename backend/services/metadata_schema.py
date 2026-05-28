from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional


@dataclass
class GraduationMetadata:
    graduation_context: bool = False
    has_beca: bool = False
    has_capelo: bool = False
    has_canudo: bool = False
    has_faixa: bool = False
    has_jabor: bool = False
    group_photo: bool = False
    main_subject: Optional[str] = None
    ocr_text: str = ""
    ocr_confidence: float = 0.0
    ocr_source: str = "paddleocr"
    vlm_analyzed: bool = False
    vlm_confidence: float = 0.0
    reviewed: bool = False
    description: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> GraduationMetadata:
        return cls(
            graduation_context=data.get("graduation_context", False),
            has_beca=data.get("has_beca", False),
            has_capelo=data.get("has_capelo", False),
            has_canudo=data.get("has_canudo", False),
            has_faixa=data.get("has_faixa", False),
            has_jabor=data.get("has_jabor", False),
            group_photo=data.get("group_photo", False),
            main_subject=data.get("main_subject"),
            ocr_text=data.get("ocr_text", ""),
            ocr_confidence=data.get("ocr_confidence", 0.0),
            ocr_source=data.get("ocr_source", "paddleocr"),
            vlm_analyzed=data.get("vlm_analyzed", False),
            vlm_confidence=data.get("vlm_confidence", 0.0),
            reviewed=data.get("reviewed", False),
            description=data.get("description", ""),
        )

    def merge_ocr(self, text: str, confidence: float) -> None:
        if confidence > self.ocr_confidence:
            self.ocr_text = text
            self.ocr_confidence = confidence
            self.ocr_source = "paddleocr"

    def merge_vlm(self, vlm_result: dict) -> None:
        self.graduation_context = vlm_result.get("graduation_context", False)
        self.has_beca = vlm_result.get("has_beca", False)
        self.has_capelo = vlm_result.get("has_capelo", False)
        self.has_canudo = vlm_result.get("has_canudo", False)
        self.has_faixa = vlm_result.get("has_faixa", False)
        self.has_jabor = vlm_result.get("has_jabor", False)
        self.group_photo = vlm_result.get("group_photo", False)
        self.main_subject = vlm_result.get("main_subject") or self.main_subject
        self.description = vlm_result.get("description", "")
        self.vlm_analyzed = True
        self.vlm_confidence = 0.85
