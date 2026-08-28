"""Tests for the ai-service HTTP surface: auth gate, validation, health."""

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.services import agents as A


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def no_api_key(monkeypatch):
    """Dev mode — INTERNAL_API_KEY unset, so the gate is open."""
    get_settings.cache_clear()
    monkeypatch.setenv("INTERNAL_API_KEY", "")
    yield
    get_settings.cache_clear()


@pytest.fixture
def with_api_key(monkeypatch):
    key = "k" * 32
    get_settings.cache_clear()
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    yield key
    get_settings.cache_clear()


class TestHealth:
    def test_liveness_is_always_ok(self, client):
        res = client.get("/health")
        assert res.status_code == 200
        assert res.json()["service"] == "ai-service"

    def test_readiness_reports_a_provider_check(self, client):
        res = client.get("/health/ready")
        assert res.status_code in (200, 503)
        assert "llm_provider" in res.json()["checks"]

    def test_readiness_fails_when_no_provider_is_reachable(self, client, monkeypatch):
        get_settings.cache_clear()
        A._readiness_cache = None
        # Every provider must be knocked out, otherwise the check legitimately
        # reports ready via whichever one is still configured.
        monkeypatch.setenv("GOOGLE_API_KEY", "")
        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("GROQ_API_KEY", "")
        monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:59999")

        res = client.get("/health/ready")

        get_settings.cache_clear()
        A._readiness_cache = None
        assert res.status_code == 503
        assert res.json()["status"] == "degraded"


class TestInternalApiKeyGate:
    def test_rejects_a_missing_key(self, client, with_api_key):
        res = client.post("/api/v1/review", json={"code": "x=1", "language": "python"})
        assert res.status_code == 403

    def test_rejects_a_wrong_key(self, client, with_api_key):
        res = client.post(
            "/api/v1/review",
            json={"code": "x=1", "language": "python"},
            headers={"X-Internal-Api-Key": "wrong"},
        )
        assert res.status_code == 403

    def test_gate_also_guards_the_streaming_endpoint(self, client, with_api_key):
        res = client.post("/api/v1/review/stream", json={"code": "x=1", "language": "python"})
        assert res.status_code == 403

    def test_allows_a_correct_key(self, client, with_api_key, monkeypatch):
        async def fake_review(**_kwargs):
            return {"issues": [], "summary": "Found 0 issues.", "agent_errors": []}

        monkeypatch.setattr("app.routers.review.run_code_review", fake_review)
        res = client.post(
            "/api/v1/review",
            json={"code": "x=1", "language": "python"},
            headers={"X-Internal-Api-Key": with_api_key},
        )
        assert res.status_code == 200


