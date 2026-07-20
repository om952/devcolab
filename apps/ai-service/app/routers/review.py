from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import os

from app.services.agents import run_code_review, run_code_review_stream

router = APIRouter()

class ReviewRequest(BaseModel):
    code: str
    language: str = "python"
    file_path: str = ""
    session_id: str = ""

class ReviewIssue(BaseModel):
    category: str
    severity: str
    line_start: Optional[int]
    line_end: Optional[int]
    message: str
    suggestion: str

class ReviewResponse(BaseModel):
    session_id: str
    file_path: str
    issues: List[ReviewIssue]
    summary: str

@router.post("/review", response_model=ReviewResponse)
async def analyze_code(request: ReviewRequest):
    try:
        result = await run_code_review(
            code=request.code,
            language=request.language,
            file_path=request.file_path,
        )
        return ReviewResponse(
            session_id=request.session_id,
            file_path=request.file_path,
            issues=result["issues"],
            summary=result["summary"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/review/stream")
async def analyze_code_stream(request: ReviewRequest):
    """Stream review results as they complete from each agent."""
    from fastapi.responses import StreamingResponse
    import json

    async def event_stream():
        try:
            async for event in run_code_review_stream(
                code=request.code,
                language=request.language,
                file_path=request.file_path,
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
    )
