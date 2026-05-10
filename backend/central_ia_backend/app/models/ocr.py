from sqlalchemy import Column, Integer, String, Float, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.db.session import Base


class OCRResult(Base):
    __tablename__ = "ocr_results"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    photo_id = Column(Integer, ForeignKey("photos.id"), nullable=False)
    
    raw_text = Column(Text)
    detected_name = Column(String(255))
    detected_number = Column(String(100))
    confidence = Column(Float)
    
    event = relationship("Event", back_populates="ocr_results")
    photo = relationship("Photo", back_populates="ocr_results")