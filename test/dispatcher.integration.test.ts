// Integration tests of the Phase 3 dispatcher with REAL tmux (PRD section 16,
// Phase 3 Done When + section 18). Skipped automatically when tmux is absent.
//
// - Test sessions use their own prefix (sb-t3-<pid>-) and are ALWAYS killed
//   in teardown, including on failure (afterEach + afterAll sweep).
// - No hub/HTTP here: the dispatcher is exercised directly through
//   deliverMessage (the exact production path of api.ts/mcp.ts), with a real
//   Store on a temp dir and a REAL tmux wrapper whose ExecFn is wrapped by a
//   recording spy — real behavior plus exact send-keys accounting.
// - No timers are started: pollOnce/flushPending are invoked directly.
//   Anything asynchronous is polled with a deadline (no blind sleeps).
// - NEVER uses ports 4577/4578 (no ports at all, in fact).

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTmux, type ExecFn, type Tmux } from "../src/server/tmux.js";
import { Dispatcher } from "../src/server/dispatcher.js";
import { Store } from "../src/server/store.js";
import { Logger } from "../src/server/log.js";
import { EventBus, deliverMessage } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import type { SseEvent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const PREFIX = `sb-t3-${process.pid}-`;

const execFileAsync = promisify(execFile);
const realExec: ExecFn = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
  return { stdout, stderr };
};

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

