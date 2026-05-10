from sqlalchemy import Column, Integer, String, Float, LargeBinary, ForeignKey, Enum
from sqlalchemy.orm import relationship
from app.db.session import Base
import enum


class FaceStatus(str, enum.Enum):
    DETECTED = "detected"
    EMBEDDED = "embedded"
    SUGGESTED = "suggested"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"


class Face(Base):
    __tablename__ = "faces"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    photo_id = Column(Integer, ForeignKey("photos.id"), nullable=False)
    
    crop_path = Column(String(1024))
    
    x = Column(Integer)
    y = Column(Integer)
    width = Column(Integer)
    height = Column(Integer)
    
    detection_score = Column(Float)
    embedding = Column(LargeBinary)
    
    status = Column(String(50), default=FaceStatus.DETECTED.value)
    
    suggested_person_id = Column(Integer, ForeignKey("persons.id"))
    suggested_person_name = Column(String(255))
    confidence = Column(Float)
    cluster_id = Column(Integer, ForeignKey("clusters.id"))
    
    created_at = Column(Integer)
    
    event = relationship("Event", back_populates="faces")
    photo = relationship("Photo", back_populates="faces")
    suggested_person = relationship("Person", foreign_keys=[suggested_person_id])