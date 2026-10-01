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
import { assertInterop } from "../shared/wsl.js";

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
 * Picks the PowerShell to run the dialogs with: pwsh when it exists,
 * powershell.exe otherwise. It used to decide WHICH folder dialog the user got
 * (FolderBrowserDialog is the XP-era tree on 5.1 and the Windows 11 dialog only
 * on modern .NET); the folder picker now calls the modern dialog itself
 * (PICKER_CS), so either shell shows the same thing and powershell.exe — on
 * every Windows — is no longer the ugly fallback.
 */
export function findPowerShell(exists: (p: string) => boolean = fs.existsSync): string {
  return PWSH_PATHS.find(exists) ?? "powershell.exe";
}

/**
 * C# for the folder dialog, compiled by Add-Type inside the PowerShell that
 * shows it: the Win32 foreground calls, and the Vista+ folder picker
 * (IFileOpenDialog with FOS_PICKFOLDERS) — the Windows 11 dialog with a path
 * bar and the distro in the sidebar.
 *
 * Why not FolderBrowserDialog: on Windows PowerShell 5.1 (.NET Framework) that
 * class is the XP-era "Browse For Folder" tree, which opens on the Desktop and
 * will not navigate to \\wsl$. Only PowerShell 7 renders it as the modern
 * dialog, and PowerShell 7 is not installed on most machines (it was not on the
 * owner's new PC — "pq ta ainda abrindo esse picker de folder tosco?", 01/10).
 * Calling the COM dialog directly gives the modern one on ANY PowerShell.
 *
 * Only the vtable prefix up to GetResult is declared — the methods past it are
 * never called, and a COM interface may be declared short.
 *
 * Kept free of single quotes: it travels inside a single-quoted PowerShell literal.
 */
const PICKER_CS = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class SbPicker {",
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialog { }',
  '[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "private interface IShellItem {",
  "void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);",
  "void GetParent(out IShellItem parent);",
  "void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);",
  "void GetAttributes(uint mask, out uint attribs);",
  "void Compare(IShellItem other, uint hint, out int order);",
  "}",
  '[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "private interface IFileDialog {",
  "[PreserveSig] int Show(IntPtr parent);",
  "void SetFileTypes(uint count, IntPtr specs);",
  "void SetFileTypeIndex(uint index);",
  "void GetFileTypeIndex(out uint index);",
  "void Advise(IntPtr sink, out uint cookie);",
  "void Unadvise(uint cookie);",
  "void SetOptions(uint fos);",
  "void GetOptions(out uint fos);",
  "void SetDefaultFolder(IShellItem item);",
  "void SetFolder(IShellItem item);",
  "void GetFolder(out IShellItem item);",
  "void GetCurrentSelection(out IShellItem item);",
  "void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);",
  "void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);",
  "void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);",
  "void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);",
  "void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);",
  "void GetResult(out IShellItem item);",
  "}",
  '[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]',
  "private static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);",
  // FOS_PICKFOLDERS 0x20 | FOS_FORCEFILESYSTEM 0x40; SIGDN_FILESYSPATH 0x80058000.
  // Show answers ERROR_CANCELLED (not 0) on Cancel, so anything but 0 is "no pick".
  "public static string PickFolder(IntPtr owner, string title, string startIn) {",
  "IFileDialog dialog = (IFileDialog)new FileOpenDialog();",
  "uint fos; dialog.GetOptions(out fos);",
  "dialog.SetOptions(fos | 0x20 | 0x40);",
  "dialog.SetTitle(title);",
  "try { IShellItem start; SHCreateItemFromParsingName(startIn, IntPtr.Zero, typeof(IShellItem).GUID, out start); dialog.SetFolder(start); } catch (Exception) { }",
  "if (dialog.Show(owner) != 0) return null;",
  "IShellItem picked; dialog.GetResult(out picked);",
  "string path; picked.GetDisplayName(0x80058000, out path);",
  "return path;",
  "}",
  "}",
].join(" ");

