from app.api.routes_events import router as events_router
from app.api.routes_photos import router as photos_router
from app.api.routes_ai import router as ai_router
from app.api.routes_review import router as review_router
from app.api.routes_export import router as export_router
from app.api.routes_search import router as search_router

__all__ = [
    "events_router", "photos_router", "ai_router",
    "review_router", "export_router", "search_router"
]