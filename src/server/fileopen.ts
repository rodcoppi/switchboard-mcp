// Hand a file to the Windows default app, for the things the dashboard cannot
// render itself. filepreview.ts renders text/code/markdown/images and gives a
// PDF or a binary a placeholder — so a video, an archive or a PDF has nowhere
// to go. This is that door: the operator clicks "open" and Windows opens it.
//
// SECURITY — this is a SHARPER tool than a preview, and it is built on the same
// premise (filepreview.ts): a message body is UNTRUSTED. A preview only ever
// READS bytes; the Windows shell EXECUTES what it is handed, so "open the path
// an agent typed" would otherwise mean "run the .bat an agent wrote". Two gates,
// BOTH required, and the caller must apply them in order:
//
//   1. resolveInScope (filepreview.ts) — the file sits under an agent's working
//      dir or the operator's home, realpath'd so `..` and symlinks cannot
//      escape.
//   2. isOpenable — an ALLOWLIST of inert media/document types. A denylist is
//      the wrong shape here: the risk is the extension nobody thought of, so the
//      default has to be REFUSE. Nothing executable or scriptable is on the list
//      (no .exe/.bat/.cmd/.ps1/.msi/.vbs/.lnk/.reg/.sh/.jar), and neither are
//      the macro-enabled Office twins (.docm/.xlsm/.pptm) — a macro is a script
//      wearing a document's extension.
//
// The size cap that guards previews (MAX_PREVIEW_BYTES) deliberately does NOT
// apply: nothing is read into the hub here. The path is handed to Windows and
// the bytes never touch this process, so a 200 MB video opens fine — which is
// the whole reason this exists.

import path from "node:path";

/**
 * Extensions the hub will hand to the Windows shell. Inert content only: things
 * that get VIEWED or PLAYED, never run. See the security note above before
 * adding to this — the question is not "is this useful" but "can this execute".
 */
export const OPENABLE_EXT = new Set([
  // video — the reason this exists (the dashboard cannot play one)
  ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv",
  // audio
  ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".oga", ".aac", ".opus", ".wma",
  // images (previewable inline too, but a real viewer zooms)
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
  // documents
  ".pdf", ".txt", ".md", ".markdown", ".csv", ".rtf", ".epub",
  // office, macro-free only
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
  // archives (Explorer shows these as a folder)
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz",
]);

/** Whether the hub may hand this path to the Windows shell. Allowlist only. */
export function isOpenable(filePath: string): boolean {
  return OPENABLE_EXT.has(path.extname(filePath).toLowerCase());
}

/** The reason given when the allowlist refuses — written for the operator. */
export function refusalFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return (
    `Switchboard will not open "${ext || "a file with no extension"}" in a system app. ` +
    `Windows RUNS what it opens, and a file path can come from an agent's message — ` +
    `so only inert media and documents (video, audio, images, PDF, office, archives) ` +
    `are handed over. Open it yourself if you meant to.`
  );
}

/** execFile that hands back stdout — wslpath's answer is the whole point. */
export type ExecCapture = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string }>;

export interface FileOpener {
  /** Opens `realPath` in the Windows default app. Throws on failure. */
  open(realPath: string): Promise<void>;
}

/**
 * Builds the opener, or null when this hub is not running under WSL (no Windows
 * side to open anything on — callers report that clearly, like openTerminal).
 */
export function createWindowsFileOpener(deps: {
  exec: ExecCapture;
  distro?: string;
}): FileOpener | null {
  const distro = deps.distro ?? process.env.WSL_DISTRO_NAME;
  if (!distro) return null;
  return {
    async open(realPath: string): Promise<void> {
      // A Windows program cannot read "/home/…"; wslpath turns it into the
      // \\wsl$\<distro>\home\… UNC form the shell understands.
      const { stdout } = await deps.exec("wslpath", ["-w", realPath]);
      const win = stdout.trim();
      if (win === "") throw new Error(`wslpath gave no Windows path for ${realPath}`);
      // cwd /mnt/c: Windows executables warn (and misbehave) when started from
      // a \\wsl$ UNC working directory — same reason as the terminal opener.
      const opts = { cwd: "/mnt/c" };
      try {
        await deps.exec("explorer.exe", [win], opts);
      } catch (err) {
        // explorer.exe exits NON-ZERO even when it opened the file — a
        // long-standing Windows quirk — so its exit code says nothing. Only a
        // spawn failure is real, and it has one known cause: a hub booted from
        // a bare environment has no /mnt/c/... on PATH (the same report that
        // shaped the terminal opener). Its location is fixed on every install.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
        await deps.exec("/mnt/c/Windows/explorer.exe", [win], opts);
      }
    },
  };
}