/**
 * The PowerShell that shows the dialog (pure — unit-tested).
 *
 * The hard part is the FOREGROUND. A process launched from WSL cannot bring its
 * window forward: Windows only lets the process that currently owns the
 * foreground (the browser the user just clicked in) call SetForegroundWindow,
 * so a folder dialog opened from here lands BEHIND Chrome and the user sees
 * nothing. A TopMost owner form that is never shown does not fix it — it has no
 * window to activate.
 *
 * So the owner form is REAL: TopMost, 1×1, off-screen, and actually shown, then
 * forced foreground through the AttachThreadInput trick (attach to the current
 * foreground thread's input queue, which lifts the restriction, then
 * SetForegroundWindow). The modal dialog opens parented to that topmost,
 * foregrounded owner, so it comes up in front. The owner is 1×1 and transparent,
 * so the flash is invisible.
 *
 * The dialog itself is the modern one (PICKER_CS). Should it fail to come up
 * at all, the old FolderBrowserDialog still does — an ugly dialog beats a
 * button that silently does nothing.
 *
 * -STA is required for Windows Forms; without it ShowDialog throws. `startIn` is
 * machine-derived (never network text) and embedded in a single-quoted literal
 * with quotes doubled, so a folder called "Tim O'Brien" cannot end the literal.
 * Output is UTF-8, or "Área de Trabalho" would come back mangled by the console
 * code page.
 */
export function pickFolderScript(startIn: string): string {
  const quoted = `'${startIn.replace(/'/g, "''")}'`;
  const title = "'Switchboard — pick the folder the agent works in'";
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    `Add-Type -TypeDefinition '${PICKER_CS}'`,
    // A REAL topmost owner: 1x1, transparent, off-screen, shown — so it owns a
    // window that can be forced to the front.
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = 'None'",
    "$owner.Opacity = 0",
    "$owner.Size = New-Object System.Drawing.Size(1,1)",
    "$owner.StartPosition = 'Manual'",
    "$owner.Location = New-Object System.Drawing.Point(-32000,-32000)",
    "$owner.Show()",
    // Steal the foreground: attach to whoever holds it now, then claim it.
    "$foreThread = [SbPicker]::GetWindowThreadProcessId([SbPicker]::GetForegroundWindow(), [IntPtr]::Zero)",
    "$thisThread = [SbPicker]::GetCurrentThreadId()",
    "[void][SbPicker]::AttachThreadInput($thisThread, $foreThread, $true)",
    "[void][SbPicker]::BringWindowToTop($owner.Handle)",
    "[void][SbPicker]::SetForegroundWindow($owner.Handle)",
    "[void][SbPicker]::AttachThreadInput($thisThread, $foreThread, $false)",
    "$owner.Activate()",
    "$picked = $null",
    `try { $picked = [SbPicker]::PickFolder($owner.Handle, ${title}, ${quoted}) } catch { ` +
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      `$dialog.Description = ${title}; ` +
      "$dialog.ShowNewFolderButton = $false; " +
      `$dialog.SelectedPath = ${quoted}; ` +
      "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dialog.SelectedPath } }",
    "$owner.Dispose()",
    `if ($picked) { Write-Output $picked } else { Write-Output '${PICK_CANCELLED}' }`,
  ].join("; ");
}

/**
 * The FILE twin of pickFolderScript. Same window-owning and foreground
 * gymnastics — a dialog that opens behind the browser is a dialog nobody
 * answers. `fileName` pre-fills the box so the operator only confirms: the
 * caller reaches here because a file was DRAGGED IN and the browser hid its
 * path, so the name is known and the folder usually is not.
 */
