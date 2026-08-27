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

import fs from "node:fs";
import path from "node:path";
import { assertInterop, interopStatus } from "../shared/wsl.js";

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
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export interface FileOpener {
  /** Opens `realPath` in the Windows default app. Throws on failure. */
  open(realPath: string): Promise<void>;
  /**
   * Opens Windows Explorer on `realPath`'s PARENT folder with the file
   * selected ("show in folder"). Never opens or runs the file itself, which
   * is why the API route behind this needs no allowlist — revealing an
   * agent-written .bat is as inert as listing its directory.
   */
  reveal(realPath: string): Promise<void>;
}

/**
 * Builds the opener, or null when this hub is not running under WSL (no Windows
 * side to open anything on — callers report that clearly, like openTerminal).
 */
export function createWindowsFileOpener(deps: {
  exec: ExecCapture;
  distro?: string;
  /** Interop probe; injectable so tests do not depend on the host's binfmt. */
  interop?: () => void;
}): FileOpener | null {
  const distro = deps.distro ?? process.env.WSL_DISTRO_NAME;
  if (!distro) return null;

  // A Windows program cannot read "/home/…"; wslpath turns it into the
  // \\wsl$\<distro>\home\… UNC form the shell understands.
  async function toWindowsPath(realPath: string): Promise<string> {
    const { stdout } = await deps.exec("wslpath", ["-w", realPath]);
    const win = stdout.trim();
    if (win === "") throw new Error(`wslpath gave no Windows path for ${realPath}`);
    return win;
  }

  /**
   * Explorer opens the window BEHIND whatever has focus: Windows refuses the
   * foreground to a process that did not get it from a user gesture, and our
   * caller is a background hub. The window then sits behind the browser and
   * the operator concludes the button is broken (it was "opening" 13 windows
   * he never saw). Releasing the foreground lock the documented way — a
   * synthetic ALT keypress around SetForegroundWindow — is what every launcher
   * does. Best-effort: a failure here just leaves the window where it was.
   */
  async function raiseWindow(winPath: string): Promise<void> {
    const ps = [
      "Add-Type @'",
      "using System;using System.Runtime.InteropServices;",
      "public class SbFg {",
      ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
      ' [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, IntPtr e);',
      "}",
      "'@ -EA SilentlyContinue",
      // The path is EMBEDDED, not passed as an environment variable: a Linux
      // env var does not reach a Windows process unless it is listed in
      // WSLENV, so the first version handed PowerShell an empty target and
      // quietly raised nothing. Single-quoted PS literal, quotes doubled.
      `$t = '${winPath.replace(/'/g, "''")}'`,
      "$sh = New-Object -ComObject Shell.Application",
      "$w = $sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $t } catch { $false } } | Select-Object -Last 1",
      "if ($w) { $h=[IntPtr]$w.HWND;",
      " [SbFg]::keybd_event(0x12,0,0,[IntPtr]::Zero);",
      " [void][SbFg]::ShowWindow($h,9); [void][SbFg]::SetForegroundWindow($h);",
      " [SbFg]::keybd_event(0x12,0,2,[IntPtr]::Zero) }",
    ].join("\n");
    // -EncodedCommand, not -Command: this script is multi-line and carries a
    // here-string, and passing that as one argv through execFile → cmd → PS
    // mangles it silently (it "succeeds" and does nothing — exactly what the
    // first attempt did). Base64 of UTF-16LE is the one form nothing rewrites.
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    await deps.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      cwd: "/mnt/c",
    });
  }

  async function runExplorer(arg: string): Promise<void> {
    // cwd /mnt/c: Windows executables warn (and misbehave) when started from
    // a \\wsl$ UNC working directory — same reason as the terminal opener.
    const opts = { cwd: "/mnt/c" };
    try {
      await deps.exec("explorer.exe", [arg], opts);
    } catch (err) {
      // explorer.exe exits NON-ZERO even when it opened the file — a
      // long-standing Windows quirk — so its exit code says nothing. Only a
      // spawn failure is real, and it has two known causes.
      const code = (err as NodeJS.ErrnoException).code;
      // (1) A hub booted from a bare environment has no /mnt/c/... on PATH.
      //     Explorer's location is fixed on every install, so try it there.
      if (code === "ENOENT") {
        await deps.exec("/mnt/c/Windows/explorer.exe", [arg], opts);
        return;
      }
      // (2) The distro cannot run .exe files AT ALL — no WSLInterop in
      //     binfmt_misc, which is how an imported distro often comes up. The
      //     old code returned quietly here, so the hub logged "opened project
      //     folder" and answered ok while nothing whatsoever had happened
      //     (27/08, after moving PCs). Say what is wrong and how to fix it.
      if (code === "ENOEXEC" || /exec format error/i.test(String((err as Error).message))) {
        const status = interopStatus();
        throw new Error(
          status.reason ??
            "This WSL distro cannot run Windows programs (Exec format error from explorer.exe).",
        );
      }
      return; // any other non-zero exit is Explorer's usual noise
    }
  }

  return {
    async open(realPath: string): Promise<void> {
      (deps.interop ?? assertInterop)(); // one clear sentence beats an "Exec format error"
      const win = await toWindowsPath(realPath);
      await runExplorer(win);
      // Only a FOLDER gets raised: a file handed to its default app owns its
      // own window, and stealing focus from a video player is not our call.
      try {
        if (fs.statSync(realPath).isDirectory()) {
          await new Promise((r) => setTimeout(r, 600)); // let Explorer create it
          await raiseWindow(win);
        }
      } catch {
        /* best-effort: the window is open either way */
      }
    },
    async reveal(realPath: string): Promise<void> {
      // `/select,<path>` is ONE argv token (Explorer's own comma syntax):
      // Explorer opens the parent folder and highlights the entry.
      const win = await toWindowsPath(realPath);
      await runExplorer(`/select,${win}`);
      await new Promise((r) => setTimeout(r, 600));
      await raiseWindow(win.replace(/\\[^\\]+$/, "")).catch(() => {});
    },
  };
}
