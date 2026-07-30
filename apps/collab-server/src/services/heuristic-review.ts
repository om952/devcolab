/**
 * Regex-based reviewer used only when the AI service is unreachable.
 *
 * Results produced here are always labelled `heuristic-fallback` so callers and
 * the UI never present them as AI output.
 */

export type IssueCategory = "bug" | "security" | "anti_pattern" | "test" | "general";
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface ReviewIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  message: string;
  suggestion: string;
  line_start: number | null;
  line_end: number | null;
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
}

const SECRET_PATTERNS = [
  /password\s*[=:]\s*["'][^"']+["']/i,
  /api[_-]?key\s*[=:]\s*["'][^"']+["']/i,
  /secret\s*[=:]\s*["'][^"']+["']/i,
  /token\s*[=:]\s*["'][^"']{12,}["']/i,
];

export function generateHeuristicReview(code: string, language: string): ReviewResult {
  const lines = code.split("\n");
  const issues: ReviewIssue[] = [];

  const push = (
    category: IssueCategory,
    severity: IssueSeverity,
    message: string,
    suggestion: string,
    lineStart: number,
    lineEnd = lineStart
  ) => issues.push({ category, severity, message, suggestion, line_start: lineStart, line_end: lineEnd });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.includes("console.log") || line.includes("print(")) {
      push(
        "anti_pattern",
        "low",
        "Debug logging found in production code",
        "Remove console.log statements before committing. Use a proper logging library like Winston or Pino.",
        lineNo
      );
    }

    if (line.includes("TODO") || line.includes("FIXME") || line.includes("HACK")) {
      push(
        "bug",
        "medium",
        "Incomplete implementation found",
        "Address TODO/FIXME comments before merging. Create tickets for unresolved items.",
        lineNo
      );
    }

    if (line.length > 100) {
      push(
        "anti_pattern",
        "low",
        "Line exceeds 100 characters",
        "Break long lines into multiple lines for better readability.",
        lineNo
      );
    }

    if (line.includes("catch") && (lines[i + 1]?.trim() === "}" || lines[i + 1]?.trim() === "")) {
      push(
        "bug",
        "high",
        "Empty catch block suppresses errors",
        "Handle errors properly in catch blocks. Log the error or re-throw if appropriate.",
        lineNo
      );
    }

    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) {
      push(
        "security",
        "critical",
        "Potential hardcoded secret detected",
        "Use environment variables or a secrets manager. Never hardcode credentials in source code.",
        lineNo
      );
    }
  }

  if (!code.includes("test") && !code.includes("describe") && !code.includes("it(")) {
    push(
      "test",
      "info",
      "No tests found for this code",
      `Add unit tests for ${language} functions. Consider using Jest, Vitest, or the language's standard testing framework.`,
      1,
      Math.min(lines.length, 5)
    );
  }

  const count = (category: IssueCategory) => issues.filter((issue) => issue.category === category).length;

  return {
    issues,
    summary:
      `Found ${issues.length} issues: ${count("bug")} bugs, ${count("security")} security, ` +
      `${count("anti_pattern")} anti-patterns, ${count("test")} test suggestions.`,
  };
}
