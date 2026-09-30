"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth, UnauthorizedError } from "../../lib/auth-context";
import { io, Socket } from "socket.io-client";
import CodeViewer from "../../components/CodeViewer";
import FileTree from "../../components/FileTree";
import {
  chunkFiles,
  detectLanguage,
  skipReason,
  MAX_TOTAL_FILES,
  type SkipReason,
  type UploadFile,
} from "../../lib/file-upload";
import LlmKeyPanel, { type LlmKeyStatus } from "../../components/LlmKeyPanel";
import {
  canAddFiles,
  canTriggerReview,
  roleLabel,
  sessionRole,
  whyCannotAddFiles,
} from "../../lib/permissions";
import "../../styles/prism.css";


interface Participant {
  id: string;
  name: string;
  role: string;
  color: string;
}

interface Comment {
  id: string;
  content: string;
  category: string;
  authorType: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  createdAt: string;
  author: { id: string; name: string; role: string };
}

interface CodeFile {
  id: string;
  filePath: string;
  content: string;
  language?: string;
}

interface CursorUpdate {
  userId: string;
  userName: string;
  color: string;
  filePath?: string;
  line?: number;
  column?: number;
}

type AgentState = {
  status: "running" | "completed" | "failed";
  issueCount?: number;
  error?: string;
};

interface RunProgress {
  runId: string;
  fileId?: string;
  filePath?: string;
  agents: Record<string, AgentState>;
  summary?: string;
  engine?: string;
  degraded?: boolean;
  failed?: boolean;
  totalIssues?: number;
  done?: boolean;
}

/** Replace by path rather than append — an upload of an existing path updates
 * that file server-side, so a second list entry would duplicate it. */
function mergeFile(files: CodeFile[], incoming: CodeFile): CodeFile[] {
  const index = files.findIndex((f) => f.filePath === incoming.filePath);
  if (index === -1) return [...files, incoming];
  const next = [...files];
  next[index] = incoming;
  return next;
}

