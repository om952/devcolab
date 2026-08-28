"""Tests for the LangGraph multi-agent pipeline."""

import time

import pytest

from app.services import agents as A


class TestGraphExecution:
    async def test_all_four_agents_run(self, fake_llm, sample_code):
        llm = fake_llm()
        await A.run_code_review(sample_code, "python", "f.py")
        assert sorted(llm.seen) == ["antipattern", "bug", "security", "test"]

    async def test_agents_run_in_parallel(self, fake_llm, sample_code):
        # Four 0.3s agents: parallel finishes near 0.3s, sequential near 1.2s.
        fake_llm(delay=0.3)
        start = time.monotonic()
        await A.run_code_review(sample_code, "python", "f.py")
        assert time.monotonic() - start < 0.9

    async def test_results_are_severity_ordered(self, fake_llm, sample_code):
        fake_llm()
        result = await A.run_code_review(sample_code, "python", "f.py")
        assert [i["severity"] for i in result["issues"]] == ["critical", "high", "low", "info"]

    async def test_every_issue_is_categorised(self, fake_llm, sample_code):
        fake_llm()
        result = await A.run_code_review(sample_code, "python", "f.py")
        assert sorted(i["category"] for i in result["issues"]) == [
            "anti_pattern",
            "bug",
            "security",
            "test",
        ]

    async def test_summary_counts_match_issues(self, fake_llm, sample_code):
        fake_llm()
        result = await A.run_code_review(sample_code, "python", "f.py")
        assert f"Found {len(result['issues'])} issues" in result["summary"]


class TestAgentIsolation:
    async def test_one_failing_agent_does_not_sink_the_run(self, fake_llm, sample_code):
        fake_llm(fail_on=["security"])
        result = await A.run_code_review(sample_code, "python", "f.py")

        assert len(result["issues"]) == 3
        assert [e["agent"] for e in result["agent_errors"]] == ["security_scan"]

    async def test_failure_is_disclosed_in_the_summary(self, fake_llm, sample_code):
        fake_llm(fail_on=["security"])
        result = await A.run_code_review(sample_code, "python", "f.py")
        assert "unavailable" in result["summary"]
        assert "security_scan" in result["summary"]

    async def test_all_agents_failing_still_returns_a_result(self, fake_llm, sample_code):
        fake_llm(fail_on=["bug", "security", "antipattern", "test"])
        result = await A.run_code_review(sample_code, "python", "f.py")

        assert result["issues"] == []
        assert len(result["agent_errors"]) == 4

    async def test_a_hanging_agent_times_out_without_blocking_others(
        self, fake_llm, sample_code, monkeypatch
    ):
        monkeypatch.setattr(A, "AGENT_TIMEOUT_SECONDS", 0.3)
        fake_llm(hang_on=["security"])

        start = time.monotonic()
        result = await A.run_code_review(sample_code, "python", "f.py")
        elapsed = time.monotonic() - start

        assert elapsed < 3
        assert len(result["issues"]) == 3
        assert "timed out" in result["agent_errors"][0]["error"]


class TestRateLimitRetry:
    async def test_a_throttled_agent_retries_and_then_succeeds(
        self, fake_llm, sample_code, monkeypatch
    ):
        monkeypatch.setattr(A, "RATE_LIMIT_BASE_DELAY_SECONDS", 0.01)
        llm = fake_llm(rate_limit_on=["security"], rate_limit_times=1)

        result = await A.run_code_review(sample_code, "python", "f.py")

        assert result["agent_errors"] == [], "a recoverable throttle must not degrade the run"
        assert llm.rate_limit_hits["security"] == 1
        assert len(result["issues"]) == 4

    async def test_retries_never_outlive_the_agent_budget(
        self, fake_llm, sample_code, monkeypatch
    ):
        # Backoff longer than the remaining budget must give up rather than
        # stall the whole review past the caller's timeout.
        monkeypatch.setattr(A, "AGENT_TIMEOUT_SECONDS", 0.5)
        monkeypatch.setattr(A, "RATE_LIMIT_BASE_DELAY_SECONDS", 30.0)
        fake_llm(rate_limit_on=["security"], rate_limit_times=99)

        start = time.monotonic()
        result = await A.run_code_review(sample_code, "python", "f.py")
        elapsed = time.monotonic() - start

        assert elapsed < 5, "must not sleep past the agent budget"
        assert len(result["agent_errors"]) == 1
        assert len(result["issues"]) == 3

    async def test_a_throttle_is_reported_in_plain_language(
        self, fake_llm, sample_code, monkeypatch
    ):
        monkeypatch.setattr(A, "AGENT_TIMEOUT_SECONDS", 0.5)
        monkeypatch.setattr(A, "RATE_LIMIT_BASE_DELAY_SECONDS", 30.0)
        fake_llm(rate_limit_on=["security"], rate_limit_times=99)

        result = await A.run_code_review(sample_code, "python", "f.py")

        assert "rate limited" in result["agent_errors"][0]["error"]
        assert "429" not in result["agent_errors"][0]["error"]

    async def test_a_genuine_error_is_not_retried(self, fake_llm, sample_code, monkeypatch):
        monkeypatch.setattr(A, "RATE_LIMIT_BASE_DELAY_SECONDS", 0.01)
        llm = fake_llm(fail_on=["security"])

        result = await A.run_code_review(sample_code, "python", "f.py")

        assert llm.seen.count("security") == 1, "non-throttle failures must not retry"
        assert "exploded" in result["agent_errors"][0]["error"]


