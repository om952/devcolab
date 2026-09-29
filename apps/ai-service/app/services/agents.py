"""LangGraph multi-agent code review pipeline.

Four specialist agents fan out in parallel from START, then a consolidation
node merges their findings. Each agent is isolated: a failing or slow agent
records an error and yields no issues rather than failing the whole review.
"""

from __future__ import annotations

import asyncio
import json
import operator
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any, TypedDict

import structlog
from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph

from app.config import get_settings

logger = structlog.get_logger(service="ai-service", component="agents")

try:
    from langchain_google_genai import ChatGoogleGenerativeAI

    GEMINI_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on install extras
    GEMINI_AVAILABLE = False

try:
    from langchain_groq import ChatGroq

    GROQ_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on install extras
    GROQ_AVAILABLE = False

try:
    from langchain_ollama import ChatOllama

    OLLAMA_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on install extras
    OLLAMA_AVAILABLE = False


AGENT_TIMEOUT_SECONDS = get_settings().agent_timeout_seconds
"""Per-agent wall clock budget. Exceeding it degrades that agent, not the run."""

MAX_CODE_CHARS = 60_000
"""Files larger than this are truncated so a single upload cannot blow context."""

VALID_SEVERITIES = ("critical", "high", "medium", "low", "info")
SEVERITY_ORDER = {name: index for index, name in enumerate(VALID_SEVERITIES)}

RATE_LIMIT_MARKERS = ("429", "resource_exhausted", "rate limit", "ratelimit", "quota")
"""Substrings identifying a provider throttle rather than a real failure."""

OVERLOAD_MARKERS = ("503", "unavailable", "overloaded", "high demand")
"""Substrings identifying a provider that is temporarily out of capacity."""

RATE_LIMIT_BASE_DELAY_SECONDS = 5.0


def is_rate_limited(exc: BaseException) -> bool:
    """Whether an exception is the provider throttling us.

    Reviewing a folder fans out four calls per file, so brushing against a
    per-minute limit is routine and worth retrying — unlike a genuine error.
    """
    text = str(exc).lower()
    return any(marker in text for marker in RATE_LIMIT_MARKERS)


def is_overloaded(exc: BaseException) -> bool:
    """Whether the provider is temporarily out of capacity (HTTP 503).

    Distinct from a throttle: the limit is not ours, but the remedy is the same,
    since these spikes clear within seconds and retrying inside the agent's
    budget usually succeeds where failing outright cannot.
    """
    text = str(exc).lower()
    return any(marker in text for marker in OVERLOAD_MARKERS)


class NoLLMConfiguredError(RuntimeError):
    """Raised when neither Groq nor Ollama is usable."""


@lru_cache(maxsize=1)
def get_llm():
    """Build the LLM client once and reuse it across agents and requests.

    Providers are tried in priority order — Gemini, then Groq, then a local
    Ollama — so configuring a key is the only step needed to switch.
    """
    settings = get_settings()

    if settings.google_api_key and GEMINI_AVAILABLE:
        logger.info("llm_selected", provider="gemini", model=settings.gemini_model)
        return ChatGoogleGenerativeAI(
            google_api_key=settings.google_api_key,
            model=settings.gemini_model,
            temperature=0.1,
            max_retries=2,
        )

    if settings.groq_api_key and GROQ_AVAILABLE:
        logger.info("llm_selected", provider="groq", model="llama-3.1-8b-instant")
        return ChatGroq(
            api_key=settings.groq_api_key,
            model="llama-3.1-8b-instant",
            temperature=0.1,
            max_retries=2,
        )

    if OLLAMA_AVAILABLE:
        logger.info("llm_selected", provider="ollama", model="codellama:7b")
        return ChatOllama(
            base_url=settings.ollama_host,
            model="codellama:7b",
            temperature=0.1,
        )

    raise NoLLMConfiguredError(
        "No LLM available. Set GOOGLE_API_KEY or GROQ_API_KEY, or run Ollama "
        "and install langchain-ollama."
    )


_READINESS_TTL_SECONDS = 10.0
_readiness_cache: tuple[float, bool, str] | None = None


