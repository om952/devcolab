"use client";

import Link from "next/link";
import { useAuth } from "./lib/auth-context";
import ReviewPreview from "./components/landing/ReviewPreview";
import {
  ArrowRight,
  BoltIcon,
  BugIcon,
  CheckIcon,
  FlaskIcon,
  GraphIcon,
  LayersIcon,
  LockIcon,
  ShieldIcon,
  UsersIcon,
} from "./components/landing/icons";

const AGENTS = [
  {
    icon: BugIcon,
    name: "Bug detection",
    body: "Logic errors, null dereferences, off-by-ones, resource leaks and misused APIs — with the fix spelled out.",
    accent: "text-rose-300 ring-rose-500/20 bg-rose-500/10",
  },
  {
    icon: ShieldIcon,
    name: "Security scanning",
    body: "Injection, XSS, path traversal, hardcoded secrets and broken auth, graded by severity.",
    accent: "text-amber-300 ring-amber-500/20 bg-amber-500/10",
  },
  {
    icon: LayersIcon,
    name: "Anti-pattern analysis",
    body: "Code smells, SOLID violations, performance traps and the maintainability debt reviewers skim past.",
    accent: "text-sky-300 ring-sky-500/20 bg-sky-500/10",
  },
  {
    icon: FlaskIcon,
    name: "Test generation",
    body: "The edge cases you're missing, plus concrete test scaffolding to cover them.",
    accent: "text-violet-300 ring-violet-500/20 bg-violet-500/10",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Open a session",
    body: "Create a review session and drop in a file — drag, drop or paste. Teammates join instantly.",
  },
  {
    n: "02",
    title: "Agents fan out",
    body: "Four specialists analyse the file in parallel through a LangGraph pipeline. A slow agent never blocks the rest.",
  },
  {
    n: "03",
    title: "Review together",
    body: "Findings stream in per agent and land as inline comments your team can reply to, right beside human notes.",
  },
];

const PLATFORM = [
  {
    icon: UsersIcon,
    title: "Real-time by default",
    body: "Live cursors, presence and threaded comments over Socket.IO — Redis-backed so it scales past one instance.",
  },
  {
    icon: BoltIcon,
    title: "Never blocks on the LLM",
    body: "Reviews run as background jobs. You get a run id immediately and results stream in as each agent lands.",
  },
  {
    icon: LockIcon,
    title: "Role-aware access",
    body: "JWT-authenticated sockets with author, reviewer and AI-reviewer boundaries enforced server-side, not just in the UI.",
  },
  {
    icon: GraphIcon,
    title: "Every run is auditable",
    body: "Per-agent status, issue counts, durations and raw output are persisted — inspect any review after the fact.",
  },
];

const STACK = ["Next.js", "Node.js", "Express", "Socket.IO", "FastAPI", "LangGraph", "PostgreSQL", "Redis"];

