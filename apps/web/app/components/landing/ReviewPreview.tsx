"use client";

import { useEffect, useState } from "react";

/**
 * Decorative mock of a live review session. Mirrors the real session UI —
 * agent chips resolving one by one, then AI comments landing inline — so the
 * landing page shows what the product actually does.
 */

const CODE_LINES: { text: string; tone?: "kw" | "str" | "fn" | "cmt" }[] = [
  { text: "export async function login(req, res) {" },
  { text: "  const { email, password } = req.body;" },
  { text: '  const secret = "sk_live_9f2b41c";', tone: "str" },
  { text: "  const user = await db.query(" },
  { text: "    `SELECT * FROM users WHERE email='${email}'`", tone: "str" },
  { text: "  );" },
  { text: "  try {" },
  { text: "    return sign(user, secret);" },
  { text: "  } catch (e) {}" },
  { text: "}" },
];

const AGENTS = [
  { id: "bug", label: "Bugs", count: 2, color: "text-rose-300", ring: "ring-rose-400/30", dot: "bg-rose-400" },
  { id: "security", label: "Security", count: 2, color: "text-amber-300", ring: "ring-amber-400/30", dot: "bg-amber-400" },
  { id: "anti", label: "Anti-patterns", count: 1, color: "text-sky-300", ring: "ring-sky-400/30", dot: "bg-sky-400" },
  { id: "test", label: "Tests", count: 3, color: "text-violet-300", ring: "ring-violet-400/30", dot: "bg-violet-400" },
];

const FINDINGS = [
  {
    severity: "critical",
    line: 5,
    label: "SQL injection",
    body: "User input is interpolated straight into the query. Use a parameterised statement.",
    accent: "bg-rose-500/10 text-rose-300 ring-rose-500/20",
  },
  {
    severity: "critical",
    line: 3,
    label: "Hardcoded secret",
    body: "A live signing key is committed in source. Move it to a secrets manager.",
    accent: "bg-rose-500/10 text-rose-300 ring-rose-500/20",
  },
  {
    severity: "high",
    line: 9,
    label: "Empty catch block",
    body: "Failures are silently swallowed — log the error or rethrow.",
    accent: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  },
];

export default function ReviewPreview() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    // One pass through the pipeline, then hold on the finished state.
    if (step >= AGENTS.length + FINDINGS.length) return;
    const timer = setTimeout(() => setStep((s) => s + 1), step === 0 ? 700 : 520);
    return () => clearTimeout(timer);
  }, [step]);

  const agentsDone = Math.min(step, AGENTS.length);
  const findingsShown = Math.max(0, Math.min(step - AGENTS.length, FINDINGS.length));

  return (
    <div className="relative">
      {/* Glow behind the panel */}
      <div
        aria-hidden
        className="absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-tr from-emerald-500/20 via-cyan-500/10 to-violet-500/20 blur-3xl"
      />

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl backdrop-blur">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/80 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-2 font-mono text-xs text-slate-500">auth/login.ts</span>
          <div className="ml-auto flex -space-x-1.5">
            {["bg-emerald-400", "bg-sky-400", "bg-violet-400"].map((c, i) => (
              <span
                key={c}
                className={`h-5 w-5 rounded-full ${c} ring-2 ring-slate-900`}
                title={`Reviewer ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* Agent pipeline */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Pipeline</span>
          {AGENTS.map((agent, i) => {
            const done = i < agentsDone;
            return (
              <span
                key={agent.id}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 transition-colors duration-300 ${
                  done ? `${agent.color} ${agent.ring} bg-slate-800/60` : "text-slate-600 ring-slate-800"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${done ? agent.dot : "bg-slate-700"} ${
                    i === agentsDone ? "animate-pulse" : ""
                  }`}
                />
                {agent.label}
                {done && <span className="tabular-nums opacity-70">{agent.count}</span>}
              </span>
            );
          })}
        </div>

        <div className="grid gap-0 md:grid-cols-[1.1fr_1fr]">
          {/* Code */}
          <div className="border-b border-slate-800 p-4 font-mono text-[12px] leading-6 md:border-b-0 md:border-r">
            {CODE_LINES.map((line, i) => {
              const flagged = FINDINGS.slice(0, findingsShown).some((f) => f.line === i + 1);
              return (
                <div
                  key={i}
                  className={`-mx-2 flex gap-3 rounded px-2 transition-colors duration-500 ${
                    flagged ? "bg-rose-500/10" : ""
                  }`}
                >
                  <span className="w-4 shrink-0 select-none text-right text-slate-600">{i + 1}</span>
                  <code className={line.tone === "str" ? "text-emerald-300/90" : "text-slate-300"}>
                    {line.text}
                  </code>
                </div>
              );
            })}
          </div>

          {/* Findings */}
          <div className="space-y-2 p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              AI findings
            </p>
            {FINDINGS.slice(0, findingsShown).map((finding, i) => (
              <div
                key={finding.label}
                className="animate-agent rounded-lg border border-slate-800 bg-slate-900/70 p-3"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ring-1 ${finding.accent}`}>
                    {finding.severity}
                  </span>
                  <span className="text-xs font-medium text-slate-200">{finding.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-slate-500">L{finding.line}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{finding.body}</p>
              </div>
            ))}

            {findingsShown === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-800 p-3 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                Agents analysing…
              </div>
            )}

            {findingsShown === FINDINGS.length && (
              <p className="pt-1 text-[11px] text-slate-500">
                8 findings · streamed to 3 reviewers in real time
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