async def check_llm_ready() -> tuple[bool, str]:
    """Readiness check for the configured LLM provider.

    Constructing a client proves nothing — ChatOllama builds fine against a dead
    host — so for Ollama we actually probe the server. For Groq we can only
    confirm a key is present without spending a paid call.

    Cached briefly so frequent probes do not hammer the provider.
    """
    global _readiness_cache

    now = asyncio.get_event_loop().time()
    if _readiness_cache and now - _readiness_cache[0] < _READINESS_TTL_SECONDS:
        return _readiness_cache[1], _readiness_cache[2]

    settings = get_settings()
    ready, detail = False, "no provider configured"

    if settings.google_api_key and GEMINI_AVAILABLE:
        ready, detail = True, f"gemini api key configured ({settings.gemini_model})"
    elif settings.groq_api_key and GROQ_AVAILABLE:
        ready, detail = True, "groq api key configured"
    elif OLLAMA_AVAILABLE:
        try:
            import httpx

            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{settings.ollama_host.rstrip('/')}/api/tags")
            ready = resp.status_code == 200
            detail = "ollama reachable" if ready else f"ollama returned {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            ready, detail = False, f"ollama unreachable: {type(exc).__name__}"

    _readiness_cache = (now, ready, detail)
    return ready, detail


class ReviewState(TypedDict):
    code: str
    language: str
    file_path: str
    bug_issues: list[dict]
    security_issues: list[dict]
    antipattern_issues: list[dict]
    test_issues: list[dict]
    # Parallel branches append concurrently, so this needs a merge reducer.
    agent_errors: Annotated[list[dict], operator.add]
    consolidated: list[dict]
    summary: str


BUG_DETECTION_PROMPT = """You are a bug detection specialist. Analyze the provided code for:
1. Logic errors and runtime exceptions
2. Null/undefined dereferences
3. Off-by-one errors
4. Resource leaks
5. Incorrect API usage

Respond ONLY with a JSON array of issues found. Each issue must have:
- severity: "critical", "high", "medium", or "low"
- line_start: line number where issue begins (or null if unclear)
- line_end: line number where issue ends (or null)
- message: brief description of the bug
- suggestion: how to fix it

If no bugs found, return an empty array [].

Code to analyze:
```{language}
{code}
```
"""

SECURITY_PROMPT = """You are a security scanning specialist. Analyze the provided code for:
1. SQL injection vulnerabilities
2. XSS vulnerabilities
3. Hardcoded secrets/API keys
4. Insecure deserialization
5. Path traversal
6. CSRF vulnerabilities
7. Insecure authentication/authorization

Respond ONLY with a JSON array of issues found. Each issue must have:
- severity: "critical", "high", "medium", or "low"
- line_start: line number (or null)
- line_end: line number (or null)
- message: security issue description
- suggestion: secure coding fix

If no security issues found, return [].

Code to analyze:
```{language}
{code}
```
"""

ANTIPATTERN_PROMPT = """You are a code quality specialist. Analyze the provided code for:
1. Code smells (duplication, long methods, god classes)
2. Performance anti-patterns
3. Maintainability issues
4. SOLID principle violations
5. Naming convention violations
6. Missing error handling

Respond ONLY with a JSON array of issues found. Each issue must have:
- severity: "critical", "high", "medium", or "low"
- line_start: line number (or null)
- line_end: line number (or null)
- message: anti-pattern description
- suggestion: refactoring recommendation

If no issues found, return [].

Code to analyze:
```{language}
{code}
```
"""

TEST_PROMPT = """You are a test generation specialist. Analyze the provided code and suggest:
1. Missing unit tests
2. Edge cases not covered
3. Integration test scenarios
4. Mock/stub recommendations

Respond ONLY with a JSON array of test suggestions. Each item must have:
- severity: "info" (always)
- line_start: line number of function to test (or null)
- line_end: line number (or null)
- message: what test should cover
- suggestion: example test code or strategy

If no test suggestions needed, return [].

Code to analyze:
```{language}
{code}
```
"""


@dataclass(frozen=True)
class AgentSpec:
    """Declarative description of one specialist agent."""

    name: str
    category: str
    state_key: str
    prompt: str
    default_severity: str


AGENT_SPECS: tuple[AgentSpec, ...] = (
    AgentSpec("bug_detection", "bug", "bug_issues", BUG_DETECTION_PROMPT, "medium"),
    AgentSpec("security_scan", "security", "security_issues", SECURITY_PROMPT, "high"),
    AgentSpec("antipattern_analysis", "anti_pattern", "antipattern_issues", ANTIPATTERN_PROMPT, "low"),
    AgentSpec("test_generation", "test", "test_issues", TEST_PROMPT, "info"),
)

AGENT_BY_NAME = {spec.name: spec for spec in AGENT_SPECS}

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def response_text(response: Any) -> str:
    """Flatten an LLM response into plain text.

    Providers disagree on the shape of `.content`: Groq and Ollama return a
    string, while Gemini returns a list of content blocks
    (``[{"type": "text", "text": ...}]``). Normalising here keeps the parsing
    below provider-agnostic instead of branching per vendor.
    """
    content = getattr(response, "content", None)

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        if parts:
            return "".join(parts)

    # langchain-core exposes a flattened `.text` on newer versions; it is a
    # property on some releases and a method on others.
    text = getattr(response, "text", None)
    if callable(text):
        text = text()
    return text if isinstance(text, str) else ""


