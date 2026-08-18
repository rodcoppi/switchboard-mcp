// CLI entry point (PRD sections 6 and 11): dispatches the subcommands
// serve | up | setup | start <name> | wire | status | send <to> <msg...> |
// stop <name> | down | rename <old> <new> | logs [-f], each implemented in
// src/cli/*.ts. Also mounts the hidden kickoff-agent re-entry used by the
// detached kickoff of `start`/`wire`.
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
import { registerSetupCommand } from "./cli/setup.js";
import { registerKickoffAgentCommand, registerStartCommand } from "./cli/start.js";
import { registerWireCommand } from "./cli/wire.js";
import { registerStatusCommand } from "./cli/status.js";
import { registerSendCommand } from "./cli/send.js";
import { registerStopCommands } from "./cli/stop.js";
import { registerRenameCommand } from "./cli/rename.js";
import { registerLogsCommand } from "./cli/logs.js";
import { hydrateWslDistroEnv } from "./shared/wsl.js";

// WSL_DISTRO_NAME, once, for the whole process tree. It is exported only to
// sessions WSL itself starts, so a hub launched by the Windows login hook has
// an env WITHOUT it — and every Windows-side feature (the native folder/file
// dialogs, open folder, open in a new terminal, the desktop shortcut) refused
// to work with "WSL_DISTRO_NAME is not set" on a machine that is plainly WSL
// (18/08). Resolving it HERE also fixes it for the agents: the launcher hands
// the hub's environment to each one it opens.
hydrateWslDistroEnv();

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
registerSetupCommand(program);
registerStartCommand(program);
registerWireCommand(program);
registerKickoffAgentCommand(program);
registerStatusCommand(program);
registerSendCommand(program);
registerStopCommands(program); // stop <name> + down
registerRenameCommand(program);
registerLogsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`switchboard: ${String(err)}`);
  process.exit(1);
});
