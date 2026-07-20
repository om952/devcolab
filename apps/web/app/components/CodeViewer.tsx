"use client";

import { useRef } from "react";

interface CodeViewerProps {
  code: string;
  language?: string;
  selectedLine?: number | null;
  onLineClick?: (lineIndex: number) => void;
  onLineHover?: (lineIndex: number) => void;
  lineComments?: Record<number, any[]>;
  cursors?: any[];
}

export default function CodeViewer({
  code,
  selectedLine,
  onLineClick,
  onLineHover,
  lineComments = {},
  cursors = [],
}: CodeViewerProps) {
  const lines = code.split("\n");

  // Escape HTML entities to prevent XSS
  const escapeHtml = (text: string): string => {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  };

  // Build HTML line by line with syntax highlighting via simple regex
  const highlightedLines = lines.map((line, i) => {
    const cursorHtml = cursors
      .filter((c) => c.line === i + 1)
      .map(
        (c) =>
          `<div class="absolute left-0 top-0 h-full w-0.5" style="background-color:${c.color}" title="${c.userName}"></div>`
      )
      .join("");

    const selectedClass = selectedLine === i ? "bg-emerald-500/10" : "";
    const escaped = escapeHtml(line || " ");

    // Simple keyword highlighting for common languages
    const highlighted = escaped
      .replace(
        /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof|undefined|null|true|false)\b/g,
        '<span class="text-pink-400">$1</span>'
      )
      .replace(
        /\b(def|class|if|elif|else|for|while|return|import|from|try|except|with|as|pass|break|continue|lambda|yield|raise|assert|del|global|nonlocal|True|False|None)\b/g,
        '<span class="text-pink-400">$1</span>'
      )
      .replace(
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
        '<span class="text-emerald-400">$1</span>'
      )
      .replace(
        /(\/\/.*$|\#.*$)/gm,
        '<span class="text-slate-500">$1</span>'
      )
      .replace(
        /\b(\d+(?:\.\d+)?)\b/g,
        '<span class="text-amber-400">$1</span>'
      );

    return `<div class="relative px-4 leading-6 ${selectedClass}" data-line="${i}">${cursorHtml}${highlighted}</div>`;
  });

  const codeHtml = highlightedLines.join("\n");

  return (
    <div className="rounded-lg bg-slate-900 ring-1 ring-slate-800 overflow-hidden">
      <div className="flex">
        {/* Line numbers */}
        <div className="select-none border-r border-slate-800 bg-slate-900/50 py-4 pr-3 text-right">
          {lines.map((_, i) => (
            <div
              key={`num-${i}`}
              className={`px-3 text-xs leading-6 ${
                selectedLine === i
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "text-slate-600"
              }`}
              onClick={() => onLineClick?.(i)}
            >
              {i + 1}
              {lineComments[i]?.length > 0 && (
                <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">
                  {lineComments[i].length}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Code */}
        <div className="flex-1 overflow-auto py-4">
          <pre className="!m-0 !bg-transparent !p-0">
            <code
              className="block font-mono text-sm text-slate-300"
              dangerouslySetInnerHTML={{ __html: codeHtml }}
              onClick={(e) => {
                const lineEl = (e.target as HTMLElement).closest("[data-line]");
                if (lineEl) {
                  const lineIndex = parseInt(lineEl.getAttribute("data-line") || "0", 10);
                  onLineClick?.(lineIndex);
                }
              }}
              onMouseOver={(e) => {
                const lineEl = (e.target as HTMLElement).closest("[data-line]");
                if (lineEl) {
                  const lineIndex = parseInt(lineEl.getAttribute("data-line") || "0", 10);
                  onLineHover?.(lineIndex);
                }
              }}
            />
          </pre>
        </div>
      </div>
    </div>
  );
}
