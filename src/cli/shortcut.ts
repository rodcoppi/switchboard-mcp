// `switchboard shortcut` — generates a one-click Windows launcher for
// WSL-based setups (the project's target environment, PRD section 1): a .bat
// on the user's Windows Desktop (or Startup folder with --startup) that runs
// `switchboard up` inside WSL and opens the dashboard in the Windows browser.
//
// Why this shape:
// - The .bat calls `wsl.exe -d <distro> -- bash -lc "node '<bin shim>' up"`:
//   a LOGIN shell (-l) loads ~/.profile so the user's PATH (node managers,
//   ~/.local/bin where tmux may live) is complete, and the absolute bin-shim
//   path makes the shortcut independent of `npm link`.
// - The dashboard is reachable from Windows at http://localhost:<port>/
//   thanks to WSL2's built-in localhost forwarding — the hub itself still
//   binds 127.0.0.1 INSIDE WSL only (D6 intact; forwarding is Windows-local).
// - The Desktop/Startup folders are resolved via PowerShell's
//   [Environment]::GetFolderPath, which honors OneDrive-redirected folders.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { loadConfig } from "../server/config.js";
import { CliError, runCliAction, type OutFn } from "./common.js";

const execFileAsync = promisify(execFile);

/** Repo-root bin shim, resolved relative to this module (works from any cwd). */
function binShimPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/switchboard.mjs");
}

/**
 * The .bat content (pure — unit-tested). ASCII-only and CRLF (cmd.exe is
 * unreliable with bare LF), closes by itself on success and pauses on failure
 * so the user can read the error.
 */
export function shortcutBatContent(input: {
  distro: string;
  shimPath: string;
  port: number;
}): string {
  const lines = [
    "@echo off",
    "title Switchboard",
    "echo Starting the Switchboard hub (WSL)...",
    // Single quotes around the shim path survive bash -lc; the path comes from
    // this repo's location (no user input) but may contain spaces.
    `wsl.exe -d ${input.distro} -- bash -lc "node '${input.shimPath}' up"`,
    "if errorlevel 1 (",
    "  echo.",
    "  echo The hub could not start. Read the message above.",
    "  pause",
    "  exit /b 1",
    ")",
    `start "" http://localhost:${input.port}/`,
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * Resolves a Windows special folder from inside WSL: PowerShell gives the
 * REAL folder (OneDrive-aware), wslpath converts it to a /mnt/... path.
 */
async function windowsFolderAsWslPath(folder: "Desktop" | "Startup"): Promise<string> {
  const { stdout: winPath } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `[Environment]::GetFolderPath('${folder}')`,
  ]);
  const trimmed = winPath.replace(/\r?\n/g, "").trim();
  if (trimmed === "") {
    throw new CliError(`Could not resolve the Windows ${folder} folder via PowerShell.`);
  }
  const { stdout: wsl } = await execFileAsync("wslpath", ["-u", trimmed]);
  return wsl.replace(/\r?\n/g, "").trim();
}

export interface ShortcutOptions {
  /** Install into the Windows Startup folder (runs on boot) instead of the Desktop. */
  startup?: boolean;
  // -- injectables (index.ts uses the defaults; tests override) --------------
  baseDir?: string;
  out?: OutFn;
  distro?: string;
  shimPath?: string;
  resolveFolder?: (folder: "Desktop" | "Startup") => Promise<string>;
  writeFile?: (filePath: string, content: string) => void;
}

export async function runShortcut(options: ShortcutOptions = {}): Promise<void> {
  const out = options.out ?? console.log;

  // WSL only: on plain Linux/macOS there is no Windows side to put a shortcut
  // on — auto-start (start/wire/up) already covers those.
  const distro = options.distro ?? process.env.WSL_DISTRO_NAME;
  if (!distro) {
    throw new CliError(
      "switchboard shortcut is for Windows + WSL setups (it creates a Windows .bat that boots " +
        "the hub inside WSL). This session does not look like WSL (WSL_DISTRO_NAME is not set). " +
        'On Linux/macOS just rely on the auto-start: any "switchboard up/start/wire" boots the hub.',
    );
  }

  const folder = options.startup ? "Startup" : "Desktop";
  const dir = await (options.resolveFolder ?? windowsFolderAsWslPath)(folder);
  const filePath = path.join(dir, "Switchboard.bat");
  const content = shortcutBatContent({
    distro,
    shimPath: options.shimPath ?? binShimPath(),
    port: loadConfig(options.baseDir).port,
  });
  (options.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c)))(filePath, content);

  out(`Shortcut created: ${filePath}`);
  if (options.startup) {
    out(
      "It lives in the Windows STARTUP folder: on every boot the hub comes up in the " +
        "background and the dashboard opens. Delete the file to undo.",
    );
  } else {
    out(
      "Double-click it on the Desktop to bring the hub up and open the dashboard. " +
        'Tip: "switchboard shortcut --startup" also installs it to run on Windows boot.',
    );
  }
}

export function registerShortcutCommand(program: Command): void {
  program
    .command("shortcut")
    .description(
      "Creates a one-click Windows launcher (Switchboard.bat) on the Desktop — or in the " +
        "Startup folder with --startup, so the hub comes up on every boot. WSL setups only.",
    )
    .option("--startup", "install into the Windows Startup folder (runs on boot)")
    .action(async (opts: { startup?: boolean }) => {
      await runCliAction(() => runShortcut({ startup: opts.startup }));
    });
}
