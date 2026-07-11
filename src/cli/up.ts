// `switchboard up` — makes sure the Hub is running and exits, then prints a
// polished status banner. The workhorse for one-click launchers (e.g. a
// Windows .bat that runs `wsl -- bash -lc "switchboard up"` and then opens the
// dashboard in the browser) and for startup scripts: unlike `serve` it does
// not stay in the foreground, and unlike `start`/`wire` it does not touch any
// agent — it only guarantees the background sb-hub session is up (booting it
// when needed).

import type { Command } from "commander";
import {
  defaultHubUrl,
  ensureHubUp,
  runCliAction,
  type OutFn,
} from "./common.js";

export interface UpStatus {
  /** Agents currently online, or null when the hub could not be queried. */
  online: number | null;
  /** Agents registered in total, or null when unavailable. */
  total: number | null;
  /** Hub version string, or null when unavailable. */
  version: string | null;
}

export interface UpOptions {
  // -- injectables (index.ts uses the defaults; tests override) --------------
  hubUrl?: string;
  baseDir?: string;
  out?: OutFn;
  /** Hub liveness strategy (default ensureHubUp — auto-starts sb-hub). */
  ensureHub?: (hubUrl: string, opts: { out: OutFn }) => Promise<void>;
  /** Status probe (default: GET /api/health + /api/agents). Injectable for tests. */
  probeStatus?: (hubUrl: string) => Promise<UpStatus>;
  /** Force ANSI color on/off (default: on when stdout is a TTY). */
  color?: boolean;
}

/** Browser-friendly display URL: 127.0.0.1 → localhost (WSL forwards it), trailing slash. */
export function displayUrl(hubUrl: string): string {
  return hubUrl.replace("127.0.0.1", "localhost").replace(/\/+$/, "") + "/";
}

/**
 * The status banner (pure, unit-tested). ANSI color only when `color` is true —
 * off it is plain ASCII, safe to pipe or log. Missing counts degrade to a
 * clear note rather than fake zeros.
 */
export function formatUpBanner(
  info: { url: string } & UpStatus,
  color: boolean,
): string {
  const paint = (code: string, s: string): string =>
    color ? `[${code}m${s}[0m` : s;
  const cyan = (s: string) => paint("36", s);
  const bold = (s: string) => paint("1", s);
  const dim = (s: string) => paint("2", s);
  const green = (s: string) => paint("32", s);

  const agents =
    info.online === null || info.total === null
      ? dim("(could not read the agent list)")
      : `${bold(String(info.online))} online ${dim("·")} ${info.total} registered`;

  return [
    "",
    `   ${cyan("⇄")}  ${bold(cyan("Switchboard"))}   ${dim("— agents talk to agents")}`,
    `   ${dim("──────────────────────────────────────────")}`,
    `   ${green("●")} ${bold("Hub online")}${info.version ? dim(`  v${info.version}`) : ""}`,
    `     ${dim("Dashboard")}   ${bold(cyan(info.url))}`,
    `     ${dim("Agents")}      ${agents}`,
    `     ${dim("Logs")}        switchboard logs -f`,
    `     ${dim("Stop all")}    switchboard down`,
    "",
  ].join("\n");
}

/** Default status probe: best-effort, short timeout — `up` must return fast. */
async function defaultProbeStatus(hubUrl: string): Promise<UpStatus> {
  const empty: UpStatus = { online: null, total: null, version: null };
  try {
    const [healthRes, agentsRes] = await Promise.all([
      fetch(`${hubUrl}/api/health`, { signal: AbortSignal.timeout(2500) }),
      fetch(`${hubUrl}/api/agents`, { signal: AbortSignal.timeout(2500) }),
    ]);
    const health = (await healthRes.json().catch(() => ({}))) as { version?: string };
    const agents = (await agentsRes.json().catch(() => [])) as Array<{ status?: string }>;
    if (!Array.isArray(agents)) return { ...empty, version: health.version ?? null };
    return {
      online: agents.filter((a) => a.status === "online").length,
      total: agents.length,
      version: health.version ?? null,
    };
  } catch {
    return empty;
  }
}

export async function runUp(options: UpOptions = {}): Promise<void> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  // Default: auto-start and stay quiet on success (the banner is the summary).
  const ensureHub =
    options.ensureHub ??
    ((url: string, opts: { out: OutFn }) => ensureHubUp(url, { ...opts, quietSuccess: true }));
  await ensureHub(hubUrl, { out });

  const status = await (options.probeStatus ?? defaultProbeStatus)(hubUrl);
  const color = options.color ?? process.stdout.isTTY === true;
  out(formatUpBanner({ url: displayUrl(hubUrl), ...status }, color));
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description(
      'Makes sure the Hub is running (auto-starting it in the background tmux session "sb-hub" ' +
        "when needed) and prints its status. Handy for one-click launchers and startup scripts.",
    )
    .action(async () => {
      await runCliAction(() => runUp());
    });
}
