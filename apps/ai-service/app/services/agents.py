from typing import TypedDict, List, Optional, AsyncIterator
import os
import json

from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages

# Try to use Groq first (free tier), fallback to Ollama
try:
    from langchain_groq import ChatGroq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

try:
    from langchain_ollama import ChatOllama
    OLLAMA_AVAILABLE = True
except ImportError:
    OLLAMA_AVAILABLE = False

from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

# Model configuration - FREE TIER ONLY
def get_llm():
    """Get LLM instance using free APIs only."""
    groq_key = os.getenv("GROQ_API_KEY")
    ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    
    if groq_key and GROQ_AVAILABLE:
        return ChatGroq(
            api_key=groq_key,
            model="llama-3.1-8b-instant",  # Fast, good for code analysis
            temperature=0.1,
        )
    elif OLLAMA_AVAILABLE:
        return ChatOllama(
            base_url=ollama_host,
            model="codellama:7b",  # Code-optimized model
            temperature=0.1,
        )
    else:
        raise RuntimeError(
            "No free LLM available. Set GROQ_API_KEY or install Ollama."
        )


class ReviewState(TypedDict):
    code: str
    language: str
    file_path: str
    bug_issues: List[dict]
    security_issues: List[dict]
    antipattern_issues: List[dict]
    test_issues: List[dict]
    consolidated: List[dict]
    summary: str


# Agent prompts
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


def parse_json_response(text: str) -> List[dict]:
    """Extract JSON array from LLM response."""
    try:
        # Try to find JSON array in the response
        start = text.find("[")
        end = text.rfind("]")
        if start != -1 and end != -1:
            return json.loads(text[start:end+1])
        return []
    except json.JSONDecodeError:
        return []


async def bug_detection_agent(state: ReviewState) -> ReviewState:
    """Agent 1: Bug detection."""
    llm = get_llm()
    prompt = BUG_DETECTION_PROMPT.format(
        language=state["language"],
        code=state["code"]
    )
    response = await llm.ainvoke([HumanMessage(content=prompt)])
    issues = parse_json_response(response.content)
    return {**state, "bug_issues": issues}


async def security_agent(state: ReviewState) -> ReviewState:
    """Agent 2: Security scanning."""
    llm = get_llm()
    prompt = SECURITY_PROMPT.format(
        language=state["language"],
        code=state["code"]
    )
    response = await llm.ainvoke([HumanMessage(content=prompt)])
    issues = parse_json_response(response.content)
    return {**state, "security_issues": issues}


async def antipattern_agent(state: ReviewState) -> ReviewState:
    """Agent 3: Anti-pattern analysis."""
    llm = get_llm()
    prompt = ANTIPATTERN_PROMPT.format(
        language=state["language"],
        code=state["code"]
    )
    response = await llm.ainvoke([HumanMessage(content=prompt)])
    issues = parse_json_response(response.content)
    return {**state, "antipattern_issues": issues}


async def test_agent(state: ReviewState) -> ReviewState:
    """Agent 4: Test generation."""
    llm = get_llm()
    prompt = TEST_PROMPT.format(
        language=state["language"],
        code=state["code"]
    )
    response = await llm.ainvoke([HumanMessage(content=prompt)])
    issues = parse_json_response(response.content)
    return {**state, "test_issues": issues}


async def consolidate_results(state: ReviewState) -> ReviewState:
    """Consolidate all agent results into unified output."""
    all_issues = []
    
    for issue in state.get("bug_issues", []):
        issue["category"] = "bug"
        all_issues.append(issue)
    
    for issue in state.get("security_issues", []):
        issue["category"] = "security"
        all_issues.append(issue)
    
    for issue in state.get("antipattern_issues", []):
        issue["category"] = "anti_pattern"
        all_issues.append(issue)
    
    for issue in state.get("test_issues", []):
        issue["category"] = "test"
        all_issues.append(issue)
    
    # Sort by severity
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    all_issues.sort(key=lambda x: severity_order.get(x.get("severity", "low"), 3))
    
    summary = f"Found {len(all_issues)} issues: "
    summary += f"{len(state.get('bug_issues', []))} bugs, "
    summary += f"{len(state.get('security_issues', []))} security, "
    summary += f"{len(state.get('antipattern_issues', []))} anti-patterns, "
    summary += f"{len(state.get('test_issues', []))} test suggestions."
    
    return {
        **state,
        "consolidated": all_issues,
        "summary": summary,
    }


