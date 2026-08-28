"use client";

import { useMemo } from "react";
import Prism from "prismjs";

// Language grammars. Order matters: Prism components extend earlier ones, so a
// dependency must be imported before whatever builds on it.
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-scala";
import "prismjs/components/prism-r";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-sass";
import "prismjs/components/prism-less";

interface CursorMarker {
  userId?: string;
  userName?: string;
  color?: string;
  line?: number;
}

interface CodeViewerProps {
  code: string;
  language?: string;
  selectedLine?: number | null;
  onLineClick?: (lineIndex: number) => void;
  onLineHover?: (lineIndex: number) => void;
  lineComments?: Record<number, any[]>;
  cursors?: CursorMarker[];
}

/** Our detected language ids mapped onto Prism's grammar names. */
const PRISM_ALIASES: Record<string, string> = {
  html: "markup",
  xml: "markup",
  vue: "markup",
  svelte: "markup",
  astro: "markup",
  prisma: "clike",
  shell: "bash",
  zsh: "bash",
  dockerfile: "docker",
};

/** One contiguous run of characters sharing a highlight class. */
interface Piece {
  text: string;
  className: string;
}

/**
 * Flatten Prism's nested token tree into a flat list of styled runs.
 *
 * Prism nests tokens (a template string containing an interpolation containing
 * a keyword), and each level contributes a class, so classes accumulate down
 * the tree.
 */
function flattenTokens(tokens: (string | Prism.Token)[], inherited = ""): Piece[] {
  const pieces: Piece[] = [];

  for (const token of tokens) {
    if (typeof token === "string") {
      pieces.push({ text: token, className: inherited });
      continue;
    }

    const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
    const className = ["token", token.type, ...aliases, inherited].filter(Boolean).join(" ");

    if (typeof token.content === "string") {
      pieces.push({ text: token.content, className });
    } else if (Array.isArray(token.content)) {
      pieces.push(...flattenTokens(token.content, className));
    } else {
      pieces.push(...flattenTokens([token.content], className));
    }
  }

  return pieces;
}

/**
 * Regroup styled runs into one array per source line.
 *
 * Highlighting runs over the whole file rather than line by line, because
 * constructs like block comments and template literals span lines and cannot
 * be tokenised correctly in isolation. Splitting afterwards keeps each line
 * individually clickable for comments and cursors.
 */
function splitIntoLines(pieces: Piece[]): Piece[][] {
  const lines: Piece[][] = [[]];

  for (const piece of pieces) {
    const segments = piece.text.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) lines.push([]);
      if (segment) lines[lines.length - 1].push({ text: segment, className: piece.className });
    });
  }

  return lines;
}

function highlight(code: string, language?: string): Piece[][] {
  const name = (language || "").toLowerCase();
  const grammarName = PRISM_ALIASES[name] ?? name;
  const grammar = Prism.languages[grammarName];

  // Unknown language (or plain text): render verbatim rather than guessing.
  if (!grammar) {
    return code.split("\n").map((line) => (line ? [{ text: line, className: "" }] : []));
  }

  return splitIntoLines(flattenTokens(Prism.tokenize(code, grammar)));
}

export default function CodeViewer({
  code,
  language,
  selectedLine,
  onLineClick,
  onLineHover,
  lineComments = {},
  cursors = [],
}: CodeViewerProps) {
  const lines = useMemo(() => highlight(code, language), [code, language]);

  return (
    <div className="rounded-lg bg-slate-900 ring-1 ring-slate-800 overflow-hidden">
      <div className="flex">
        {/* Line numbers */}
        <div className="select-none border-r border-slate-800 bg-slate-900/50 py-4 pr-3 text-right">
          {lines.map((_, i) => (
            <div
              key={`num-${i}`}
              onClick={() => onLineClick?.(i)}
              className={`cursor-pointer px-3 text-xs leading-6 ${
                selectedLine === i ? "bg-emerald-500/10 text-emerald-400" : "text-slate-600"
              }`}
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

        {/* Code. Rendered as React elements rather than raw HTML, so neither a
            display name nor file contents can inject markup. */}
        <div className="flex-1 overflow-auto py-4">
          <pre className="!m-0 !bg-transparent !p-0">
            <code className="block font-mono text-sm text-slate-300">
              {lines.map((pieces, i) => {
                const lineCursors = cursors.filter((cursor) => cursor.line === i + 1);

                return (
                  <div
                    key={`line-${i}`}
                    data-line={i}
                    onClick={() => onLineClick?.(i)}
                    onMouseEnter={() => onLineHover?.(i)}
                    className={`relative px-4 leading-6 ${
                      selectedLine === i ? "bg-emerald-500/10" : ""
                    }`}
                  >
                    {lineCursors.map((cursor, index) => (
                      <span
                        key={`cursor-${cursor.userId ?? index}`}
                        title={cursor.userName}
                        style={{ backgroundColor: cursor.color }}
                        className="absolute left-0 top-0 h-full w-0.5"
                      />
                    ))}

                    {pieces.length > 0 ? (
                      pieces.map((piece, index) => (
                        <span key={index} className={piece.className || undefined}>
                          {piece.text}
                        </span>
                      ))
                    ) : (
                      // Keep empty lines selectable and correctly spaced.
                      <span>{" "}</span>
                    )}
                  </div>
                );
              })}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}
