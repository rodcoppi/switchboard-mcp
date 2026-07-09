// Integration tests for Phase 2 (PRD sections 16/Phase 2 and 18): hub on an
// ephemeral port + MCP clients from the SDK itself simulating two agents.
// Every test uses a fresh temp dir (NEVER ~/.switchboard) and a config.json
// injected with a tight pairRateLimitPerMinute. No blind sleeps: everything
// asynchronous is polled with a deadline.
//
// This file exercises the MCP/REST/store surface in ISOLATION: the hub is
// started with the deterministic Phase 2 delivery stub as onMessage (muted →
// queued_muted, otherwise queued_offline), so no tmux is ever touched and the
// SDK clients (which join without any tmux session) keep deterministic
// deliveries. The Phase 3 dispatcher has its own suites
// (test/dispatcher.test.ts and test/dispatcher.integration.test.ts); the
// manual-nudge endpoint test below spins a dedicated hub WITH the dispatcher.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHub, type Hub } from "../src/server/hub.js";
import type { Message } from "../src/shared/types.js";

const RATE_LIMIT = 3; // injected via config.json (default would be 12)

let dir: string;
let hub: Hub;
let clients: Client[];

function api(pathname: string): string {
  return `http://127.0.0.1:${hub.port}${pathname}`;
}

