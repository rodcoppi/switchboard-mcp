// CLI entry point (PRD section 11). Phase 2 ships only `serve`; the other
// subcommands (start, status, send, stop, down, logs) arrive in Phase 4 —
// do not add them before their phase.

import { Command, Option } from "commander";
import type { LogLevel } from "./shared/types.js";
import { DEFAULTS } from "./server/config.js";
import { startHub } from "./server/hub.js";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const program = new Command();

program
  .name("switchboard")
  .description(
    "Hub local que conecta instâncias independentes de Claude Code em sessões tmux, " +
      "com troca assíncrona de mensagens via MCP e dashboard web de observação.",
  );

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

    const hub = await startHub({ port, logLevel, baseDir: opts.dir });

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

program.parseAsync(process.argv).catch((err) => {
  console.error(`switchboard: ${String(err)}`);
  process.exit(1);
});
