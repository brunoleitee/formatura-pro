from sqlalchemy import Column, Integer, String, DateTime, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.db.session import Base


class Event(Base):
    __tablename__ = "events"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    base_code = Column(String(50))
    status = Column(String(50), default="active")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    photos = relationship("Photo", back_populates="event", cascade="all, delete-orphan")
    faces = relationship("Face", back_populates="event", cascade="all, delete-orphan")
    persons = relationship("Person", back_populates="event", cascade="all, delete-orphan")
    clusters = relationship("Cluster", back_populates="event", cascade="all, delete-orphan")
    occurrences = relationship("Occurrence", back_populates="event", cascade="all, delete-orphan")
    ocr_results = relationship("OCRResult", back_populates="event", cascade="all, delete-orphan")
    jobs = relationship("ProcessingJob", back_populates="event", cascade="all, delete-orphan")
    exports = relationship("Export", back_populates="event", cascade="all, delete-orphan")