async function registerAgent(name: string, role = `role de ${name}`): Promise<void> {
  const res = await fetch(api("/api/agents/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, role, cwd: `/tmp/${name}`, tmuxSession: `sb-${name}` }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
}

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: "integration-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${hub.port}/mcp`),
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Calls a tool and parses the JSON payload from content[0].text (MCP pattern). */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content.find((c) => c.type === "text");
  expect(text, `tool ${name} deveria devolver content[type=text]`).toBeDefined();
  return JSON.parse(text!.text);
}

async function joinAs(name: string): Promise<Client> {
  const client = await mcpClient();
  const joined = await callTool(client, "join", { agent_name: name });
  expect(joined.ok).toBe(true);
  return client;
}

/** Polls fn until it returns a truthy value or the deadline expires. */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`Timeout (${timeoutMs}ms) esperando: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function jsonlLines(): unknown[] {
  const file = path.join(dir, "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Opens GET /api/events (SSE), runs `trigger`, and reads the stream until
 * `predicate(buffer)` is satisfied or the deadline expires. Returns the raw
 * SSE text received. Read with fetch + reader and a hard timeout — no hangs.
 */
async function collectSse(
  predicate: (text: string) => boolean,
  trigger: () => Promise<void>,
  timeoutMs = 5000,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(api("/api/events"), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    await trigger();
    while (Date.now() < deadline && !predicate(buffer)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (chunk === "timeout") break;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return buffer;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-test-"));
  // Injected config: tight rate limit so the pair-limit test does not need 12 sends.
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ pairRateLimitPerMinute: RATE_LIMIT }),
  );
  clients = [];
  hub = await startHub({
    baseDir: dir,
    port: 0,
    quiet: true,
    // Delivery stub (see header): keeps this file dispatcher/tmux-free.
    onMessage: (_message, recipient) =>
      recipient.muted ? "queued_muted" : "queued_offline",
  });
});

afterEach(async () => {
  for (const client of clients) {
    await client.close().catch(() => {});
  }
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fluxo alpha → beta via MCP", () => {
  it("join, send_message, SSE message_created, check_messages, JSONL e unread", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");

    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    // join returns the agent list + etiquette paragraph.
    const joined = await callTool(alpha, "join", { agent_name: "alpha" });
    expect(joined.ok).toBe(true);
    expect(joined.agents.map((a: any) => a.name).sort()).toEqual(["alpha", "beta"]);
    expect(joined.agents[0]).toHaveProperty("role");
    expect(joined.agents[0]).toHaveProperty("status");
    expect(typeof joined.etiquette).toBe("string");
    expect(joined.etiquette.length).toBeGreaterThan(50);

    // SSE must carry message_created for the send (reader opened BEFORE).
    const sse = await collectSse(
      (text) => text.includes("message_created"),
      async () => {
        const sent = await callTool(alpha, "send_message", {
          to: "beta",
          message: "contrato pronto em /tmp/a.md",
        });
        expect(sent.ok).toBe(true);
        // Delivery vem do stub injetado (sem dispatcher/tmux neste arquivo).
        expect(sent.delivery).toBe("queued_offline");
      },
    );
    expect(sse).toContain("message_created");
    expect(sse).toContain("contrato pronto em /tmp/a.md");

    // Message persisted in the temp-dir JSONL.
    const stored = await pollUntil(
      () =>
        jsonlLines().find(
          (l: any) => l.from === "alpha" && l.to === "beta" && l.body?.includes("contrato"),
        ),
      "mensagem alpha→beta no messages.jsonl",
    );
    expect((stored as Message).readAt).toBeNull();

    // beta reads via check_messages.
    const checked = await callTool(beta, "check_messages");
    expect(checked.ok).toBe(true);
    expect(checked.messages).toHaveLength(1);
    expect(checked.messages[0].from).toBe("alpha");
    expect(checked.messages[0].body).toBe("contrato pronto em /tmp/a.md");
    expect(typeof checked.messages[0].created_at).toBe("string");
    expect(checked.agents_online).toContain("alpha");
    expect(checked.agents_online).toContain("beta");

    // Read event appended to the JSONL (never edited in place).
    await pollUntil(
      () =>
        jsonlLines().find(
          (l: any) => l.type === "read" && l.messageId === (stored as Message).id,
        ),
      "evento read no messages.jsonl",
    );

    // Unread zeroed on both REST and MCP views.
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    const betaRow = agents.find((a) => a.name === "beta");
    expect(betaRow.unreadCount).toBe(0);
    expect(betaRow.mcpConnected).toBe(true);

    const listed = await callTool(alpha, "list_agents");
    expect(listed.ok).toBe(true);
    const betaListed = listed.agents.find((a: any) => a.name === "beta");
    expect(betaListed).toMatchObject({
      role: "role de beta",
      status: "online",
      mcp_connected: true,
      unread_count: 0,
    });

    // A second check returns nothing (all read).
    const rechecked = await callTool(beta, "check_messages");
    expect(rechecked.messages).toHaveLength(0);
  }, 15_000);
});

describe("broadcast", () => {
  it('to "all" expande em N registros com o mesmo broadcastId, excluindo o remetente', async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    await registerAgent("gamma");
    const alpha = await joinAs("alpha");

    const sent = await callTool(alpha, "send_message", {
      to: "all",
      message: "aviso geral",
    });
    expect(sent.ok).toBe(true);

    const records = jsonlLines().filter((l: any) => l.body === "aviso geral") as Message[];
    expect(records).toHaveLength(2); // beta + gamma, alpha excluded
    expect(records.map((m) => m.to).sort()).toEqual(["beta", "gamma"]);
    expect(records[0].broadcastId).not.toBeNull();
    expect(records[1].broadcastId).toBe(records[0].broadcastId);
    expect(records.every((m) => m.from === "alpha")).toBe(true);

    // REST view agrees (most recent first).
    const messages = (await (await fetch(api("/api/messages?limit=10"))).json()) as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0].broadcastId).toBe(records[0].broadcastId);
  }, 15_000);

  it("broadcast sem outros agentes registrados retorna erro instrutivo", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");
    const sent = await callTool(alpha, "send_message", { to: "all", message: "eco?" });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Broadcast sem destinatários");
  }, 15_000);
});

describe("anti-loop e limites (PRD seção 14)", () => {
  it(`rate limit por PAR ORDENADO dispara no ${RATE_LIMIT + 1}º envio com a mensagem da spec`, async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    await registerAgent("gamma");
    const alpha = await joinAs("alpha");

    for (let i = 0; i < RATE_LIMIT; i++) {
      const sent = await callTool(alpha, "send_message", {
        to: "gamma",
        message: `msg ${i}`,
      });
      expect(sent.ok).toBe(true);
    }
    const blocked = await callTool(alpha, "send_message", {
      to: "gamma",
      message: "uma a mais",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe(
      `Rate limit para este destinatário atingido (${RATE_LIMIT}/min). ` +
        `Se isto é uma conversa em loop, pare e reavalie se a troca está progredindo.`,
    );

    // Ordered pair: alpha→gamma is exhausted, alpha→beta is NOT.
    const other = await callTool(alpha, "send_message", { to: "beta", message: "ok?" });
    expect(other.ok).toBe(true);
  }, 15_000);

  it("maxMessageBytes rejeita payload grande com a dica de arquivo + path", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    const big = "x".repeat(hub.config.maxMessageBytes + 1);
    const sent = await callTool(alpha, "send_message", { to: "beta", message: big });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Mensagem grande demais");
    expect(sent.error).toContain("arquivo");
    expect(sent.error).toContain("path absoluto");

    // Nothing was stored.
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("mensagem vazia retorna ok:false SEM queimar budget do rate limit nem gravar nada", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    const empty = await callTool(alpha, "send_message", { to: "beta", message: "" });
    expect(empty.ok).toBe(false); // envelope padrão, nunca tool error cru
    expect(empty.error).toContain("vazia");
    expect(jsonlLines()).toHaveLength(0);

    // O budget do par está intacto: os RATE_LIMIT envios válidos ainda passam.
    for (let i = 0; i < RATE_LIMIT; i++) {
      const sent = await callTool(alpha, "send_message", { to: "beta", message: `m${i}` });
      expect(sent.ok, `envio válido ${i + 1} após tentativa vazia`).toBe(true);
    }
  }, 15_000);

  it("payload entre maxMessageBytes e o limite do parser recebe o erro instrutivo, não 500", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    // 150 KB: acima do default de 100kb do express.json (que sem o limit
    // configurado viraria um 500 opaco), abaixo do limite do parser do hub.
    const big = "x".repeat(150_000);
    const sent = await callTool(alpha, "send_message", { to: "beta", message: big });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Mensagem grande demais");
    expect(sent.error).toContain("path absoluto");
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("payload acima do limite do parser responde 413 em JSON no /api e JSON-RPC no /mcp", async () => {
    await registerAgent("alpha");
    const huge = "x".repeat(2_000_000); // > 1 MB do parser

    const apiRes = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: huge }),
    });
    expect(apiRes.status).toBe(413);
    const apiBody = (await apiRes.json()) as any;
    expect(apiBody.ok).toBe(false);
    expect(apiBody.error).toContain("arquivo");
    expect(apiBody.error).toContain("path absoluto");

    const mcpRes = await fetch(api("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send_message", arguments: { to: "alpha", message: huge } },
      }),
    });
    expect(mcpRes.status).toBe(413);
    const mcpBody = (await mcpRes.json()) as any;
    expect(mcpBody.jsonrpc).toBe("2.0"); // envelope JSON-RPC, nunca {ok:false} no /mcp
    expect(mcpBody.error.code).toBe(-32600);
    expect(mcpBody.error.message).toContain("path absoluto");
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("destinatário inexistente e self-send retornam erro orientando o modelo", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");

    const unknown = await callTool(alpha, "send_message", { to: "zeta", message: "oi" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Destinatário desconhecido: "zeta"');
    expect(unknown.error).toContain("list_agents");

    const self = await callTool(alpha, "send_message", { to: "alpha", message: "eu" });
    expect(self.ok).toBe(false);
    expect(self.error).toContain("si mesmo");
  }, 15_000);
});

describe('nomes reservados "operator" e "all" (PRD seção 8: namespaces disjuntos)', () => {
  it("register REST responde 400 e join MCP responde ok:false para ambos", async () => {
    for (const reserved of ["operator", "all"]) {
      const res = await fetch(api("/api/agents/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: reserved }),
      });
      expect(res.status, `register "${reserved}"`).toBe(400);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.error).toContain("reservado");
    }

    const client = await mcpClient();
    for (const reserved of ["operator", "all"]) {
      const joined = await callTool(client, "join", { agent_name: reserved });
      expect(joined.ok, `join "${reserved}"`).toBe(false);
      expect(joined.error).toContain("reservado");
    }

    // Nada foi registrado: impersonação do humano e colisão com o broadcast
    // ficam impossíveis por colisão de nome.
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents).toHaveLength(0);
  }, 15_000);
});

describe("REST como operator", () => {
  it("POST /api/messages fixa from=operator e o agente recebe via check_messages", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");

    const res = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: "olá do humano" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.delivery).toBe("queued_offline");
    expect(body.messages[0].from).toBe("operator");

    const checked = await callTool(alpha, "check_messages");
    expect(checked.messages).toHaveLength(1);
    expect(checked.messages[0].from).toBe("operator");
    expect(checked.messages[0].body).toBe("olá do humano");
  }, 15_000);

  it("POST /api/messages: 404 só para destinatário desconhecido; validação é 400", async () => {
    const post = (payload: unknown) =>
      fetch(api("/api/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    // broadcast sem destinatários: estado inválido, não rota inexistente → 400
    const broadcast = await post({ to: "all", body: "x" });
    expect(broadcast.status).toBe(400);
    expect(((await broadcast.json()) as any).error).toContain("Broadcast sem destinatários");

    // self-send (operator → operator): validação → 400
    const self = await post({ to: "operator", body: "x" });
    expect(self.status).toBe(400);
    expect(((await self.json()) as any).error).toContain("si mesmo");

    // destinatário desconhecido: not-found real → 404
    const unknown = await post({ to: "zeta", body: "x" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error).toContain("Destinatário desconhecido");
  }, 15_000);

  it("GET /api/messages: mais recentes primeiro, filtro ?agent (from OU to) e truncamento ?limit", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    await registerAgent("gamma");
    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    expect((await callTool(alpha, "send_message", { to: "beta", message: "primeira" })).ok).toBe(true);
    expect((await callTool(beta, "send_message", { to: "alpha", message: "segunda" })).ok).toBe(true);
    expect((await callTool(alpha, "send_message", { to: "gamma", message: "terceira" })).ok).toBe(true);

    // ordem inversa de criação, comparada por corpo (não por broadcastId)
    const all = (await (await fetch(api("/api/messages"))).json()) as Message[];
    expect(all.map((m) => m.body)).toEqual(["terceira", "segunda", "primeira"]);

    // limit trunca de verdade, mantendo as mais recentes
    const limited = (await (await fetch(api("/api/messages?limit=2"))).json()) as Message[];
    expect(limited.map((m) => m.body)).toEqual(["terceira", "segunda"]);

    // ?agent casa remetente OU destinatário
    const betaSide = (await (await fetch(api("/api/messages?agent=beta"))).json()) as Message[];
    expect(betaSide.map((m) => m.body)).toEqual(["segunda", "primeira"]);

    // limit inválido → 400 {ok:false}
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const res = await fetch(api(`/api/messages?limit=${bad}`));
      expect(res.status, `limit=${bad}`).toBe(400);
      expect(((await res.json()) as any).ok).toBe(false);
    }
  }, 15_000);

  it("mute via REST reflete no delivery queued_muted", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    const muteRes = await fetch(api("/api/agents/beta/mute"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: true }),
    });
    expect(muteRes.status).toBe(200);
    expect(((await muteRes.json()) as any).agent.muted).toBe(true);

    const sent = await callTool(alpha, "send_message", { to: "beta", message: "psiu" });
    expect(sent.ok).toBe(true);
    expect(sent.delivery).toBe("queued_muted");
  }, 15_000);
});

describe("eventos SSE além do message_created (PRD 10.1)", () => {
  it("check_messages emite message_read e mute emite agent_updated no stream", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    const sent = await callTool(alpha, "send_message", { to: "beta", message: "leia-me" });
    expect(sent.ok).toBe(true);
    const stored = jsonlLines().find((l: any) => l.body === "leia-me") as Message;
    expect(stored).toBeDefined();

    // message_read no stream, com o messageId correto.
    const readSse = await collectSse(
      (text) => text.includes("message_read"),
      async () => {
        const checked = await callTool(beta, "check_messages");
        expect(checked.ok).toBe(true);
        expect(checked.messages).toHaveLength(1);
      },
    );
    expect(readSse).toContain("message_read");
    expect(readSse).toContain(stored.id);

    // agent_updated no stream, com muted:true no payload.
    const muteSse = await collectSse(
      (text) => text.includes("agent_updated") && text.includes('"muted":true'),
      async () => {
        const res = await fetch(api("/api/agents/beta/mute"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ muted: true }),
        });
        expect(res.status).toBe(200);
      },
    );
    expect(muteSse).toContain("agent_updated");
    expect(muteSse).toContain('"name":"beta"');
    expect(muteSse).toContain('"muted":true');
  }, 15_000);
});

describe("sessões MCP (achado P6)", () => {
  it("sessão sem join: check_messages e send_message pedem join; list_agents funciona", async () => {
    await registerAgent("alpha");
    const stranger = await mcpClient(); // connects but never joins

    const checked = await callTool(stranger, "check_messages");
    expect(checked.ok).toBe(false);
    expect(checked.error).toContain("join");
    expect(checked.error).toContain("SWITCHBOARD_AGENT_NAME");

    const sent = await callTool(stranger, "send_message", { to: "alpha", message: "?" });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("join");

    // Discovery must never dead-end: list_agents works without join.
    const listed = await callTool(stranger, "list_agents");
    expect(listed.ok).toBe(true);
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0].name).toBe("alpha");
  }, 15_000);

  it("re-join da MESMA sessão com outro nome libera o nome anterior (sem agente fantasma)", async () => {
    await registerAgent("alpha");
    await registerAgent("gamma");
    const client = await joinAs("alpha"); // ex.: o modelo alucinou o nome…

    let agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents.find((a) => a.name === "alpha").mcpConnected).toBe(true);

    // …percebeu e corrigiu com um segundo join na mesma sessão MCP.
    const rejoined = await callTool(client, "join", { agent_name: "gamma" });
    expect(rejoined.ok).toBe(true);

    agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents.find((a) => a.name === "gamma").mcpConnected).toBe(true);
    // O nome antigo NÃO fica conectado para sempre.
    expect(agents.find((a) => a.name === "alpha").mcpConnected).toBe(false);

    // E o mapeamento novo funciona: gamma consegue operar.
    const checked = await callTool(client, "check_messages");
    expect(checked.ok).toBe(true);
  }, 15_000);

  it("boot reconcilia estado fantasma: mcpConnected/online de um crash viram false/offline", async () => {
    // agents.json exatamente como um kill -9 deixa: conectado e online
    // (só o close() gracioso reseta via dropSession).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-boot-"));
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir2, "agents.json"),
      JSON.stringify([
        {
          name: "alpha",
          role: "",
          tmuxSession: "sb-alpha",
          cwd: "",
          status: "online",
          mcpConnected: true,
          muted: false,
          createdAt: now,
          lastSeenAt: now,
          lastNudgeAt: null,
        },
      ]),
    );

    const hub2 = await startHub({ baseDir: dir2, port: 0, quiet: true });
    try {
      // Nenhuma sessão MCP sobrevive a um restart do hub (Map em memória):
      // o boot precisa derrubar o estado fantasma imediatamente.
      const agents = (await (
        await fetch(`http://127.0.0.1:${hub2.port}/api/agents`)
      ).json()) as any[];
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("alpha");
      expect(agents[0].mcpConnected).toBe(false);
      expect(agents[0].status).toBe("offline");

      // De carona: PRD seção 7 — o primeiro serve cria config.json com defaults
      // (este dir2 não recebeu o config.json que o beforeEach injeta).
      expect(fs.existsSync(path.join(dir2, "config.json"))).toBe(true);
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);

  it("sessão órfã expira por inatividade e o agente perde mcpConnected", async () => {
    // Dedicated hub with an aggressive sweep (injectable — NOTES.md finding 4).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-sweep-"));
    const hub2 = await startHub({
      baseDir: dir2,
      port: 0,
      quiet: true,
      sessionIdleTimeoutMs: 150,
      sessionSweepIntervalMs: 50,
    });
    try {
      const client = new Client({ name: "sweep-test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${hub2.port}/mcp`),
      );
      await client.connect(transport);
      const joined = await client.callTool({
        name: "join",
        arguments: { agent_name: "alpha" },
      });
      expect(joined).toBeDefined();

      const connectedNow = (await (
        await fetch(`http://127.0.0.1:${hub2.port}/api/agents`)
      ).json()) as any[];
      expect(connectedNow[0].mcpConnected).toBe(true);

      // No DELETE, no further requests: the sweep must reap the session and
      // drop mcpConnected. Poll with deadline (no blind sleep).
      await pollUntil(
        async () => {
          const agents = (await (
            await fetch(`http://127.0.0.1:${hub2.port}/api/agents`)
          ).json()) as any[];
          return agents[0].mcpConnected === false;
        },
        "agente alpha perder mcpConnected após expiração da sessão",
      );
      await client.close().catch(() => {});
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("endpoints auxiliares", () => {
  it("GET /api/health responde {ok, uptime, version}", async () => {
    const res = await fetch(api("/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("POST /api/agents/:name/nudge (hub com dispatcher): 404 desconhecido; 409 guard abortado", async () => {
    // Phase 3: o endpoint dispara um nudge manual REAL, então este teste usa
    // um hub dedicado SEM o stub de onMessage (dispatcher default). Sessão
    // tmux com nome único que garantidamente não existe → a guarda de pane
    // falha fechada (não foi possível ler o pane) → abortado, nada digitado,
    // 409. Mesmo comportamento com tmux ausente (execFile ENOENT → fail-closed).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-nudge-"));
    const hub2 = await startHub({ baseDir: dir2, port: 0, quiet: true });
    try {
      const base = `http://127.0.0.1:${hub2.port}`;
      const ghostSession = `sb-int-nudge-${process.pid}-${Date.now()}`;
      const res0 = await fetch(`${base}/api/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "alpha", tmuxSession: ghostSession }),
      });
      expect(res0.status).toBe(201);

      const res = await fetch(`${base}/api/agents/alpha/nudge`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Nudge manual não entregue");
      expect(body.error).toContain("check_messages");

      const unknown = await fetch(`${base}/api/agents/zeta/nudge`, { method: "POST" });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as any).ok).toBe(false);
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);

  it("POST /api/agents/:name/nudge com onMessage injetado (sem dispatcher) responde 501", async () => {
    await registerAgent("alpha");
    const res = await fetch(api("/api/agents/alpha/nudge"), { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("sem o dispatcher");
  });

  it("body JSON malformado responde JSON, nunca HTML (achado 5)", async () => {
    const apiRes = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    expect(apiRes.status).toBe(400);
    expect((await apiRes.json()) as any).toMatchObject({ ok: false });

    const mcpRes = await fetch(api("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    expect(mcpRes.status).toBe(400);
    expect(((await mcpRes.json()) as any).error.code).toBe(-32700);
  });

  it("re-registro do mesmo nome faz re-attach lógico (201, mcpConnected resetado)", async () => {
    await registerAgent("alpha");
    await joinAs("alpha");
    // Re-register (e.g. a new `switchboard start alpha` after the session died).
    await registerAgent("alpha", "novo role");
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0].role).toBe("novo role");
    expect(agents[0].mcpConnected).toBe(false); // reset until the new join
  }, 15_000);
});
