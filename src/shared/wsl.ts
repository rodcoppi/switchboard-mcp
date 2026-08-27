// Which WSL distro this process runs in — the one fact every Windows-side
// feature needs (the native folder/file dialogs, "open folder", "open in a new
// terminal", the desktop shortcut).
//
// WSL_DISTRO_NAME is the canonical source, but it is only exported to sessions
// WSL itself starts. A hub born from the Windows login hook — and every agent
// the hub launches, since they inherit its environment — has an env WITHOUT
// it, and each of those features refused to work with "WSL_DISTRO_NAME is not
// set" on a machine that is plainly WSL (18/08, the owner's board). So when the
// variable is missing we ask the kernel side instead: `wslpath -w /` prints
// \\wsl.localhost\<distro>\ (older builds: \\wsl$\<distro>\).
//
// Everything here is env-in/exec-in, so tests drive it without a real WSL.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * The distro name inside a Windows UNC path for the WSL root, or undefined
 * when the string is not one. Pure.
 */
export function distroFromRootUnc(unc: string): string | undefined {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?/i.exec(unc.trim());
  return m ? m[1] : undefined;
}

/** Reads `wslpath -w /`, or null when it is not there (not WSL, no interop). */
function readRootUnc(): string | null {
  try {
    return execFileSync("wslpath", ["-w", "/"], { encoding: "utf8", timeout: 3000 });
  } catch {
    return null;
  }
}

/** Pure core: the env wins, `wslpath` is the fallback. Exported for tests. */
export function resolveWslDistro(
  env: NodeJS.ProcessEnv,
  rootUnc: () => string | null,
): string | undefined {
  const fromEnv = env.WSL_DISTRO_NAME?.trim();
  if (fromEnv) return fromEnv;
  const unc = rootUnc();
  return unc ? distroFromRootUnc(unc) : undefined;
}

let cached: string | undefined;
let resolved = false;

/**
 * The distro name for this process, resolved once and reused. undefined means
 * "not running under WSL" — callers report that to the operator as before.
 */
export function wslDistroName(): string | undefined {
  if (!resolved) {
    cached = resolveWslDistro(process.env, readRootUnc);
    resolved = true;
  }
  return cached;
}

/**
 * Puts the resolved name INTO the environment when it is missing. Called once
 * at the CLI entrypoint: every consumer then reads WSL_DISTRO_NAME as it
 * always did, and — because the launcher hands the hub's environment to every
 * agent it opens — the agents inherit a correct one too, instead of passing
 * the login hook's blind spot down the tree. Returns the name it settled on.
 */
export function hydrateWslDistroEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const distro = resolveWslDistro(env, readRootUnc);
  if (distro && !env.WSL_DISTRO_NAME?.trim()) env.WSL_DISTRO_NAME = distro;
  return distro;
}

/** Test seam: forget the memoized answer. */
export function resetWslDistroCache(): void {
  resolved = false;
  cached = undefined;
}

/**
 * The Windows directories an agent needs on its PATH to reach Windows at all:
 * powershell.exe lives in the third one, and a PATH without it turns every
 * interop call into "not found". Order matters only in that these go at the
 * END — a Linux binary must always win over a Windows one with the same name.
 */
export const WINDOWS_INTEROP_PATHS = [
  "/mnt/c/Windows/System32",
  "/mnt/c/Windows",
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
];

/**
 * Guarantees those directories on a PATH, appending only the ones that are
 * missing AND actually exist on this machine.
 *
 * The hub bakes its own environment into every agent it launches, so an
 * incomplete PATH at the hub becomes an incomplete PATH in ten agents — and
 * the failure surfaces far from the cause, as a Stop hook dying with
 * "/bin/sh: 1: powershell.exe: not found" (22/08, after the hub was restarted
 * by hand with a shortened PATH). Agents stop inheriting that mistake here.
 */
export function withWindowsInterop(
  pathValue: string,
  exists: (dir: string) => boolean = (dir) => existsSync(dir),
): string {
  const present = new Set(pathValue.split(":").filter((p) => p !== ""));
  const missing = WINDOWS_INTEROP_PATHS.filter((dir) => !present.has(dir) && exists(dir));
  if (missing.length === 0) return pathValue;
  return pathValue === "" ? missing.join(":") : `${pathValue}:${missing.join(":")}`;
}


/** Where the kernel records that Windows executables can be run from here. */
export const WSL_INTEROP_BINFMT = "/proc/sys/fs/binfmt_misc/WSLInterop";

export interface InteropStatus {
  ok: boolean;
  /** Operator-facing explanation + fix, present only when ok is false. */
  reason?: string;
}

/**
 * Can this distro run Windows executables at all?
 *
 * Everything on the Windows side — open folder, open in a terminal, the native
 * file dialogs, the desktop shortcut — is a `.exe` launched from Linux, and
 * that only works while the kernel has WSLInterop registered in binfmt_misc.
 * A distro brought over with `wsl --import` (a new machine, a migrated setup)
 * frequently comes up WITHOUT it, and then every one of those features fails
 * with "Exec format error" — which surfaced here as buttons that reported
 * success and did nothing (27/08, after moving PCs).
 *
 * Cheap enough to call per request: one stat and one small read.
 */
export function interopStatus(
  read: (file: string) => string | null = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
): InteropStatus {
  const raw = read(WSL_INTEROP_BINFMT);
  if (raw === null) {
    return {
      ok: false,
      reason:
        "This WSL distro cannot run Windows programs: the kernel has no WSLInterop entry " +
        "(common right after `wsl --import`). Add to /etc/wsl.conf:\n\n" +
        "  [interop]\n  enabled=true\n  appendWindowsPath=true\n\n" +
        "then restart the distro from Windows: wsl --terminate <distro>. " +
        "To fix it without restarting (needs root):\n\n" +
        "  echo ':WSLInterop:M::MZ::/init:PF' | sudo tee /proc/sys/fs/binfmt_misc/register",
    };
  }
  if (/^\s*disabled\s*$/im.test(raw)) {
    return {
      ok: false,
      reason:
        "Windows interop is registered but DISABLED in this distro. Enable it with:\n\n" +
        "  echo 1 | sudo tee /proc/sys/fs/binfmt_misc/WSLInterop",
    };
  }
  return { ok: true };
}

/**
 * Throws with the operator-facing explanation when this distro cannot run
 * Windows programs. Every Windows-side entry point calls it FIRST, so the
 * failure is one clear sentence at the top instead of an "Exec format error"
 * from whatever .exe happened to be tried.
 */
export function assertInterop(): void {
  const status = interopStatus();
  if (!status.ok) throw new Error(status.reason ?? "Windows interop is unavailable in this distro.");
}
