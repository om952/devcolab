import json

import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.dependencies import verify_internal_api_key
from app.services.agents import (
    NoLLMConfiguredError,
    run_code_review,
    run_code_review_stream,
)

logger = structlog.get_logger(service="ai-service", component="review")

router = APIRouter(dependencies=[Depends(verify_internal_api_key)])

MAX_CODE_BYTES = 1_000_000


class ReviewRequest(BaseModel):
    code: str = Field(..., max_length=MAX_CODE_BYTES)
    language: str = "python"
    file_path: str = ""
    session_id: str = ""


class ReviewIssue(BaseModel):
    category: str
    severity: str
    line_start: int | None = None
    line_end: int | None = None
    message: str
    suggestion: str


class AgentError(BaseModel):
    agent: str
    error: str


class ReviewResponse(BaseModel):
    session_id: str
    file_path: str
    issues: list[ReviewIssue]
    summary: str
    agent_errors: list[AgentError] = []
    degraded: bool = False
    """True when at least one agent failed, so callers can flag partial results."""


@router.post("/review", response_model=ReviewResponse)
async def analyze_code(request: ReviewRequest):
    try:
        result = await run_code_review(
            code=request.code,
            language=request.language,
            file_path=request.file_path,
        )
    except NoLLMConfiguredError as exc:
        # 503 rather than 500: the caller should fall back, not treat this as a bug.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("review_failed", error=str(exc), error_type=type(exc).__name__)
        raise HTTPException(status_code=500, detail="Review pipeline failed") from exc

    agent_errors = result.get("agent_errors") or []
    return ReviewResponse(
        session_id=request.session_id,
        file_path=request.file_path,
        issues=result["issues"],
        summary=result["summary"],
        agent_errors=agent_errors,
        degraded=bool(agent_errors),
    )


@router.post("/review/stream")
async def analyze_code_stream(request: ReviewRequest):
    """Stream review results as each agent completes, as SSE."""

    async def event_stream():
        try:
            async for event in run_code_review_stream(
                code=request.code,
                language=request.language,
                file_path=request.file_path,
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"
        except NoLLMConfiguredError as exc:
            yield f"data: {json.dumps({'type': 'error', 'code': 'no_llm', 'message': str(exc)})}\n\n"
        except Exception as exc:  # noqa: BLE001
            logger.error("stream_failed", error=str(exc), error_type=type(exc).__name__)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Review pipeline failed'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Stop nginx/ingress from buffering the stream into one blob.
            "X-Accel-Buffering": "no",
        },
    )
