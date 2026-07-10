// `switchboard up` — makes sure the Hub is running and exits. The workhorse
// for one-click launchers (e.g. a Windows .bat that runs `wsl -- bash -lc
// "switchboard up"` and then opens the dashboard in the browser) and for
// startup scripts: unlike `serve` it does not stay in the foreground, and
// unlike `start`/`wire` it does not touch any agent — it only guarantees the
// background sb-hub session is up (booting it when needed) and prints where
// the dashboard lives.

import type { Command } from "commander";
import {
  defaultHubUrl,
  ensureHubUp,
  runCliAction,
  type OutFn,
} from "./common.js";

export interface UpOptions {
  // -- injectables (index.ts uses the defaults; tests override) --------------
  hubUrl?: string;
  baseDir?: string;
  out?: OutFn;
  /** Hub liveness strategy (default ensureHubUp — auto-starts sb-hub). */
  ensureHub?: (hubUrl: string, opts: { out: OutFn }) => Promise<void>;
}

export async function runUp(options: UpOptions = {}): Promise<void> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  const ensureHub = options.ensureHub ?? ensureHubUp;
  await ensureHub(hubUrl, { out });
  out(`Hub is running. Dashboard: ${hubUrl}/`);
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description(
      'Makes sure the Hub is running (auto-starting it in the background tmux session "sb-hub" ' +
        "when needed) and exits. Handy for one-click launchers and startup scripts.",
    )
    .action(async () => {
      await runCliAction(() => runUp());
    });
}