export function pickFileScript(startIn: string, fileName: string): string {
  const quotedDir = `'${startIn.replace(/'/g, "''")}'`;
  const quotedName = `'${fileName.replace(/'/g, "''")}'`;
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$sig = '" +
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid); ' +
      '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); ' +
      '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); ' +
      '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); ' +
      "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int cmd);'",
    "$fg = Add-Type -MemberDefinition $sig -Name FgFile -Namespace Win32 -PassThru",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = 'Switchboard — point at the file you dragged'",
    "$dialog.CheckFileExists = $true",
    "$dialog.Multiselect = $false",
    `$dialog.InitialDirectory = ${quotedDir}`,
    `$dialog.FileName = ${quotedName}`,
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = 'None'",
    "$owner.Opacity = 0",
    "$owner.Size = New-Object System.Drawing.Size(1,1)",
    "$owner.StartPosition = 'Manual'",
    "$owner.Location = New-Object System.Drawing.Point(-32000,-32000)",
    "$owner.Show()",
    "$foreThread = $fg::GetWindowThreadProcessId($fg::GetForegroundWindow(), [IntPtr]::Zero)",
    "$thisThread = $fg::GetCurrentThreadId()",
    "[void]$fg::AttachThreadInput($thisThread, $foreThread, $true)",
    "[void]$fg::BringWindowToTop($owner.Handle)",
    "[void]$fg::SetForegroundWindow($owner.Handle)",
    "[void]$fg::AttachThreadInput($thisThread, $foreThread, $false)",
    "$owner.Activate()",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Dispose()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName } " +
      `else { Write-Output '${PICK_CANCELLED}' }`,
  ].join("; ");
}

export interface PickFolderDeps {
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** Interop probe; injectable so tests do not depend on the host's binfmt. */
  interop?: () => void;
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
  (deps.interop ?? assertInterop)(); // the dialog IS a PowerShell process
  const exec =
    deps.exec ??
    (async (file: string, args: string[]) => {
      const { stdout } = await execFileAsync(file, args, {
        timeout: deps.timeoutMs ?? 180_000,
        maxBuffer: 1024 * 64,
        // cwd /mnt/c, the same reason the terminal opener uses it (launcher.ts):
        // a Windows GUI launched from a \\wsl$ UNC working directory misbehaves,
        // and here that meant the dialog opened with no visible window. The hub
        // runs in a WSL cwd, so without this the picker inherited it.
        cwd: "/mnt/c",
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

/**
 * Opens the native file dialog and answers with the WSL path the operator
 * pointed at (null when they cancel). Exists for one case: a file dragged
 * into the dashboard whose original the hub could not locate — refusing it,
 * or copying a multi-gigabyte render into ~/.switchboard, are both wrong.
 */
export async function pickWindowsFile(
  fileName: string,
  startIn?: string,
  deps: PickFolderDeps = {},
): Promise<string | null> {
  const distro = deps.distro ?? process.env.WSL_DISTRO_NAME;
  if (!distro) {
    throw new PickError(
      "The native file dialog is a Windows + WSL feature (WSL_DISTRO_NAME is not set).",
      true,
    );
  }
  assertInterop(); // the dialog is a PowerShell process; without interop there is none
  const exec =
    deps.exec ??
    (async (file: string, args: string[]) => {
      const { stdout } = await execFileAsync(file, args, {
        timeout: deps.timeoutMs ?? 180_000,
        maxBuffer: 1024 * 64,
        cwd: "/mnt/c",
      });
      return { stdout };
    });

  const requested = startIn ?? (deps.homeDir ?? os.homedir());
  const script = pickFileScript(
    requested.startsWith("/") ? toWslUnc(distro, requested) : requested,
    fileName,
  );
  const shell = deps.shell ?? findPowerShell();

  let stdout: string;
  try {
    ({ stdout } = await exec(shell, ["-NoProfile", "-STA", "-Command", script]));
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `${shell} was not found — the native dialog needs Windows interop.`
      : `The native file dialog failed: ${(err as Error).message}`;
    throw new PickError(message, true);
  }

  const picked = stdout.replace(/\r?\n/g, "").trim();
  if (picked === "" || picked === PICK_CANCELLED) return null;
  try {
    const { stdout: wsl } = await exec("wslpath", ["-u", picked]);
    return wsl.replace(/\r?\n/g, "").trim();
  } catch {
    throw new PickError(`Could not translate "${picked}" into a WSL path.`);
  }
}
