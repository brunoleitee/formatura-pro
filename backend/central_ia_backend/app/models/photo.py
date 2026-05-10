from sqlalchemy import Column, Integer, String, BigInteger, DateTime, Float, Boolean, ForeignKey, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.session import Base
import enum


class PhotoStatus(str, enum.Enum):
    IMPORTED = "imported"
    DETECTED = "detected"
    PROCESSED = "processed"
    ERROR = "error"


class ColorLabel(str, enum.Enum):
    NONE = "none"
    RED = "red"
    YELLOW = "yellow"
    BLUE = "blue"
    GREEN = "green"
    PURPLE = "purple"


class Photo(Base):
    __tablename__ = "photos"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    
    file_name = Column(String(255), nullable=False)
    original_path = Column(String(1024), nullable=False)
    preview_path = Column(String(1024))
    thumbnail_path = Column(String(1024))
    
    width = Column(Integer)
    height = Column(Integer)
    file_size = Column(BigInteger)
    capture_date = Column(DateTime)
    scanner_origin = Column(String(100))
    
    status = Column(String(50), default=PhotoStatus.IMPORTED.value)
    rating = Column(Integer, default=0)
    color_label = Column(String(20), default=ColorLabel.NONE.value)
    favorite = Column(Boolean, default=False)
    discarded = Column(Boolean, default=False)
    
    hash = Column(String(64))
    
    created_at = Column(DateTime, default=func.now())
    
    event = relationship("Event", back_populates="photos")
    faces = relationship("Face", back_populates="photo", cascade="all, delete-orphan")
    ocr_results = relationship("OCRResult", back_populates="photo", cascade="all, delete-orphan")