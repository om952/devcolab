import { Router } from "express";
import { prisma } from "@devcolab/database";
import { authenticate, AuthRequest } from "../lib/middleware";

const router = Router({ mergeParams: true });

function generateMockReview(code: string, language: string) {
  const lines = code.split("\n");
  const issues = [];

  // Check for common patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for console.log
    if (line.includes("console.log") || line.includes("print(")) {
      issues.push({
        category: "anti_pattern",
        message: "Debug logging found in production code",
        suggestion: "Remove console.log statements before committing. Use a proper logging library like Winston or Pino.",
        line_start: i + 1,
        line_end: i + 1,
      });
    }

    // Check for TODO/FIXME
    if (line.includes("TODO") || line.includes("FIXME") || line.includes("HACK")) {
      issues.push({
        category: "bug",
        message: "Incomplete implementation found",
        suggestion: "Address TODO/FIXME comments before merging. Create tickets for unresolved items.",
        line_start: i + 1,
        line_end: i + 1,
      });
    }

    // Check for long lines
    if (line.length > 100) {
      issues.push({
        category: "anti_pattern",
        message: "Line exceeds 100 characters",
        suggestion: "Break long lines into multiple lines for better readability.",
        line_start: i + 1,
        line_end: i + 1,
      });
    }

    // Check for empty catch blocks
    if (line.includes("catch") && (lines[i + 1]?.trim() === "}" || lines[i + 1]?.trim() === "")) {
      issues.push({
        category: "bug",
        message: "Empty catch block suppresses errors",
        suggestion: "Handle errors properly in catch blocks. Log the error or re-throw if appropriate.",
        line_start: i + 1,
        line_end: i + 1,
      });
    }

    // Check for hardcoded secrets
    if (line.match(/password\s*[=:]\s*["'][^"']+["']/i) || line.match(/api[_-]?key\s*[=:]\s*["'][^"']+["']/i)) {
      issues.push({
        category: "security",
        message: "Potential hardcoded secret detected",
        suggestion: "Use environment variables or a secrets manager. Never hardcode credentials in source code.",
        line_start: i + 1,
        line_end: i + 1,
      });
    }
  }

  // Add test suggestion if no tests found
  if (!code.includes("test") && !code.includes("describe") && !code.includes("it(")) {
    issues.push({
      category: "test",
      message: "No tests found for this code",
      suggestion: `Add unit tests for ${language} functions. Consider using Jest, Vitest, or the language's standard testing framework.`,
      line_start: 1,
      line_end: Math.min(lines.length, 5),
    });
  }

  return {
    issues,
    summary: `Found ${issues.length} issues: ${issues.filter(i => i.category === "bug").length} bugs, ${issues.filter(i => i.category === "security").length} security, ${issues.filter(i => i.category === "anti_pattern").length} anti-patterns, ${issues.filter(i => i.category === "test").length} test suggestions.`,
  };
}

router.post("/ai-review", authenticate, async (req: AuthRequest, res) => {
  const { fileId } = req.body;
  const sessionId = req.params.id;

  const file = await prisma.codeFile.findUnique({ where: { id: fileId } });
  if (!file || file.sessionId !== sessionId) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";

  try {
    let result;
    
    try {
      const response = await fetch(`${AI_SERVICE_URL}/api/v1/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: file.content,
          language: file.language || "typescript",
          file_path: file.filePath,
          session_id: sessionId,
        }),
      });

      if (response.ok) {
        result = await response.json();
      } else {
        throw new Error(`AI service returned ${response.status}`);
      }
    } catch (aiErr) {
      // Fallback: generate mock review for demo
      console.log("AI service unavailable, using mock review");
      result = generateMockReview(file.content, file.language || "typescript");
    }

    // Create AI comments from the review results
    const aiComments = await Promise.all(
      result.issues.map((issue: any) =>
        prisma.comment.create({
          data: {
            sessionId,
            codeFileId: fileId,
            authorId: req.user!.userId,
            authorType: "ai",
            category: issue.category,
            content: `${issue.message}\n\n**Suggestion:** ${issue.suggestion}`,
            filePath: file.filePath,
            lineStart: issue.line_start,
            lineEnd: issue.line_end,
          },
          include: { author: { select: { id: true, name: true, role: true } } },
        })
      )
    );

    // Emit new comments via Socket.IO
    const io = req.app.get("io");
    if (io) {
      aiComments.forEach((comment: any) => {
        io.to(sessionId).emit("comment:created", comment);
      });
    }

    res.json({ success: true, issuesFound: result.issues.length, summary: result.summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
