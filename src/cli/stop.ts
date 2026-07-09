// `switchboard stop <name>` / `switchboard down` (PRD section 11).
//
// stop: kills the agent's tmux session via tmux.ts killSession — confirming
// on the terminal first when there are unread messages (--yes skips) — and
// reminds that the REGISTRATION stays in the hub (a future start re-attaches
// the name). down: same, aggregated over every registered agent whose session
// is alive, then instructs how to stop the hub (it never kills the hub).

import readline from "node:readline/promises";
import type { Command } from "commander";
import { createTmux } from "../server/tmux.js";
import {
  CliError,
  checkHubHealth,
  defaultHubUrl,
  hubGet,
  runCliAction,
  type OutFn,
} from "./common.js";
import type { StatusRow } from "./status.js";

/** Narrow tmux surface stop/down need (injectable for integration tests). */
export interface StopTmux {
  hasSession(session: string): Promise<boolean>;
  killSession(session: string): Promise<void>;
}

/** Terminal yes/no prompt ("y"/"yes" confirms). Injectable for tests. */
export type ConfirmFn = (question: string) => Promise<boolean>;

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Gate shared by stop and down: unread > 0 requires a confirmation (--yes
 * skips; a non-interactive terminal cannot confirm → instructive error).
 * Returns true when the caller may proceed with the kill.
 */
async function confirmIfUnread(input: {
  unreadLabel: string;
  question: string;
  yes: boolean;
  isTTY: boolean;
  confirm: ConfirmFn;
  out: OutFn;
}): Promise<boolean> {
  if (input.yes) return true;
  if (!input.isTTY) {
    throw new CliError(
      `${input.unreadLabel} No interactive terminal to confirm — repeat with --yes to force.`,
    );
  }
  let confirmed: boolean;
  try {
    confirmed = await input.confirm(input.question);
  } catch (err) {
    // Ctrl-C at the prompt: readline/promises rejects with AbortError — that
    // is the USER CANCELLING, not a bug; treat it exactly like answering "n"
    // instead of letting runCliAction print a stack trace.
    if (err instanceof Error && err.name === "AbortError") {
      input.out("Canceled — nothing was stopped.");
      return false;
    }
    throw err;
  }
  if (confirmed) return true;
  input.out("Canceled — nothing was stopped.");
  return false;
}

export interface StopOptions {
  name: string;
  /** Skip the unread confirmation (flag --yes). */
  yes?: boolean;
  hubUrl?: string;
  baseDir?: string;
  tmux?: StopTmux;
  out?: OutFn;
  confirm?: ConfirmFn;
  isTTY?: boolean;
}

/** Post-kill reminder (PRD section 11: stop never unregisters). */
function registryReminder(name: string): string {
  return (
    `The registration of agent "${name}" stays in the Hub — a future ` +
    `"switchboard start ${name}" reuses the name (re-attach).`
  );
}

export async function runStop(options: StopOptions): Promise<{ killed: boolean }> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl);

  const agents = await hubGet<StatusRow[]>(hubUrl, "/api/agents");
  const agent = agents.find((a) => a.name === options.name);
  if (!agent) {
    const names = agents.map((a) => a.name);
    throw new CliError(
      `Agent "${options.name}" is not registered in the Hub. ` +
        `Registered: ${names.length > 0 ? names.join(", ") : "(none)"}.`,
    );
  }

  if (agent.unreadCount > 0) {
    const proceed = await confirmIfUnread({
      unreadLabel: `Agent "${agent.name}" has ${agent.unreadCount} unread message(s).`,
      question:
        `Agent "${agent.name}" has ${agent.unreadCount} unread message(s). ` +
        `Stop anyway? [y/N] `,
      yes: options.yes ?? false,
      isTTY: options.isTTY ?? process.stdin.isTTY === true,
      confirm: options.confirm ?? defaultConfirm,
      out,
    });
    if (!proceed) return { killed: false };
  }

  // The session name comes from the REGISTRATION (GET /api/agents carries
  // tmuxSession — PRD 8: the registry is the source of truth), never from a
  // prefix+name recomputation: a tmuxSessionPrefix edited in config.json
  // after the start (or a custom tmuxSession registered via REST) would make
  // the recomputed name miss the LIVE session and report "already stopped"
  // while the hub keeps nudging it.
  const session = agent.tmuxSession;
  const tmux: StopTmux = options.tmux ?? createTmux();
  if (await tmux.hasSession(session)) {
    await tmux.killSession(session);
    out(`Tmux session "${session}" stopped.`);
  } else {
    out(`The tmux session "${session}" does not exist — the agent was already stopped.`);
  }
  out(registryReminder(agent.name));
  return { killed: true };
}