class TestReviewEndpoint:
    def test_rejects_a_request_with_no_code_field(self, client, no_api_key):
        assert client.post("/api/v1/review", json={"language": "python"}).status_code == 422

    def test_rejects_an_oversized_payload(self, client, no_api_key):
        res = client.post("/api/v1/review", json={"code": "x" * 2_000_000, "language": "python"})
        assert res.status_code == 422

    def test_returns_normalized_issues_and_echoes_identifiers(self, client, no_api_key, monkeypatch):
        async def fake_review(**_kwargs):
            return {
                "issues": [
                    {
                        "category": "security",
                        "severity": "critical",
                        "line_start": 2,
                        "line_end": 2,
                        "message": "Hardcoded secret",
                        "suggestion": "Use env vars",
                    }
                ],
                "summary": "Found 1 issues.",
                "agent_errors": [],
            }

        monkeypatch.setattr("app.routers.review.run_code_review", fake_review)
        res = client.post(
            "/api/v1/review",
            json={"code": "p='x'", "language": "python", "file_path": "a.py", "session_id": "s1"},
        )

        body = res.json()
        assert body["session_id"] == "s1"
        assert body["file_path"] == "a.py"
        assert body["degraded"] is False
        assert body["issues"][0]["category"] == "security"

    def test_flags_degraded_when_an_agent_failed(self, client, no_api_key, monkeypatch):
        async def fake_review(**_kwargs):
            return {
                "issues": [],
                "summary": "Found 0 issues. (1 agent(s) unavailable: security_scan)",
                "agent_errors": [{"agent": "security_scan", "error": "boom"}],
            }

        monkeypatch.setattr("app.routers.review.run_code_review", fake_review)
        res = client.post("/api/v1/review", json={"code": "x=1", "language": "python"})

        body = res.json()
        assert body["degraded"] is True
        assert body["agent_errors"][0]["agent"] == "security_scan"

    def test_returns_503_when_no_llm_is_configured(self, client, no_api_key, monkeypatch):
        async def fake_review(**_kwargs):
            raise A.NoLLMConfiguredError("No LLM available")

        monkeypatch.setattr("app.routers.review.run_code_review", fake_review)
        res = client.post("/api/v1/review", json={"code": "x=1", "language": "python"})
        # 503 tells the caller to fall back rather than treating it as a bug.
        assert res.status_code == 503

    def test_returns_500_on_an_unexpected_failure(self, client, no_api_key, monkeypatch):
        async def fake_review(**_kwargs):
            raise RuntimeError("kaboom")

        monkeypatch.setattr("app.routers.review.run_code_review", fake_review)
        res = client.post("/api/v1/review", json={"code": "x=1", "language": "python"})
        assert res.status_code == 500
        # Internal details must not leak to the caller.
        assert "kaboom" not in res.text


class TestStreamEndpoint:
    def _frames(self, text: str) -> list[dict]:
        return [
            json.loads(line[len("data:") :].strip())
            for line in text.splitlines()
            if line.startswith("data:")
        ]

    def test_streams_sse_frames_ending_with_complete(self, client, no_api_key, monkeypatch):
        async def fake_stream(**_kwargs):
            yield {"type": "agent_complete", "agent": "bug_detection", "category": "bug", "issues": []}
            yield {"type": "consolidated", "issues": [], "summary": "ok", "agent_errors": []}

        monkeypatch.setattr("app.routers.review.run_code_review_stream", fake_stream)
        res = client.post("/api/v1/review/stream", json={"code": "x=1", "language": "python"})

        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        # Proxies must not buffer the stream into a single blob.
        assert res.headers.get("x-accel-buffering") == "no"
        assert [f["type"] for f in self._frames(res.text)] == [
            "agent_complete",
            "consolidated",
            "complete",
        ]

    def test_reports_pipeline_errors_as_a_frame(self, client, no_api_key, monkeypatch):
        async def failing_stream(**_kwargs):
            raise RuntimeError("kaboom")
            yield  # pragma: no cover

        monkeypatch.setattr("app.routers.review.run_code_review_stream", failing_stream)
        res = client.post("/api/v1/review/stream", json={"code": "x=1", "language": "python"})

        frames = self._frames(res.text)
        assert frames[-1]["type"] == "error"
        assert "kaboom" not in res.text


class TestSettings:
    def test_parses_a_comma_separated_origin_list(self):
        s = Settings(cors_origins="https://a.example.com/, https://b.example.com")
        assert s.cors_origin_list == ["https://a.example.com", "https://b.example.com"]

    def test_production_requires_an_internal_api_key(self):
        with pytest.raises(ValueError, match="INTERNAL_API_KEY"):
            Settings(environment="production", internal_api_key="", cors_origins="https://a.example.com")

    def test_production_rejects_a_short_internal_api_key(self):
        with pytest.raises(ValueError, match="at least 16"):
            Settings(environment="production", internal_api_key="short", cors_origins="https://a.example.com")

    def test_production_rejects_localhost_origins(self):
        with pytest.raises(ValueError, match="localhost"):
            Settings(environment="production", internal_api_key="k" * 32, cors_origins="http://localhost:3000")

    def test_accepts_a_valid_production_config(self):
        s = Settings(environment="production", internal_api_key="k" * 32, cors_origins="https://app.example.com")
        assert s.is_production

    def test_development_is_permissive(self):
        assert Settings(environment="development", internal_api_key="").is_production is False
