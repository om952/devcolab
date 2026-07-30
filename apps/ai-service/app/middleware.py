import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = structlog.get_logger(service="ai-service", component="http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Bind a correlation id to every log line emitted while handling a request.

    collab-server sends the review run id as X-Request-Id, so agent logs here
    can be joined back to the run record on the other side of the API.
    """

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)

        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request_failed",
                path=request.url.path,
                method=request.method,
                duration_ms=round((time.perf_counter() - started) * 1000, 1),
            )
            raise

        response.headers["X-Request-Id"] = request_id

        # Health probes fire constantly; logging them buries real traffic.
        if not request.url.path.startswith("/health"):
            logger.info(
                "request_completed",
                path=request.url.path,
                method=request.method,
                status=response.status_code,
                duration_ms=round((time.perf_counter() - started) * 1000, 1),
            )

        return response
