// `switchboard start <name>` (PRD section 11) — the command the user runs
// instead of opening `claude` by hand — plus the hidden `kickoff-agent`
// subcommand that the detached kickoff process re-enters through.
//
// Sequence (PRD 11, steps 1-6):
//   1. validate the name (same regex as the store) + hub alive on /api/health;
//   2. refuse if the tmux session already exists (pitfall P7);
//   3. POST /api/agents/register → capability token (v1.1). The token is kept
//      in a local variable, injected into the session env and NEVER printed,
//      logged or returned;
//   4. tmux new-session (via tmux.ts, argv as ARRAY) running
//      `env SWITCHBOARD_AGENT_NAME=<name> SWITCHBOARD_AGENT_TOKEN=<token>
//       claude <claude-args>`; prints the section 9.5 permissions reminder on
//      the first execution (P10);
//   5. TTY → tmux attach (interactive; see defaultAttach for the sanctioned
//      exception to "all tmux via tmux.ts"); no TTY / already inside tmux →
//      prints how to attach;
//   6. kickoff (default ON, --no-kickoff disables): a DETACHED process (the
//      attach of step 5 blocks this terminal) that waits kickoffDelayMs, then
//      polls the TUI for READINESS and only then injects the kickoff line via
//      the guarded nudge path (tmux.nudgeSession).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { defaultBaseDir, loadConfig } from "../server/config.js";
import { AGENT_NAME_RE } from "../server/store.js";
import { createTmux, type NudgeResult, type Tmux } from "../server/tmux.js";
import type { PublicAgent } from "../shared/types.js";
import {
  CliError,
  checkHubHealth,
  defaultHubUrl,
  hubPost,
  runCliAction,
  type OutFn,
} from "./common.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/cli.test.ts).
// ---------------------------------------------------------------------------

/**
 * Splits the --claude-args string into argv elements. DECISION (documented as
 * the task demands): no external lib and no `sh -c` passthrough — a simple
 * quote-aware splitter covering the practical subset: tokens separated by
 * whitespace; '…' and "…" group a token (quotes stripped, whitespace
 * preserved); NO escape processing inside quotes (this is not a shell).
 * Unterminated quote → clear error instead of silently guessing. Each element
 * then travels with exact argv semantics through tmux.newSession(array) —
 * see quoteShellArg in tmux.ts.
 */
export function parseClaudeArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const args: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCurrent = true; // '' counts as an (empty) token
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        args.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (quote !== null) {
    throw new CliError(
      `--claude-args com aspas (${quote}) não fechadas: ${raw}\n` +
        `Feche as aspas — ex.: --claude-args "--model opus --append-system-prompt 'texto com espaços'"`,
    );
  }
  if (hasCurrent) args.push(current);
  return args;
}

/**
 * argv (PRD 11 step 4): `env SWITCHBOARD_AGENT_NAME=<name>
 * SWITCHBOARD_AGENT_TOKEN=<token> claude <claude-args>`. Built as an ARRAY —
 * tmux.newSession preserves each element as one argv of the final process.
 * The token rides ONLY here (env of the agent's session, per the v1.1
 * addendum); callers must never print/log this array. `claudeArgs` accepts
 * the raw --claude-args string OR a pre-parsed argv array — runStart
 * pre-parses in step 1a so bad quoting fails BEFORE the register mutates the
 * hub. `claudeBin` is a test-only injection point (integration tests run
 * `sh`/`cat` instead of a real claude — PRD: "NÃO abra claude real nos
 * testes").
 */
export function buildAgentCommand(input: {
  name: string;
  token: string;
  claudeArgs?: string | string[];
  claudeBin?: string;
}): string[] {
  const extraArgs = Array.isArray(input.claudeArgs)
    ? input.claudeArgs
    : parseClaudeArgs(input.claudeArgs);
  return [
    "env",
    `SWITCHBOARD_AGENT_NAME=${input.name}`,
    `SWITCHBOARD_AGENT_TOKEN=${input.token}`,
    input.claudeBin ?? "claude",
    ...extraArgs,
  ];
}

