from sqlalchemy import Column, Integer, String, Float, Text, DateTime
from sqlalchemy.orm import relationship
from app.db.session import Base
from datetime import datetime


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    
    type = Column(String(50), nullable=False)
    status = Column(String(50), default="pending")
    progress = Column(Float, default=0.0)
    total = Column(Integer, default=0)
    processed = Column(Integer, default=0)
    error_message = Column(Text)
    
    started_at = Column(DateTime, default=datetime.now)
    finished_at = Column(DateTime)
    
    event = relationship("Event", back_populates="jobs")