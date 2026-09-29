import asyncio
import json

import pytest

from app.services import agents as A


class FakeResponse:
    def __init__(self, content: str):
        self.content = content


class FakeLLM:
    """Stand-in for the provider client.

    Records which specialist prompt it saw and can be told to fail or stall for
    specific agents, so agent isolation can be tested without a network call.
    """

    def __init__(
        self,
        delay: float = 0.0,
        fail_on=None,
        hang_on=None,
        responses=None,
        rate_limit_on=None,
        rate_limit_times: int = 1,
        overload_on=None,
        overload_times: int = 1,
    ):
        self.seen: list[str] = []
        self.delay = delay
        self.fail_on = set(fail_on or [])
        self.hang_on = set(hang_on or [])
        self.responses = responses or {}
        # Throttle these agents for the first `rate_limit_times` calls, then
        # answer normally — the shape of a real provider rate limit.
        self.rate_limit_on = set(rate_limit_on or [])
        self.rate_limit_times = rate_limit_times
        self.rate_limit_hits: dict[str, int] = {}
        # Same shape for a provider that is out of capacity (HTTP 503).
        self.overload_on = set(overload_on or [])
        self.overload_times = overload_times
        self.overload_hits: dict[str, int] = {}

    @staticmethod
    def _kind(prompt: str) -> str:
        if "bug detection specialist" in prompt:
            return "bug"
        if "security scanning specialist" in prompt:
            return "security"
        if "code quality specialist" in prompt:
            return "antipattern"
        return "test"

    async def ainvoke(self, messages):
        kind = self._kind(messages[0].content)
        self.seen.append(kind)

        if kind in self.hang_on:
            await asyncio.sleep(3600)
        if self.delay:
            await asyncio.sleep(self.delay)
        if kind in self.rate_limit_on:
            hits = self.rate_limit_hits.get(kind, 0)
            if hits < self.rate_limit_times:
                self.rate_limit_hits[kind] = hits + 1
                raise RuntimeError(
                    "Error calling model (RESOURCE_EXHAUSTED): 429 RESOURCE_EXHAUSTED quota exceeded"
                )

        if kind in self.overload_on:
            hits = self.overload_hits.get(kind, 0)
            if hits < self.overload_times:
                self.overload_hits[kind] = hits + 1
                raise RuntimeError(
                    "503 UNAVAILABLE. {'error': {'code': 503, 'message': 'This model is "
                    "currently experiencing high demand.', 'status': 'UNAVAILABLE'}}"
                )

        if kind in self.fail_on:
            raise RuntimeError(f"{kind} provider exploded")
        if kind in self.responses:
            return FakeResponse(self.responses[kind])

        severity = {"bug": "critical", "security": "high", "antipattern": "low", "test": "info"}[kind]
        payload = [
            {
                "severity": severity,
                "line_start": 2,
                "line_end": 2,
                "message": f"{kind} finding",
                "suggestion": "fix it",
            }
        ]
        return FakeResponse("Here you go:\n```json\n" + json.dumps(payload) + "\n```")


@pytest.fixture
def fake_llm(monkeypatch):
    """Install a FakeLLM in place of the real provider."""

    def _install(**kwargs):
        llm = FakeLLM(**kwargs)
        monkeypatch.setattr(A, "get_llm", lambda: llm)
        return llm

    return _install


@pytest.fixture
def sample_code() -> str:
    return "def f():\n    password = 'hunter2'\n    return 1\n"