/**
 * EXACT kickoff text from PRD 11 step 6 — one line, never contains the token
 * (the agent reads it from its own env, as the join tool description says).
 */
export function kickoffText(name: string): string {
  return (
    `[switchboard] Você é o agente '${name}' nesta rede local de agentes. ` +
    `Confirme chamando a tool join com agent_name="${name}". ` +
    `Depois continue seu trabalho normalmente; quando receber notificações [switchboard], use check_messages.`
  );
}

/**
 * TUI readiness detection (spikes/NOTES.md, spike 0.3): a ready Claude Code
 * pane shows "? for shortcuts" under the input box, whose left border renders
 * as "│ >". While the trust dialog is up ("Quick safety check: Is this a
 * project you created or one you trust?") NONE of these markers are present —
 * and a blind kickoff there would type into a MENU where digits select options.
 *
 * IMPORTANT (observed with claude 2.1.205): a non-default permission mode
 * REPLACES "? for shortcuts" in the footer. Under `--permission-mode
 * bypassPermissions` the footer reads "⏵⏵ bypass permissions on (shift+tab to
 * cycle)" and "? for shortcuts" never appears — so we ALSO accept the
 * permission-mode footer markers, otherwise the kickoff of a bypass-mode agent
 * (the setup section 9.5 explicitly says is "already covered") would time out
 * and never fire. None of these strings appear in the trust dialog.
 */
export function isTuiReady(pane: string): boolean {
  return (
    pane.includes("? for shortcuts") || // default footer
    pane.includes("│ >") || // legacy input-box left border
    pane.includes("shift+tab to cycle") || // any non-default permission mode
    pane.includes("bypass permissions on") ||
    pane.includes("accept edits on") ||
    pane.includes("plan mode on")
  );
}

// ---------------------------------------------------------------------------
// Kickoff runner (the detached `switchboard kickoff-agent <name>` process).
// ---------------------------------------------------------------------------

/** Narrow tmux surface the kickoff needs (injectable for unit tests). */
export interface KickoffTmux {
  hasSession(session: string): Promise<boolean>;
  capturePane(session: string, lines?: number): Promise<string>;
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
}

