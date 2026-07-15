// The native Windows "choose a folder" dialog, opened from inside WSL.
//
// Why the hub opens it and not the page: no browser hands a web page the
// absolute path of a folder. showDirectoryPicker() yields a handle, and
// <input webkitdirectory> yields names relative to the chosen folder — the one
// thing the launcher needs (an absolute path) is exactly what the sandbox
// withholds. So the dialog is opened Windows-side by the hub, which may read
// the path it returns.
//
// Same interop the terminal opener already relies on (launcher.ts): the hub
// runs in WSL, powershell.exe runs on the Windows side with a real desktop.
// The path comes back in Windows form (`\\wsl$\Ubuntu\home\…` for a folder
// inside the distro, `C:\…` for one on Windows) and wslpath converts it —
// normalizeIncomingPath in launcher.ts accepts both shapes anyway.
//
// This degrades, it never breaks: outside WSL, or with powershell.exe missing,
// the caller falls back to the dashboard's own folder browser.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Marker the script prints when the user closes the dialog with Cancel. */
export const PICK_CANCELLED = "<<switchboard-cancelled>>";

/**
 * The PowerShell that shows the dialog (pure — unit-tested).
 *
 * Two details are load-bearing:
 *   - the dialog is owned by a TopMost form, or it opens BEHIND the browser the
 *     user just clicked in and looks like nothing happened;
 *   - -STA is required for Windows Forms; without it ShowDialog throws.
 *
 * `startIn` is a Windows path to open on. It is machine-derived (the distro's
 * own \\wsl$ root, or the folder already typed in the form), never free text
 * from the network, and it is embedded in a single-quoted literal with the
 * quotes doubled, so a folder called "Tim O'Brien" cannot end the literal.
 */
export function pickFolderScript(startIn: string): string {
  const quoted = `'${startIn.replace(/'/g, "''")}'`;
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Switchboard — pick the folder the agent works in'",
    "$dialog.ShowNewFolderButton = $false",
    `$dialog.SelectedPath = ${quoted}`,
    // The owner window: TopMost, so the dialog lands in front.
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Dispose()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath } " +
      `else { Write-Output '${PICK_CANCELLED}' }`,
  ].join("; ");
}

export interface PickFolderDeps {
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** WSL distro name (default: the env var WSL sets). */
  distro?: string;
  /** How long to wait for a human to browse before giving up. */
  timeoutMs?: number;
}

export class PickError extends Error {
  constructor(
    message: string,
    /** true when the dashboard should fall back to its own folder browser. */
    readonly unsupported = false,
  ) {
    super(message);
    this.name = "PickError";
  }
}

/**
 * Opens the dialog and resolves to a WSL path, or null when the user cancels.
 *
 * @param startIn Windows path to start browsing at; defaults to the distro root.
 */
export async function pickWindowsFolder(
  startIn?: string,
  deps: PickFolderDeps = {},
): Promise<string | null> {
  const distro = deps.distro ?? process.env.WSL_DISTRO_NAME;
  if (!distro) {
    throw new PickError(
      "The native folder dialog is a Windows + WSL feature (WSL_DISTRO_NAME is not set).",
      true,
    );
  }
  const exec =
    deps.exec ??
    (async (file: string, args: string[]) => {
      const { stdout } = await execFileAsync(file, args, {
        timeout: deps.timeoutMs ?? 180_000,
        maxBuffer: 1024 * 64,
      });
      return { stdout };
    });

  const script = pickFolderScript(startIn ?? `\\\\wsl$\\${distro}\\home`);

  let stdout: string;
  try {
    ({ stdout } = await exec("powershell.exe", ["-NoProfile", "-STA", "-Command", script]));
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "powershell.exe was not found — the native dialog needs Windows interop."
      : `The native folder dialog failed: ${(err as Error).message}`;
    // Either way the caller can still offer its own browser, so this is a
    // fallback signal rather than a dead end.
    throw new PickError(message, true);
  }

  const picked = stdout.replace(/\r?\n/g, "").trim();
  if (picked === "" || picked === PICK_CANCELLED) return null;

  // Windows path → WSL path. A folder inside the distro comes back as
  // \\wsl$\<distro>\… and lands on /home/…; one on the Windows drives becomes
  // /mnt/c/… , which is a real path the agent can be opened in.
  try {
    const { stdout: wsl } = await exec("wslpath", ["-u", picked]);
    return wsl.replace(/\r?\n/g, "").trim();
  } catch {
    throw new PickError(`Could not translate "${picked}" into a WSL path.`);
  }
}
