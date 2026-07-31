// File preview (owner-approved feature, inspired by claudinei): agents name
// absolute paths in their messages all the time ("wrote /home/rod/x/SKILL.md"),
// so the dashboard makes those paths clickable and shows the file inline.
//
// The security decision is the whole point (PRD rule: local security >
// convenience). The operator is already trusted — localhost, and they launch
// agents in any directory — but a message body is UNTRUSTED: a compromised or
// hallucinating agent could plant "/etc/shadow" hoping the operator clicks it.
// So reads are SCOPED to a set of allowed roots (the agents' working dirs and
// the operator's home), and the path is resolved with realpath BEFORE the check
// so `..` and symlinks cannot escape the scope. Anything outside is refused with
// a clear reason, never read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PreviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

/** Above this nothing is READ: a preview is a glance, not a download. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** "toolarge": a real file, over the cap — shown as such, never read. */
export type PreviewKind = "image" | "markdown" | "code" | "text" | "pdf" | "binary" | "toolarge";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
// Not exhaustive, and it does not need to be: anything not matched falls back to
// "text" and is shown as-is. This only tunes how the modal renders.
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".rb", ".go",
  ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash",
  ".zsh", ".fish", ".sql", ".html", ".css", ".scss", ".yaml", ".yml", ".toml",
  ".ini", ".xml", ".lua", ".swift", ".kt", ".dart", ".vue", ".svelte",
]);

/** Best-guess file kind from the extension. Drives how the modal renders. */
export function kindOfPath(filePath: string): PreviewKind {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (CODE_EXT.has(ext)) return "code";
  return "text";
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Content-Type map for GET /api/files/raw — the "open in your browser" door.
 * The browser decides how to SHOW a file purely by this header (the route
 * sets nosniff), so the map names what a tab genuinely renders: html as the
 * site, images at full size, PDF in the built-in viewer, media in the player.
 * Markdown is served as plain text — a tab cannot render it, and pretending
 * (text/html) would show garbage. Anything unknown is octet-stream, which
 * downloads instead of rendering: still a door, never a surprise.
 */
const RAW_MIME: Record<string, string> = {
  ...IMAGE_MIME,
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/** Content-Type for the raw route. Octet-stream when the tab cannot render it. */
export function rawMime(filePath: string): string {
  return RAW_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Expands a leading "~" to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolves `rawPath` and proves it sits inside one of `allowedRoots`, or
 * throws PreviewError. The realpath (which collapses `..` and follows symlinks)
 * is what gets scope-checked, so neither trick escapes. Non-existent paths and
 * directories are rejected here too — there is nothing to preview.
 *
 * `allowedRoots` are themselves realpath-normalized so a symlinked home
 * (common on macOS: /var → /private/var) still matches.
 *
 * This is the SCOPE gate and nothing else. The size cap deliberately lives in
 * readPreview: "too big to show" is a preview policy about reading bytes, not a
 * statement that the file is off-limits. Enforcing it here once meant a 9 MB
 * video was refused outright — so the one thing you CAN do with it (open it in
 * a system app, which reads nothing) was refused along with the preview.
 */
export function resolveInScope(rawPath: string, allowedRoots: string[]): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new PreviewError("No file path given.");
  }
  const abs = path.resolve(expandHome(rawPath.trim()));

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new PreviewError(`File not found: ${abs}`, 404);
  }

  const roots = allowedRoots
    .map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return null;
      }
    })
    .filter((r): r is string => r !== null);

  const inScope = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!inScope) {
    throw new PreviewError(
      `Outside the preview scope: "${abs}". Switchboard only previews files under an ` +
        `agent's working directory or your home folder — a message can name any path, so it ` +
        `refuses the rest.`,
      403,
    );
  }

  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    throw new PreviewError(`That is a directory, not a file: ${abs}`);
  }
  return real;
}

export interface PreviewResult {
  kind: PreviewKind;
  name: string;
  path: string;
  size: number;
  /** text/markdown/code: the file's text. image: a data: URL. pdf/binary: null. */
  content: string | null;
}

/**
 * Reads a scope-resolved file into a preview payload. Text kinds come back as
 * UTF-8; images as a data: URL; a file whose bytes are not valid text is
 * downgraded to "binary" so the modal says so instead of printing mojibake.
 *
 * Over the cap the file is NOT read — it comes back as "toolarge", which is a
 * fact about this view, not about the file: the caller may still offer to open
 * it in a system app.
 */
export function readPreview(realPath: string): PreviewResult {
  const kind = kindOfPath(realPath);
  const name = path.basename(realPath);
  const size = fs.statSync(realPath).size;
  const base = { name, path: realPath, size };

  // Checked BEFORE the read, which is the whole point of a cap.
  if (size > MAX_PREVIEW_BYTES) {
    return { ...base, kind: "toolarge", content: null };
  }
  const buf = fs.readFileSync(realPath);

  if (kind === "image") {
    const mime = IMAGE_MIME[path.extname(realPath).toLowerCase()] ?? "application/octet-stream";
    return { ...base, kind, content: `data:${mime};base64,${buf.toString("base64")}` };
  }
  if (kind === "pdf") {
    return { ...base, kind, content: null };
  }
  // Text-ish. A NUL byte means it is really binary despite the extension.
  if (buf.includes(0)) {
    return { ...base, kind: "binary", content: null };
  }
  return { ...base, kind, content: buf.toString("utf8") };
}
