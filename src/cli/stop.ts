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

/** Terminal yes/no prompt ("s"/"sim" confirms). Injectable for tests. */
export type ConfirmFn = (question: string) => Promise<boolean>;

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^s(im)?$/i.test(answer.trim());
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
      `${input.unreadLabel} Sem terminal interativo para confirmar — repita com --yes para forçar.`,
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
      input.out("Cancelado — nada foi parado.");
      return false;
    }
    throw err;
  }
  if (confirmed) return true;
  input.out("Cancelado — nada foi parado.");
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
    `O registro do agente "${name}" permanece no Hub — um próximo ` +
    `"switchboard start ${name}" reaproveita o nome (re-attach).`
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
      `Agente "${options.name}" não está registrado no Hub. ` +
        `Registrados: ${names.length > 0 ? names.join(", ") : "(nenhum)"}.`,
    );
  }

  if (agent.unreadCount > 0) {
    const proceed = await confirmIfUnread({
      unreadLabel: `O agente "${agent.name}" tem ${agent.unreadCount} mensagem(ns) não lida(s).`,
      question:
        `O agente "${agent.name}" tem ${agent.unreadCount} mensagem(ns) não lida(s). ` +
        `Parar mesmo assim? [s/N] `,
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
  // the recomputed name miss the LIVE session and report "já estava parado"
  // while the hub keeps nudging it.
  const session = agent.tmuxSession;
  const tmux: StopTmux = options.tmux ?? createTmux();
  if (await tmux.hasSession(session)) {
    await tmux.killSession(session);
    out(`Sessão tmux "${session}" encerrada.`);
  } else {
    out(`A sessão tmux "${session}" não existe — o agente já estava parado.`);
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
    out("Nenhum agente com sessão tmux viva para parar.");
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
      unreadLabel: `Há ${totalUnread} mensagem(ns) não lida(s) no total (${detail}).`,
      question:
        `Há ${totalUnread} mensagem(ns) não lida(s) no total (${detail}). ` +
        `Parar TODOS os ${live.length} agente(s) mesmo assim? [s/N] `,
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
    out(`Sessão tmux "${agent.session}" encerrada (agente ${agent.name}).`);
  }
  out(`Os registros permanecem no Hub — "switchboard start <nome>" reaproveita cada nome.`);
  out(hubStopInstruction());
  return { killed };
}

/** down NEVER kills the hub (PRD 11) — it instructs the human instead. */
function hubStopInstruction(): string {
  return (
    `O Hub continua rodando. Para pará-lo: Ctrl-C no terminal do "switchboard serve" ` +
    `(ou "tmux kill-session -t sb-hub", se ele roda na sessão recomendada sb-hub).`
  );
}

export function registerStopCommands(program: Command): void {
  program
    .command("stop")
    .description("Encerra a sessão tmux de um agente (o registro no Hub permanece).")
    .argument("<name>", "nome do agente")
    .option("--yes", "não pedir confirmação mesmo com mensagens não lidas")
    .action(async (name: string, opts: { yes?: boolean }) => {
      await runCliAction(() => runStop({ name, yes: opts.yes }).then(() => undefined));
    });

  program
    .command("down")
    .description("Encerra as sessões tmux de TODOS os agentes registrados (o Hub continua no ar).")
    .option("--yes", "não pedir confirmação mesmo com mensagens não lidas")
    .action(async (opts: { yes?: boolean }) => {
      await runCliAction(() => runDown({ yes: opts.yes }).then(() => undefined));
    });
}
