from fastapi import Depends, HTTPException, Security
from fastapi.security import APIKeyHeader

from app.config import Settings, get_settings

api_key_header = APIKeyHeader(name="X-Internal-Api-Key", auto_error=False)


async def verify_internal_api_key(
    api_key: str | None = Security(api_key_header),
    settings: Settings = Depends(get_settings),
):
    """Verify the internal API key sent by collab-server.

    If INTERNAL_API_KEY is not configured, validation is skipped so local
    development works without extra setup. Settings validation rejects that
    configuration outright in production, so this branch is dev-only.
    """
    if not settings.internal_api_key:
        # No key configured — allow all requests (dev mode only)
        return

    if not api_key or api_key != settings.internal_api_key:
        raise HTTPException(status_code=403, detail="Invalid or missing internal API key")
