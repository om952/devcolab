/**
 * Client-side filtering and batching for folder imports.
 *
 * A real project folder is mostly things nobody wants to review — dependencies,
 * build output, binaries, lockfiles. Filtering in the browser means they are
 * never read off disk or put on the wire in the first place.
 */

/** Mirrors MAX_CODE_FILE_BYTES on collab-server; the server rejects past this. */
export const MAX_FILE_BYTES = 512 * 1024;

/** Guard against someone selecting their home directory by mistake. */
export const MAX_TOTAL_FILES = 500;

/** Batch budget — stays under the server's 2 MB JSON body limit. */
const MAX_BATCH_FILES = 40;
const MAX_BATCH_BYTES = 1_000_000;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out",
  "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", "target", "vendor", "coverage", ".cache", ".turbo", ".parcel-cache",
  ".idea", ".vscode", ".gradle", ".terraform", "bin", "obj", "Pods",
  ".svelte-kit", ".output", ".vercel", ".serverless", "site-packages",
]);

const SKIP_EXTS = new Set([
  // images / media
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd",
  "mp3", "mp4", "wav", "avi", "mov", "mkv", "webm", "flac", "ogg",
  // fonts
  "woff", "woff2", "ttf", "eot", "otf",
  // archives / binaries
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "jar", "war", "exe", "dll",
  "so", "dylib", "bin", "dat", "class", "pyc", "pyo", "o", "a", "obj", "wasm",
  // documents / data blobs
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "db", "sqlite", "sqlite3", "mdb", "pack", "idx",
]);

const SKIP_NAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock",
  ".DS_Store", "Thumbs.db",
]);

/** Templates are safe to share; the real thing is not. */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

/**
 * Secret-bearing files must never be uploaded — review content is sent to a
 * third-party LLM, so an imported `.env` would leak live credentials.
 */
function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();

  if (lower === ".env" || lower.startsWith(".env.")) {
    return !ENV_TEMPLATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  }

  return (
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx") ||
    lower.endsWith(".keystore") ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === "credentials" ||
    lower === ".netrc"
  );
}

export interface SkipReason {
  path: string;
  reason: string;
}

/** Why this path should not be uploaded, or null to keep it. */
export function skipReason(relativePath: string, sizeBytes: number): string | null {
  const segments = relativePath.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";

  // Ignore the first segment: the browser prefixes it with the chosen folder's
  // own name, which may legitimately be called "build" or "dist".
  if (segments.slice(1, -1).some((segment) => SKIP_DIRS.has(segment))) {
    return "dependency or build directory";
  }
  if (SKIP_NAMES.has(name)) return "lockfile or system file";
  if (isSecretFile(name)) return "may contain secrets";

  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (SKIP_EXTS.has(ext)) return "binary or media file";

  if (sizeBytes > MAX_FILE_BYTES) return "larger than 512 KB";
  if (sizeBytes === 0) return "empty file";

  return null;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  go: "go", rs: "rust", rb: "ruby", php: "php", cs: "csharp", swift: "swift",
  kt: "kotlin", kts: "kotlin", scala: "scala", r: "r", sql: "sql",
  html: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  md: "markdown", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  dockerfile: "docker", vue: "vue", svelte: "svelte", astro: "astro",
  prisma: "prisma", graphql: "graphql", gql: "graphql", env: "bash",
};

export function detectLanguage(fileName: string): string {
  const name = fileName.split("/").pop() ?? fileName;
  if (name.toLowerCase().startsWith("dockerfile")) return "docker";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANGUAGE_BY_EXT[ext] || ext || "plaintext";
}

export interface UploadFile {
  filePath: string;
  content: string;
  language: string;
}

/**
 * Split files into request-sized batches, bounded by both count and payload
 * size — a handful of large files can blow the body limit well before the
 * count limit is reached.
 */
export function chunkFiles(files: UploadFile[]): UploadFile[][] {
  const batches: UploadFile[][] = [];
  let current: UploadFile[] = [];
  let bytes = 0;

  for (const file of files) {
    const size = file.content.length;
    if (current.length > 0 && (current.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
