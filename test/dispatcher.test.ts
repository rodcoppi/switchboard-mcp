// Unit tests for the nudge dispatcher (PRD 10.2 — the pseudocode is the
// spec): fake clock + tmux mocked by dependency injection, fully
// deterministic (flush/poll are invoked directly; no real timers).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dispatcher } from "../src/server/dispatcher.js";
import type { DispatcherTmux } from "../src/server/dispatcher.js";
import { Store } from "../src/server/store.js";
import { Logger } from "../src/server/log.js";
import { EventBus } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import type { NudgeResult } from "../src/server/tmux.js";
import type { Agent, Config, SseEvent } from "../src/shared/types.js";

const COOLDOWN = DEFAULTS.nudgeCooldownMs; // 15000

interface NudgeCall {
  session: string;
  text: string;
  enterDelayMs: number;
}

/**
 * tmux mock: liveness controlled by `alive`; pane safety controlled by
 * `unsafePanes` (default: everything safe); every nudge recorded.
 */
function mockTmux(options: { nudgeResult?: () => NudgeResult } = {}) {
  const alive = new Set<string>();
  const unsafePanes = new Set<string>();
  const nudges: NudgeCall[] = [];
  const hasSessionCalls: string[] = [];
  const paneSafetyCalls: string[] = [];
  const tmux: DispatcherTmux = {
    async hasSession(session) {
      hasSessionCalls.push(session);
      return alive.has(session);
    },
    async nudgeSession(session, text, enterDelayMs) {
      nudges.push({ session, text, enterDelayMs });
      return options.nudgeResult ? options.nudgeResult() : { sent: true };
    },
    async isPaneSafeToNudge(session) {
      paneSafetyCalls.push(session);
      return !unsafePanes.has(session);
    },
  };
  return { tmux, alive, unsafePanes, nudges, hasSessionCalls, paneSafetyCalls };
}

let dir: string;
let store: Store;
let bus: EventBus;
let events: SseEvent[];
let nowMs: number;
let config: Config;

const iso = (ms: number) => new Date(ms).toISOString();

function makeDispatcher(tmux: DispatcherTmux): Dispatcher {
  return new Dispatcher({
    store,
    config,
    log: new Logger({ stdout: false, filePath: path.join(dir, "hub.log") }),
    bus,
    tmux,
    now: () => nowMs,
  });
}

function registerOnline(name: string, session = `sb-${name}`): Agent {
  store.registerAgent({ name, role: "", tmuxSession: session, cwd: "" });
  return store.updateAgent(name, { status: "online" });
}

/** Delivers one message through the dispatcher exactly like deliverMessage does. */
function deliver(dispatcher: Dispatcher, from: string, to: string, body: string) {
  const message = store.appendMessage({ from, to, body });
  return dispatcher.onNewMessage(message, store.getAgent(to)!);
}

