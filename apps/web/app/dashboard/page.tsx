"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, UnauthorizedError } from "../lib/auth-context";
import { failureMessage, networkFailureMessage } from "../lib/api-errors";


interface Session {
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt: string;
  creator: { name: string; email: string };
  _count: { comments: number };
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, logout, isLoading, apiFetch } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // Shown when a request fails. Without it a failed load looked like an empty
  // dashboard and a failed create did nothing at all.
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // The auth context restores from localStorage asynchronously; redirecting
    // before that resolves would bounce a signed-in user on every hard load.
    if (isLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    fetchSessions();
  }, [user, isLoading, router]);

  const fetchSessions = async () => {
    try {
      const res = await apiFetch("/api/sessions");
      // Without this the error body lands in setSessions and renders as an
      // empty dashboard, which reads as "you have no sessions".
      if (!res.ok) {
        setError(await failureMessage(res, "Could not load your sessions."));
        return;
      }
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) return; // already redirecting
      console.error(err);
      setError(networkFailureMessage());
    } finally {
      setLoading(false);
    }
  };

  const createSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, description: newDesc }),
      });
      if (!res.ok) {
        // The form stays open with what was typed, so retrying is one click.
        setError(await failureMessage(res, "Could not create the session."));
        return;
      }
      setNewTitle("");
      setNewDesc("");
      setShowCreate(false);
      fetchSessions();
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      console.error(err);
      setError(networkFailureMessage());
    } finally {
      setCreating(false);
    }
  };

  if (isLoading) {
    return <div className="p-8 text-slate-400">Loading…</div>;
  }
  if (!user) return null;

  return (
    <div className="min-h-screen px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">DevColab</p>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-sm text-slate-400">Welcome back, {user.name}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              New Session
            </button>
            <button
              onClick={logout}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            data-testid="error-banner"
            className="mb-6 flex items-start justify-between gap-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-200 ring-1 ring-red-500/30"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss"
              className="text-red-300 hover:text-red-100"
            >
              ✕
            </button>
          </div>
        )}

        {showCreate && (
          <div className="mb-6 rounded-lg bg-slate-800 p-4 ring-1 ring-slate-700">
            <form onSubmit={createSession} className="space-y-3">
              <input
                type="text"
                placeholder="Session title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
                required
              />
              <textarea
                placeholder="Description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
                rows={2}
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  {creating ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-600"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {loading ? (
          <p className="text-slate-400">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <div className="rounded-lg bg-slate-800 p-8 text-center ring-1 ring-slate-700">
            <p className="text-slate-400">
              {error
                ? "Your sessions could not be loaded."
                : "No sessions yet. Create your first review session."}
            </p>
            {error && (
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  fetchSessions();
                }}
                className="mt-3 rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600"
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => router.push(`/session/${session.id}`)}
                className="cursor-pointer rounded-lg bg-slate-800 p-4 ring-1 ring-slate-700 transition hover:ring-emerald-500/50"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{session.title}</h3>
                    {session.description && (
                      <p className="text-sm text-slate-400">{session.description}</p>
                    )}
                    <p className="mt-1 text-xs text-slate-500">
                      By {session.creator.name} · {session._count.comments} comments ·{" "}
                      {new Date(session.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      session.status === "active"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : session.status === "completed"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-slate-500/10 text-slate-400"
                    }`}
                  >
                    {session.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
