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
 * ("imprime na PRIMEIRA linha", so it must precede the hub's own startup
 * logs); second line = the tmux sb-hub recommendation.
 */
export function serveHeaderLines(url: string): string[] {
  return [
    `Dashboard: ${url}/  |  MCP: ${url}/mcp  |  Registro (uma vez): claude mcp add --transport http --scope user switchboard ${url}/mcp`,
    `Recomendação: rode este serve dentro de uma sessão tmux "sb-hub" (tmux new -s sb-hub) para ele sobreviver ao fechamento do terminal.`,
  ];
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description(
      "Sobe o Hub em foreground (logs no stdout + arquivo). " +
        "Recomendado: rodar dentro de uma sessão tmux 'sb-hub' para sobreviver ao fechamento do terminal.",
    )
    .option("--port <porta>", `porta do Hub (default: ${DEFAULTS.port}, ou o valor do config.json)`)
    .option("--log-level <nível>", `nível de log: ${LOG_LEVELS.join(" | ")}`)
    // Hidden flag: keeps the data dir injectable (verification/tests) without a
    // new env var. Production simply omits it and uses ~/.switchboard.
    .addOption(new Option("--dir <dir>", "diretório de dados (default: ~/.switchboard)").hideHelp())
    .action(async (opts: { port?: string; logLevel?: string; dir?: string }) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(`switchboard serve: porta inválida "${opts.port}" (esperado 0..65535).`);
          process.exit(1);
        }
      }

      let logLevel: LogLevel | undefined;
      if (opts.logLevel !== undefined) {
        if (!(LOG_LEVELS as string[]).includes(opts.logLevel)) {
          console.error(
            `switchboard serve: log-level inválido "${opts.logLevel}" (esperado ${LOG_LEVELS.join(" | ")}).`,
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
            `A porta ${configuredPort} já está em uso — provavelmente já existe um ` +
              `"switchboard serve" rodando (confira com "switchboard status" ou "switchboard logs"). ` +
              `Para usar outra porta: --port <porta>.`,
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
        hub.log.info(`[hub] ${signal} recebido — encerrando.`);
        hub
          .close()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error(`Erro ao encerrar o Hub: ${String(err)}`);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });
}
