// `switchboard rename <old> <new>` (post-v1 sibling of stop/send): changes an
// agent's NAME — its address on the network — via POST /api/agents/:name/rename.
//
// REST only, like status/send/stop: the CLI never touches the store files (the
// hub stays the single writer). The hub owns every rule and every error text
// (unknown agent, agent online, invalid/taken name), so they are printed
// verbatim — they are already written in English for the reader to self-correct.

import type { Command } from "commander";
import type { PublicAgent } from "../shared/types.js";
import {
  checkHubHealth,
  defaultHubUrl,
  hubPost,
  runCliAction,
  type OutFn,
} from "./common.js";

interface RenameResponse {
  ok: boolean;
  agent: PublicAgent;
}

export interface RenameOptions {
  from: string;
  to: string;
  hubUrl?: string;
  baseDir?: string;
  out?: OutFn;
}

export async function runRename(options: RenameOptions): Promise<RenameResponse> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl); // hub down → clear "serve first" error

  const result = await hubPost<RenameResponse>(
    hubUrl,
    `/api/agents/${encodeURIComponent(options.from)}/rename`,
    { name: options.to },
  );

  out(`Agent "${options.from}" renamed to "${result.agent.name}".`);
  out(
    `Its message history followed the rename — the unread of "${options.from}" is now ` +
      `the unread of "${result.agent.name}".`,
  );
  out(
    `Start it under the new name: "switchboard start ${result.agent.name}" ` +
      `(tmux session "${result.agent.tmuxSession}").`,
  );
  return result;
}

export function registerRenameCommand(program: Command): void {
  program
    .command("rename")
    .description(
      "Renames a registered agent, keeping its message history (the agent must be stopped).",
    )
    .argument("<old>", "current agent name")
    .argument("<new>", "new agent name (lowercase letters, digits and hyphens)")
    .action(async (from: string, to: string) => {
      await runCliAction(() => runRename({ from, to }).then(() => undefined));
    });
}
