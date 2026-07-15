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
// Capability tokens returned by /api/agents/register (v1.1) — joinAs presents
// them the same way `switchboard start` will via SWITCHBOARD_AGENT_TOKEN.
let tokens: Map<string, string>;

const TOKEN_RE = /^[0-9a-f]{64}$/; // crypto.randomBytes(32).toString("hex")

function api(pathname: string): string {
  return `http://127.0.0.1:${hub.port}${pathname}`;
}

async function registerAgent(
  name: string,
  role = `role of ${name}`,
  group?: string,
): Promise<string> {
  const res = await fetch(api("/api/agents/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      role,
      cwd: `/tmp/${name}`,
      tmuxSession: `sb-${name}`,
      ...(group === undefined ? {} : { group }),
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    ok: boolean;
    token?: string;
    agent?: Record<string, unknown>;
  };
  expect(body.ok).toBe(true);
  // v1.1: the register response carries the capability token (it is how the
  // Phase 4 `switchboard start` obtains it)…
  expect(body.token).toMatch(TOKEN_RE);
  // …while the embedded agent object stays redacted.
  expect(body.agent).not.toHaveProperty("token");
  tokens.set(name, body.token!);
  return body.token!;
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
  expect(text, `tool ${name} should return content[type=text]`).toBeDefined();
  return JSON.parse(text!.text);
}

async function joinAs(name: string): Promise<Client> {
  const client = await mcpClient();
  // v1.1: registered agents are token-protected — join must present the
  // token from the register response (SWITCHBOARD_AGENT_TOKEN in production).
  const joined = await callTool(client, "join", {
    agent_name: name,
    ...(tokens.has(name) ? { token: tokens.get(name) } : {}),
  });
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
      throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${what}`);
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
  tokens = new Map();
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

// ---------------------------------------------------------------------------
// Groups over the real MCP tools. The wall has to hold HERE — the store knowing
// the rule is worth nothing if send_message does not ask it.
// ---------------------------------------------------------------------------

describe("groups (the wall, over MCP)", () => {
  it("an agent cannot message, see, or broadcast to another group", async () => {
    await registerAgent("alpha", "backend", "panorama");
    await registerAgent("beta", "frontend", "panorama");
    await registerAgent("outsider", "other project", "site");

    const alpha = await joinAs("alpha");

    // join reports the room and only the room.
    const joined = await callTool(alpha, "join", {
      agent_name: "alpha",
      token: tokens.get("alpha"),
    });
    expect(joined.group).toBe("panorama");
    expect(joined.agents.map((a: any) => a.name).sort()).toEqual(["alpha", "beta"]);

    // list_agents shows the room only. An agent it cannot message is an agent
    // it should never be tempted to try.
    const listed = await callTool(alpha, "list_agents", {});
    expect(listed.agents.map((a: any) => a.name).sort()).toEqual(["alpha", "beta"]);

    // Same group → delivered.
    const inside = await callTool(alpha, "send_message", { to: "beta", message: "ok" });
    expect(inside.ok).toBe(true);

    // Different group → refused, and reported as UNKNOWN: from inside panorama
    // that name does not exist. The error names who it CAN use, so the model's
    // retry is a correct one instead of a workaround attempt.
    const across = await callTool(alpha, "send_message", { to: "outsider", message: "hi" });
    expect(across.ok).toBe(false);
    expect(across.error).toContain('Unknown recipient: "outsider"');
    expect(across.error).toContain("You can message: beta");
    expect(across.error).not.toContain("forbidden");

    // Nothing was written for the outsider.
    const outsiderClient = await joinAs("outsider");
    const outsiderInbox = await callTool(outsiderClient, "check_messages", {});
    expect(outsiderInbox.messages).toEqual([]);
  });

  it('"all" stops at the group edge — the loudest hole there could be', async () => {
    await registerAgent("alpha", "backend", "panorama");
    await registerAgent("beta", "frontend", "panorama");
    await registerAgent("outsider", "other project", "site");

    const alpha = await joinAs("alpha");
    const sent = await callTool(alpha, "send_message", { to: "all", message: "heads up" });
    expect(sent.ok).toBe(true);

    const beta = await joinAs("beta");
    expect((await callTool(beta, "check_messages", {})).messages).toHaveLength(1);

    const outsiderClient = await joinAs("outsider");
    expect((await callTool(outsiderClient, "check_messages", {})).messages).toEqual([]);
  });

  it("agents_online reports the group's presence, not the machine's", async () => {
    await registerAgent("alpha", "backend", "panorama");
    await registerAgent("beta", "frontend", "panorama");
    await registerAgent("outsider", "other", "site");
    // Presence is normally derived by the tmux poller; set it directly here, as
    // the poller would. Both rooms are lit, which is the whole point: an empty
    // agents_online would make this assertion pass while proving nothing.
    for (const name of ["alpha", "beta", "outsider"]) {
      hub.store.updateAgent(name, { status: "online" });
    }

    const alpha = await joinAs("alpha");
    const checked = await callTool(alpha, "check_messages", {});
    expect(checked.agents_online.sort()).toEqual(["alpha", "beta"]);
    expect(checked.agents_online).not.toContain("outsider");
  });

  it("a broadcast alone in its group is refused, and says why", async () => {
    await registerAgent("alpha", "backend", "panorama");
    await registerAgent("outsider", "other", "site");
    const alpha = await joinAs("alpha");
    const sent = await callTool(alpha, "send_message", { to: "all", message: "anyone?" });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("no other agent is in your group");
  });

  it("the operator is above the groups and reaches every agent", async () => {
    await registerAgent("alpha", "backend", "panorama");
    await registerAgent("outsider", "other", "site");

    // The human sending from the dashboard: no group, reaches both.
    for (const to of ["alpha", "outsider"]) {
      const res = await fetch(api("/api/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, body: "from the human" }),
      });
      expect(res.status).toBe(201);
    }
    const outsiderClient = await joinAs("outsider");
    expect((await callTool(outsiderClient, "check_messages", {})).messages).toHaveLength(1);
  });
});

describe("alpha → beta flow via MCP", () => {
  it("join, send_message, SSE message_created, check_messages, JSONL and unread", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");

    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    // join returns the agent list + etiquette paragraph.
    const joined = await callTool(alpha, "join", {
      agent_name: "alpha",
      token: tokens.get("alpha"),
    });
    expect(joined.ok).toBe(true);
    expect(joined.agents.map((a: any) => a.name).sort()).toEqual(["alpha", "beta"]);
    expect(joined.agents[0]).toHaveProperty("role");
    expect(joined.agents[0]).toHaveProperty("status");
    expect(typeof joined.etiquette).toBe("string");
    expect(joined.etiquette.length).toBeGreaterThan(50);

    // The mention protocol is the ONLY way an agent learns that "%beta" in its
    // user's prompt means "delegate to beta" — join is where it is delivered.
    // Both sigils are load-bearing: "%" is the one we teach (the TUI resolves
    // "@" as a file reference before the model sees the prompt, which silently
    // ate the delegation), "@" stays understood for prompts that already use it.
    expect(joined.etiquette).toContain('"%<name>"');
    expect(joined.etiquette).toContain('"@<name>"');
    expect(joined.etiquette).toContain("DELEGATION");

    // SSE must carry message_created for the send (reader opened BEFORE).
    const sse = await collectSse(
      (text) => text.includes("message_created"),
      async () => {
        const sent = await callTool(alpha, "send_message", {
          to: "beta",
          message: "contract ready at /tmp/a.md",
        });
        expect(sent.ok).toBe(true);
        // Delivery comes from the injected stub (no dispatcher/tmux in this file).
        expect(sent.delivery).toBe("queued_offline");
      },
    );
    expect(sse).toContain("message_created");
    expect(sse).toContain("contract ready at /tmp/a.md");

    // Message persisted in the temp-dir JSONL.
    const stored = await pollUntil(
      () =>
        jsonlLines().find(
          (l: any) => l.from === "alpha" && l.to === "beta" && l.body?.includes("contract"),
        ),
      "message alpha→beta in messages.jsonl",
    );
    expect((stored as Message).readAt).toBeNull();

    // beta reads via check_messages.
    const checked = await callTool(beta, "check_messages");
    expect(checked.ok).toBe(true);
    expect(checked.messages).toHaveLength(1);
    expect(checked.messages[0].from).toBe("alpha");
    expect(checked.messages[0].body).toBe("contract ready at /tmp/a.md");
    expect(typeof checked.messages[0].created_at).toBe("string");
    expect(checked.agents_online).toContain("alpha");
    expect(checked.agents_online).toContain("beta");

    // Read event appended to the JSONL (never edited in place).
    await pollUntil(
      () =>
        jsonlLines().find(
          (l: any) => l.type === "read" && l.messageId === (stored as Message).id,
        ),
      "read event in messages.jsonl",
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
      role: "role of beta",
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
  it('to "all" expands into N records with the same broadcastId, excluding the sender', async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    await registerAgent("gamma");
    const alpha = await joinAs("alpha");

    const sent = await callTool(alpha, "send_message", {
      to: "all",
      message: "general notice",
    });
    expect(sent.ok).toBe(true);

    const records = jsonlLines().filter((l: any) => l.body === "general notice") as Message[];
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

  it("broadcast with no other registered agents returns an instructive error", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");
    const sent = await callTool(alpha, "send_message", { to: "all", message: "echo?" });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Broadcast has no recipients");
  }, 15_000);
});

describe("anti-loop and limits (PRD section 14)", () => {
  it(`rate limit per ORDERED PAIR fires on the ${RATE_LIMIT + 1}th send with the spec message`, async () => {
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
      message: "one more",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe(
      `Rate limit for this recipient reached (${RATE_LIMIT}/min). ` +
        `If this is a conversation loop, stop and reassess whether the exchange is making progress.`,
    );

    // Ordered pair: alpha→gamma is exhausted, alpha→beta is NOT.
    const other = await callTool(alpha, "send_message", { to: "beta", message: "ok?" });
    expect(other.ok).toBe(true);
  }, 15_000);

  it("maxMessageBytes rejects a large payload with the file + path hint", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    const big = "x".repeat(hub.config.maxMessageBytes + 1);
    const sent = await callTool(alpha, "send_message", { to: "beta", message: big });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Message too large");
    expect(sent.error).toContain("file");
    expect(sent.error).toContain("absolute path");

    // Nothing was stored.
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("an empty message returns ok:false WITHOUT burning rate-limit budget or storing anything", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    const empty = await callTool(alpha, "send_message", { to: "beta", message: "" });
    expect(empty.ok).toBe(false); // standard envelope, never a raw tool error
    expect(empty.error).toContain("Empty message");
    expect(jsonlLines()).toHaveLength(0);

    // The pair's budget is intact: the RATE_LIMIT valid sends still pass.
    for (let i = 0; i < RATE_LIMIT; i++) {
      const sent = await callTool(alpha, "send_message", { to: "beta", message: `m${i}` });
      expect(sent.ok, `valid send ${i + 1} after the empty attempt`).toBe(true);
    }
  }, 15_000);

  it("a payload between maxMessageBytes and the parser limit gets the instructive error, not 500", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");

    // 150 KB: above express.json's 100kb default (which without the configured
    // limit would become an opaque 500), below the hub parser's limit.
    const big = "x".repeat(150_000);
    const sent = await callTool(alpha, "send_message", { to: "beta", message: big });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain("Message too large");
    expect(sent.error).toContain("absolute path");
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("a payload above the parser limit responds 413 as JSON on /api and JSON-RPC on /mcp", async () => {
    await registerAgent("alpha");
    const huge = "x".repeat(2_000_000); // > the parser's 1 MB

    const apiRes = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: huge }),
    });
    expect(apiRes.status).toBe(413);
    const apiBody = (await apiRes.json()) as any;
    expect(apiBody.ok).toBe(false);
    expect(apiBody.error).toContain("file");
    expect(apiBody.error).toContain("absolute path");

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
    expect(mcpBody.jsonrpc).toBe("2.0"); // JSON-RPC envelope, never {ok:false} on /mcp
    expect(mcpBody.error.code).toBe(-32600);
    expect(mcpBody.error.message).toContain("absolute path");
    expect(jsonlLines()).toHaveLength(0);
  }, 15_000);

  it("a nonexistent recipient and self-send return an error guiding the model", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");

    const unknown = await callTool(alpha, "send_message", { to: "zeta", message: "hi" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown recipient: "zeta"');
    expect(unknown.error).toContain("list_agents");

    const self = await callTool(alpha, "send_message", { to: "alpha", message: "me" });
    expect(self.ok).toBe(false);
    expect(self.error).toContain("yourself");
  }, 15_000);
});

describe('reserved names "operator" and "all" (PRD section 8: disjoint namespaces)', () => {
  it("register REST responds 400 and join MCP responds ok:false for both", async () => {
    for (const reserved of ["operator", "all"]) {
      const res = await fetch(api("/api/agents/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: reserved }),
      });
      expect(res.status, `register "${reserved}"`).toBe(400);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Reserved");
    }

    const client = await mcpClient();
    for (const reserved of ["operator", "all"]) {
      const joined = await callTool(client, "join", { agent_name: reserved });
      expect(joined.ok, `join "${reserved}"`).toBe(false);
      expect(joined.error).toContain("Reserved");
    }

    // Nothing was registered: impersonating the human and colliding with the
    // broadcast become impossible via name collision.
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents).toHaveLength(0);
  }, 15_000);
});

describe("REST as operator", () => {
  it("POST /api/messages pins from=operator and the agent receives it via check_messages", async () => {
    await registerAgent("alpha");
    const alpha = await joinAs("alpha");

    const res = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: "hello from the human" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.delivery).toBe("queued_offline");
    expect(body.messages[0].from).toBe("operator");

    const checked = await callTool(alpha, "check_messages");
    expect(checked.messages).toHaveLength(1);
    expect(checked.messages[0].from).toBe("operator");
    expect(checked.messages[0].body).toBe("hello from the human");
  }, 15_000);

  it("POST /api/messages: 404 only for an unknown recipient; validation is 400", async () => {
    const post = (payload: unknown) =>
      fetch(api("/api/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    // broadcast with no recipients: invalid state, not a missing route → 400
    const broadcast = await post({ to: "all", body: "x" });
    expect(broadcast.status).toBe(400);
    expect(((await broadcast.json()) as any).error).toContain("Broadcast has no recipients");

    // self-send (operator → operator): validation → 400
    const self = await post({ to: "operator", body: "x" });
    expect(self.status).toBe(400);
    expect(((await self.json()) as any).error).toContain("yourself");

    // unknown recipient: real not-found → 404
    const unknown = await post({ to: "zeta", body: "x" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error).toContain("Unknown recipient");
  }, 15_000);

  it("DELETE /api/agents/:name removes the registration (offline only), emits agent_removed, keeps messages", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    // a message TO alpha that must survive the removal (append-only JSONL)
    await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: "survives the removal" }),
    });

    // online agent → 409 telling to stop it first (registry/reality guard)
    hub.store.updateAgent("alpha", { status: "online" });
    const refused = await fetch(api("/api/agents/alpha"), { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toContain("switchboard stop alpha");

    // offline agent → removed + SSE agent_removed on the stream
    hub.store.updateAgent("alpha", { status: "offline" });
    let removedStatus = 0;
    let removedBody: any;
    const sse = await collectSse(
      (text) => text.includes('"agent_removed"') && text.includes('"alpha"'),
      async () => {
        const res = await fetch(api("/api/agents/alpha"), { method: "DELETE" });
        removedStatus = res.status;
        removedBody = await res.json();
      },
    );
    expect(removedStatus).toBe(200);
    expect(removedBody.removed).toBe("alpha");
    expect(sse).toContain('"type":"agent_removed"');
    expect(sse).toContain('"name":"alpha"');

    // gone from the listing; unknown afterwards → 404
    const agents = (await (await fetch(api("/api/agents"))).json()) as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).not.toContain("alpha");
    const again = await fetch(api("/api/agents/alpha"), { method: "DELETE" });
    expect(again.status).toBe(404);

    // the message is still in the JSONL: re-registering the name sees it unread
    await registerAgent("alpha");
    expect(hub.store.unreadCount("alpha")).toBe(1);
  }, 15_000);

  it("POST /api/agents/:name/rename renames (offline only), keeps the history and re-addresses the agent", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    // a message TO alpha that must FOLLOW the rename (append-only JSONL)
    await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: "follows the rename" }),
    });

    const rename = (name: string, payload: unknown) =>
      fetch(api(`/api/agents/${name}/rename`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    // unknown agent → 404
    const ghost = await rename("ghost", { name: "zeta" });
    expect(ghost.status).toBe(404);
    expect(((await ghost.json()) as any).error).toContain("Unknown agent");

    // online agent → 409 telling to stop it first (its env still holds the old name)
    hub.store.updateAgent("alpha", { status: "online" });
    const refused = await rename("alpha", { name: "payments-api" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toContain("switchboard stop alpha");
    hub.store.updateAgent("alpha", { status: "offline" });

    // taken / invalid / reserved / missing new name → 400 with the actionable text
    const taken = await rename("alpha", { name: "beta" });
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as any).error).toContain("already");
    const invalid = await rename("alpha", { name: "Payments_API" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).error).toContain("Invalid agent name");
    const reserved = await rename("alpha", { name: "operator" });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as any).error).toContain("Reserved name");
    const missing = await rename("alpha", {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).error).toContain("Invalid body");
    // every refusal left the agent exactly where it was
    expect(hub.store.getAgent("alpha")).toBeDefined();

    // the happy path: 200 + the redacted agent, and the SSE pair on the stream
    let status = 0;
    let body: any;
    const sse = await collectSse(
      (text) => text.includes('"agent_removed"') && text.includes('"payments-api"'),
      async () => {
        const res = await rename("alpha", { name: "payments-api" });
        status = res.status;
        body = await res.json();
      },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.agent.name).toBe("payments-api");
    expect(body.agent.tmuxSession).toBe("sb-payments-api");
    expect(body.agent).not.toHaveProperty("token"); // v1.1: never leaves the hub
    // the old card vanishes, the new one appears — existing event types only
    expect(sse).toContain('"type":"agent_removed"');
    expect(sse).toContain('"name":"alpha"');
    expect(sse).toContain('"type":"agent_updated"');
    expect(sse).toContain('"name":"payments-api"');

    // the old name is gone from the listing and 404s on every :name route
    const agents = (await (await fetch(api("/api/agents"))).json()) as Array<{
      name: string;
      unreadCount: number;
    }>;
    expect(agents.map((a) => a.name).sort()).toEqual(["beta", "payments-api"]);
    expect((await rename("alpha", { name: "zeta" })).status).toBe(404);
    expect((await fetch(api("/api/agents/alpha"), { method: "DELETE" })).status).toBe(404);

    // the history followed: the unread of "alpha" is the unread of "payments-api"
    expect(agents.find((a) => a.name === "payments-api")?.unreadCount).toBe(1);

    // and the new name is a working ADDRESS: a message to it is delivered…
    const sent = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "payments-api", body: "addressed to the new name" }),
    });
    expect(sent.status).toBe(201);
    // …while the old address is unknown to the network
    const toOld = await fetch(api("/api/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alpha", body: "nobody lives here" }),
    });
    expect(toOld.status).toBe(404);

    // the agent joins under the new name and reads BOTH messages — the one
    // written to "alpha" before the rename and the one written to the new name
    tokens.set("payments-api", tokens.get("alpha")!); // rename keeps the token
    const renamedAgent = await joinAs("payments-api");
    const checked = await callTool(renamedAgent, "check_messages");
    expect(checked.messages.map((m: Message) => m.body)).toEqual([
      "follows the rename",
      "addressed to the new name",
    ]);
  }, 15_000);

  it("GET /api/messages: most recent first, ?agent filter (from OR to) and ?limit truncation", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    await registerAgent("gamma");
    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    expect((await callTool(alpha, "send_message", { to: "beta", message: "first" })).ok).toBe(true);
    expect((await callTool(beta, "send_message", { to: "alpha", message: "second" })).ok).toBe(true);
    expect((await callTool(alpha, "send_message", { to: "gamma", message: "third" })).ok).toBe(true);

    // reverse creation order, compared by body (not by broadcastId)
    const all = (await (await fetch(api("/api/messages"))).json()) as Message[];
    expect(all.map((m) => m.body)).toEqual(["third", "second", "first"]);

    // limit really truncates, keeping the most recent
    const limited = (await (await fetch(api("/api/messages?limit=2"))).json()) as Message[];
    expect(limited.map((m) => m.body)).toEqual(["third", "second"]);

    // ?agent matches sender OR recipient
    const betaSide = (await (await fetch(api("/api/messages?agent=beta"))).json()) as Message[];
    expect(betaSide.map((m) => m.body)).toEqual(["second", "first"]);

    // invalid limit → 400 {ok:false}
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const res = await fetch(api(`/api/messages?limit=${bad}`));
      expect(res.status, `limit=${bad}`).toBe(400);
      expect(((await res.json()) as any).ok).toBe(false);
    }
  }, 15_000);

  it("mute via REST reflects in the queued_muted delivery", async () => {
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

    const sent = await callTool(alpha, "send_message", { to: "beta", message: "psst" });
    expect(sent.ok).toBe(true);
    expect(sent.delivery).toBe("queued_muted");
  }, 15_000);
});

describe("SSE events beyond message_created (PRD 10.1)", () => {
  it("check_messages emits message_read and mute emits agent_updated on the stream", async () => {
    await registerAgent("alpha");
    await registerAgent("beta");
    const alpha = await joinAs("alpha");
    const beta = await joinAs("beta");

    const sent = await callTool(alpha, "send_message", { to: "beta", message: "read me" });
    expect(sent.ok).toBe(true);
    const stored = jsonlLines().find((l: any) => l.body === "read me") as Message;
    expect(stored).toBeDefined();

    // message_read on the stream, with the correct messageId.
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

    // agent_updated on the stream, with muted:true in the payload.
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

describe("MCP sessions (finding P6)", () => {
  it("session without join: check_messages and send_message require join; list_agents works", async () => {
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

  it("re-join of the SAME session with another name frees the previous name (no ghost agent)", async () => {
    await registerAgent("alpha");
    await registerAgent("gamma");
    const client = await joinAs("alpha"); // e.g. the model hallucinated the name…

    let agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents.find((a) => a.name === "alpha").mcpConnected).toBe(true);

    // …noticed and corrected with a second join on the same MCP session.
    const rejoined = await callTool(client, "join", {
      agent_name: "gamma",
      token: tokens.get("gamma"),
    });
    expect(rejoined.ok).toBe(true);

    agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents.find((a) => a.name === "gamma").mcpConnected).toBe(true);
    // The old name does NOT stay connected forever.
    expect(agents.find((a) => a.name === "alpha").mcpConnected).toBe(false);

    // And the new mapping works: gamma can operate.
    const checked = await callTool(client, "check_messages");
    expect(checked.ok).toBe(true);
  }, 15_000);

  it("boot reconciles ghost state: mcpConnected/online from a crash become false/offline", async () => {
    // agents.json exactly as a kill -9 leaves it: connected and online
    // (only a graceful close() resets it via dropSession).
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
      // No MCP session survives a hub restart (in-memory Map): the boot must
      // tear down the ghost state immediately.
      const agents = (await (
        await fetch(`http://127.0.0.1:${hub2.port}/api/agents`)
      ).json()) as any[];
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("alpha");
      expect(agents[0].mcpConnected).toBe(false);
      expect(agents[0].status).toBe("offline");

      // Along the way: PRD section 7 — the first serve creates config.json with
      // defaults (this dir2 did not receive the config.json the beforeEach injects).
      expect(fs.existsSync(path.join(dir2, "config.json"))).toBe(true);
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);

  it("an orphan session expires from inactivity and the agent loses mcpConnected", async () => {
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
        "agent alpha to lose mcpConnected after the session expires",
      );
      await client.close().catch(() => {});
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("capability token (addendum v1.1)", () => {
  it("join without a token or with the wrong token fails with an instructive error; with the correct token it enters", async () => {
    await registerAgent("alpha");
    const client = await mcpClient();

    // No token: refused, with a printenv SWITCHBOARD_AGENT_TOKEN instruction.
    const missing = await callTool(client, "join", { agent_name: "alpha" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("printenv SWITCHBOARD_AGENT_TOKEN");
    expect(missing.error).toContain("token");
    // The instructive error never echoes the expected token.
    expect(missing.error).not.toContain(tokens.get("alpha")!);

    // Wrong token (valid format, wrong value): refused all the same.
    const wrong = await callTool(client, "join", {
      agent_name: "alpha",
      token: "deadbeef".repeat(8),
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain("printenv SWITCHBOARD_AGENT_TOKEN");

    // The refused joins did not touch state: the agent stays disconnected.
    let agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents[0].mcpConnected).toBe(false);

    // Correct token: enters, and the normal join does NOT echo the token back.
    const ok = await callTool(client, "join", {
      agent_name: "alpha",
      token: tokens.get("alpha"),
    });
    expect(ok.ok).toBe(true);
    expect(ok).not.toHaveProperty("token");

    agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents[0].mcpConnected).toBe(true);
  }, 15_000);

  it("on-the-fly join returns the new token and a SECOND session only enters by presenting it", async () => {
    // The first session to claim the name becomes its owner (PRD 9.1 v1.1).
    const first = await mcpClient();
    const claimed = await callTool(first, "join", { agent_name: "nomad" });
    expect(claimed.ok).toBe(true);
    expect(claimed.token).toMatch(TOKEN_RE);

    // Second session without the token: refused with the instructive error.
    const second = await mcpClient();
    const denied = await callTool(second, "join", { agent_name: "nomad" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("printenv SWITCHBOARD_AGENT_TOKEN");

    // With the token issued at claim time: accepted (and it does not re-issue the token).
    const accepted = await callTool(second, "join", {
      agent_name: "nomad",
      token: claimed.token,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted).not.toHaveProperty("token");
  }, 15_000);

  it("re-registration REGENERATES the token: the old one is invalidated, the new one works", async () => {
    const oldToken = await registerAgent("alpha");
    const newToken = await registerAgent("alpha"); // re-attach (P7)
    expect(newToken).toMatch(TOKEN_RE);
    expect(newToken).not.toBe(oldToken);

    const stale = await mcpClient();
    const denied = await callTool(stale, "join", { agent_name: "alpha", token: oldToken });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("printenv SWITCHBOARD_AGENT_TOKEN");

    const fresh = await mcpClient();
    const ok = await callTool(fresh, "join", { agent_name: "alpha", token: newToken });
    expect(ok.ok).toBe(true);
  }, 15_000);

  it("GET /api/agents, list_agents, join and SSE events NEVER contain the token field", async () => {
    const alphaToken = await registerAgent("alpha");
    const betaToken = await registerAgent("beta");
    const alpha = await joinAs("alpha");

    // REST: no listed agent carries a token.
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent, `GET /api/agents (${agent.name})`).not.toHaveProperty("token");
    }

    // MCP: list_agents and the list returned by join are redacted too.
    const listed = await callTool(alpha, "list_agents");
    for (const agent of listed.agents) {
      expect(agent, `list_agents (${agent.name})`).not.toHaveProperty("token");
    }
    const rejoined = await callTool(alpha, "join", {
      agent_name: "alpha",
      token: tokens.get("alpha"),
    });
    for (const agent of rejoined.agents) {
      expect(agent, `join.agents (${agent.name})`).not.toHaveProperty("token");
    }

    // SSE: the mute triggers agent_updated — redacted payload, no token.
    const sse = await collectSse(
      (text) => text.includes("agent_updated") && text.includes('"muted":true'),
      async () => {
        const res = await fetch(api("/api/agents/beta/mute"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ muted: true }),
        });
        expect(res.status).toBe(200);
        // The mute response is redacted too.
        expect(((await res.json()) as any).agent).not.toHaveProperty("token");
      },
    );
    expect(sse).toContain("agent_updated");
    expect(sse).not.toContain('"token"');
    expect(sse).not.toContain(alphaToken);
    expect(sse).not.toContain(betaToken);
  }, 15_000);

  it("no hub log line contains the token", async () => {
    const token = await registerAgent("alpha");
    await joinAs("alpha");
    // A refused join also logs (warn) — and must not leak the expected token.
    const stranger = await mcpClient();
    const denied = await callTool(stranger, "join", {
      agent_name: "alpha",
      token: "0".repeat(64),
    });
    expect(denied.ok).toBe(false);

    // The logger writes synchronously (appendFileSync); the file is already complete.
    const logContent = fs.readFileSync(path.join(dir, "logs", "hub.log"), "utf8");
    expect(logContent.length).toBeGreaterThan(0);
    expect(logContent).toContain("agent registered: alpha"); // the flow logged…
    expect(logContent).not.toContain(token); // …but never the token
  }, 15_000);

  it("legacy snapshot without a token: join accepts, generates, returns and starts requiring the token", async () => {
    // pre-v1.1 agents.json: valid record, without the token field.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-legacy-"));
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir2, "agents.json"),
      JSON.stringify([
        {
          name: "alpha",
          role: "veteran",
          tmuxSession: "sb-alpha",
          cwd: "",
          status: "offline",
          mcpConnected: false,
          muted: false,
          createdAt: now,
          lastSeenAt: now,
          lastNudgeAt: null,
        },
      ]),
    );

    const hub2 = await startHub({
      baseDir: dir2,
      port: 0,
      quiet: true,
      onMessage: () => "queued_offline",
    });
    const localClients: Client[] = [];
    const connect = async () => {
      const client = new Client({ name: "legacy-test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub2.port}/mcp`)),
      );
      localClients.push(client);
      return client;
    };
    try {
      // First join without a token: accepted (legacy record), token generated and RETURNED.
      const first = await connect();
      const claimed = await callTool(first, "join", { agent_name: "alpha" });
      expect(claimed.ok).toBe(true);
      expect(claimed.token).toMatch(TOKEN_RE);

      // The generated token was persisted in the snapshot (local trust model).
      const snapshot = JSON.parse(
        fs.readFileSync(path.join(dir2, "agents.json"), "utf8"),
      ) as any[];
      expect(snapshot[0].token).toBe(claimed.token);

      // From here on the name is protected: a join without a token is refused…
      const second = await connect();
      const denied = await callTool(second, "join", { agent_name: "alpha" });
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("printenv SWITCHBOARD_AGENT_TOKEN");

      // …and with the issued token, accepted.
      const ok = await callTool(second, "join", {
        agent_name: "alpha",
        token: claimed.token,
      });
      expect(ok.ok).toBe(true);
    } finally {
      for (const client of localClients) await client.close().catch(() => {});
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("auxiliary endpoints", () => {
  it("GET /api/health responds {ok, uptime, version}", async () => {
    const res = await fetch(api("/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("GET /api/events heartbeats as a real EVENT, not only a comment", async () => {
    // The dashboard cannot see `: heartbeat` — EventSource drops comments — so
    // a stream killed by WSL2's localhost proxy (or a sleeping laptop) looks
    // exactly like an idle network and the feed silently stops. The observable
    // heartbeat is what lets the dashboard tell those apart, and nothing else
    // in the product would fail if it regressed to a comment.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-int-hb-"));
    const hub2 = await startHub({ baseDir: dir2, port: 0, quiet: true, heartbeatMs: 60 });
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${hub2.port}/api/events`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !buffer.includes('"type":"heartbeat"')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      expect(buffer).toContain('data: {"type":"heartbeat"');
      expect(buffer).toContain(": heartbeat"); // the comment stays, for dumb proxies
    } finally {
      controller.abort();
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("POST /api/agents/:name/nudge (hub with dispatcher): 404 unknown; 409 guard aborted", async () => {
    // Phase 3: the endpoint fires a REAL manual nudge, so this test uses a
    // dedicated hub WITHOUT the onMessage stub (default dispatcher). A tmux
    // session with a unique name that is guaranteed not to exist → the pane
    // guard fails closed (could not read the pane) → aborted, nothing typed,
    // 409. Same behavior with tmux absent (execFile ENOENT → fail-closed).
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
      expect(body.error).toContain("Manual nudge not delivered");
      expect(body.error).toContain("check_messages");

      const unknown = await fetch(`${base}/api/agents/zeta/nudge`, { method: "POST" });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as any).ok).toBe(false);
    } finally {
      await hub2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 15_000);

  it("POST /api/agents/:name/nudge with an injected onMessage (no dispatcher) responds 501", async () => {
    await registerAgent("alpha");
    const res = await fetch(api("/api/agents/alpha/nudge"), { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("without the nudge dispatcher");
  });

  it("a malformed JSON body responds JSON, never HTML (finding 5)", async () => {
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

  it("re-registering the same name does a logical re-attach (201, mcpConnected reset)", async () => {
    await registerAgent("alpha");
    await joinAs("alpha");
    // Re-register (e.g. a new `switchboard start alpha` after the session died).
    await registerAgent("alpha", "new role");
    const agents = (await (await fetch(api("/api/agents"))).json()) as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0].role).toBe("new role");
    expect(agents[0].mcpConnected).toBe(false); // reset until the new join
  }, 15_000);
});
