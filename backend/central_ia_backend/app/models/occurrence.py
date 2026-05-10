from sqlalchemy import Column, Integer, String, Float, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.db.session import Base
import enum


class OccurrenceStatus(str, enum.Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"


class Occurrence(Base):
    __tablename__ = "occurrences"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    photo_id = Column(Integer, ForeignKey("photos.id"))
    face_id = Column(Integer, ForeignKey("faces.id"))
    person_id = Column(Integer, ForeignKey("persons.id"))
    cluster_id = Column(Integer, ForeignKey("clusters.id"))
    
    confidence = Column(Float)
    status = Column(String(50), default=OccurrenceStatus.PENDING.value)
    note = Column(Text)
    
    event = relationship("Event", back_populates="occurrences")