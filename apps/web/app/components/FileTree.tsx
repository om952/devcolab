"use client";

import { useMemo, useState } from "react";

export interface TreeFile {
  id: string;
  filePath: string;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: TreeFile;
}

function newNode(name: string, path: string): TreeNode {
  return { name, path, children: new Map() };
}

/** Fold a flat list of `a/b/c.ts` paths into a nested directory tree. */
function buildTree(files: TreeFile[]): TreeNode {
  const root = newNode("", "");

  for (const file of files) {
    const segments = file.filePath.split("/").filter(Boolean);
    let node = root;

    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.get(segment);
      if (!child) {
        child = newNode(segment, path);
        node.children.set(segment, child);
      }
      node = child;
    });

    // Only leaves carry a file; a directory never does.
    node.file = file;
  }

  return root;
}

/** Directories first, then alphabetical — the ordering every file explorer uses. */
function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    const aIsDir = a.children.size > 0;
    const bIsDir = b.children.size > 0;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Collapse single-child directory chains into one row (`src/app/lib` instead of
 * three nested rows), which keeps deep project trees readable in a narrow
 * sidebar.
 */
function collapseChain(node: TreeNode): { label: string; node: TreeNode } {
  let label = node.name;
  let current = node;

  while (current.children.size === 1 && !current.file) {
    const only = Array.from(current.children.values())[0];
    if (only.children.size === 0) break; // next hop is a file — stop here
    label += `/${only.name}`;
    current = only;
  }

  return { label, node: current };
}

function Row({
  node,
  depth,
  activeFileId,
  onSelect,
  defaultOpen,
}: {
  node: TreeNode;
  depth: number;
  activeFileId?: string | null;
  onSelect: (file: TreeFile) => void;
  defaultOpen: boolean;
}) {
  const isDir = node.children.size > 0;
  const { label, node: target } = isDir ? collapseChain(node) : { label: node.name, node };
  const [open, setOpen] = useState(defaultOpen);

  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (!isDir) {
    const isActive = node.file?.id === activeFileId;
    return (
      <button
        onClick={() => node.file && onSelect(node.file)}
        style={indent}
        title={node.path}
        className={`flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-sm ${
          isActive ? "bg-slate-800 text-emerald-400" : "text-slate-300 hover:bg-slate-800/50"
        }`}
      >
        <span className="shrink-0 text-slate-600">•</span>
        <span className="truncate">{label}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={indent}
        title={target.path}
        className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-sm text-slate-400 hover:bg-slate-800/50"
      >
        <span className="shrink-0 text-[10px] text-slate-500">{open ? "▼" : "▶"}</span>
        <span className="truncate font-medium">{label}</span>
      </button>

      {open && (
        <div>
          {sortedChildren(target).map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              onSelect={onSelect}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  files,
  activeFileId,
  onSelect,
}: {
  files: TreeFile[];
  activeFileId?: string | null;
  onSelect: (file: TreeFile) => void;
}) {
  const root = useMemo(() => buildTree(files), [files]);
  const children = sortedChildren(root);

  // A small import is more useful expanded; a large one is unreadable that way.
  const defaultOpen = files.length <= 60;

  return (
    <div className="-mx-1">
      {children.map((child) => (
        <Row
          key={child.path}
          node={child}
          depth={0}
          activeFileId={activeFileId}
          onSelect={onSelect}
          defaultOpen={defaultOpen}
        />
      ))}
    </div>
  );
}
