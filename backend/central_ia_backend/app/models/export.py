from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.db.session import Base
from datetime import datetime


class Export(Base):
    __tablename__ = "exports"
    
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), nullable=False)
    
    type = Column(String(50))
    path = Column(String(1024))
    status = Column(String(50), default="pending")
    created_at = Column(DateTime, default=datetime.now)
    
    event = relationship("Event", back_populates="exports")