from sqlalchemy import Column, Integer, String, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from app.db.session import Base


class Person(Base):
    __tablename__ = "persons"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    
    name = Column(String(255), nullable=False)
    external_id = Column(String(100))
    avatar_path = Column(String(1024))
    total_photos = Column(Integer, default=0)
    status = Column(String(50), default="active")
    
    event = relationship("Event", back_populates="persons")
    faces = relationship("Face", back_populates="suggested_person", foreign_keys="Face.suggested_person_id")
    occurrences = relationship("Occurrence", back_populates="person", cascade="all, delete-orphan")