const AGENT_LABELS: Record<string, string> = {
  bug_detection: "Bugs",
  security_scan: "Security",
  anti_pattern: "Anti-patterns",
  test_generation: "Tests",
};

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoading: authLoading, apiFetch } = useAuth();
  const sessionId = params.id as string;

  const [socket, setSocket] = useState<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [activeFile, setActiveFile] = useState<CodeFile | null>(null);
  const [newComment, setNewComment] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [cursors, setCursors] = useState<Record<string, CursorUpdate>>({});
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pasteContent, setPasteContent] = useState("");
  const [pasteFileName, setPasteFileName] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
  const [skipped, setSkipped] = useState<SkipReason[]>([]);
  const [socketError, setSocketError] = useState<string | null>(null);
  /** Creator of this session. Adding files is ownership-based, not role-based. */
  const [createdById, setCreatedById] = useState<string | null>(null);
  // Keyed by run id: a folder review has one run per file, all in flight.
  const [runs, setRuns] = useState<Record<string, RunProgress>>({});
  /** How many files the current review covers; >1 renders the folder summary. */
  const [reviewScope, setReviewScope] = useState(0);
  // The user's own LLM key: whether one is set, never the key itself.
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus | null>(null);
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);

  /** Reviews cannot run without the user's key; ask for it instead of failing. */
  const askForKey = (message: string) => {
    setKeyStatus({ configured: false });
    setKeyPrompt(message);
    setKeyPanelOpen(true);
  };
  const fileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;

    // Same origin as the page (the API is proxied), so the handshake carries
    // the session cookie and no token is ever handed to script.
    const s = io();

    s.on("connect", () => {
      setSocketError(null);
      // Identity comes from the JWT in the handshake — the server ignores any
      // user id sent from the client.
      s.emit("session:join", { sessionId });
    });

    s.on("connect_error", (err) => {
      setSocketError(
        err.message === "Unauthorized"
          ? "Your session expired. Please sign in again."
          : "Lost connection to the collaboration server."
      );
    });

    s.on("error:validation", (e: { message?: string }) =>
      setSocketError(e?.message ?? "Invalid request")
    );
    s.on("error:not_found", (e: { message?: string }) =>
      setSocketError(e?.message ?? "Not found")
    );
    s.on("error:server", (e: { message?: string }) =>
      setSocketError(e?.message ?? "Server error")
    );

    s.on("session:joined", (data) => {
      setParticipants(data.participants);
    });

    s.on("user:joined", (data) => {
      setParticipants(data.participants);
    });

    s.on("user:left", (data) => {
      setParticipants((prev) => prev.filter((p) => p.id !== data.userId));
      setCursors((prev) => {
        const next = { ...prev };
        delete next[data.userId];
        return next;
      });
    });

    s.on("cursor:update", (data: CursorUpdate) => {
      setCursors((prev) => ({ ...prev, [data.userId]: data }));
    });

    s.on("comment:created", (comment: Comment) => {
      setComments((prev) =>
        prev.some((c) => c.id === comment.id) ? prev : [comment, ...prev]
      );
    });

    // Review progress streams per agent. Runs are keyed by id because a folder
    // review has several in flight at once.
    s.on("ai:review_started", (d: { runId: string; fileId: string; agents: string[] }) => {
      setRuns((prev) => ({
        ...prev,
        [d.runId]: {
          ...prev[d.runId],
          runId: d.runId,
          fileId: d.fileId,
          agents: Object.fromEntries(d.agents.map((a) => [a, { status: "running" as const }])),
        },
      }));
    });

    s.on(
      "ai:agent_completed",
      (d: { runId: string; agent: string; issueCount: number; error: string | null }) => {
        setRuns((prev) => {
          const run = prev[d.runId];
          if (!run) return prev;
          return {
            ...prev,
            [d.runId]: {
              ...run,
              agents: {
                ...run.agents,
                [d.agent]: {
                  status: d.error ? "failed" : "completed",
                  issueCount: d.issueCount,
                  error: d.error ?? undefined,
                },
              },
            },
          };
        });
      }
    );

    s.on(
      "ai:review_completed",
      (d: {
        runId: string;
        summary: string;
        engine: string;
        degraded: boolean;
        totalIssues?: number;
      }) => {
        setRuns((prev) => {
          const run = prev[d.runId];
          if (!run) return prev;
          return {
            ...prev,
            [d.runId]: {
              ...run,
              summary: d.summary,
              engine: d.engine,
              degraded: d.degraded,
              totalIssues: d.totalIssues,
              done: true,
            },
          };
        });
      }
    );

    s.on("ai:review_failed", (d: { runId: string; code?: string; error?: string }) => {
      // The key vanished between queueing and running (logout, expiry, or a
      // server restart); the fix is to add it again, so say so.
      if (d.code === "llm_key_required") askForKey(d.error ?? "Add your AI key again to re-run the review.");
      setRuns((prev) => {
        const run = prev[d.runId];
        if (!run) return prev;
        return { ...prev, [d.runId]: { ...run, failed: true, done: true } };
      });
    });

    setSocket(s);

    fetchSessionData();
    apiFetch("/api/llm-key")
      .then((res) => (res.ok ? res.json() : null))
      .then((status) => status && setKeyStatus(status))
      .catch(() => undefined);

    return () => {
      s.emit("session:leave");
      s.disconnect();
    };
  }, [user, sessionId]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push("/login");
  }, [authLoading, user, router]);

  const fetchSessionData = async () => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`);
      // An error body has no comments or codeFiles, so without this check the
      // page renders a session that looks real but is empty.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not load session (${res.status})`);
      }
      const data = await res.json();
      setComments(data.comments || []);
      setFiles(data.codeFiles || []);
      setCreatedById(data.createdById ?? null);
      if (data.codeFiles?.length > 0) {
        setActiveFile(data.codeFiles[0]);
      }
    } catch (err: any) {
      if (err instanceof UnauthorizedError) return; // already redirecting
      console.error(err);
      setSocketError(err?.message ?? "Could not load this session");
    } finally {
      setLoading(false);
    }
  };

  const handleFileClick = (lineIndex: number) => {
    setSelectedLine(lineIndex);
  };

  const handleCursorMove = (lineIndex: number) => {
    if (!socket || !activeFile) return;
    socket.emit("cursor:move", {
      filePath: activeFile.filePath,
      line: lineIndex + 1,
      column: 1,
    });
  };

  const submitComment = () => {
    if (!socket || !newComment.trim() || !activeFile) return;
    socket.emit("comment:create", {
      content: newComment,
      category: "general",
      filePath: activeFile.filePath,
      lineStart: selectedLine ? selectedLine + 1 : undefined,
      lineEnd: selectedLine ? selectedLine + 1 : undefined,
    });
    setNewComment("");
    setSelectedLine(null);
  };

  // Roll-up across every run in the current review.
  const runList = Object.values(runs);
  const reviewSummary = {
    done: runList.filter((r) => r.done).length,
    failed: runList.filter((r) => r.failed).length,
    degraded: runList.filter((r) => r.done && !r.failed && r.degraded).length,
    totalIssues: runList.reduce((sum, r) => sum + (r.totalIssues ?? 0), 0),
  };
  const singleRun = reviewScope === 1 ? runList[0] : undefined;

  // The button stays busy until every run in the batch reports back.
  useEffect(() => {
    if (reviewScope > 0 && reviewSummary.done >= reviewScope) setAiLoading(false);
  }, [reviewScope, reviewSummary.done]);

  const startReview = async (path: string, body: unknown, scope: number) => {
    setAiLoading(true);
    setRuns({});
    setReviewScope(scope);
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (res.status === 428 && data.code === "llm_key_required") {
        askForKey(data.error);
        setAiLoading(false);
        setReviewScope(0);
        return null;
      }
      if (!res.ok) throw new Error(data.error || "Could not start review");
      return data;
    } catch (err: any) {
      console.error(err);
      setSocketError(err.message || "AI review failed to start");
      setAiLoading(false);
      setReviewScope(0);
      return null;
    }
  };

  const triggerAIReview = async () => {
    if (!activeFile) return;
    const data = await startReview("/ai-review", { fileId: activeFile.id }, 1);
    if (!data) return;

    // Seed the run so its card appears before the first socket event lands.
    setRuns({ [data.runId]: { runId: data.runId, fileId: activeFile.id, filePath: activeFile.filePath, agents: {} } });
    // Safety net for missed socket events (reconnect, tab asleep).
    setTimeout(() => pollRun(data.runId), 120_000);
  };

  /** Review every file in the session — one run per file, queued server-side. */
  const triggerFolderReview = async () => {
    if (files.length === 0) return;
    const data = await startReview("/ai-review/batch", {}, files.length);
    if (!data) return;

    const seeded: Record<string, RunProgress> = {};
    for (const run of data.runs ?? []) {
      seeded[run.runId] = {
        runId: run.runId,
        fileId: run.fileId,
        filePath: run.filePath,
        agents: {},
      };
    }
    setRuns(seeded);
    setReviewScope(Object.keys(seeded).length);

    if (data.skipped?.length) {
      setSocketError(
        `Reviewing ${data.runs.length} of ${data.runs.length + data.skipped.length} files — ${data.limit} is the per-batch limit.`
      );
    }

    for (const run of data.runs ?? []) {
      setTimeout(() => pollRun(run.runId), 120_000);
    }
  };

  const pollRun = async (runId: string) => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/ai-review/${runId}`);
      if (!res.ok) return;
      const run = await res.json();
      if (run.status !== "completed" && run.status !== "failed") return;

      setRuns((prev) => {
        const existing = prev[runId];
        if (!existing || existing.done) return prev;
        return {
          ...prev,
          [runId]: {
            ...existing,
            agents: Object.fromEntries(
              (run.agentRuns ?? []).map((a: any) => [
                a.agentType,
                {
                  status: a.status === "completed" ? "completed" : "failed",
                  issueCount: a.issueCount,
                  error: a.error ?? undefined,
                },
              ])
            ),
            summary: run.summary,
            engine: run.engine,
            degraded: run.degraded,
            totalIssues: run.totalIssues,
            failed: run.status === "failed",
            done: true,
          },
        };
      });
    } catch {
      /* best-effort only */
    }
  };

  const getLineComments = (lineIndex: number) => {
    if (!activeFile) return [];
    return comments.filter(
      (c) =>
        c.filePath === activeFile.filePath &&
        c.lineStart === lineIndex + 1
    );
  };

  const getCursorForLine = (lineIndex: number) => {
    return Object.values(cursors).filter(
      (c) => c.filePath === activeFile?.filePath && c.line === lineIndex + 1
    );
  };

  /**
   * Import a whole folder. Everything not worth reviewing is filtered in the
   * browser, then the survivors are uploaded in batches so one huge request
   * cannot exceed the server's body limit.
   */
  const handleFolderUpload = async (fileList: FileList) => {
    const picked = Array.from(fileList);
    if (picked.length === 0) return;

    setUploadLoading(true);
    setUploadProgress({ done: 0, total: 0, label: "Scanning folder…" });
    setSkipped([]);

    try {
      const skippedFiles: SkipReason[] = [];
      const keep: File[] = [];

      for (const file of picked) {
        // webkitRelativePath is the folder-relative path; it is empty for a
        // plain multi-file selection, where the name is the whole path.
        const path = (file as any).webkitRelativePath || file.name;
        const reason = skipReason(path, file.size);
        if (reason) {
          skippedFiles.push({ path, reason });
        } else {
          keep.push(file);
        }
      }

      if (keep.length === 0) {
        setSkipped(skippedFiles);
        setSocketError("Nothing to import — every file was filtered out.");
        return;
      }

      const truncated = keep.length > MAX_TOTAL_FILES;
      const selected = truncated ? keep.slice(0, MAX_TOTAL_FILES) : keep;
      if (truncated) {
        skippedFiles.push({
          path: `${keep.length - MAX_TOTAL_FILES} more file(s)`,
          reason: `over the ${MAX_TOTAL_FILES} file import limit`,
        });
      }

      setUploadProgress({ done: 0, total: selected.length, label: "Reading files…" });

      const payload: UploadFile[] = [];
      for (const file of selected) {
        const rawPath = (file as any).webkitRelativePath || file.name;
        // Drop the wrapper folder name so paths read as project-relative.
        const filePath = rawPath.includes("/")
          ? rawPath.split("/").slice(1).join("/") || rawPath
          : rawPath;
        payload.push({
          filePath,
          content: await file.text(),
          language: detectLanguage(filePath),
        });
      }

      const batches = chunkFiles(payload);
      const uploaded: CodeFile[] = [];
      let done = 0;

      for (const batch of batches) {
        const res = await apiFetch(`/api/sessions/${sessionId}/files/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: batch }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed (${res.status})`);
        }

        const data = await res.json();
        uploaded.push(...(data.files ?? []));
        for (const entry of data.skipped ?? []) {
          skippedFiles.push({ path: entry.filePath, reason: entry.reason });
        }

        done += batch.length;
        setUploadProgress({
          done,
          total: payload.length,
          label: `Uploading… ${done}/${payload.length}`,
        });
      }

      // Re-uploading a path updates it server-side, so replace by path rather
      // than appending a second entry for the same file.
      setFiles((prev) => {
        const byPath = new Map(prev.map((f) => [f.filePath, f]));
        for (const file of uploaded) byPath.set(file.filePath, file);
        return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
      });

      if (uploaded.length > 0) setActiveFile(uploaded[0]);
      setSkipped(skippedFiles);
      setShowUploadModal(false);
    } catch (err: any) {
      console.error("Folder upload error:", err);
      setSocketError(err.message || "Folder import failed");
    } finally {
      setUploadLoading(false);
      setUploadProgress(null);
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadLoading(true);
    try {
      const content = await file.text();
      const language = detectLanguage(file.name);

      const res = await apiFetch(`/api/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: file.name,
          content,
          language,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // 403 here means the role check rejected it — say so plainly rather
        // than reporting a generic failure.
        throw new Error(
          res.status === 403
            ? whyCannotAddFiles(user?.id, createdById) ?? 'You do not have permission to add files'
            : body.error || `Upload failed (${res.status})`
        );
      }
      const newFile = await res.json();
      setFiles((prev) => mergeFile(prev, newFile));
      setActiveFile(newFile);
      setShowUploadModal(false);
    } catch (err: any) {
      console.error('Upload error:', err);
      setSocketError(err.message || 'Failed to upload file');
    } finally {
      setUploadLoading(false);
    }
  };

  const handlePasteSubmit = async () => {
    if (!pasteContent.trim() || !pasteFileName.trim()) return;
    setUploadLoading(true);
    try {
      const language = detectLanguage(pasteFileName);

      const res = await apiFetch(`/api/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: pasteFileName,
          content: pasteContent,
          language,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // 403 here means the role check rejected it — say so plainly rather
        // than reporting a generic failure.
        throw new Error(
          res.status === 403
            ? whyCannotAddFiles(user?.id, createdById) ?? 'You do not have permission to add files'
            : body.error || `Upload failed (${res.status})`
        );
      }
      const newFile = await res.json();
      setFiles((prev) => mergeFile(prev, newFile));
      setActiveFile(newFile);
      setShowUploadModal(false);
      setPasteContent('');
      setPasteFileName('');
    } catch (err: any) {
      console.error('Paste error:', err);
      setSocketError(err.message || 'Failed to save file');
    } finally {
      setUploadLoading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  // Rendering null here left a signed-out visitor staring at a blank page.
  // Send them to login the way the dashboard does — but only once auth has
  // finished restoring, or a hard reload bounces a signed-in user.
  if (!user) return null;

  // Until the session loads, createdById is unknown; fall back to "reviewer",
  // the least-privileged role, so no author-only control flashes into view.
  const myRole = sessionRole(user.id, createdById) ?? "reviewer";

  if (loading) return <div className="p-8">Loading session...</div>;

  const lines = activeFile?.content?.split("\n") || [];

  return (
    <div className="flex h-screen flex-col">
      {socketError && (
        <div className="flex items-center justify-between bg-red-500/10 px-4 py-2 text-sm text-red-300">
          <span>{socketError}</span>
          <button onClick={() => setSocketError(null)} className="text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-4">
          <h1 className="font-medium">Session: {sessionId.slice(0, 8)}</h1>
          <div className="flex items-center gap-2">
            {participants.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-1 text-xs"
                style={{ borderLeft: `2px solid ${p.color}` }}
                title={`${p.name} — ${roleLabel(p.role)}`}
              >
                <span>{p.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {roleLabel(p.role)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Your own role, so it is obvious why a control is unavailable. */}
          <span
            className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-400"
            title="Your role in this session determines what you can do"
          >
            You: <span className="text-slate-200">{roleLabel(myRole)}</span>
          </span>
          {canTriggerReview(myRole) && (
            <>
              <LlmKeyPanel
                open={keyPanelOpen}
                onOpenChange={(open) => {
                  setKeyPanelOpen(open);
                  if (!open) setKeyPrompt(null);
                }}
                status={keyStatus}
                onStatusChange={setKeyStatus}
                prompt={keyPrompt}
              />
              <button
                onClick={triggerAIReview}
                disabled={aiLoading || !activeFile}
                title={!activeFile ? "Select a file to review" : "Review the open file"}
                className="rounded-lg bg-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {aiLoading && reviewScope === 1 ? "Analyzing..." : "AI Review"}
              </button>
              <button
                onClick={triggerFolderReview}
                disabled={aiLoading || files.length === 0}
                title={
                  files.length === 0
                    ? "Add files first"
                    : `Review all ${files.length} file(s) — 4 agent calls each`
                }
                className="rounded-lg bg-violet-500/10 px-3 py-1.5 text-sm font-medium text-violet-300 ring-1 ring-violet-500/30 hover:bg-violet-500/20 disabled:opacity-50"
              >
                {aiLoading && reviewScope > 1
                  ? `Analyzing ${reviewSummary.done}/${reviewScope}…`
                  : `Review all (${files.length})`}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Review progress. A folder review shows an aggregate roll-up; a
          single-file review shows the per-agent chips. */}
      {reviewScope > 0 && (
        <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-400">
              {reviewScope > 1 ? `AI Review · ${reviewScope} files` : "AI Review"}
            </span>

            {reviewScope > 1 ? (
              <>
                <span className="rounded-full bg-slate-700/50 px-2 py-0.5 text-slate-300">
                  {reviewSummary.done}/{reviewScope} done
                </span>
                {reviewSummary.totalIssues > 0 && (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-400">
                    {reviewSummary.totalIssues} issues
                  </span>
                )}
                {reviewSummary.degraded > 0 && (
                  <span
                    className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-400"
                    title="Some agents did not finish — findings are incomplete"
                  >
                    {reviewSummary.degraded} degraded
                  </span>
                )}
                {reviewSummary.failed > 0 && (
                  <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-400">
                    {reviewSummary.failed} failed
                  </span>
                )}
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${(reviewSummary.done / reviewScope) * 100}%` }}
                  />
                </div>
              </>
            ) : (
              singleRun && (
                <>
                  {Object.entries(singleRun.agents).map(([agent, state]) => (
                    <span
                      key={agent}
                      title={state.error || undefined}
                      className={`rounded-full px-2 py-0.5 ${
                        state.status === "completed"
                          ? "bg-emerald-500/10 text-emerald-400"
                          : state.status === "failed"
                          ? "bg-red-500/10 text-red-400"
                          : "bg-slate-700/50 text-slate-400"
                      }`}
                    >
                      {AGENT_LABELS[agent] ?? agent}
                      {state.status === "running" && " …"}
                      {state.status === "completed" && ` · ${state.issueCount ?? 0}`}
                      {state.status === "failed" && " · failed"}
                    </span>
                  ))}
                  {singleRun.summary && <span className="text-slate-400">{singleRun.summary}</span>}
                  {singleRun.failed && <span className="text-red-400">Review failed</span>}
                  {singleRun.engine === "heuristic-fallback" && (
                    <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-400">
                      AI service unreachable — heuristic scan only
                    </span>
                  )}
                </>
              )
            )}

            <button
              onClick={() => {
                setRuns({});
                setReviewScope(0);
              }}
              className="ml-auto text-slate-500 hover:text-slate-300"
            >
              ✕
            </button>
          </div>

          {/* Per-file breakdown once more than one file is in flight. */}
          {reviewScope > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.values(runs).map((run) => (
                <span
                  key={run.runId}
                  title={run.summary || undefined}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    run.failed
                      ? "bg-red-500/10 text-red-400"
                      : run.done
                      ? run.degraded
                        ? "bg-amber-500/10 text-amber-400"
                        : "bg-emerald-500/10 text-emerald-400"
                      : "bg-slate-700/40 text-slate-500"
                  }`}
                >
                  {run.filePath?.split("/").pop() ?? run.runId.slice(0, 6)}
                  {run.done && !run.failed ? ` · ${run.totalIssues ?? 0}` : run.done ? " · failed" : " …"}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* File sidebar */}
        <div className="w-64 border-r border-slate-800 overflow-y-auto">
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">Files</h3>
            {/* Mirrors requireSessionRole("author") on POST /files — the server rejects
                non-authors regardless, this just avoids offering a dead control. */}
            {canAddFiles(user.id, createdById) ? (
              <button
                onClick={() => setShowUploadModal(true)}
                className="rounded bg-slate-800 px-2 py-1 text-xs text-emerald-400 hover:bg-slate-700"
              >
                + Add
              </button>
            ) : (
              <span
                className="cursor-not-allowed rounded bg-slate-800/50 px-2 py-1 text-xs text-slate-600"
                title={whyCannotAddFiles(user.id, createdById) ?? undefined}
              >
                + Add
              </span>
            )}
          </div>
          {files.length > 0 && (
            <FileTree
              files={files}
              activeFileId={activeFile?.id}
              onSelect={(picked) => {
                const full = files.find((f) => f.id === picked.id);
                if (full) setActiveFile(full);
              }}
            />
          )}
          {files.length === 0 && (
            <div className="rounded border border-dashed border-slate-700 p-4 text-center">
              <p className="text-sm text-slate-500">No files yet</p>
              {canAddFiles(user.id, createdById) ? (
                <button
                  onClick={() => setShowUploadModal(true)}
                  className="mt-2 text-sm text-emerald-400 hover:text-emerald-300"
                >
                  Upload or paste code
                </button>
              ) : (
                <p className="mt-2 text-xs text-slate-600">
                  {whyCannotAddFiles(user.id, createdById)}
                </p>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Code viewer */}
        <div className="flex-1 overflow-auto p-4" ref={fileRef}>
          {activeFile ? (
            <div>
              <div className="mb-2 text-sm text-slate-400">{activeFile.filePath}</div>
              <CodeViewer
                code={activeFile.content}
                language={activeFile.language || "typescript"}
                selectedLine={selectedLine}
                onLineClick={handleFileClick}
                onLineHover={handleCursorMove}
                lineComments={Object.fromEntries(
                  lines.map((_, i) => [i, getLineComments(i)])
                )}
                cursors={Object.values(cursors).filter(
                  (c) => c.filePath === activeFile?.filePath
                )}
              />
              
              {/* Inline comment panel */}
              {selectedLine !== null && (
                <div className="mt-4 rounded-lg bg-slate-800 p-4 ring-1 ring-slate-700">
                  <h4 className="mb-2 text-sm font-medium">Comments on line {selectedLine + 1}</h4>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {getLineComments(selectedLine).map((c) => (
                      <div key={c.id} className="rounded bg-slate-900 p-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.author.name}</span>
                          <span className="text-xs text-slate-500">{c.authorType}</span>
                        </div>
                        <p className="mt-1 text-slate-300">{c.content}</p>
                      </div>
                    ))}
                    {getLineComments(selectedLine).length === 0 && (
                      <p className="text-sm text-slate-500">No comments yet</p>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Add a comment..."
                      className="flex-1 rounded bg-slate-900 px-2 py-1 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
                      onKeyDown={(e) => e.key === "Enter" && submitComment()}
                    />
                    <button
                      onClick={submitComment}
                      className="rounded bg-emerald-500 px-3 py-1 text-sm text-white hover:bg-emerald-600"
                    >
                      Post
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-slate-500">
              No file selected
            </div>
          )}
        </div>

        {/* Comments sidebar */}
        <div className="w-80 border-l border-slate-800 overflow-y-auto">
          <div className="p-3">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">All Comments</h3>
            <div className="space-y-3">
              {comments.map((c) => (
                <div key={c.id} className="rounded-lg bg-slate-800 p-3 ring-1 ring-slate-700">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{c.author.name}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        c.category === "bug"
                          ? "bg-red-500/10 text-red-400"
                          : c.category === "security"
                          ? "bg-orange-500/10 text-orange-400"
                          : c.category === "anti_pattern"
                          ? "bg-yellow-500/10 text-yellow-400"
                          : c.category === "test"
                          ? "bg-blue-500/10 text-blue-400"
                          : "bg-slate-500/10 text-slate-400"
                      }`}
                    >
                      {c.category}
                    </span>
                  </div>
                  {c.filePath && (
                    <p className="mt-1 text-xs text-slate-500">
                      {c.filePath}:{c.lineStart}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-slate-300">{c.content}</p>
                </div>
              ))}
              {comments.length === 0 && (
                <p className="text-sm text-slate-500">No comments yet</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-xl bg-slate-900 p-6 ring-1 ring-slate-700">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-medium">Add Code File</h2>
              <button
                onClick={() => setShowUploadModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Drag & Drop */}
            <div
              className="mb-4 rounded-lg border-2 border-dashed border-slate-700 p-8 text-center hover:border-slate-500"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              <p className="text-sm text-slate-400">Drag & drop a file here</p>
              <p className="mt-1 text-xs text-slate-500">or</p>
              <div className="mt-2 flex items-center justify-center gap-2">
                <label className="inline-block cursor-pointer rounded bg-slate-800 px-4 py-2 text-sm text-emerald-400 hover:bg-slate-700">
                  Browse files
                  <input
                    type="file"
                    className="hidden"
                    disabled={uploadLoading}
                    onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
                    accept=".js,.ts,.tsx,.jsx,.py,.java,.go,.rs,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.scala,.r,.sql,.html,.css,.scss,.sass,.less,.json,.xml,.yaml,.md,.sh,.bash,.zsh,.ps1,.dockerfile,.vue,.svelte,.astro,.prisma,.graphql,.gql,.toml,.ini,.env"
                  />
                </label>
                <label className="inline-block cursor-pointer rounded bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/20">
                  Open folder
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    disabled={uploadLoading}
                    // Directory selection is non-standard, so these attributes
                    // are not in React's JSX types.
                    {...({ webkitdirectory: "", directory: "" } as any)}
                    onChange={(e) => e.target.files && handleFolderUpload(e.target.files)}
                  />
                </label>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Folders import the whole project. Dependencies, build output and
                binaries are skipped automatically.
              </p>
            </div>

            {/* Import progress */}
            {uploadProgress && (
              <div className="mb-4 rounded-lg bg-slate-800 p-3">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span>{uploadProgress.label}</span>
                  {uploadProgress.total > 0 && (
                    <span className="text-slate-500">
                      {Math.round((uploadProgress.done / uploadProgress.total) * 100)}%
                    </span>
                  )}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{
                      width: uploadProgress.total
                        ? `${(uploadProgress.done / uploadProgress.total) * 100}%`
                        : "10%",
                    }}
                  />
                </div>
              </div>
            )}

            {/* What was filtered out, so the import is not silently partial */}
            {skipped.length > 0 && !uploadLoading && (
              <details className="mb-4 rounded-lg bg-slate-800/60 p-3 text-xs">
                <summary className="cursor-pointer text-slate-400">
                  Skipped {skipped.length} file(s)
                </summary>
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-slate-500">
                  {skipped.slice(0, 100).map((item, i) => (
                    <li key={`${item.path}-${i}`} className="truncate">
                      <span className="text-slate-400">{item.path}</span> — {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="mb-4 flex items-center gap-2">
              <div className="h-px flex-1 bg-slate-800" />
              <span className="text-xs text-slate-500">or paste code</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            {/* Paste */}
            <div className="space-y-3">
              <input
                type="text"
                placeholder="filename.js"
                value={pasteFileName}
                onChange={(e) => setPasteFileName(e.target.value)}
                className="w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 ring-1 ring-slate-700 focus:outline-none focus:ring-emerald-500"
              />
              <textarea
                placeholder="Paste your code here..."
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
                rows={10}
                className="w-full rounded-lg bg-slate-800 px-3 py-2 text-sm font-mono text-white placeholder-slate-500 ring-1 ring-slate-700 focus:outline-none focus:ring-emerald-500"
              />
              <button
                onClick={handlePasteSubmit}
                disabled={uploadLoading || !pasteContent.trim() || !pasteFileName.trim()}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {uploadLoading ? 'Saving...' : 'Save File'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