describe.skipIf(!hasTmux)("dispatcher + tmux real (Done When da Phase 3)", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let events: SseEvent[];
  let execCalls: string[][];
  let tmux: Tmux;
  let dispatcher: Dispatcher;
  let createdSessions: string[];

  /** send-keys calls (from the spy) aimed at a given session pane target. */
  const sendKeysCallsFor = (session: string) =>
    execCalls.filter((args) => args[0] === "send-keys" && args.includes(`=${session}:`));
  const literalSendKeysFor = (session: string) =>
    sendKeysCallsFor(session).filter((args) => args.includes("-l"));

  async function newTestSession(name: string, cmd?: string): Promise<string> {
    const session = PREFIX + name;
    createdSessions.push(session);
    await tmux.newSession(session, dir, cmd);
    return session;
  }

  function register(name: string, session: string): void {
    store.registerAgent({ name, role: "", tmuxSession: session, cwd: dir });
  }

  function sendToAgent(to: string, body: string) {
    return deliverMessage(store, bus, dispatcher.onNewMessage, {
      from: "operator",
      to,
      body,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-t3-int-"));
    store = new Store(dir, { info() {}, warn() {} });
    bus = new EventBus();
    events = [];
    bus.subscribe((event) => events.push(event));
    execCalls = [];
    const recordingExec: ExecFn = (file, args) => {
      execCalls.push([...args]);
      return realExec(file, args);
    };
    tmux = createTmux({ exec: recordingExec });
    dispatcher = new Dispatcher({
      store,
      config: { ...DEFAULTS },
      log: new Logger({ stdout: false, filePath: path.join(dir, "hub.log") }),
      bus,
      tmux,
    });
    createdSessions = [];
  });

  afterEach(async () => {
    dispatcher.stop();
    for (const session of createdSessions) {
      await tmux.killSession(session).catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    // Sweep de sessões ÓRFÃS de runs anteriores: se um run morreu por SIGKILL
    // (afterEach/afterAll nunca rodaram), sobram sessões sb-t3-<pid>- que
    // nenhum run futuro varreria (o PREFIX embute o pid). Aqui matamos apenas
    // as de pids MORTOS — runs concorrentes (pids vivos) ficam intactos.
    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const raw = createTmux();
    for (const session of await raw.listSessions("sb-t3-")) {
      const match = /^sb-t3-(\d+)-/.exec(session);
      if (match && !pidAlive(Number(match[1]))) {
        await raw.killSession(session).catch(() => {});
      }
    }
  });

  afterAll(async () => {
    // Safety sweep: nothing with our prefix survives this file, even after
    // a failure between createdSessions.push and the afterEach.
    const raw = createTmux();
    for (const session of await raw.listSessions(PREFIX)) {
      await raw.killSession(session).catch(() => {});
    }
  });

  it("(a) sessão rodando cat recebe o nudge após a mensagem (texto visível no capture-pane)", async () => {
    const session = await newTestSession("a", "cat");
    register("alpha", session);

    // Polling de status detecta a sessão viva e marca online.
    await dispatcher.pollOnce();
    expect(store.getAgent("alpha")!.status).toBe("online");

    const result = sendToAgent("alpha", "contrato pronto em /tmp/a.md");
    expect(result.delivery).toBe("nudged");

    // nudge_sent é emitido DEPOIS do Enter separado — quando chega, o ciclo
    // texto → delay(500ms) → Enter terminou por completo.
    await pollUntil(
      () => events.some((e) => e.type === "nudge_sent"),
      "evento nudge_sent após o Enter separado",
    );

    // O nudge completo aparece no pane >= 2 vezes: o eco do tty (texto
    // digitado, ANTES do Enter) + a saída do cat (SÓ existe se o Enter
    // SUBMETEU a linha) — mesmo critério de PASS do spike 0.2
    // (01-sendkeys-basic.sh: "linha submetida apareceu 2x no pane"). Uma
    // única ocorrência provaria apenas a digitação, não a submissão (P1).
    // Linhas do capture são re-unidas porque o pane de 80 colunas quebra a
    // linha digitada.
    const expectedText =
      "[switchboard] 1 nova(s) mensagem(ns) de: operator. Use a tool check_messages para ler.";
    await pollUntil(async () => {
      const pane = await tmux.capturePane(session, 200);
      const flat = pane.split("\n").join("");
      return flat.split(expectedText).length - 1 >= 2;
    }, "texto do nudge visível 2x no capture-pane (eco + saída do cat pós-Enter)");

    // O corpo da mensagem NUNCA trafega via tmux.
    const pane = await tmux.capturePane(session, 200);
    expect(pane).not.toContain("contrato pronto");

    // Enter foi um send-keys SEPARADO (P1): 1 literal + 1 Enter.
    expect(literalSendKeysFor(session)).toHaveLength(1);
    expect(sendKeysCallsFor(session)).toHaveLength(2);

    // lastNudgeAt registrado e SSE nudge_sent emitido (payload da spec).
    expect(store.getAgent("alpha")!.lastNudgeAt).not.toBeNull();
    const nudgeEvents = events.filter((e) => e.type === "nudge_sent");
    expect(nudgeEvents).toHaveLength(1);
    expect(nudgeEvents[0].payload).toMatchObject({ agent: "alpha", unread: 1 });
  }, 20_000);

  it("(b) 3 mensagens em < 5s geram EXATAMENTE 1 send-keys de nudge (coalescing)", async () => {
    const session = await newTestSession("b", "cat");
    register("beta", session);
    await dispatcher.pollOnce();
    expect(store.getAgent("beta")!.status).toBe("online");

    const d1 = sendToAgent("beta", "m1").delivery;
    const d2 = sendToAgent("beta", "m2").delivery;
    const d3 = sendToAgent("beta", "m3").delivery;
    expect([d1, d2, d3]).toEqual(["nudged", "coalesced", "coalesced"]);

    // Espera o único nudge completar (nudge_sent chega DEPOIS do Enter) …
    await pollUntil(
      () => events.filter((e) => e.type === "nudge_sent").length >= 1,
      "nudge (texto + Enter + nudge_sent) completar",
    );
    // … e então prova que foi EXATAMENTE um: 1 send-keys literal, 1 Enter,
    // 1 nudge_sent, e as outras duas mensagens ficaram pendentes (cooldown
    // de 15s ativo, timers desligados — nada mais pode disparar).
    expect(literalSendKeysFor(session)).toHaveLength(1);
    expect(sendKeysCallsFor(session)).toHaveLength(2);
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["beta"]);
    expect(store.unreadCount("beta")).toBe(3);
  }, 20_000);

  it("(c) OBRIGATÓRIO: pane rodando bash NUNCA recebe send-keys; agente vira offline", async () => {
    const session = await newTestSession("c", "bash");
    register("gamma", session);

    // A sessão EXISTE (has-session passa): polling marca online.
    await dispatcher.pollOnce();
    expect(store.getAgent("gamma")!.status).toBe("online");

    // A decisão (síncrona, otimista) reporta nudged — mas a guarda de pane
    // no caminho assíncrono aborta ANTES de qualquer send-keys (P2).
    const result = sendToAgent("gamma", "rm -rf / # se isto rodar, é RCE");
    expect(result.delivery).toBe("nudged");

    await pollUntil(
      () => store.getAgent("gamma")!.status === "offline",
      "guarda de pane abortar e marcar gamma offline",
    );

    // NENHUM send-keys foi executado contra a sessão (nem texto, nem Enter).
    expect(sendKeysCallsFor(session)).toHaveLength(0);

    // E o pane não tem NADA digitado (prompt limpo, sem [switchboard]).
    const pane = await tmux.capturePane(session, 200);
    expect(pane).not.toContain("[switchboard]");
    expect(pane).not.toContain("rm -rf");

    // Nenhum nudge_sent emitido; nudge manual (força) TAMBÉM respeita a guarda.
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(0);
    const forced = await dispatcher.forceNudge("gamma");
    expect(forced.sent).toBe(false);
    expect(sendKeysCallsFor(session)).toHaveLength(0);

    // Anti-flapping: a sessão continua VIVA (has-session passa), mas o pane
    // segue num shell — polls subsequentes NÃO devolvem gamma para online
    // (nada de oscilação online↔offline a cada ciclo, nem novas tentativas
    // de nudge fadadas a abortar).
    const agentUpdatesBefore = events.filter((e) => e.type === "agent_updated").length;
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    expect(store.getAgent("gamma")!.status).toBe("offline");
    expect(events.filter((e) => e.type === "agent_updated")).toHaveLength(agentUpdatesBefore);
    expect(sendKeysCallsFor(session)).toHaveLength(0);
  }, 20_000);

  it("(d) agente com sessão inexistente → queued_offline e status offline", async () => {
    const ghost = PREFIX + "ghost"; // nunca criada
    register("delta", ghost);

    await dispatcher.pollOnce(); // has-session falha → permanece offline
    expect(store.getAgent("delta")!.status).toBe("offline");

    const result = sendToAgent("delta", "alguém aí?");
    expect(result.delivery).toBe("queued_offline");
    expect(store.getAgent("delta")!.status).toBe("offline");
    expect(store.unreadCount("delta")).toBe(1); // gravada, esperando check_messages

    // Nenhum send-keys em lugar nenhum.
    expect(execCalls.filter((args) => args[0] === "send-keys")).toHaveLength(0);
  }, 20_000);
});
