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

import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Marker the script prints when the user closes the dialog with Cancel. */
export const PICK_CANCELLED = "<<switchboard-cancelled>>";

/**
 * Where PowerShell 7 installs itself. Worth looking for by hand: it is not on
 * the PATH of a WSL shell unless the user put it there, and it is the whole
 * difference between the two dialogs below.
 */
export const PWSH_PATHS = [
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  "/mnt/c/Program Files/PowerShell/6/pwsh.exe",
];

/**
 * Picks the PowerShell to run the dialog with, and it decides which DIALOG the
 * user gets — the same FolderBrowserDialog class renders very differently:
 *
 *   - powershell.exe is 5.1 on .NET Framework, whose FolderBrowserDialog is the
 *     Windows-XP-era "Browse For Folder" tree. It opens on the Desktop showing
 *     OneDrive and Libraries, and it will NOT navigate to a \\wsl$\… path — so
 *     the folders the user actually wants are several clicks away, if they find
 *     them at all;
 *   - pwsh is PowerShell 7 on modern .NET, where the same class is the Vista+
 *     IFileDialog: the Windows 11 dialog, with a path bar, the distro in the
 *     sidebar, and UNC paths it can open on.
 *
 * So pwsh when it exists, powershell.exe when it does not — the old dialog beats
 * no dialog, and the caller can always fall back to the in-page browser.
 */
export function findPowerShell(exists: (p: string) => boolean = fs.existsSync): string {
  return PWSH_PATHS.find(exists) ?? "powershell.exe";
}

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
    // Modern .NET only, and harmless on 5.1 (guarded): it promotes Description
    // from a label above the tree to the dialog's actual title.
    "if ($dialog.PSObject.Properties['UseDescriptionForTitle']) { $dialog.UseDescriptionForTitle = $true }",
    "$dialog.ShowNewFolderButton = $false",
    // Start on the agent's own world. The modern dialog opens right here; the
    // legacy one ignores UNC and lands on the Desktop, which is one more reason
    // findPowerShell prefers pwsh.
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
  /** Which PowerShell to run (default: pwsh if installed — see findPowerShell). */
  shell?: string;
  /** The hub's home directory, where browsing starts (default: os.homedir()). */
  homeDir?: string;
}

/**
 * Windows spelling of a path inside the distro: /home/rod → \\wsl$\Ubuntu\home\rod.
 * Used only to choose where the dialog OPENS; whatever comes back goes through
 * wslpath, so this never has to be exact about anything else.
 */
export function toWslUnc(distro: string, dir: string): string {
  return `\\\\wsl$\\${distro}${dir.replace(/\//g, "\\")}`;
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

  // Where to open: whatever the form already points at, else the operator's own
  // home INSIDE the distro — that is where the projects are. Not \\wsl$\<distro>
  // root, which would make them walk down to home themselves.
  //
  // The form holds WSL paths ("/home/rod/projects"), and SelectedPath only
  // speaks Windows, so a POSIX one is translated here. Without this, "resume
  // where you were" would hand the dialog a path Windows cannot resolve and it
  // would open wherever it liked.
  const requested = startIn ?? (deps.homeDir ?? os.homedir());
  const script = pickFolderScript(
    requested.startsWith("/") ? toWslUnc(distro, requested) : requested,
  );
  const shell = deps.shell ?? findPowerShell();

  let stdout: string;
  try {
    // -STA is required by Windows Forms on 5.1 and accepted by pwsh, which is
    // STA already — one argv serves both.
    ({ stdout } = await exec(shell, ["-NoProfile", "-STA", "-Command", script]));
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `${shell} was not found — the native dialog needs Windows interop.`
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