def parse_json_response(text: str) -> list[dict]:
    """Extract a JSON array of issues from a model response.

    Models wrap JSON in prose or code fences and occasionally return a bare
    object instead of an array, so try progressively looser strategies.
    """
    if not text:
        return []

    candidates: list[str] = []

    fenced = _FENCE_RE.search(text)
    if fenced:
        candidates.append(fenced.group(1).strip())

    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue

        if isinstance(parsed, list):
            return [item for item in parsed if isinstance(item, dict)]
        if isinstance(parsed, dict):
            for key in ("issues", "results", "findings"):
                nested = parsed.get(key)
                if isinstance(nested, list):
                    return [item for item in nested if isinstance(item, dict)]
            return [parsed]

    return []


def _coerce_line(value: Any, max_line: int) -> int | None:
    """Clamp a model-supplied line number into the file's actual range."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        line = int(value)
    except (TypeError, ValueError):
        return None
    if line < 1:
        return None
    return min(line, max_line) if max_line else line


def normalize_issue(raw: dict, spec: AgentSpec, max_line: int) -> dict | None:
    """Coerce a model-produced issue into the shape the API contract promises."""
    message = str(raw.get("message") or "").strip()
    if not message:
        return None

    severity = str(raw.get("severity") or "").strip().lower()
    if severity not in SEVERITY_ORDER:
        severity = spec.default_severity

    line_start = _coerce_line(raw.get("line_start"), max_line)
    line_end = _coerce_line(raw.get("line_end"), max_line)
    if line_start and line_end and line_end < line_start:
        line_start, line_end = line_end, line_start

    suggestion = str(raw.get("suggestion") or "").strip() or "No specific suggestion provided."

    return {
        "category": spec.category,
        "severity": severity,
        "line_start": line_start,
        "line_end": line_end,
        "message": message[:2_000],
        "suggestion": suggestion[:2_000],
    }


async def run_agent(spec: AgentSpec, state: ReviewState) -> dict:
    """Run one specialist agent.

    Always returns a partial state update touching only this agent's key plus
    agent_errors — returning the whole state would collide with the other
    branches running in parallel.
    """
    code = state["code"]
    max_line = code.count("\n") + 1
    log = logger.bind(agent=spec.name, file_path=state.get("file_path") or None)

    loop = asyncio.get_event_loop()
    deadline = loop.time() + AGENT_TIMEOUT_SECONDS

    try:
        llm = get_llm()
        prompt = spec.prompt.format(language=state["language"], code=code)

        attempt = 0
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError

            try:
                response = await asyncio.wait_for(
                    llm.ainvoke([HumanMessage(content=prompt)]), timeout=remaining
                )
                break
            except Exception as exc:  # noqa: BLE001 - retried or re-raised below
                # Retry throttling and overload within the agent's existing
                # budget rather than extending it, so a slow provider cannot
                # stall the run past the caller's timeout.
                backoff = RATE_LIMIT_BASE_DELAY_SECONDS * (2**attempt)
                rate_limited = is_rate_limited(exc)
                if (
                    not (rate_limited or is_overloaded(exc))
                    or deadline - loop.time() <= backoff
                ):
                    raise

                attempt += 1
                log.warning(
                    "agent_retrying",
                    reason="rate_limited" if rate_limited else "overloaded",
                    attempt=attempt,
                    retry_in_seconds=backoff,
                )
                await asyncio.sleep(backoff)

        raw_issues = parse_json_response(response_text(response))
        issues = [
            normalized
            for item in raw_issues
            if (normalized := normalize_issue(item, spec, max_line)) is not None
        ]
        log.info("agent_completed", issues=len(issues))
        return {spec.state_key: issues, "agent_errors": []}

    except TimeoutError:
        log.warning("agent_timeout", timeout_seconds=AGENT_TIMEOUT_SECONDS)
        return {
            spec.state_key: [],
            "agent_errors": [
                {"agent": spec.name, "error": f"timed out after {AGENT_TIMEOUT_SECONDS:.0f}s"}
            ],
        }
    except Exception as exc:  # noqa: BLE001 - one agent must not sink the run
        log.error("agent_failed", error=str(exc), error_type=type(exc).__name__)
        # Provider throttling is the common failure when reviewing many files;
        # a raw 429 payload tells a reviewer nothing actionable.
        if is_rate_limited(exc):
            message = (
                "rate limited by the LLM provider — retry in a minute or reduce "
                "AI_REVIEW_CONCURRENCY"
            )
        elif is_overloaded(exc):
            message = "the LLM provider is temporarily overloaded — retry in a minute"
        else:
            message = str(exc)
        return {spec.state_key: [], "agent_errors": [{"agent": spec.name, "error": message}]}


def _make_node(spec: AgentSpec) -> Callable[[ReviewState], Any]:
    async def node(state: ReviewState) -> dict:
        return await run_agent(spec, state)

    node.__name__ = f"{spec.name}_node"
    return node


def build_summary(state: dict) -> str:
    counts = {spec.category: len(state.get(spec.state_key) or []) for spec in AGENT_SPECS}
    total = sum(counts.values())
    summary = (
        f"Found {total} issues: {counts['bug']} bugs, {counts['security']} security, "
        f"{counts['anti_pattern']} anti-patterns, {counts['test']} test suggestions."
    )

    failed = state.get("agent_errors") or []
    if failed:
        names = ", ".join(sorted({item["agent"] for item in failed}))
        summary += f" ({len(failed)} agent(s) unavailable: {names})"
    return summary


async def consolidate_results(state: ReviewState) -> dict:
    """Merge every agent's findings into one severity-ordered list."""
    all_issues: list[dict] = []
    for spec in AGENT_SPECS:
        all_issues.extend(state.get(spec.state_key) or [])

    all_issues.sort(key=lambda issue: SEVERITY_ORDER.get(issue.get("severity", "low"), 3))

    return {"consolidated": all_issues, "summary": build_summary(dict(state))}


