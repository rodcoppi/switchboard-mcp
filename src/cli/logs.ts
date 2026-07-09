// `switchboard logs [-f]` (PRD section 11): tail of ~/.switchboard/logs/hub.log.
// Default: last ~100 lines. -f follows the file WITHOUT new dependencies and
// WITHOUT fs.watch — inotify is unreliable on WSL2 filesystems (and the hub
// appends with appendFileSync, no rename), so following is a simple size poll
// every 500ms: size grew → read and print the delta; size shrank (truncate /
// manual rotation) → start over from 0. Ctrl-C exits cleanly.

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { defaultBaseDir } from "../server/config.js";
import { CliError, runCliAction, type OutFn } from "./common.js";

export const DEFAULT_TAIL_LINES = 100;

/**
 * Last `n` lines of `content` (ignoring a trailing newline). Pure —
 * unit-tested directly.
 */
export function tailLines(content: string, n: number): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}

/** Reads bytes [offset, size) of the file. */
function readFrom(file: string, offset: number, size: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogsOptions {
  follow?: boolean;
  lines?: number;
  /** Data dir (default ~/.switchboard); the log lives at <dir>/logs/hub.log. */
  baseDir?: string;
  out?: OutFn;
  /** Follow poll cadence (default 500ms; injectable for tests). */
  pollMs?: number;
  /** Test hook: aborting ends the follow loop like Ctrl-C would. */
  signal?: AbortSignal;
}

export async function runLogs(options: LogsOptions = {}): Promise<void> {
  const out = options.out ?? console.log;
  const baseDir = options.baseDir ?? defaultBaseDir();
  const file = path.join(baseDir, "logs", "hub.log");
  if (!fs.existsSync(file)) {
    throw new CliError(
      `Log file does not exist: ${file}. Has the Hub run on this machine yet? Run "switchboard serve".`,
    );
  }

  for (const line of tailLines(fs.readFileSync(file, "utf8"), options.lines ?? DEFAULT_TAIL_LINES)) {
    out(line);
  }
  if (!options.follow) return;

  let offset = fs.statSync(file).size;
  let carry = ""; // partial (not yet newline-terminated) tail of the last read
  const pollMs = options.pollMs ?? 500;

  await new Promise<void>((resolve) => {
    const poll = (): void => {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        return; // file briefly missing (manual cleanup) — keep polling
      }
      if (size < offset) {
        // Truncated/recreated (e.g. user wiped the log): restart from zero.
        offset = 0;
        carry = "";
      }
      if (size > offset) {
        try {
          carry += readFrom(file, offset, size);
          offset = size;
        } catch {
          // The file can vanish BETWEEN the statSync above and the open here
          // (user wiped/rotated the log mid-follow): same treatment as the
          // stat failure — keep polling; if it reappears smaller, the
          // size < offset branch resets offset/carry on the next round.
          return;
        }
        // Emit only COMPLETE lines; a torn tail waits for its newline.
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) out(line);
      }
    };
    const timer = setInterval(poll, pollMs);
    const stop = (): void => {
      clearInterval(timer);
      process.removeListener("SIGINT", stop);
      resolve(); // clean exit path for Ctrl-C (and for the test AbortSignal)
    };
    process.once("SIGINT", stop);
    options.signal?.addEventListener("abort", stop, { once: true });
  });
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description(`Shows the last ${DEFAULT_TAIL_LINES} lines of the Hub log (~/.switchboard/logs/hub.log).`)
    .option("-f, --follow", "follows the log file (Ctrl-C to exit)")
    .action(async (opts: { follow?: boolean }) => {
      await runCliAction(() => runLogs({ follow: opts.follow }));
    });
}