export interface DownOptions {
  yes?: boolean;
  hubUrl?: string;
  baseDir?: string;
  tmux?: StopTmux;
  out?: OutFn;
  confirm?: ConfirmFn;
  isTTY?: boolean;
}

export async function runDown(options: DownOptions = {}): Promise<{ killed: string[] }> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl);

  const tmux: StopTmux = options.tmux ?? createTmux();
  const agents = await hubGet<StatusRow[]>(hubUrl, "/api/agents");

  // Only agents whose tmux session is actually alive are stopped; the check
  // goes through tmux.ts (exact-match target), never a raw tmux call. The
  // session name is the REGISTERED one (see runStop) — never recomputed.
  const live: Array<{ name: string; session: string; unread: number }> = [];
  for (const agent of agents) {
    const session = agent.tmuxSession;
    if (await tmux.hasSession(session)) {
      live.push({ name: agent.name, session, unread: agent.unreadCount });
    }
  }

  if (live.length === 0) {
    out("No agent with a live tmux session to stop.");
    out(hubStopInstruction());
    return { killed: [] };
  }

  const totalUnread = live.reduce((sum, a) => sum + a.unread, 0);
  if (totalUnread > 0) {
    const detail = live
      .filter((a) => a.unread > 0)
      .map((a) => `${a.name}: ${a.unread}`)
      .join(", ");
    const proceed = await confirmIfUnread({
      unreadLabel: `There are ${totalUnread} unread message(s) in total (${detail}).`,
      question:
        `There are ${totalUnread} unread message(s) in total (${detail}). ` +
        `Stop ALL ${live.length} agent(s) anyway? [y/N] `,
      yes: options.yes ?? false,
      isTTY: options.isTTY ?? process.stdin.isTTY === true,
      confirm: options.confirm ?? defaultConfirm,
      out,
    });
    if (!proceed) return { killed: [] };
  }

  const killed: string[] = [];
  for (const agent of live) {
    await tmux.killSession(agent.session);
    killed.push(agent.name);
    out(`Tmux session "${agent.session}" stopped (agent ${agent.name}).`);
  }
  out(`The registrations stay in the Hub — "switchboard start <name>" reuses each name.`);
  out(hubStopInstruction());
  return { killed };
}

/** down NEVER kills the hub (PRD 11) — it instructs the human instead. */
function hubStopInstruction(): string {
  return (
    `The Hub keeps running. To stop it: Ctrl-C in the "switchboard serve" terminal ` +
    `(or "tmux kill-session -t sb-hub", if it runs in the recommended sb-hub session).`
  );
}

export function registerStopCommands(program: Command): void {
  program
    .command("stop")
    .description("Stops an agent's tmux session (the registration in the Hub stays).")
    .argument("<name>", "agent name")
    .option("--yes", "do not ask for confirmation even with unread messages")
    .action(async (name: string, opts: { yes?: boolean }) => {
      await runCliAction(() => runStop({ name, yes: opts.yes }).then(() => undefined));
    });

  program
    .command("down")
    .description("Stops the tmux sessions of ALL registered agents (the Hub stays up).")
    .option("--yes", "do not ask for confirmation even with unread messages")
    .action(async (opts: { yes?: boolean }) => {
      await runCliAction(() => runDown({ yes: opts.yes }).then(() => undefined));
    });
}