class TestStreaming:
    async def test_emits_one_event_per_agent_then_consolidated(self, fake_llm, sample_code):
        fake_llm()
        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]

        assert [e["type"] for e in events] == ["agent_complete"] * 4 + ["consolidated"]

    async def test_each_event_carries_a_mappable_category(self, fake_llm, sample_code):
        fake_llm()
        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]

        categories = {e["category"] for e in events if e["type"] == "agent_complete"}
        assert categories == {"bug", "security", "anti_pattern", "test"}

    async def test_consolidated_contains_every_issue(self, fake_llm, sample_code):
        fake_llm()
        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]

        streamed = sum(len(e["issues"]) for e in events if e["type"] == "agent_complete")
        assert len(events[-1]["issues"]) == streamed

    async def test_a_failing_agent_reports_its_error_on_its_own_event(
        self, fake_llm, sample_code
    ):
        # Regression: the error used to appear only in the final consolidated
        # payload, so a failed agent streamed identically to one that ran fine
        # and found nothing.
        fake_llm(fail_on=["security"])
        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]

        by_agent = {e["agent"]: e for e in events if e["type"] == "agent_complete"}
        assert by_agent["security_scan"]["error"], "failed agent must carry an error"
        assert by_agent["security_scan"]["issues"] == []

    async def test_a_healthy_agent_reports_no_error(self, fake_llm, sample_code):
        fake_llm()
        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]

        assert all(
            e["error"] is None for e in events if e["type"] == "agent_complete"
        ), "a successful agent must not report an error"

    async def test_a_timed_out_agent_reports_the_timeout_on_its_event(
        self, fake_llm, sample_code, monkeypatch
    ):
        monkeypatch.setattr(A, "AGENT_TIMEOUT_SECONDS", 0.3)
        fake_llm(hang_on=["security"])

        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]
        by_agent = {e["agent"]: e for e in events if e["type"] == "agent_complete"}

        assert "timed out" in by_agent["security_scan"]["error"]

    async def test_faster_agents_are_emitted_first(self, fake_llm, sample_code, monkeypatch):
        # Completion order, not declaration order, should drive the stream.
        import asyncio

        original = A.run_agent
        delays = {"security_scan": 0.4, "bug_detection": 0.01}

        async def staggered(spec, state):
            await asyncio.sleep(delays.get(spec.name, 0.2))
            return await original(spec, state)

        fake_llm()
        monkeypatch.setattr(A, "run_agent", staggered)

        events = [e async for e in A.run_code_review_stream(sample_code, "python", "f.py")]
        order = [e["agent"] for e in events if e["type"] == "agent_complete"]
        assert order[0] == "bug_detection"
        assert order[-1] == "security_scan"


class TestResponseParsing:
    @pytest.mark.parametrize(
        "payload,expected",
        [
            ('[{"severity":"high","message":"m","suggestion":"s"}]', 1),
            ('Sure!\n[{"severity":"low","message":"m","suggestion":"s"}]\nHope that helps', 1),
            ('```json\n[{"severity":"low","message":"m","suggestion":"s"}]\n```', 1),
            ('{"issues":[{"severity":"low","message":"m","suggestion":"s"}]}', 1),
            ('{"severity":"low","message":"m","suggestion":"s"}', 1),
            ("I could not analyze this code.", 0),
            ("", 0),
            ("[]", 0),
            ("[not valid json", 0),
        ],
    )
    def test_tolerates_messy_model_output(self, payload, expected):
        parsed = A.parse_json_response(payload)
        spec = A.AGENT_SPECS[0]
        normalized = [n for raw in parsed if (n := A.normalize_issue(raw, spec, 10))]
        assert len(normalized) == expected

    def test_drops_issues_with_no_message(self):
        spec = A.AGENT_SPECS[0]
        assert A.normalize_issue({"severity": "high", "suggestion": "s"}, spec, 10) is None

    def test_clamps_line_numbers_to_the_file(self):
        spec = A.AGENT_SPECS[0]
        issue = A.normalize_issue({"message": "m", "line_start": 9999}, spec, 3)
        assert issue["line_start"] == 3

    def test_rejects_nonsense_line_numbers(self):
        spec = A.AGENT_SPECS[0]
        for bad in (-5, 0, "abc", None, True):
            issue = A.normalize_issue({"message": "m", "line_start": bad}, spec, 10)
            assert issue["line_start"] is None

    def test_swaps_reversed_line_ranges(self):
        spec = A.AGENT_SPECS[0]
        issue = A.normalize_issue({"message": "m", "line_start": 8, "line_end": 3}, spec, 10)
        assert (issue["line_start"], issue["line_end"]) == (3, 8)

    def test_defaults_unknown_severity_to_the_agent_default(self):
        spec = A.AGENT_SPECS[0]  # bug_detection -> medium
        assert A.normalize_issue({"message": "m", "severity": "bogus"}, spec, 10)["severity"] == "medium"

    def test_supplies_a_suggestion_when_the_model_omits_one(self):
        spec = A.AGENT_SPECS[0]
        assert A.normalize_issue({"message": "m"}, spec, 10)["suggestion"]

    def test_truncates_absurdly_long_text(self):
        spec = A.AGENT_SPECS[0]
        issue = A.normalize_issue({"message": "x" * 10_000}, spec, 10)
        assert len(issue["message"]) <= 2_000


class TestInputHandling:
    def test_oversized_files_are_truncated(self):
        state = A.initial_state("y" * (A.MAX_CODE_CHARS + 5_000), "python", "big.py")
        assert len(state["code"]) == A.MAX_CODE_CHARS

    def test_small_files_are_untouched(self):
        code = "print(1)\n"
        assert A.initial_state(code, "python", "s.py")["code"] == code
