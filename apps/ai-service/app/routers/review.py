import json

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.dependencies import verify_internal_api_key
from app.services.agents import (
    SUPPORTED_PROVIDERS,
    LLMCredential,
    NoLLMConfiguredError,
    release_credential,
    run_code_review,
    run_code_review_stream,
    scrub,
    use_credential,
)

logger = structlog.get_logger(service="ai-service", component="review")

router = APIRouter(dependencies=[Depends(verify_internal_api_key)])

MAX_CODE_BYTES = 1_000_000


async def llm_credential(
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
) -> LLMCredential:
    """The caller's own provider and key, from headers.

    Headers rather than the JSON body: request bodies are what access logs and
    error reporters tend to capture, and the key is used for this call only.
    """
    provider = (x_llm_provider or "").strip().lower()
    api_key = (x_llm_api_key or "").strip()

    if not api_key:
        raise HTTPException(status_code=400, detail="No LLM key supplied. Add your API key to run a review.")
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported LLM provider. Use one of: {', '.join(SUPPORTED_PROVIDERS)}.",
        )
    return LLMCredential(provider=provider, api_key=api_key)


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
async def analyze_code(request: ReviewRequest, credential: LLMCredential = Depends(llm_credential)):
    token = use_credential(credential)
    try:
        result = await run_code_review(
            code=request.code,
            language=request.language,
            file_path=request.file_path,
        )
    except NoLLMConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("review_failed", error=scrub(str(exc)), error_type=type(exc).__name__)
        raise HTTPException(status_code=500, detail="Review pipeline failed") from exc
    finally:
        release_credential(token)

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
async def analyze_code_stream(
    request: ReviewRequest, credential: LLMCredential = Depends(llm_credential)
):
    """Stream review results as each agent completes, as SSE."""

    async def event_stream():
        # Set here, inside the generator, so the agents it spawns inherit it
        # whichever task Starlette drives the stream from.
        token = use_credential(credential)
        try:
            async for event in run_code_review_stream(
                code=request.code,
                language=request.language,
                file_path=request.file_path,
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"
        except NoLLMConfiguredError as exc:
            yield f"data: {json.dumps({'type': 'error', 'code': 'llm_key_required', 'message': str(exc)})}\n\n"
        except Exception as exc:  # noqa: BLE001
            logger.error("stream_failed", error=scrub(str(exc)), error_type=type(exc).__name__)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Review pipeline failed'})}\n\n"
        finally:
            release_credential(token)

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