# Build the LangGraph workflow
workflow = StateGraph(ReviewState)

# Add all agents as nodes
workflow.add_node("bug_detection", bug_detection_agent)
workflow.add_node("security_scan", security_agent)
workflow.add_node("antipattern_analysis", antipattern_agent)
workflow.add_node("test_generation", test_agent)
workflow.add_node("consolidate", consolidate_results)

# All agents run in parallel from the start
workflow.set_entry_point("bug_detection")
workflow.add_edge("bug_detection", "consolidate")
workflow.add_edge("security_scan", "consolidate")
workflow.add_edge("antipattern_analysis", "consolidate")
workflow.add_edge("test_generation", "consolidate")
workflow.add_edge("consolidate", END)

# Compile the graph
review_graph = workflow.compile()


async def run_code_review(code: str, language: str = "python", file_path: str = "") -> dict:
    """Run the full multi-agent review pipeline."""
    initial_state = ReviewState(
        code=code,
        language=language,
        file_path=file_path,
        bug_issues=[],
        security_issues=[],
        antipattern_issues=[],
        test_issues=[],
        consolidated=[],
        summary="",
    )
    
    # Run all agents in parallel manually (since LangGraph parallel execution needs special setup)
    import asyncio
    
    results = await asyncio.gather(
        bug_detection_agent(initial_state),
        security_agent(initial_state),
        antipattern_agent(initial_state),
        test_agent(initial_state),
    )
    
    # Merge all results
    merged_state = {
        **initial_state,
        "bug_issues": results[0]["bug_issues"],
        "security_issues": results[1]["security_issues"],
        "antipattern_issues": results[2]["antipattern_issues"],
        "test_issues": results[3]["test_issues"],
    }
    
    final = await consolidate_results(merged_state)
    
    return {
        "issues": final["consolidated"],
        "summary": final["summary"],
    }


async def run_code_review_stream(code: str, language: str = "python", file_path: str = "") -> AsyncIterator[dict]:
    """Stream review results as each agent completes."""
    import asyncio
    
    initial_state = ReviewState(
        code=code,
        language=language,
        file_path=file_path,
        bug_issues=[],
        security_issues=[],
        antipattern_issues=[],
        test_issues=[],
        consolidated=[],
        summary="",
    )
    
    # Run agents with yield after each
    bug_result = await bug_detection_agent(initial_state)
    yield {"type": "agent_complete", "agent": "bug_detection", "issues": bug_result["bug_issues"]}
    
    security_result = await security_agent(initial_state)
    yield {"type": "agent_complete", "agent": "security", "issues": security_result["security_issues"]}
    
    antipattern_result = await antipattern_agent(initial_state)
    yield {"type": "agent_complete", "agent": "antipattern", "issues": antipattern_result["antipattern_issues"]}
    
    test_result = await test_agent(initial_state)
    yield {"type": "agent_complete", "agent": "test", "issues": test_result["test_issues"]}
    
    merged = {
        **initial_state,
        "bug_issues": bug_result["bug_issues"],
        "security_issues": security_result["security_issues"],
        "antipattern_issues": antipattern_result["antipattern_issues"],
        "test_issues": test_result["test_issues"],
    }
    
    final = await consolidate_results(merged)
    yield {"type": "consolidated", "issues": final["consolidated"], "summary": final["summary"]}