export interface KickoffOptions {
  name: string;
  /** Session override (default: config.tmuxSessionPrefix + name). */
  session?: string;
  /** Config dir (default ~/.switchboard). */
  baseDir?: string;
  tmux?: KickoffTmux;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Initial wait before the first readiness poll (default config.kickoffDelayMs). */
  delayMs?: number;
  /** Delay between kickoff text and Enter (default config.nudgeEnterDelayMs). */
  enterDelayMs?: number;
  /** Extra readiness budget after the initial delay (default 60s). */
  readinessTimeoutMs?: number;
  /** Readiness poll cadence (default 2s). */
  readinessPollMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits kickoffDelayMs, then polls the pane for TUI readiness and ONLY THEN
 * injects the kickoff line through the guarded nudge path (tmux.nudgeSession:
 * pane-command allow-list, -l/--, separate Enter, TOCTOU re-check).
 *
 * Why the readiness poll exists (spikes/NOTES.md, spike 0.3, wording of
 * claude 2.1.205): in a --dir never trusted before, the TUI sits on the
 * "Quick safety check: Is this a project you created or one you trust?"
 * dialog — a BLIND kickoff after the 8s delay would type text into a menu
 * where DIGITS SELECT OPTIONS. So after the delay we capture-pane every 2s
 * for up to ~60 extra seconds looking for the readiness markers observed in
 * the spike ("? for shortcuts" / "│ >") and give up (message stays queued for
 * a manual join) if they never appear. The pane guard is NOT a substitute for
 * this: the trust dialog runs inside the claude process, so the guard alone
 * would happily type into it.
 */
export async function runKickoffAgent(options: KickoffOptions): Promise<NudgeResult> {
  const config = loadConfig(options.baseDir);
  const session = options.session ?? config.tmuxSessionPrefix + options.name;
  const tmux = options.tmux ?? createTmux();
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const delayMs = options.delayMs ?? config.kickoffDelayMs;
  const enterDelayMs = options.enterDelayMs ?? config.nudgeEnterDelayMs;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const readinessPollMs = options.readinessPollMs ?? 2_000;

  await sleep(delayMs);

  const deadline = now() + readinessTimeoutMs;
  for (;;) {
    if (!(await tmux.hasSession(session))) {
      return {
        sent: false,
        reason: `sessão "${session}" não existe mais — kickoff cancelado`,
      };
    }
    let pane = "";
    try {
      pane = await tmux.capturePane(session, 200);
    } catch {
      pane = ""; // pane unreadable this round — treated as not ready
    }
    if (isTuiReady(pane)) break;
    if (now() >= deadline) {
      return {
        sent: false,
        reason:
          `TUI do claude não ficou pronta em ${readinessTimeoutMs}ms após o delay inicial ` +
          `(diálogo de confiança pendente? aceite-o no attach) — kickoff não enviado; ` +
          `o agente pode chamar a tool join manualmente`,
      };
    }
    await sleep(readinessPollMs);
  }

  // Guarded nudge path (PRD 11 step 6: "mesma função do dispatcher, com a
  // mesma guarda de pane"). Text is one line by construction; no token.
  return tmux.nudgeSession(session, kickoffText(options.name), enterDelayMs);
}

// ---------------------------------------------------------------------------
// start runner.
// ---------------------------------------------------------------------------

/** Narrow tmux surface `start` needs (injectable for integration tests). */
export interface StartTmux {
  hasSession(session: string): Promise<boolean>;
  newSession(session: string, cwd: string, cmd?: string | string[]): Promise<void>;
}

export interface StartOptions {
  name: string;
  role?: string;
  /** Working dir for the agent (default: process.cwd()); "~" is expanded. */
  dir?: string;
  /** Kickoff on/off (default true; --no-kickoff sets false). */
  kickoff?: boolean;
  claudeArgs?: string;
  // -- injectables (index.ts uses the defaults; tests override) --------------
  hubUrl?: string;
  /** Config + permissions-reminder marker dir (default ~/.switchboard). */
  baseDir?: string;
  tmux?: StartTmux;
  out?: OutFn;
  isTTY?: boolean;
  /** Running inside tmux already? (default: !!process.env.TMUX). */
  insideTmux?: boolean;
  /**
   * Interactive attach (default: spawn tmux attach with stdio inherit).
   * Resolves with the attach exit code — non-zero means the attach FAILED
   * (e.g. stdin is a pipe: "open terminal failed") and the user never saw
   * the session, so runStart prints how to attach instead of "Desanexado".
   */
  attach?: (session: string) => Promise<number | void>;
  /** Detached kickoff spawner (default: re-enters via `kickoff-agent`). */
  spawnKickoff?: (name: string, session: string) => void;
  /** Injectable sleep (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Post-create liveness settle window in ms (default START_SETTLE_MS). */
  settleMs?: number;
  /** TEST-ONLY: binary in place of "claude" (never open a real claude in tests). */
  claudeBin?: string;
}

/** Expands a leading "~" (the shell does not expand it inside --dir values). */
function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/**
 * Section 9.5 permissions reminder (pitfall P10), printed on the FIRST
 * execution only — tracked by a marker file in the data dir.
 */
export const REMINDER_MARKER = ".start-permissions-reminder-shown";

function printPermissionsReminderOnce(baseDir: string, out: OutFn): void {
  const marker = path.join(baseDir, REMINDER_MARKER);
  if (fs.existsSync(marker)) return;
  out(
    `Lembrete de permissões (só nesta primeira execução): para as tools do Switchboard ` +
      `rodarem sem prompt de aprovação a cada uso, adicione a allow rule "mcp__switchboard__*" ` +
      `nas permissions do settings.json do Claude Code. Quem usa bypassPermissions já está coberto.`,
  );
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + "\n");
  } catch {
    // Marker write failure only means the reminder repeats — never fatal.
  }
}

