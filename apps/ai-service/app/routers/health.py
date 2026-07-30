from fastapi import APIRouter, Response

from app.services.agents import check_llm_ready

router = APIRouter()


@router.get("/health")
async def health_check():
    """Liveness — the process is up. Must not depend on downstreams."""
    return {"status": "ok", "service": "ai-service"}


@router.get("/health/ready")
async def readiness_check(response: Response):
    """Readiness — the service can actually serve reviews.

    Returns 503 when the LLM provider is unreachable or unconfigured so an
    orchestrator keeps the instance out of rotation rather than sending it
    traffic it cannot serve.
    """
    llm_ready, detail = await check_llm_ready()
    if not llm_ready:
        response.status_code = 503
    return {
        "status": "ok" if llm_ready else "degraded",
        "service": "ai-service",
        "checks": {"llm_provider": detail},
    }
