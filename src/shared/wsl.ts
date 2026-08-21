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
import { existsSync } from "node:fs";

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