/**
 * DOCUMENTED EXCEPTION to "the CLI never runs tmux outside tmux.ts": attach
 * is INTERACTIVE — it takes over the user's terminal until detach — so it
 * cannot go through execFile (which buffers stdio). spawn with stdio
 * "inherit", args as an array (P9 still holds: no string interpolation), and
 * the exact-match "=" target from the spike findings.
 */
function defaultAttach(session: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", ["attach-session", "-t", `=${session}`], {
      stdio: "inherit",
    });
    child.on("error", reject);
    // Resolve WITH the exit code: `tmux attach` fails immediately when the
    // terminal is not usable ("open terminal failed: not a terminal") or the
    // session died — swallowing that would make runStart print "Desanexado…
    // continua rodando" for a session the user never saw.
    child.on("exit", (code, signal) => resolve(signal !== null ? 1 : (code ?? 1)));
  });
}

/**
 * Default kickoff spawner: a DETACHED re-entry into this same CLI
 * (`switchboard kickoff-agent <name>`, hidden command) — detached + unref +
 * stdio ignore, because the attach in step 5 blocks this terminal and the
 * kickoff must keep running behind it (and survive the CLI exiting). Re-entry
 * uses process.execPath + process.execArgv, which carry the tsx loader flags
 * (verified: tsx re-execs node with --require/--import in execArgv), so the
 * .ts entry resolves without a build step.
 */
function defaultSpawnKickoff(name: string, session: string, out: OutFn = console.log): void {
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "kickoff-agent", name, session],
    { detached: true, stdio: "ignore" },
  );
  // spawn failures (EMFILE/ENOMEM/EAGAIN under pressure) are emitted
  // ASYNCHRONOUSLY as an "error" event — without a handler they would crash
  // the whole start AFTER its success output. The kickoff is best-effort:
  // warn and move on (same language as runKickoffAgent when it gives up).
  child.on("error", () => {
    out(
      `Não foi possível agendar o kickoff (falha ao criar o processo em background) — ` +
        `o agente pode chamar a tool join manualmente.`,
    );
  });
  child.unref();
}

interface RegisterResponse {
  ok: boolean;
  agent: PublicAgent;
  token: string;
}

export interface StartResult {
  tmuxSession: string;
  cwd: string;
}

/**
 * Settle window after new-session: enough for `sh -c` + env to fail on a
 * missing binary/bad args (probe: dies in <1s, usually instantly) without
 * making every start sluggish.
 */
export const START_SETTLE_MS = 400;

/** Shared guidance for the concurrent-start race (two starts, same name). */
function concurrentStartHint(name: string): string {
  return (
    `Se outro "switchboard start ${name}" rodou ao mesmo tempo, atenção: ESTE registro ` +
    `regenerou o token do agente, então o join da sessão que sobreviveu vai falhar. ` +
    `Rode "switchboard stop ${name}" e depois um novo "switchboard start ${name}".`
  );
}