def _build_graph():
    """Fan out to every agent from START, then join on consolidate."""
    workflow = StateGraph(ReviewState)

    for spec in AGENT_SPECS:
        workflow.add_node(spec.name, _make_node(spec))
    workflow.add_node("consolidate", consolidate_results)

    for spec in AGENT_SPECS:
        workflow.add_edge(START, spec.name)
        workflow.add_edge(spec.name, "consolidate")

    workflow.add_edge("consolidate", END)
    return workflow.compile()


review_graph = _build_graph()


def initial_state(code: str, language: str, file_path: str) -> ReviewState:
    truncated = code[:MAX_CODE_CHARS]
    if len(code) > MAX_CODE_CHARS:
        logger.warning("code_truncated", original_chars=len(code), kept_chars=MAX_CODE_CHARS)

    return ReviewState(
        code=truncated,
        language=language,
        file_path=file_path,
        bug_issues=[],
        security_issues=[],
        antipattern_issues=[],
        test_issues=[],
        agent_errors=[],
        consolidated=[],
        summary="",
    )


async def run_code_review(code: str, language: str = "python", file_path: str = "") -> dict:
    """Run the full multi-agent review pipeline through the compiled graph."""
    final = await review_graph.ainvoke(initial_state(code, language, file_path))
    return {
        "issues": final["consolidated"],
        "summary": final["summary"],
        "agent_errors": final.get("agent_errors") or [],
    }


async def run_code_review_stream(
    code: str, language: str = "python", file_path: str = ""
) -> AsyncIterator[dict]:
    """Stream each agent's findings as it finishes, then the consolidated set.

    Agents run concurrently and are emitted in completion order, so a slow
    agent does not hold back results that are already available.
    """
    state = initial_state(code, language, file_path)

    tasks = {
        asyncio.create_task(run_agent(spec, state)): spec for spec in AGENT_SPECS
    }
    collected: dict[str, Any] = {"agent_errors": []}

    try:
        for completed in asyncio.as_completed(tasks.keys()):
            update = await completed
            agent_errors = update.get("agent_errors") or []
            collected["agent_errors"].extend(agent_errors)

            state_key = next(key for key in update if key != "agent_errors")
            spec = AGENT_BY_NAME[
                next(s.name for s in AGENT_SPECS if s.state_key == state_key)
            ]
            issues = update[state_key] or []
            collected[state_key] = issues

            # Carry this agent's failure on its own event. Reporting it only in
            # the final consolidated payload made a failed agent arrive looking
            # exactly like one that ran fine and found nothing.
            yield {
                "type": "agent_complete",
                "agent": spec.name,
                "category": spec.category,
                "issues": issues,
                "error": agent_errors[0]["error"] if agent_errors else None,
            }
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()

    merged = {**state, **collected}
    final = await consolidate_results(merged)  # type: ignore[arg-type]
    yield {
        "type": "consolidated",
        "issues": final["consolidated"],
        "summary": final["summary"],
        "agent_errors": collected["agent_errors"],
    }
