// CLI entry point (PRD sections 6 and 11): dispatches the subcommands
// serve | up | start <name> | wire | status | send <to> <msg...> |
// stop <name> | down | logs [-f], each implemented in src/cli/*.ts. Also
// mounts the hidden kickoff-agent re-entry used by the detached kickoff of
// `start`/`wire`.
//
// `bin.switchboard` (package.json) points at bin/switchboard.mjs, a plain-node
// shim that resolves the tsx pinned in THIS repo (never from the caller's
// CWD, as the old `npx tsx` shebang did) and re-executes this .ts entry —
// still no build step (D9). Invoked with no subcommand, commander prints the
// help.

import { Command } from "commander";
import { registerServeCommand } from "./cli/serve.js";
import { registerUpCommand } from "./cli/up.js";
import { registerShortcutCommand } from "./cli/shortcut.js";
import { registerKickoffAgentCommand, registerStartCommand } from "./cli/start.js";
import { registerWireCommand } from "./cli/wire.js";
import { registerStatusCommand } from "./cli/status.js";
import { registerSendCommand } from "./cli/send.js";
import { registerStopCommands } from "./cli/stop.js";
import { registerLogsCommand } from "./cli/logs.js";

const program = new Command();

program
  .name("switchboard")
  .description(
    "Local hub that connects independent Claude Code instances in tmux sessions, " +
      "with asynchronous message exchange via MCP and a web dashboard for observation.",
  )
  .showSuggestionAfterError();

registerServeCommand(program);
registerUpCommand(program);
registerShortcutCommand(program);
registerStartCommand(program);
registerWireCommand(program);
registerKickoffAgentCommand(program);
registerStatusCommand(program);
registerSendCommand(program);
registerStopCommands(program); // stop <name> + down
registerLogsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`switchboard: ${String(err)}`);
  process.exit(1);
});
