from sqlalchemy import Column, Integer, String, Float, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from app.db.session import Base


class Cluster(Base):
    __tablename__ = "clusters"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    
    label = Column(String(100))
    person_id = Column(Integer, ForeignKey("persons.id"))
    confidence = Column(Float)
    reviewed = Column(Boolean, default=False)
    status = Column(String(50), default="pending")
    
    event = relationship("Event", back_populates="clusters")
    faces = relationship("Face", back_populates="cluster")
    occurrences = relationship("Occurrence", back_populates="cluster")