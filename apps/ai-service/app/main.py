from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import health, review

app = FastAPI(
    title="DevColab AI Service",
    description="LangGraph multi-agent code review pipeline",
    version="0.0.1",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(review.router, prefix="/api/v1")