export async function runStart(options: StartOptions): Promise<StartResult> {
  const out = options.out ?? console.log;
  const name = options.name;

  // 1a. Name validation — same regex as the store (fail fast, before HTTP).
  if (!AGENT_NAME_RE.test(name)) {
    throw new CliError(
      `Nome de agente inválido: "${name}". Use minúsculas, dígitos e hífens ` +
        `(2 a 31 caracteres, começando com letra ou dígito): ^[a-z0-9][a-z0-9-]{1,30}$`,
    );
  }

  // 1a. --claude-args parse also fails fast, BEFORE any HTTP: parsing only in
  // step 4 would leave a ghost registration (agent registered, token
  // regenerated, no session) when the quoting is bad.
  const claudeArgs = parseClaudeArgs(options.claudeArgs);

  // Working dir must exist — tmux new-session -c with a bad dir fails late
  // and cryptically; fail here with a clear message instead.
  const cwd = path.resolve(expandHome(options.dir ?? process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CliError(`Diretório não existe: ${cwd} (flag --dir).`);
  }

  // 1a. "sb-hub" is reserved for the Hub itself: serveHeaderLines and the
  // stop/down instructions tell the human to run/kill `switchboard serve`
  // in that exact session — an agent named to collide with it would either
  // get killed by those instructions or produce a misleading P7 error.
  const config = loadConfig(options.baseDir);
  const tmuxSession = config.tmuxSessionPrefix + name;
  if (tmuxSession === "sb-hub") {
    throw new CliError(
      `O nome "${name}" geraria a sessão tmux "sb-hub", reservada para o próprio Hub ` +
        `(a recomendação do "switchboard serve" é rodar dentro dela). Escolha outro nome de agente.`,
    );
  }

  // 1b. Hub alive? (clear "rode switchboard serve primeiro" error otherwise).
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl);

  // 2. Refuse an existing session (P7): never two starts on the same name.
  const tmux: StartTmux = options.tmux ?? createTmux();
  if (await tmux.hasSession(tmuxSession)) {
    throw new CliError(
      `A sessão tmux "${tmuxSession}" já existe — o agente "${name}" parece estar rodando. ` +
        `Para vê-lo: tmux attach -t ${tmuxSession}. ` +
        `Para encerrar e recomeçar: switchboard stop ${name} e depois rode o start de novo.`,
    );
  }

  // 3. Register BEFORE the TUI opens (D4). The response carries the
  // capability token (v1.1) — kept local, injected via env below, NEVER
  // printed or logged (neither here nor hub-side). `role` travels only when
  // the flag was given: a re-attach without --role must PRESERVE the
  // registered role (PRD 8: the registration is reused, not zeroed).
  const registration = await hubPost<RegisterResponse>(hubUrl, "/api/agents/register", {
    name,
    role: options.role,
    cwd,
    tmuxSession,
  });
  const token = registration.token;

  // 3b. TOCTOU re-check (P7): a concurrent start may have created the session
  // during the register HTTP round-trip — fail cleanly BEFORE new-session.
  if (await tmux.hasSession(tmuxSession)) {
    throw new CliError(
      `A sessão tmux "${tmuxSession}" surgiu durante o registro. ` + concurrentStartHint(name),
    );
  }

  // 4. Detached session running env + claude, argv as ARRAY (exact argv
  // semantics survive tmux — see tmux.newSession/quoteShellArg). Failures are
  // converted to CliError with the token REDACTED: a raw execFile error would
  // carry the full command line (with SWITCHBOARD_AGENT_TOKEN) to stderr via
  // the generic runCliAction branch (tmux.ts also sanitizes at the source;
  // this is defense in depth for any StartTmux implementation).
  try {
    await tmux.newSession(
      tmuxSession,
      cwd,
      buildAgentCommand({
        name,
        token,
        claudeArgs,
        claudeBin: options.claudeBin,
      }),
    );
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err))
      .split(token)
      .join("<token-redigido>");
    throw new CliError(
      `Falha ao criar a sessão tmux "${tmuxSession}": ${detail}\n` + concurrentStartHint(name),
    );
  }

  // 4b. The command may die at birth (typical: "claude" not on PATH, or bad
  // --claude-args) and take the session with it — reporting success there
  // would be a lie. Give it a settle window and re-check.
  const sleep = options.sleep ?? realSleep;
  await sleep(options.settleMs ?? START_SETTLE_MS);
  if (!(await tmux.hasSession(tmuxSession))) {
    throw new CliError(
      `A sessão tmux "${tmuxSession}" morreu logo após abrir — o comando do agente falhou ` +
        `no nascimento. O binário "claude" está no PATH? Os --claude-args são válidos? ` +
        `O registro do agente permanece no Hub; corrija e rode "switchboard start ${name}" de novo.`,
    );
  }

  out(`Agente "${name}" registrado no Hub e sessão tmux "${tmuxSession}" criada em ${cwd}.`);
  printPermissionsReminderOnce(options.baseDir ?? defaultBaseDir(), out);

  // 6 (spawned BEFORE the blocking attach of step 5): detached kickoff.
  const kickoff = options.kickoff ?? true;
  if (kickoff) {
    const spawnKickoff =
      options.spawnKickoff ?? ((n: string, s: string) => defaultSpawnKickoff(n, s, out));
    spawnKickoff(name, tmuxSession);
    out(
      `Kickoff agendado: em ~${Math.round(config.kickoffDelayMs / 1000)}s (quando a TUI estiver pronta) ` +
        `o agente será instruído a chamar a tool join. Use --no-kickoff para desativar.`,
    );
  }

  // 5. Attach (TTY) or print how to attach.
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const insideTmux = options.insideTmux ?? process.env.TMUX !== undefined;
  if (isTTY && !insideTmux) {
    const attachExit = (await (options.attach ?? defaultAttach)(tmuxSession)) ?? 0;
    if (attachExit === 0) {
      out(
        `Desanexado da sessão "${tmuxSession}". O agente continua rodando em background; ` +
          `use "switchboard stop ${name}" para encerrá-lo.`,
      );
    } else {
      // Attach failed (e.g. stdin is a pipe — "open terminal failed"): the
      // user never entered the session, so say how to attach for real.
      out(
        `O tmux attach falhou (exit ${attachExit}) — terminal não interativo? ` +
          `Para acompanhar o agente: tmux attach -t ${tmuxSession}. ` +
          `Estado dos agentes: switchboard status.`,
      );
    }
  } else if (isTTY) {
    // Inside tmux already (env TMUX set): nesting attach breaks the terminal.
    out(
      `Você já está dentro de uma sessão tmux — attach aninhado não é suportado. ` +
        `Em outra aba/terminal, rode: tmux attach -t ${tmuxSession}`,
    );
  } else {
    out(`Sessão criada em background. Para acompanhar o agente: tmux attach -t ${tmuxSession}`);
  }

  return { tmuxSession, cwd };
}

