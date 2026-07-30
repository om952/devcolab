import { describe, expect, it } from "vitest";
import { generateHeuristicReview } from "../src/services/heuristic-review";

const find = (code: string, category: string) =>
  generateHeuristicReview(code, "typescript").issues.filter((i) => i.category === category);

describe("heuristic review engine", () => {
  it("flags hardcoded secrets as critical security issues", () => {
    const issues = find('const password = "hunter2";\n', "security");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].line_start).toBe(1);
  });

  it.each([
    ['const apiKey = "abcdef123456";', "api key"],
    ['const secret = "topsecret";', "secret"],
    ['const token = "aaaaaaaaaaaaaaaa";', "long token"],
  ])("detects %s", (line) => {
    expect(find(line + "\n", "security")).toHaveLength(1);
  });

  it("does not flag a password comparison with no literal", () => {
    expect(find("if (password === input) return true;\n", "security")).toHaveLength(0);
  });

  it("flags empty catch blocks as high severity bugs", () => {
    const issues = find("try {\n  go();\n} catch (e) {\n}\n", "bug");
    const empty = issues.find((i) => i.message.includes("Empty catch"));
    expect(empty?.severity).toBe("high");
  });

  it("flags TODO/FIXME/HACK markers", () => {
    for (const marker of ["TODO", "FIXME", "HACK"]) {
      const issues = find(`// ${marker}: fix this\n`, "bug");
      expect(issues.some((i) => i.message.includes("Incomplete"))).toBe(true);
    }
  });

  it("flags debug logging", () => {
    expect(find('console.log("x");\n', "anti_pattern").length).toBeGreaterThan(0);
    expect(find('print("x")\n', "anti_pattern").length).toBeGreaterThan(0);
  });

  it("flags lines over 100 characters and reports the right line number", () => {
    const code = "const a = 1;\n" + "x".repeat(120) + "\n";
    const long = find(code, "anti_pattern").find((i) => i.message.includes("100 characters"));
    expect(long?.line_start).toBe(2);
  });

  it("suggests tests when none are present", () => {
    expect(find("function add(a, b) { return a + b; }\n", "test")).toHaveLength(1);
  });

  it("does not suggest tests when tests already exist", () => {
    expect(find('describe("add", () => { it("works", () => {}); });\n', "test")).toHaveLength(0);
  });

  it("returns a summary whose counts match the issues", () => {
    const result = generateHeuristicReview('const password = "p";\nconsole.log(1);\n', "typescript");
    expect(result.summary).toContain(`Found ${result.issues.length} issues`);
    const securityCount = result.issues.filter((i) => i.category === "security").length;
    expect(result.summary).toContain(`${securityCount} security`);
  });

  it("handles empty input without throwing", () => {
    expect(() => generateHeuristicReview("", "typescript")).not.toThrow();
  });

  it("only produces known categories and severities", () => {
    const result = generateHeuristicReview(
      'const password = "p";\n// TODO\nconsole.log(1);\ntry{}catch(e){\n}\n',
      "typescript"
    );
    for (const issue of result.issues) {
      expect(["bug", "security", "anti_pattern", "test", "general"]).toContain(issue.category);
      expect(["critical", "high", "medium", "low", "info"]).toContain(issue.severity);
    }
  });
});
