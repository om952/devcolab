"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth-context";

type Provider = "gemini" | "groq";

export interface LlmKeyStatus {
  configured: boolean;
  provider?: Provider;
  expiresAt?: string;
}

const PROVIDERS: { value: Provider; label: string; placeholder: string; getKeyUrl: string }[] = [
  {
    value: "gemini",
    label: "Gemini",
    placeholder: "AIza…",
    getKeyUrl: "https://aistudio.google.com/apikey",
  },
  {
    value: "groq",
    label: "Groq",
    placeholder: "gsk_…",
    getKeyUrl: "https://console.groq.com/keys",
  },
];

const labelFor = (provider?: Provider) => PROVIDERS.find((p) => p.value === provider)?.label ?? "AI";

/**
 * Where a user brings their own LLM key. Reviews run on it; there is no shared
 * key to fall back to.
 *
 * The key goes to the server once and is never sent back: this component only
 * ever learns which provider is set.
 */
export default function LlmKeyPanel({
  open,
  onOpenChange,
  status,
  onStatusChange,
  prompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: LlmKeyStatus | null;
  onStatusChange: (status: LlmKeyStatus) => void;
  /** Why the panel was opened for the user, e.g. a review that needed a key. */
  prompt?: string | null;
}) {
  const { apiFetch } = useAuth();
  const [provider, setProvider] = useState<Provider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never keep a typed key around longer than the panel is open.
  useEffect(() => {
    if (!open) {
      setApiKey("");
      setError(null);
    } else if (status?.provider) {
      setProvider(status.provider);
    }
  }, [open, status?.provider]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/llm-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save the key");
      setApiKey("");
      onStatusChange(data);
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/llm-key", { method: "DELETE" });
      onStatusChange({ configured: false });
    } finally {
      setSaving(false);
    }
  };

  const current = PROVIDERS.find((p) => p.value === provider)!;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ${
          status?.configured
            ? "text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/10"
            : "text-amber-300 ring-amber-500/40 hover:bg-amber-500/10"
        }`}
      >
        {status?.configured ? `Using your ${labelFor(status.provider)} key` : "Add AI key"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your AI key"
          className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm shadow-xl"
        >
          {prompt && <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-amber-200">{prompt}</p>}

          <form onSubmit={save} className="space-y-3">
            <div className="flex gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setProvider(p.value)}
                  aria-pressed={provider === p.value}
                  className={`flex-1 rounded-lg px-3 py-1.5 ring-1 ${
                    provider === p.value
                      ? "bg-violet-500/20 text-violet-200 ring-violet-500/50"
                      : "text-slate-400 ring-slate-700 hover:text-slate-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`${current.label} API key (${current.placeholder})`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded-lg bg-slate-800 px-3 py-2 outline-none ring-1 ring-slate-700 focus:ring-violet-500"
              required
            />

            {error && <p className="text-red-400">{error}</p>}

            <div className="flex items-center justify-between">
              <a
                href={current.getKeyUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-violet-300 hover:underline"
              >
                Get a {current.label} key
              </a>
              <button
                type="submit"
                disabled={saving || !apiKey.trim()}
                className="rounded-lg bg-violet-500 px-3 py-1.5 font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {saving ? "Checking…" : "Save key"}
              </button>
            </div>
          </form>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Held in server memory only — never saved to a database or shown again. It is forgotten when you log
            out, after 8 hours, or if the server restarts (free hosting sleeps when idle), and you will be asked for
            it again.
          </p>

          {status?.configured && (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="mt-3 text-xs text-red-300 hover:underline disabled:opacity-50"
            >
              Remove my key
            </button>
          )}
        </div>
      )}
    </div>
  );
}
