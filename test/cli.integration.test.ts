// Light integration tests of the Phase 4 CLI (task item 8): the run* helpers
// against a REAL hub on an ephemeral port + REAL tmux, with a fake command in
// place of claude (sh/cat — a real claude is NEVER opened here; the manual
// Done When flow belongs to the orchestrator). Skipped when tmux is absent.
//
// Hygiene mirrors test/dispatcher.integration.test.ts:
// - fresh temp data dir per test (never ~/.switchboard), hub on port 0;
// - agent names carry a per-pid prefix (t4-<pid>-…) so tmux sessions become
//   sb-t4-<pid>-… — swept in afterEach/afterAll, plus a beforeAll sweep of
//   orphans left by SIGKILLed previous runs (dead pids only);
// - nothing asynchronous is asserted with blind sleeps: pollUntil everywhere.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import { createTmux, type Tmux } from "../src/server/tmux.js";
import { kickoffText, runKickoffAgent, runStart, type StartTmux } from "../src/cli/start.js";
import { runStatus } from "../src/cli/status.js";
import { runSend } from "../src/cli/send.js";
import { runDown, runStop } from "../src/cli/stop.js";
import { CliError } from "../src/cli/common.js";
import type { Agent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const NAME_PREFIX = `t4-${process.pid}-`; // agent names → sessions sb-t4-<pid>-…
const SESSION_PREFIX = `sb-${NAME_PREFIX}`;

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Polls fn until truthy or deadline (no blind sleeps). */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 10_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`Timeout (${timeoutMs}ms) esperando: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!hasTmux)("CLI Phase 4 + hub real + tmux real", () => {
  let dir: string;
  let hub: Hub;
  let tmux: Tmux;
  let out: string[];
  let kickoffSpawns: string[];

  const outFn = (line: string) => out.push(line);

  /** agents.json of the hub's data dir — the only place a token legitimately rests. */
  function storedAgents(): Agent[] {
    return JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")) as Agent[];
  }

  function storedToken(name: string): string {
    const agent = storedAgents().find((a) => a.name === name);
    if (!agent?.token) throw new Error(`token ausente para ${name} em agents.json`);
    return agent.token;
  }

  /** Common runStart args: real tmux, fake claude, captured output, spied kickoff. */
  function startArgs(name: string) {
    return {
      name,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
      spawnKickoff: (n: string) => kickoffSpawns.push(n),
    };
  }

  async function flatPane(session: string): Promise<string> {
    // 80-column panes wrap long lines; joining without separators
    // reconstructs them (same technique as the Phase 3 integration tests).
    return (await tmux.capturePane(session, 200)).split("\n").join("");
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-t4-int-"));
    hub = await startHub({ baseDir: dir, port: 0, quiet: true });
    tmux = createTmux();
    out = [];
    kickoffSpawns = [];
  });

  afterEach(async () => {
    for (const session of await tmux.listSessions(SESSION_PREFIX)) {
      await tmux.killSession(session).catch(() => {});
    }
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    // Sweep orphan sessions from SIGKILLed previous runs (dead pids only —
    // concurrent runs with live pids stay untouched).
    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const raw = createTmux();
    for (const session of await raw.listSessions("sb-t4-")) {
      const match = /^sb-t4-(\d+)-/.exec(session);
      if (match && !pidAlive(Number(match[1]))) {
        await raw.killSession(session).catch(() => {});
      }
    }
  });

  afterAll(async () => {
    const raw = createTmux();
    for (const session of await raw.listSessions(SESSION_PREFIX)) {
      await raw.killSession(session).catch(() => {});
    }
  });

  it("start: registra no hub, injeta as env vars NAME/TOKEN na sessão e NUNCA imprime o token", async () => {
    const name = NAME_PREFIX + "a";
    const result = await runStart({
      ...startArgs(name),
      role: "backend de teste",
      dir,
      // Fake claude: prints the SWITCHBOARD env vars then holds the pane open
      // (validates PRD 11 step 4 end to end without a real claude).
      claudeBin: "sh",
      claudeArgs: "-c 'printenv | grep SWITCHBOARD; exec cat'",
    });

    expect(result.tmuxSession).toBe(`sb-${name}`);
    expect(result.cwd).toBe(dir);

    // Registered BEFORE the TUI would open (D4), with the right fields and
    // NO token on the public surface.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<
      Record<string, unknown>
    >;
    const registered = agents.find((a) => a.name === name);
    expect(registered).toMatchObject({
      name,
      role: "backend de teste",
      cwd: dir,
      tmuxSession: `sb-${name}`,
    });
    expect(registered).not.toHaveProperty("token");

    // The session env carries the SAME token the register stored (v1.1).
    const token = storedToken(name);
    expect(token).toMatch(TOKEN_RE);
    await pollUntil(
      async () => (await flatPane(`sb-${name}`)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "env vars visíveis no pane (printenv)",
    );
    expect(await flatPane(`sb-${name}`)).toContain(`SWITCHBOARD_AGENT_NAME=${name}`);

    // Token never printed by the CLI; kickoff spawned detached; non-TTY
    // prints how to attach; first execution prints the 9.5 reminder.
    const printed = out.join("\n");
    expect(printed).not.toContain(token);
    expect(printed).toContain(`tmux attach -t sb-${name}`);
    expect(printed).toContain("Kickoff agendado");
    expect(printed).toContain("mcp__switchboard__*");
    expect(kickoffSpawns).toEqual([name]);

    // v1.1: the token is never LOGGED either — hub-side. The quiet hub still
    // writes <dir>/logs/hub.log, so this assertion pins the register log line
    // (a future "log the request body for debug" edit would fail here).
    expect(fs.readFileSync(path.join(dir, "logs", "hub.log"), "utf8")).not.toContain(token);
    const messagesPath = path.join(dir, "messages.jsonl");
    if (fs.existsSync(messagesPath)) {
      expect(fs.readFileSync(messagesPath, "utf8")).not.toContain(token);
    }
  }, 20_000);

  it("token NUNCA vaza quando o new-session falha depois do register (regressão v1.1)", async () => {
    const name = NAME_PREFIX + "leak";
    // StartTmux que simula o erro CRU do execFile promisificado (o cenário da
    // corrida de dois starts): message com a linha de comando completa,
    // incluindo o token ATUALMENTE VÁLIDO no store.
    const failingTmux: StartTmux = {
      async hasSession() {
        return false;
      },
      async newSession(session): Promise<void> {
        throw new Error(
          `Command failed: tmux new-session -d -s ${session} env ` +
            `SWITCHBOARD_AGENT_TOKEN=${storedToken(name)} claude\nduplicate session: ${session}`,
        );
      },
    };

    const err = await runStart({
      ...startArgs(name),
      dir,
      kickoff: false,
      tmux: failingTmux,
      claudeBin: "cat",
    }).then(
      () => undefined,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(CliError);
    const token = storedToken(name); // registro aconteceu; token regenerado ficou no store
    expect(err!.message).not.toContain(token);
    expect(String(err!.stack ?? "")).not.toContain(token);
    expect(out.join("\n")).not.toContain(token);
    // Continua diagnosticável e orienta a corrida de starts simultâneos.
    expect(err!.message).toContain("<token-redigido>");
    expect(err!.message).toMatch(/switchboard stop .*switchboard start/s);
  }, 20_000);

  it("start detecta o comando do agente morrendo no nascimento (ex.: claude fora do PATH)", async () => {
    const name = NAME_PREFIX + "natimorto";
    await expect(
      runStart({
        ...startArgs(name),
        dir,
        kickoff: false,
        claudeBin: "/nao/existe/claude-xyz",
      }),
    ).rejects.toThrow(/morreu logo após abrir/);
    // Nada de mensagens falsas de sucesso.
    expect(out.join("\n")).not.toContain("Kickoff agendado");
    expect(await tmux.hasSession(`sb-${name}`)).toBe(false);
  }, 20_000);

  it("attach com exit != 0 não finge 'Desanexado' — orienta o attach manual; exit 0 mantém a mensagem", async () => {
    const name = NAME_PREFIX + "at";
    await runStart({
      ...startArgs(name),
      dir,
      kickoff: false,
      claudeBin: "cat",
      isTTY: true,
      insideTmux: false,
      attach: async () => 1, // ex.: "open terminal failed: not a terminal" (stdin pipe)
    });
    let printed = out.join("\n");
    expect(printed).not.toContain("Desanexado");
    expect(printed).toContain("attach falhou");
    expect(printed).toContain(`tmux attach -t sb-${name}`);

    // Caminho feliz do attach (exit 0) preserva a mensagem de detach.
    out = [];
    await runStop({ name, yes: true, hubUrl: hub.url, baseDir: dir, tmux, out: outFn, isTTY: false });
    await pollUntil(async () => !(await tmux.hasSession(`sb-${name}`)), "sessão morta");
    out = [];
    await runStart({
      ...startArgs(name),
      dir,
      kickoff: false,
      claudeBin: "cat",
      isTTY: true,
      insideTmux: false,
      attach: async () => 0,
    });
    printed = out.join("\n");
    expect(printed).toContain("Desanexado");
  }, 20_000);

  it("start: recusa nome com sessão tmux já existente (P7) e não repete o lembrete de permissões", async () => {
    const name = NAME_PREFIX + "b";
    await runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" });
    expect(out.join("\n")).toContain("mcp__switchboard__*"); // primeira execução

    // Duplicate: refused with guidance (stop/attach), session left untouched.
    await expect(
      runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" }),
    ).rejects.toThrow(new RegExp(`sb-${name}" já existe[\\s\\S]*switchboard stop ${name}`));

    // Second run (another name): reminder marker suppresses the repeat.
    out = [];
    const name2 = NAME_PREFIX + "b2";
    await runStart({ ...startArgs(name2), dir, kickoff: false, claudeBin: "cat" });
    expect(out.join("\n")).not.toContain("mcp__switchboard__*");
    expect(kickoffSpawns).toEqual([]); // kickoff:false nunca agendou
  }, 20_000);

  it("send: entrega como operator e imprime o delivery; stop confirma com unread e --yes mata a sessão", async () => {
    const name = NAME_PREFIX + "c";
    await runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" });

    const sent = await runSend({
      to: name,
      message: "contrato pronto em /tmp/x.md",
      hubUrl: hub.url,
      out: outFn,
    });
    expect(sent.ok).toBe(true);
    expect(out.join("\n")).toContain(`Mensagem enviada como operator para "${name}"`);
    expect(out.join("\n")).toContain(`Delivery: ${sent.delivery}`);
    expect(hub.store.unreadCount(name)).toBe(1);

    // unread > 0: confirmation asked; answering "no" cancels (session lives).
    const questions: string[] = [];
    const denied = await runStop({
      name,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: true,
      confirm: async (q) => {
        questions.push(q);
        return false;
      },
    });
    expect(denied.killed).toBe(false);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("1 mensagem(ns) não lida(s)");
    expect(out.join("\n")).toContain("Cancelado");
    expect(await tmux.hasSession(`sb-${name}`)).toBe(true);

    // --yes skips the confirmation and kills; the registration remains.
    const confirmed = await runStop({
      name,
      yes: true,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
    });
    expect(confirmed.killed).toBe(true);
    await pollUntil(
      async () => !(await tmux.hasSession(`sb-${name}`)),
      "sessão morta após stop --yes",
    );
    expect(out.join("\n")).toContain("permanece no Hub");
    expect(hub.store.getAgent(name)).toBeDefined();
  }, 20_000);

  it("send para destinatário inexistente → erro claro do hub; stop de agente não registrado → erro claro", async () => {
    await expect(
      runSend({ to: "fantasma-inexistente", message: "oi", hubUrl: hub.url, out: outFn }),
    ).rejects.toThrow(/Destinatário desconhecido/);

    await expect(
      runStop({ name: "fantasma-inexistente", hubUrl: hub.url, baseDir: dir, tmux, out: outFn }),
    ).rejects.toThrow(/não está registrado no Hub/);
  }, 20_000);

  it("status: tabela com NAME/ROLE/STATUS/MCP/UNREAD/LAST SEEN a partir do GET /api/agents", async () => {
    const name = NAME_PREFIX + "d";
    await runStart({
      ...startArgs(name),
      role: "papel de teste",
      dir,
      kickoff: false,
      claudeBin: "cat",
    });
    await runSend({ to: name, message: "m1", hubUrl: hub.url, out: () => {} });

    out = [];
    await runStatus({ hubUrl: hub.url, out: outFn });
    const table = out.join("\n");
    expect(table).toMatch(/NAME\s+ROLE\s+STATUS\s+MCP\s+UNREAD\s+LAST SEEN/);
    expect(table).toMatch(new RegExp(`${name}\\s+papel de teste\\s+\\w+\\s+não\\s+1\\s+`));
  }, 20_000);

  it("down: mata TODAS as sessões vivas (confirmação agregada com --yes) e NÃO mata o hub", async () => {
    const nameA = NAME_PREFIX + "e1";
    const nameB = NAME_PREFIX + "e2";
    await runStart({ ...startArgs(nameA), dir, kickoff: false, claudeBin: "cat" });
    await runStart({ ...startArgs(nameB), dir, kickoff: false, claudeBin: "cat" });
    await runSend({ to: nameA, message: "pendente", hubUrl: hub.url, out: () => {} });

    out = [];
    const result = await runDown({
      yes: true,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
    });
    expect(result.killed.sort()).toEqual([nameA, nameB].sort());
    expect(await tmux.hasSession(`sb-${nameA}`)).toBe(false);
    expect(await tmux.hasSession(`sb-${nameB}`)).toBe(false);

    // The hub survives — down only instructs how to stop it.
    expect(out.join("\n")).toContain("O Hub continua rodando");
    const health = (await (await fetch(`${hub.url}/api/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
  }, 20_000);

  it("stop/down usam o tmuxSession REGISTRADO, não prefix+name recomputado", async () => {
    // Registro via REST com tmuxSession custom (≠ sb-<name>) e sessão real
    // viva nesse nome: o stop tem que matar A SESSÃO REGISTRADA.
    const name = NAME_PREFIX + "custom";
    const customSession = `${SESSION_PREFIX}sessao-custom`;
    await tmux.newSession(customSession, dir, "cat");
    const res = await fetch(`${hub.url}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, cwd: dir, tmuxSession: customSession }),
    });
    expect(res.status).toBe(201);

    const result = await runStop({
      name,
      yes: true,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
    });
    expect(result.killed).toBe(true);
    expect(out.join("\n")).toContain(`"${customSession}" encerrada`);
    await pollUntil(
      async () => !(await tmux.hasSession(customSession)),
      "sessão custom registrada morta após stop",
    );
  }, 20_000);

  it("stop com não lidas, sem TTY e sem --yes → CliError instrutiva (--yes) e sessão intacta", async () => {
    const name = NAME_PREFIX + "g1";
    await runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" });
    await runSend({ to: name, message: "pendente", hubUrl: hub.url, out: () => {} });

    await expect(
      runStop({ name, hubUrl: hub.url, baseDir: dir, tmux, out: outFn, isTTY: false }),
    ).rejects.toThrow(/--yes/);
    expect(await tmux.hasSession(`sb-${name}`)).toBe(true);
  }, 20_000);

  it("down com confirmação negada → killed:[] e nenhuma sessão morta", async () => {
    const nameA = NAME_PREFIX + "g2";
    const nameB = NAME_PREFIX + "g3";
    await runStart({ ...startArgs(nameA), dir, kickoff: false, claudeBin: "cat" });
    await runStart({ ...startArgs(nameB), dir, kickoff: false, claudeBin: "cat" });
    await runSend({ to: nameA, message: "pendente", hubUrl: hub.url, out: () => {} });

    const result = await runDown({
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: true,
      confirm: async () => false,
    });
    expect(result.killed).toEqual([]);
    expect(out.join("\n")).toContain("Cancelado");
    expect(await tmux.hasSession(`sb-${nameA}`)).toBe(true);
    expect(await tmux.hasSession(`sb-${nameB}`)).toBe(true);
  }, 20_000);

  it("stop de agente registrado com sessão já morta → 'já estava parado' + lembrete do registro", async () => {
    const name = NAME_PREFIX + "g4";
    // Registro sem sessão tmux nenhuma (só REST).
    const res = await fetch(`${hub.url}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, cwd: dir }),
    });
    expect(res.status).toBe(201);

    const result = await runStop({
      name,
      yes: true,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
    });
    expect(result.killed).toBe(true);
    const printed = out.join("\n");
    expect(printed).toContain("já estava parado");
    expect(printed).toContain("permanece no Hub");
  }, 20_000);

  it("Ctrl-C na confirmação (AbortError do readline) → cancelamento limpo, sem stack", async () => {
    const name = NAME_PREFIX + "g5";
    await runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" });
    await runSend({ to: name, message: "pendente", hubUrl: hub.url, out: () => {} });

    const result = await runStop({
      name,
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: true,
      confirm: async () => {
        // Exatamente o que readline/promises rejeita num Ctrl-C real.
        const err = new Error("Aborted with Ctrl+C");
        err.name = "AbortError";
        throw err;
      },
    });
    expect(result.killed).toBe(false);
    expect(out.join("\n")).toContain("Cancelado");
    expect(await tmux.hasSession(`sb-${name}`)).toBe(true);
  }, 20_000);

  it("re-attach sem --role preserva o role registrado (PRD 8: registro reaproveitado, não zerado)", async () => {
    const name = NAME_PREFIX + "role";
    await runStart({
      ...startArgs(name),
      role: "backend da API",
      dir,
      kickoff: false,
      claudeBin: "cat",
    });
    await runStop({ name, yes: true, hubUrl: hub.url, baseDir: dir, tmux, out: outFn, isTTY: false });
    await pollUntil(async () => !(await tmux.hasSession(`sb-${name}`)), "sessão morta pós-stop");

    // start SEM --role (o caso normal de re-attach).
    await runStart({ ...startArgs(name), dir, kickoff: false, claudeBin: "cat" });
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<{
      name: string;
      role: string;
    }>;
    expect(agents.find((a) => a.name === name)?.role).toBe("backend da API");
  }, 20_000);

  it("kickoff real: espera a readiness da TUI e injeta o texto EXATO via caminho com guarda", async () => {
    // Un-registered session running cat (kickoff talks only to tmux): the
    // pane starts WITHOUT readiness markers, so the kickoff must WAIT.
    const name = NAME_PREFIX + "k";
    const session = `sb-${name}`;
    await tmux.newSession(session, dir, "cat");

    const kickoff = runKickoffAgent({
      name,
      session,
      baseDir: dir,
      tmux,
      delayMs: 200,
      enterDelayMs: 500,
      readinessPollMs: 100,
      readinessTimeoutMs: 8_000,
    });

    // While not ready, nothing may be typed. Give the poll a few rounds.
    await new Promise((r) => setTimeout(r, 800));
    expect(await flatPane(session)).not.toContain("[switchboard]");

    // Simulate the TUI becoming ready: the marker line appears in the pane
    // (cat echoes it — same marker spike 0.3 observed in the real claude).
    await tmux.sendKeysLiteral(session, "? for shortcuts");
    await tmux.sendEnter(session);

    const result = await kickoff;
    expect(result.sent).toBe(true);

    // The EXACT one-line kickoff text was typed AND submitted (echo + cat
    // output = 2 occurrences, same PASS criterion as spike 0.2) — no token.
    // Comparison ignores spaces: an 80-col pane trims the trailing space at
    // wrap boundaries in capture-pane output (verified live), so the match is
    // "every non-space character in exact order", which wrap cannot fake.
    const expected = kickoffText(name).replaceAll(" ", "");
    await pollUntil(async () => {
      const flat = (await flatPane(session)).replaceAll(" ", "");
      return flat.split(expected).length - 1 >= 2;
    }, "texto do kickoff visível 2x no pane (eco + saída do cat pós-Enter)");
    expect(await flatPane(session)).not.toMatch(/TOKEN/);
  }, 20_000);
});
