"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "../../lib/auth-context";
import { io, Socket } from "socket.io-client";
import CodeViewer from "../../components/CodeViewer";
import "../../styles/prism.css";

const API_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:4000";
const SOCKET_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:4000";

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

type AgentState = { status: "running" | "completed" | "failed"; issueCount?: number };

interface ReviewProgress {
  runId: string;
  agents: Record<string, AgentState>;
  summary?: string;
  engine?: string;
  degraded?: boolean;
  failed?: boolean;
}

const AGENT_LABELS: Record<string, string> = {
  bug_detection: "Bugs",
  security_scan: "Security",
  anti_pattern: "Anti-patterns",
  test_generation: "Tests",
};

export default function SessionPage() {
  const params = useParams();
  const { user, token } = useAuth();
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
  const [socketError, setSocketError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewProgress | null>(null);
  const fileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user || !token) return;

    const s = io(SOCKET_URL, {
      auth: { token },
    });

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

    // AI review progress streams in per agent as the pipeline runs.
    s.on("ai:review_started", (d: { runId: string; agents: string[] }) => {
      setReview({
        runId: d.runId,
        agents: Object.fromEntries(d.agents.map((a) => [a, { status: "running" as const }])),
      });
      setAiLoading(true);
    });

    s.on(
      "ai:agent_completed",
      (d: { runId: string; agent: string; issueCount: number; error: string | null }) => {
        setReview((prev) =>
          prev && prev.runId === d.runId
            ? {
                ...prev,
                agents: {
                  ...prev.agents,
                  [d.agent]: {
                    status: d.error ? "failed" : "completed",
                    issueCount: d.issueCount,
                  },
                },
              }
            : prev
        );
      }
    );

    s.on(
      "ai:review_completed",
      (d: { runId: string; summary: string; engine: string; degraded: boolean }) => {
        setReview((prev) =>
          prev && prev.runId === d.runId
            ? { ...prev, summary: d.summary, engine: d.engine, degraded: d.degraded }
            : prev
        );
        setAiLoading(false);
      }
    );

    s.on("ai:review_failed", (d: { runId: string }) => {
      setReview((prev) => (prev && prev.runId === d.runId ? { ...prev, failed: true } : prev));
      setAiLoading(false);
    });

    setSocket(s);

    fetchSessionData();

    return () => {
      s.emit("session:leave");
      s.disconnect();
    };
  }, [user, token, sessionId]);

  const fetchSessionData = async () => {
    try {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setComments(data.comments || []);
      setFiles(data.codeFiles || []);
      if (data.codeFiles?.length > 0) {
        setActiveFile(data.codeFiles[0]);
      }
    } catch (err) {
      console.error(err);
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

  const triggerAIReview = async () => {
    if (!activeFile) return;
    setAiLoading(true);
    setReview(null);
    try {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/ai-review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileId: activeFile.id }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not start review");

      // 202 — the run is queued. Progress arrives over the socket; poll once as
      // a safety net in case those events are missed.
      const runId: string = data.runId;
      setTimeout(() => pollRun(runId), 90_000);
    } catch (err: any) {
      console.error(err);
      setSocketError(err.message || "AI review failed to start");
      setAiLoading(false);
    }
  };

  const pollRun = async (runId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/ai-review/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const run = await res.json();
      if (run.status === "completed" || run.status === "failed") {
        setReview((prev) =>
          prev && prev.runId !== runId
            ? prev
            : {
                runId,
                agents: Object.fromEntries(
                  (run.agentRuns ?? []).map((a: any) => [
                    a.agentType,
                    { status: a.status === "completed" ? "completed" : "failed", issueCount: a.issueCount },
                  ])
                ),
                summary: run.summary,
                engine: run.engine,
                degraded: run.degraded,
                failed: run.status === "failed",
              }
        );
        setAiLoading(false);
      }
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

  const detectLanguage = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', ts: 'typescript', tsx: 'typescript',
      jsx: 'javascript', py: 'python', java: 'java',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
      go: 'go', rs: 'rust', rb: 'ruby',
      php: 'php', cs: 'csharp', swift: 'swift',
      kt: 'kotlin', scala: 'scala', r: 'r',
      sql: 'sql', html: 'html', css: 'css',
      scss: 'scss', sass: 'sass', less: 'less',
      json: 'json', xml: 'xml', yaml: 'yaml',
      md: 'markdown', sh: 'bash', bash: 'bash',
      zsh: 'bash', ps1: 'powershell', dockerfile: 'docker',
      vue: 'vue', svelte: 'svelte', astro: 'astro',
      prisma: 'prisma', graphql: 'graphql', gql: 'graphql',
      toml: 'toml', ini: 'ini', env: 'bash',
    };
    return langMap[ext] || ext || 'plaintext';
  };

  const handleFileUpload = async (file: File) => {
    setUploadLoading(true);
    try {
      const content = await file.text();
      const language = detectLanguage(file.name);

      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          filePath: file.name,
          content,
          language,
        }),
      });

      if (!res.ok) throw new Error('Upload failed');
      const newFile = await res.json();
      setFiles((prev) => [...prev, newFile]);
      setActiveFile(newFile);
      setShowUploadModal(false);
    } catch (err) {
      console.error('Upload error:', err);
      alert('Failed to upload file');
    } finally {
      setUploadLoading(false);
    }
  };

  const handlePasteSubmit = async () => {
    if (!pasteContent.trim() || !pasteFileName.trim()) return;
    setUploadLoading(true);
    try {
      const language = detectLanguage(pasteFileName);

      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          filePath: pasteFileName,
          content: pasteContent,
          language,
        }),
      });

      if (!res.ok) throw new Error('Upload failed');
      const newFile = await res.json();
      setFiles((prev) => [...prev, newFile]);
      setActiveFile(newFile);
      setShowUploadModal(false);
      setPasteContent('');
      setPasteFileName('');
    } catch (err) {
      console.error('Paste error:', err);
      alert('Failed to save file');
    } finally {
      setUploadLoading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  if (!user) return null;
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
                className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-1 text-xs"
                style={{ borderLeft: `2px solid ${p.color}` }}
              >
                <span>{p.name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerAIReview}
            disabled={aiLoading}
            className="rounded-lg bg-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {aiLoading ? "Analyzing..." : "AI Review"}
          </button>
        </div>
      </div>

      {/* AI review progress — one chip per agent, updated as each completes */}
      {review && (
        <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-400">AI Review</span>
            {Object.entries(review.agents).map(([agent, state]) => (
              <span
                key={agent}
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
            {review.summary && <span className="text-slate-400">{review.summary}</span>}
            {review.failed && <span className="text-red-400">Review failed</span>}
            {review.engine === "heuristic-fallback" && (
              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-400">
                AI service unreachable — heuristic scan only
              </span>
            )}
            <button
              onClick={() => setReview(null)}
              className="ml-auto text-slate-500 hover:text-slate-300"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* File sidebar */}
        <div className="w-64 border-r border-slate-800 overflow-y-auto">
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">Files</h3>
            <button
              onClick={() => setShowUploadModal(true)}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-emerald-400 hover:bg-slate-700"
            >
              + Add
            </button>
          </div>
          {files.map((file) => (
            <button
              key={file.id}
              onClick={() => setActiveFile(file)}
              className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                activeFile?.id === file.id
                  ? "bg-slate-800 text-emerald-400"
                  : "text-slate-300 hover:bg-slate-800/50"
              }`}
            >
              {file.filePath.split("/").pop()}
            </button>
          ))}
          {files.length === 0 && (
            <div className="rounded border border-dashed border-slate-700 p-4 text-center">
              <p className="text-sm text-slate-500">No files yet</p>
              <button
                onClick={() => setShowUploadModal(true)}
                className="mt-2 text-sm text-emerald-400 hover:text-emerald-300"
              >
                Upload or paste code
              </button>
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
              <label className="mt-2 inline-block cursor-pointer rounded bg-slate-800 px-4 py-2 text-sm text-emerald-400 hover:bg-slate-700">
                Browse files
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
                  accept=".js,.ts,.tsx,.jsx,.py,.java,.go,.rs,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.scala,.r,.sql,.html,.css,.scss,.sass,.less,.json,.xml,.yaml,.md,.sh,.bash,.zsh,.ps1,.dockerfile,.vue,.svelte,.astro,.prisma,.graphql,.gql,.toml,.ini,.env"
                />
              </label>
            </div>

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