// ---------------------------------------------------------------------------
// commander wiring.
// ---------------------------------------------------------------------------

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description(
      "Registra um agente no Hub e abre o Claude Code dele numa sessão tmux dedicada.",
    )
    .argument("<name>", "nome do agente (minúsculas, dígitos e hífens)")
    // NO default value for --role: `role: undefined` means "flag omitted" and
    // the register then PRESERVES the role already stored (re-attach, PRD 8);
    // a default "" would silently erase it on every start without --role.
    .option("--role <descrição>", "papel do agente (ex.: \"backend da API\")")
    .option("--dir <dir>", "diretório de trabalho do agente (default: diretório atual)")
    .option("--no-kickoff", "não injetar a instrução automática de join após abrir")
    .option(
      "--claude-args <args>",
      "argumentos extras para o claude (aspas simples/duplas agrupam)",
    )
    .action(
      async (
        name: string,
        opts: { role?: string; dir?: string; kickoff: boolean; claudeArgs?: string },
      ) => {
        await runCliAction(() =>
          runStart({
            name,
            role: opts.role,
            dir: opts.dir,
            kickoff: opts.kickoff,
            claudeArgs: opts.claudeArgs,
          }).then(() => undefined),
        );
      },
    );
}

/**
 * Hidden re-entry command for the detached kickoff process (see
 * defaultSpawnKickoff). Not part of the public CLI surface (PRD 11) — hence
 * hidden — but running it by hand is harmless: it just waits for readiness
 * and nudges once through the guarded path.
 */
export function registerKickoffAgentCommand(program: Command): void {
  program
    // [session] carries the tmux session the start REGISTERED (source of
    // truth) — recomputing prefix+name here could diverge if the config
    // changed between the spawn and this process reading it.
    .command("kickoff-agent <name> [session]", { hidden: true })
    .description("(interno) espera a TUI ficar pronta e injeta a instrução de join")
    .action(async (name: string, session?: string) => {
      await runCliAction(async () => {
        const result = await runKickoffAgent({ name, session });
        if (!result.sent) {
          // Detached process: stdio is ignored in production, but log anyway
          // for the manual/debug invocation path.
          console.error(`kickoff-agent ${name}: não enviado — ${result.reason ?? "motivo desconhecido"}`);
          process.exitCode = 1;
        }
      });
    });
}
