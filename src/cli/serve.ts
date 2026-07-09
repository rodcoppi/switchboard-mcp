// `switchboard serve` (PRD section 11): runs the Hub in foreground (logs on
// stdout + file). Moved verbatim from the Phase 2 src/index.ts, plus the
// Phase 4 header: the FIRST line of output carries the dashboard address, the
// MCP address and the ready-to-copy `claude mcp add` command, followed by the
// printed recommendation to run inside a tmux session "sb-hub".

import { Command, Option } from "commander";
import type { LogLevel } from "../shared/types.js";
import { BIND_HOST, DEFAULTS, loadConfig } from "../server/config.js";
import { startHub } from "../server/hub.js";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * PRD 11 header. First line = dashboard + MCP + `claude mcp add` in one line
 * ("prints on the FIRST line", so it must precede the hub's own startup
 * logs); second line = the tmux sb-hub recommendation.
 */
export function serveHeaderLines(url: string): string[] {
  return [
    `Dashboard: ${url}/  |  MCP: ${url}/mcp  |  Register (once): claude mcp add --transport http --scope user switchboard ${url}/mcp`,
    `Recommendation: run this serve inside a tmux session "sb-hub" (tmux new -s sb-hub) so it survives closing the terminal.`,
  ];
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description(
      "Starts the Hub in the foreground (logs on stdout + file). " +
        "Recommended: run inside a tmux session 'sb-hub' so it survives closing the terminal.",
    )
    .option("--port <port>", `Hub port (default: ${DEFAULTS.port}, or the config.json value)`)
    .option("--log-level <level>", `log level: ${LOG_LEVELS.join(" | ")}`)
    // Hidden flag: keeps the data dir injectable (verification/tests) without a
    // new env var. Production simply omits it and uses ~/.switchboard.
    .addOption(new Option("--dir <dir>", "data directory (default: ~/.switchboard)").hideHelp())
    .action(async (opts: { port?: string; logLevel?: string; dir?: string }) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(`switchboard serve: invalid port "${opts.port}" (expected 0..65535).`);
          process.exit(1);
        }
      }

      let logLevel: LogLevel | undefined;
      if (opts.logLevel !== undefined) {
        if (!(LOG_LEVELS as string[]).includes(opts.logLevel)) {
          console.error(
            `switchboard serve: invalid log-level "${opts.logLevel}" (expected ${LOG_LEVELS.join(" | ")}).`,
          );
          process.exit(1);
        }
        logLevel = opts.logLevel as LogLevel;
      }

      // The effective port is known BEFORE the hub starts (flag or config), so
      // the header can really be the first output. The only exception is the
      // ephemeral --port 0 (tests/debug), whose real port only exists after
      // listen — then the header prints right after startHub instead.
      const configuredPort = port ?? loadConfig(opts.dir).port;
      if (configuredPort !== 0) {
        for (const line of serveHeaderLines(`http://${BIND_HOST}:${configuredPort}`)) {
          console.log(line);
        }
      }

      let hub;
      try {
        hub = await startHub({ port, logLevel, baseDir: opts.dir });
      } catch (err) {
        // The typical failure: another `switchboard serve` already owns the
        // port. Without this, the optimistic header above would be followed
        // by a raw "Error: listen EADDRINUSE" stack — dress it for the human
        // like every other subcommand error.
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          console.error(
            `Port ${configuredPort} is already in use — there is probably a ` +
              `"switchboard serve" already running (check with "switchboard status" or "switchboard logs"). ` +
              `To use another port: --port <port>.`,
          );
          process.exit(1);
        }
        throw err;
      }
      if (configuredPort === 0) {
        for (const line of serveHeaderLines(hub.url)) console.log(line);
      }

      // Foreground process: Ctrl-C / SIGTERM shut the hub down cleanly
      // (closes MCP transports, SSE streams and the listener).
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        hub.log.info(`[hub] ${signal} received — shutting down.`);
        hub
          .close()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error(`Error shutting down the Hub: ${String(err)}`);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });
}