/** Settles the fire-and-forget nudge chain (mock resolves in microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-dispatcher-test-"));
  store = new Store(dir, { info() {}, warn() {} });
  bus = new EventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  nowMs = 1_700_000_000_000;
  config = { ...DEFAULTS };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("onNewMessage — decisão síncrona (pseudocódigo 10.2)", () => {
  it("cooldown gera coalescing: 3 mensagens em rajada → 1 nudge imediato + pendência", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "m1")).toBe("nudged");
    expect(deliver(dispatcher, "beta", "alpha", "m2")).toBe("coalesced");
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("coalesced");
    await settle();

    expect(nudges).toHaveLength(1); // exatamente UM nudge para a rajada
    expect(nudges[0].session).toBe("sb-alpha");
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);
  });

  it("lastNudgeAt é atualizado (sincronamente) quando o nudge é decidido", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(deliver(dispatcher, "beta", "alpha", "m1")).toBe("nudged");
    // Síncrono: o cooldown começa na decisão, antes do tmux completar.
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
    await settle();
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
  });

  it("muted → queued_muted, sem NENHUMA chamada tmux e sem pendência", async () => {
    const { tmux, nudges, hasSessionCalls } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.updateAgent("alpha", { muted: true });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "psiu")).toBe("queued_muted");
    await settle();
    expect(nudges).toHaveLength(0);
    expect(hasSessionCalls).toHaveLength(0);
    expect(dispatcher.pendingAgents).toEqual([]);
  });

  it("tmux morto (status offline) → queued_offline, status permanece offline, sem tmux", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    expect(store.getAgent("alpha")!.status).toBe("offline");

    expect(deliver(dispatcher, "beta", "alpha", "oi")).toBe("queued_offline");
    await settle();
    expect(nudges).toHaveLength(0);
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });

  it("guarda de pane aborta no caminho assíncrono: agente vira offline com warn (10.3)", async () => {
    const { tmux, nudges } = mockTmux({
      nudgeResult: () => ({ sent: false, reason: "pane em shell (bash)" }),
    });
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "oi")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(1); // tentado…
    expect(store.getAgent("alpha")!.status).toBe("offline"); // …abortado e marcado offline
    const updated = events.filter(
      (e) => e.type === "agent_updated" && (e.payload as Agent).name === "alpha",
    );
    expect(updated.length).toBeGreaterThan(0);
    // Nenhum nudge_sent foi emitido (nada foi digitado).
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(0);
  });

  it("nudge abortado REVERTE lastNudgeAt: a recuperação não herda cooldown de um nudge que nunca digitou", async () => {
    const { tmux, nudges } = mockTmux({
      nudgeResult: () => ({ sent: false, reason: "pane em shell (bash)" }),
    });
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(deliver(dispatcher, "beta", "alpha", "oi")).toBe("nudged");
    // Stamp SÍNCRONO presente antes do resultado do tmux (é o que coalesce rajadas)…
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
    await settle();
    // …mas o abort da guarda devolve o valor anterior: nada foi digitado,
    // logo nenhum cooldown de 15s pode atrasar a entrega pós-recuperação.
    expect(nudges).toHaveLength(1);
    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });
});

describe("texto do nudge (10.2 — template exato, uma linha, sem corpo de mensagem)", () => {
  it("uma não lida: texto exato com remetente único", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "corpo secreto da mensagem");
    await settle();

    expect(nudges[0].text).toBe(
      "[switchboard] 1 nova(s) mensagem(ns) de: beta. Use a tool check_messages para ler.",
    );
    expect(nudges[0].text).not.toMatch(/[\r\n]/); // SEMPRE uma linha (P5)
    expect(nudges[0].text).not.toContain("corpo secreto"); // corpo NUNCA via tmux
    expect(nudges[0].enterDelayMs).toBe(config.nudgeEnterDelayMs);
  });

  it("várias não lidas coalescidas: contagem e remetentes agregados no flush", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // nudge imediato (1 de beta)
    deliver(dispatcher, "operator", "alpha", "m2"); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);

    nowMs += COOLDOWN; // cooldown expira
    dispatcher.flushPending();
    await settle();

    expect(nudges).toHaveLength(2);
    expect(nudges[1].text).toBe(
      "[switchboard] 2 nova(s) mensagem(ns) de: beta, operator. Use a tool check_messages para ler.",
    );
  });
});

describe("flushPending (timer de 5s do 10.2)", () => {
  it("após o cooldown com unread > 0: dispara 1 nudge e remove a pendência", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    deliver(dispatcher, "beta", "alpha", "m2");
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown AINDA ativo: flush não faz nada.
    nowMs += COOLDOWN - 1;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown expirado + unread > 0: UM nudge e pendência removida.
    nowMs += 1;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
    expect(dispatcher.pendingAgents).toEqual([]);

    // Flush de novo: nada pendente, nada disparado.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("unread == 0 (agente já leu): flush NÃO nudga", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    const second = store.appendMessage({ from: "beta", to: "alpha", body: "m2" });
    dispatcher.onNewMessage(second, store.getAgent("alpha")!); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);

    // Agente leu tudo antes do flush (check_messages).
    for (const m of store.unreadFor("alpha")) store.markRead(m.id);

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1); // nenhum nudge extra
  });

  it("REGRESSÃO (vazamento de pendência): dívida quitada no flush é DESCARTADA e mensagem futura gera exatamente 1 nudge", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged
    deliver(dispatcher, "beta", "alpha", "m2"); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Agente leu TUDO (check_messages) antes do flush.
    for (const m of store.unreadFor("alpha")) store.markRead(m.id);
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual([]); // dívida quitada — sem entrada fantasma

    // Muito depois, UMA única mensagem nova → UM nudge imediato…
    nowMs += COOLDOWN * 10;
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(2);
    expect(dispatcher.pendingAgents).toEqual([]);

    // …e NENHUM segundo nudge duplicado no flush seguinte.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("REGRESSÃO (vazamento de pendência): nudge imediato quita a dívida de coalescing — flush não re-dispara", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged
    deliver(dispatcher, "beta", "alpha", "m2"); // coalesced → pendência
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown expira SEM o flush rodar; m3 chega → nudge IMEDIATO cobre as
    // 3 não lidas e quita a pendência antiga.
    nowMs += COOLDOWN;
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(2);
    expect(nudges[1].text).toContain("3 nova(s)");
    expect(dispatcher.pendingAgents).toEqual([]);

    // Flush posterior NÃO repete o nudge idêntico.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("agente silenciado depois de coalescido: flush suprime o nudge (mute = 10.1)", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    deliver(dispatcher, "beta", "alpha", "m2");
    await settle();
    store.updateAgent("alpha", { muted: true });

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1); // só o inicial; o flush não nudgou o mutado
  });
});

describe("polling de status (10.4)", () => {
  it("emite agent_updated SÓ quando o status muda", async () => {
    const { tmux, alive } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });

    const updatesFor = (name: string) =>
      events.filter(
        (e) => e.type === "agent_updated" && (e.payload as Agent).name === name,
      );

    // offline → offline: nenhuma mudança, nenhum evento.
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(0);
    expect(store.getAgent("alpha")!.status).toBe("offline");

    // offline → online: 1 evento.
    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(1);
    expect(store.getAgent("alpha")!.status).toBe("online");

    // online → online: nenhum evento novo.
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(1);

    // online → offline: 1 evento novo.
    alive.delete("sb-alpha");
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(2);
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });

  it("agente que fica online com unread > 0 é nudgado (cooldown expirado)", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    // Mensagem chega com o agente offline → queued_offline, sem nudge.
    expect(deliver(dispatcher, "beta", "alpha", "oi")).toBe("queued_offline");
    await settle();
    expect(nudges).toHaveLength(0);

    // Sessão volta: polling marca online e entrega o nudge pendente.
    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(1);
    expect(nudges[0].session).toBe("sb-alpha");
  });

  it("agente que fica online com unread > 0 mas em cooldown vira pendência (respeita cooldown)", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    alive.add("sb-alpha");

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged: cooldown começa
    await settle();
    expect(nudges).toHaveLength(1);

    // Sessão cai e volta DENTRO do cooldown, com uma segunda não lida.
    store.updateAgent("alpha", { status: "offline" });
    const m2 = store.appendMessage({ from: "beta", to: "alpha", body: "m2" });
    expect(dispatcher.onNewMessage(m2, store.getAgent("alpha")!)).toBe("queued_offline");

    nowMs += 1000; // cooldown (15s) ainda ativo
    await dispatcher.pollOnce();
    await settle();
    expect(nudges).toHaveLength(1); // NÃO nudgou de novo
    expect(dispatcher.pendingAgents).toEqual(["alpha"]); // …mas ficou pendente

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2); // o flush entregou depois do cooldown
  });

  it("sessão viva com pane inseguro NÃO flapa online↔offline: quarentena até a guarda passar", async () => {
    // O pane está num shell: o nudge aborta enquanto ele estiver inseguro.
    let paneSafeNow = false;
    const { tmux, alive, unsafePanes, nudges } = mockTmux({
      nudgeResult: () =>
        paneSafeNow ? { sent: true } : { sent: false, reason: "pane em shell (bash)" },
    });
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    alive.add("sb-alpha");
    unsafePanes.add("sb-alpha");

    const updatesForAlpha = () =>
      events.filter(
        (e) => e.type === "agent_updated" && (e.payload as Agent).name === "alpha",
      );

    // 1º poll: promoção normal (sem histórico de abort) → online.
    await dispatcher.pollOnce();
    expect(store.getAgent("alpha")!.status).toBe("online");

    // Mensagem chega → decisão nudged → guarda aborta → offline + quarentena.
    expect(deliver(dispatcher, "beta", "alpha", "oi")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(1);
    expect(store.getAgent("alpha")!.status).toBe("offline");
    const eventsAfterAbort = updatesForAlpha().length;

    // Polls seguintes (sessão viva, pane AINDA inseguro): status estável em
    // offline, ZERO agent_updated novos, ZERO novas tentativas de nudge —
    // mesmo com o cooldown expirado e flush rodando.
    nowMs += COOLDOWN;
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    dispatcher.flushPending();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("offline");
    expect(updatesForAlpha().length).toBe(eventsAfterAbort);
    expect(nudges).toHaveLength(1);

    // Pane volta a ser seguro (claude reaberto): o poll promove online e a
    // entrega sai IMEDIATAMENTE (o abort reverteu o cooldown).
    paneSafeNow = true;
    unsafePanes.delete("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(2);
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(1);
  });

  it("agente que fica online SEM unread não é nudgado", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });

    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(0);
  });
});

describe("nudge manual (forceNudge — botão do dashboard, PRD 10.1)", () => {
  it("ignora cooldown e mute, mas NUNCA a guarda de pane", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // cooldown ativo a partir daqui
    await settle();
    expect(nudges).toHaveLength(1);

    store.updateAgent("alpha", { muted: true });
    const forced = await dispatcher.forceNudge("alpha"); // mutado E em cooldown
    expect(forced.sent).toBe(true);
    expect(nudges).toHaveLength(2);

    // Guarda de pane continua valendo: abort → offline, sem sucesso.
    const guarded = mockTmux({ nudgeResult: () => ({ sent: false, reason: "shell" }) });
    const dispatcher2 = makeDispatcher(guarded.tmux);
    registerOnline("gamma");
    const blocked = await dispatcher2.forceNudge("gamma");
    expect(blocked.sent).toBe(false);
    expect(store.getAgent("gamma")!.status).toBe("offline");
  });

  it("agente desconhecido → {sent:false} com motivo", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    const result = await dispatcher.forceNudge("zeta");
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("desconhecido");
  });

  it("com 0 não lidas usa texto dedicado de cutucada manual (nunca '0 nova(s) ... de: .')", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");

    const result = await dispatcher.forceNudge("alpha");
    expect(result.sent).toBe(true);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toBe(
      "[switchboard] Cutucada manual do operator. Use a tool check_messages para verificar sua fila.",
    );
    expect(nudges[0].text).not.toContain("0 nova(s)");
    expect(nudges[0].text).not.toContain("de: .");
    expect(nudges[0].text).not.toMatch(/[\r\n]/); // SEMPRE uma linha (P5)
  });
});

describe("ciclo de vida (start/stop sem handles pendurados)", () => {
  it("start é idempotente e stop pode ser chamado repetidas vezes", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    dispatcher.start();
    dispatcher.start(); // no-op
    await settle();
    dispatcher.stop();
    dispatcher.stop(); // no-op — se um handle vazasse, o vitest travaria aqui
  });
});
