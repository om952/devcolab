from contextlib import asynccontextmanager

import sentry_sdk
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.middleware import RequestContextMiddleware
from app.routers import health, review

settings = get_settings()

# Configure structlog
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer() if settings.debug else structlog.processors.JSONRenderer(),
    ],
    logger_factory=structlog.PrintLoggerFactory(),
)

logger = structlog.get_logger(service="ai-service")

# Initialize Sentry (no-op if DSN is not set)
def _strip_llm_key(event, _hint):
    """Keep users' provider keys out of error reports.

    The key travels in a request header, and Sentry's own scrubbing only knows
    the common header names.
    """
    headers = (event.get("request") or {}).get("headers")
    if isinstance(headers, dict):
        for name in list(headers):
            if name.lower() in ("x-llm-api-key", "x-internal-api-key"):
                headers[name] = "[Filtered]"
    return event


if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        traces_sample_rate=0.2,
        send_default_pii=False,
        before_send=_strip_llm_key,
    )
    logger.info("sentry_initialized")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("ai_service_starting", debug=settings.debug)
    yield
    logger.info("ai_service_shutting_down")


app = FastAPI(
    title="DevColab AI Service",
    description="LangGraph multi-agent code review pipeline",
    version="0.0.1",
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization", "X-Internal-Api-Key"],
)

app.include_router(health.router)
app.include_router(review.router, prefix="/api/v1")