export default function HomePage() {
  const { user, isLoading } = useAuth();

  const primaryHref = user ? "/dashboard" : "/login";
  const primaryLabel = user ? "Go to dashboard" : "Start reviewing free";

  return (
    <main className="relative overflow-hidden">
      {/* Ambient background */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid mask-radial" />
        <div className="animate-drift absolute -top-40 left-1/2 h-[34rem] w-[60rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="animate-float absolute -right-32 top-40 h-[26rem] w-[26rem] rounded-full bg-violet-500/10 blur-[110px]" />
      </div>

      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-slate-800/60 glass">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 text-sm font-bold text-slate-950">
              D
            </span>
            DevColab
          </Link>

          <div className="ml-4 hidden items-center gap-6 text-sm text-slate-400 md:flex">
            <a href="#agents" className="transition hover:text-slate-100">Agents</a>
            <a href="#how" className="transition hover:text-slate-100">How it works</a>
            <a href="#platform" className="transition hover:text-slate-100">Platform</a>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {!isLoading && !user && (
              <Link href="/login" className="hidden text-sm text-slate-300 transition hover:text-white sm:block">
                Sign in
              </Link>
            )}
            <Link
              href={primaryHref}
              className="group flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400"
            >
              {user ? "Dashboard" : "Get started"}
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Four specialist agents · streaming results live
          </span>

          <h1
            className="animate-fade-up mt-6 text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl"
            style={{ animationDelay: "80ms" }}
          >
            Code review that <span className="text-gradient">keeps up</span> with your team
          </h1>

          <p
            className="animate-fade-up mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-400"
            style={{ animationDelay: "160ms" }}
          >
            DevColab pairs live collaborative review sessions with a multi-agent AI pipeline that
            catches bugs, security holes and anti-patterns — and writes the tests you're missing.
          </p>

          <div
            className="animate-fade-up mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
            style={{ animationDelay: "240ms" }}
          >
            <Link
              href={primaryHref}
              className="group flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-emerald-500 px-6 py-3 font-medium text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 sm:w-auto"
            >
              {primaryLabel}
              <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#how"
              className="flex w-full items-center justify-center rounded-xl border border-slate-700 bg-slate-900/50 px-6 py-3 font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800/60 sm:w-auto"
            >
              See how it works
            </a>
          </div>

          <p className="animate-fade-up mt-5 text-xs text-slate-500" style={{ animationDelay: "300ms" }}>
            Free to self-host · No credit card · Bring your own LLM key
          </p>
        </div>

        <div className="animate-fade-up mt-16" style={{ animationDelay: "380ms" }}>
          <ReviewPreview />
        </div>
      </section>

      {/* Agents */}
      <section id="agents" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">The pipeline</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Four specialists, one pass
          </h2>
          <p className="mt-4 text-slate-400">
            Every agent reads the same file at the same time and reports independently. One failing
            agent degrades its own findings — never the whole review.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {AGENTS.map(({ icon: Icon, name, body, accent }) => (
            <div
              key={name}
              className="group rounded-2xl border border-slate-800 bg-slate-900/40 p-6 transition duration-300 hover:-translate-y-0.5 hover:border-slate-700 hover:bg-slate-900/70"
            >
              <span className={`inline-flex rounded-xl p-2.5 ring-1 ${accent}`}>
                <Icon />
              </span>
              <h3 className="mt-4 font-semibold">{name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-20 border-y border-slate-800/60 bg-slate-900/20">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="max-w-2xl">
            <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">How it works</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              From paste to reviewed in seconds
            </h2>
          </div>

          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.n} className="relative rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
                <span className="font-mono text-sm text-emerald-400">{step.n}</span>
                <h3 className="mt-3 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{step.body}</p>
                {i < STEPS.length - 1 && (
                  <ArrowRight
                    className="absolute -right-3 top-1/2 hidden h-6 w-6 -translate-y-1/2 text-slate-700 md:block"
                  />
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Platform */}
      <section id="platform" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">Built to run</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Engineered like production software
            </h2>
            <p className="mt-4 text-slate-400">
              A polyglot architecture that separates real-time collaboration from AI analysis, so
              agent workloads scale independently of your review sessions.
            </p>

            <ul className="mt-6 space-y-3">
              {[
                "Human and AI comments in one unified model",
                "Reviews resume cleanly after a restart",
                "Falls back gracefully — and says so",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-300">
                  <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {PLATFORM.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                <Icon className="h-5 w-5 text-emerald-400" />
                <h3 className="mt-3 text-sm font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 border-t border-slate-800/60 pt-10">
          <span className="text-xs uppercase tracking-widest text-slate-600">Built with</span>
          {STACK.map((tech) => (
            <span key={tech} className="text-sm text-slate-500 transition hover:text-slate-300">
              {tech}
            </span>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="relative overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/50 px-6 py-16 text-center">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 bg-gradient-to-br from-emerald-500/10 via-transparent to-violet-500/10"
          />
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Put four reviewers on every pull request
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Spin up a session, invite your team, and let the agents do the first pass.
          </p>
          <Link
            href={primaryHref}
            className="group mt-8 inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-emerald-500 px-6 py-3 font-medium text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400"
          >
            {primaryLabel}
            <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-800/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-slate-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-emerald-400 to-cyan-500 text-xs font-bold text-slate-950">
              D
            </span>
            <span>DevColab</span>
          </div>
          <p>AI-powered real-time code review</p>
        </div>
      </footer>
    </main>
  );
}
