#!/usr/bin/env node
// Shim do bin "switchboard" (package.json). O shebang antigo
// (`#!/usr/bin/env -S npx tsx`) resolvia o tsx a partir do CWD DE QUEM CHAMA:
// rodar `switchboard …` de um projeto sem tsx fazia o npx perguntar/baixar um
// tsx@latest (drift em relação ao pinado) ou falhar offline — e o uso normal
// do start é exatamente de dentro do projeto do agente. Este shim resolve o
// tsx do PRÓPRIO repositório (via import.meta.url → node_modules local) e
// re-executa src/index.ts com o loader. Sem build step (D9): o entry continua
// .ts. A re-entrada do kickoff via process.execArgv segue correta — o tsx CLI
// re-executa o node com o loader (caminho absoluto) no execArgv.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli"); // node_modules/tsx DESTE repo
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// Ctrl-C chega ao grupo de processos inteiro: o filho (serve/logs -f) é quem
// trata o sinal e encerra limpo; o shim só espera e propaga o resultado.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("error", (err) => {
  console.error(`switchboard: falha ao executar o tsx do repositório: ${String(err)}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal); // re-lança o sinal (exit status fiel)
  } else {
    process.exit(code ?? 1);
  }
});
