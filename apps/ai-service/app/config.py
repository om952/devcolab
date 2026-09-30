from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Validated environment variables for ai-service."""

    # There are no server-side provider keys: every user brings their own,
    # sent with each request (see app.routers.review). Only the models are
    # configured here.
    gemini_model: str = "gemini-3.6-flash"
    groq_model: str = "llama-3.1-8b-instant"

    # Per-agent wall clock budget, in seconds. Reasoning-capable models emit
    # thinking tokens before answering and are markedly slower than the small
    # instruct models this pipeline was first tuned against, so this needs
    # headroom. Must stay below collab-server's AI_REVIEW_TIMEOUT_MS, or that
    # side aborts the stream and falls back to heuristics while agents are
    # still working.
    agent_timeout_seconds: float = 90.0

    # Inter-service security
    internal_api_key: str = ""

    # Networking. Comma-separated list of allowed browser origins.
    cors_origins: str = "http://localhost:3000"

    # Observability
    sentry_dsn: str = ""

    # Application
    environment: str = "development"
    debug: bool = False

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Old deployments still carry GOOGLE_API_KEY and friends; ignore them
        # rather than refusing to start.
        extra = "ignore"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip().rstrip("/") for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @model_validator(mode="after")
    def _enforce_production_hardening(self) -> "Settings":
        if not self.is_production:
            return self

        if not self.internal_api_key:
            raise ValueError(
                "INTERNAL_API_KEY is required in production — without it the review "
                "API accepts unauthenticated requests."
            )
        if len(self.internal_api_key) < 16:
            raise ValueError("INTERNAL_API_KEY must be at least 16 characters")
        if any("localhost" in origin for origin in self.cors_origin_list):
            raise ValueError("CORS_ORIGINS must not contain localhost in production")

        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
