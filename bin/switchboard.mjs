#!/usr/bin/env node
// Shim for the "switchboard" bin (package.json). The old shebang
// (`#!/usr/bin/env -S npx tsx`) resolved tsx from the CALLER's CWD: running
// `switchboard …` from a project without tsx made npx prompt/download a
// tsx@latest (drift from the pinned one) or fail offline — and `start` is
// normally run from inside the agent's project. This shim resolves tsx from
// THIS repo (via import.meta.url → local node_modules) and re-executes
// src/index.ts with the loader. No build step (D9): the entry stays .ts. The
// kickoff re-entry via process.execArgv stays correct — the tsx CLI re-runs
// node with the loader (absolute path) in execArgv.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli"); // node_modules/tsx of THIS repo
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// Ctrl-C reaches the whole process group: the child (serve/logs -f) is the one
// that handles the signal and exits cleanly; the shim just waits and forwards.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("error", (err) => {
  console.error(`switchboard: failed to run the repo's tsx: ${String(err)}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal); // re-raise the signal (faithful exit status)
  } else {
    process.exit(code ?? 1);
  }
});
