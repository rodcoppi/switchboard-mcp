// Unit tests for the store (PRD Phase 1 + section 18).
// Every test runs against a fresh temp directory (never the real ~/.switchboard).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_AGENTS, Store, type StoreLogger } from "../src/server/store.js";

let dir: string;
let warnings: string[];

const silentLogger: StoreLogger = {
  info: (message) => void message,
  warn: (message) => warnings.push(message),
};

function newStore(): Store {
  return new Store(dir, silentLogger);
}

function registerAgent(store: Store, name: string) {
  return store.registerAgent({
    name,
    role: `role of ${name}`,
    tmuxSession: `sb-${name}`,
    cwd: `/tmp/${name}`,
  });
}

function rawLines(): string[] {
  return fs
    .readFileSync(path.join(dir, "messages.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-store-test-"));
  warnings = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agents", () => {
  it("registers and reads back an agent", () => {
    const store = newStore();
    const agent = registerAgent(store, "alpha");
    expect(agent.name).toBe("alpha");
    expect(agent.status).toBe("offline");
    expect(agent.mcpConnected).toBe(false);
    expect(agent.lastNudgeAt).toBeNull();
    expect(store.getAgent("alpha")?.role).toBe("role of alpha");
    expect(store.listAgents()).toHaveLength(1);
  });

  it("rejects invalid agent names", () => {
    const store = newStore();
    for (const bad of ["A", "a", "-alpha", "alpha_beta", "Alpha", "a".repeat(32), ""]) {
      expect(() => registerAgent(store, bad), `name: "${bad}"`).toThrow(/Invalid agent name/);
    }
    // boundary cases that must pass
    expect(() => registerAgent(store, "ab")).not.toThrow();
    expect(() => registerAgent(store, "a".repeat(31))).not.toThrow();
  });

  it('rejects the reserved names "operator" and "all" (system identities)', () => {
    const store = newStore();
    for (const reserved of ["operator", "all"]) {
      expect(() => registerAgent(store, reserved), `name: "${reserved}"`).toThrow(
        /Reserved name/,
      );
    }
    expect(store.listAgents()).toHaveLength(0);
  });

  it("skips reserved-name agents when loading the snapshot (legacy data)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    // simulate a snapshot written before the reserved-name guard existed
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8"));
    fs.writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify([snapshot[0], { ...snapshot[0], name: "operator" }]),
    );

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listAgents().map((a) => a.name)).toEqual(["alpha"]);
    expect(warnings.some((w) => w.includes("reserved"))).toBe(true);
  });

  it("resetConnectionState clears ghost mcpConnected/online state and persists it", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");
    store.updateAgent("alpha", { status: "online", mcpConnected: true });

    // reboot WITHOUT a graceful shutdown: the snapshot still says connected
    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")?.mcpConnected).toBe(true);
    expect(rebooted.getAgent("alpha")?.status).toBe("online");

    rebooted.resetConnectionState();
    expect(rebooted.getAgent("alpha")?.mcpConnected).toBe(false);
    expect(rebooted.getAgent("alpha")?.status).toBe("offline");
    expect(rebooted.getAgent("beta")?.status).toBe("offline"); // untouched

    // and the reset reached the snapshot, not just memory
    const boot3 = newStore();
    expect(boot3.getAgent("alpha")?.mcpConnected).toBe(false);
    expect(boot3.getAgent("alpha")?.status).toBe("offline");
  });

  it("removeAgent deletes the registration, persists, and keeps messages (JSONL untouched)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");
    store.appendMessage({ from: "operator", to: "alpha", body: "kept forever" });

    expect(store.removeAgent("alpha")).toBe(true);
    expect(store.getAgent("alpha")).toBeUndefined();
    expect(store.listAgents().map((a) => a.name)).toEqual(["beta"]);
    // unknown name → false, nothing changes
    expect(store.removeAgent("alpha")).toBe(false);

    // The removal reached the snapshot AND the message survived the reboot —
    // a later re-registration under the same name sees its old unread again.
    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")).toBeUndefined();
    expect(rebooted.getAgent("beta")).toBeDefined();
    expect(rebooted.listMessages().some((m) => m.body === "kept forever")).toBe(true);
    rebooted.registerAgent({ name: "alpha", tmuxSession: "sb-alpha", cwd: "/tmp" });
    expect(rebooted.unreadCount("alpha")).toBe(1);
  });

  it("reuses the record when the same name registers again (logical re-attach)", () => {
    const store = newStore();
    const first = registerAgent(store, "alpha");
    // normal post-join state of the previous incarnation
    store.updateAgent("alpha", { status: "online", mcpConnected: true });
    const again = store.registerAgent({
      name: "alpha",
      role: "new role",
      tmuxSession: "sb-alpha",
      cwd: "/tmp/other",
    });
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.role).toBe("new role");
    // re-register happens BEFORE the new Claude Code opens: stale status /
    // mcpConnected from the dead incarnation must be reset, never preserved
    expect(again.status).toBe("offline");
    expect(again.mcpConnected).toBe(false);
    expect(store.listAgents()).toHaveLength(1);
    // and the reset is persisted, not just in memory
    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")?.status).toBe("offline");
    expect(rebooted.getAgent("alpha")?.mcpConnected).toBe(false);
  });

  it("enforces the limit of 50 registered agents", () => {
    const store = newStore();
    for (let i = 0; i < MAX_AGENTS; i++) {
      registerAgent(store, `agent-${i}`);
    }
    expect(store.listAgents()).toHaveLength(MAX_AGENTS);
    expect(() => registerAgent(store, "one-too-many")).toThrow(/50/);
    // re-registering an existing name is still allowed at the cap
    expect(() => registerAgent(store, "agent-0")).not.toThrow();
  });

  it("updateAgent merges a patch and persists it across reboot", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    store.updateAgent("alpha", { status: "online", mcpConnected: true, muted: true });
    expect(() => store.updateAgent("ghost", { muted: true })).toThrow(/Unknown agent/);

    const rebooted = newStore();
    const agent = rebooted.getAgent("alpha");
    expect(agent?.status).toBe("online");
    expect(agent?.mcpConnected).toBe(true);
    expect(agent?.muted).toBe(true);
  });

  it("updateAgent ignores keys explicitly set to undefined (snapshot stays loadable)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    // e.g. Phase 3 code passing { lastNudgeAt: maybeUndefined }: JSON.stringify
    // would drop the key and the isAgent guard would discard the whole record
    // on the next boot
    store.updateAgent("alpha", { status: undefined, muted: true } as never);
    expect(store.getAgent("alpha")?.status).toBe("offline");
    expect(store.getAgent("alpha")?.muted).toBe(true);

    const rebooted = newStore();
    expect(rebooted.listAgents()).toHaveLength(1);
    expect(rebooted.getAgent("alpha")?.status).toBe("offline");
    expect(rebooted.getAgent("alpha")?.muted).toBe(true);
  });

  it("updateAgent rejects a patch that would produce an invalid record", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    expect(() =>
      store.updateAgent("alpha", { status: "weird" } as never),
    ).toThrow(/invalid record/);
    // nothing was mutated or persisted
    expect(store.getAgent("alpha")?.status).toBe("offline");
    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")?.status).toBe("offline");
  });

  it("renameAgent re-keys the registry, recomputes tmuxSession and persists across reboot", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");
    const renamed = store.renameAgent("alpha", "payments-api");

    expect(renamed.name).toBe("payments-api");
    // the session follows the address (default prefix "sb-", no config.json here)
    expect(renamed.tmuxSession).toBe("sb-payments-api");
    expect(store.getAgent("alpha")).toBeUndefined();
    expect(store.getAgent("payments-api")).toBeDefined();
    expect(store.listAgents().map((a) => a.name).sort()).toEqual(["beta", "payments-api"]);
    // identity is preserved — this is the SAME agent, not a new registration
    expect(renamed.createdAt).toBe(store.getAgent("payments-api")?.createdAt);
    expect(store.listAgents()).toHaveLength(2);

    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")).toBeUndefined();
    expect(rebooted.getAgent("payments-api")?.tmuxSession).toBe("sb-payments-api");
  });

  it("renameAgent honours the configured tmuxSessionPrefix", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ tmuxSessionPrefix: "cc-" }),
    );
    const store = newStore();
    registerAgent(store, "alpha");
    expect(store.renameAgent("alpha", "beta").tmuxSession).toBe("cc-beta");
  });

  it("renameAgent keeps the capability token (the old session is dead by definition)", () => {
    const store = newStore();
    const token = registerAgent(store, "alpha").token;
    expect(store.renameAgent("alpha", "beta").token).toBe(token);
  });

  it("renameAgent rejects unknown, invalid, reserved and taken names", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");

    expect(() => store.renameAgent("ghost", "zeta")).toThrow(/Unknown agent/);
    for (const bad of ["A", "a", "-zeta", "zeta_1", "Zeta", "a".repeat(32), ""]) {
      expect(() => store.renameAgent("alpha", bad), `name: "${bad}"`).toThrow(
        /Invalid agent name/,
      );
    }
    for (const reserved of ["operator", "all"]) {
      expect(() => store.renameAgent("alpha", reserved), `name: "${reserved}"`).toThrow(
        /Reserved name/,
      );
    }
    expect(() => store.renameAgent("alpha", "beta")).toThrow(/already/);

    // every refusal was total: no re-key, and NOTHING was appended
    expect(store.getAgent("alpha")).toBeDefined();
    expect(store.getAgent("beta")).toBeDefined();
    expect(fs.existsSync(path.join(dir, "messages.jsonl"))).toBe(false);
  });

  it("renameAgent to the same name is a no-op that appends nothing", () => {
    const store = newStore();
    const agent = registerAgent(store, "alpha");
    expect(store.renameAgent("alpha", "alpha")).toBe(agent);
    expect(store.getAgent("alpha")).toBeDefined();
    expect(fs.existsSync(path.join(dir, "messages.jsonl"))).toBe(false);
  });

  it("renameAgent bypasses the 50-agent cap (the agent count is unchanged)", () => {
    const store = newStore();
    for (let i = 0; i < MAX_AGENTS; i++) {
      registerAgent(store, `agent-${i}`);
    }
    expect(() => store.renameAgent("agent-0", "renamed-at-the-cap")).not.toThrow();
    expect(store.listAgents()).toHaveLength(MAX_AGENTS);
  });

  it("writes the agents.json snapshot atomically, leaving no temp file behind", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    store.updateAgent("alpha", { status: "online" });
    const entries = fs.readdirSync(dir);
    expect(entries).toContain("agents.json");
    expect(entries.filter((e) => e.includes("tmp"))).toEqual([]);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8"));
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].name).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// Groups: a wall, not a view. An agent may only reach its own group, which is
// what stops one project's agents from waking another's.
// ---------------------------------------------------------------------------

describe("groups", () => {
  function registerIn(store: Store, name: string, group?: string) {
    return store.registerAgent({
      name,
      tmuxSession: `sb-${name}`,
      cwd: `/tmp/${name}`,
      ...(group === undefined ? {} : { group }),
    });
  }

  it("an agent with no group belongs to the default group", () => {
    const store = newStore();
    const agent = registerIn(store, "legacy");
    // Absent, not "default": the snapshot stays free of a field that carries no
    // information, exactly like agentType.
    expect(agent.group).toBeUndefined();
    expect(store.listAgentsInGroup("default").map((a) => a.name)).toEqual(["legacy"]);
  });

  it("agents in the same group reach each other; agents in different groups do not", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    registerIn(store, "beta", "panorama");
    registerIn(store, "gamma", "site");

    expect(store.canReach("alpha", "beta")).toBe(true);
    expect(store.canReach("alpha", "gamma")).toBe(false);
    expect(store.canReach("gamma", "alpha")).toBe(false);
  });

  it("the operator is in no group and reaches everyone", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    registerIn(store, "gamma", "site");
    expect(store.canReach("operator", "alpha")).toBe(true);
    expect(store.canReach("operator", "gamma")).toBe(true);
  });

  it("a legacy agent and an explicitly-default one are in the same room", () => {
    const store = newStore();
    registerIn(store, "legacy");
    registerIn(store, "stated", "default");
    expect(store.canReach("legacy", "stated")).toBe(true);
  });

  it("re-registering without a group PRESERVES it (a restart must not escape the room)", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    const again = store.registerAgent({ name: "alpha", tmuxSession: "sb-alpha", cwd: "/tmp/a" });
    expect(again.group).toBe("panorama");
    // Otherwise a plain `switchboard start alpha` would drop it into default,
    // where it could suddenly message every agent on the machine.
    registerIn(store, "gamma", "site");
    expect(store.canReach("alpha", "gamma")).toBe(false);
  });

  it("re-registering WITH a group moves the agent", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    expect(registerIn(store, "alpha", "site").group).toBe("site");
  });

  it("a rename keeps the agent in its group", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    registerIn(store, "beta", "panorama");
    store.renameAgent("alpha", "alpha2");
    expect(store.canReach("alpha2", "beta")).toBe(true);
  });

  it("rejects a group name that is not a valid address", () => {
    const store = newStore();
    expect(() => registerIn(store, "alpha", "Chefe de Redes")).toThrow(/Invalid group name/);
  });

  it("listGroups reports every room that has an agent, legacy records included", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    registerIn(store, "gamma", "site");
    registerIn(store, "legacy");
    expect(store.listGroups()).toEqual(["default", "panorama", "site"]);
  });

  it("the group survives a reboot (snapshot round-trip)", () => {
    const store = newStore();
    registerIn(store, "alpha", "panorama");
    registerIn(store, "gamma", "site");
    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")?.group).toBe("panorama");
    expect(rebooted.canReach("alpha", "gamma")).toBe(false);
  });
});

describe("capability token (addendum v1.1)", () => {
  const TOKEN_RE = /^[0-9a-f]{64}$/; // crypto.randomBytes(32).toString("hex")

  it("registerAgent generates a 64-char hex token, unique per agent", () => {
    const store = newStore();
    const alpha = registerAgent(store, "alpha");
    const beta = registerAgent(store, "beta");
    expect(alpha.token).toMatch(TOKEN_RE);
    expect(beta.token).toMatch(TOKEN_RE);
    expect(alpha.token).not.toBe(beta.token);
  });

  it("re-registration (re-attach) REGENERATES the token and persists the new one in the snapshot", () => {
    const store = newStore();
    const first = registerAgent(store, "alpha").token;
    const second = registerAgent(store, "alpha").token; // previous session dead (P7)
    expect(second).toMatch(TOKEN_RE);
    expect(second).not.toBe(first);

    // The snapshot persists the token (local trust model) — and it is the NEW one.
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(dir, "agents.json"), "utf8"),
    ) as Array<{ token?: string }>;
    expect(snapshot[0].token).toBe(second);

    const rebooted = newStore();
    expect(rebooted.getAgent("alpha")?.token).toBe(second);
  });

  it("loads a legacy snapshot without the token field (a pre-v1.1 record is valid)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8"));
    delete snapshot[0].token; // like an agents.json written before the addendum
    fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(snapshot));

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listAgents().map((a) => a.name)).toEqual(["alpha"]);
    expect(rebooted.getAgent("alpha")?.token).toBeUndefined();
    expect(warnings).toHaveLength(0); // legacy is NOT an invalid record
  });
});

describe("messages", () => {
  it("appends a message and reads it back (memory and JSONL)", () => {
    const store = newStore();
    const msg = store.appendMessage({ from: "alpha", to: "beta", body: "hello beta" });
    expect(msg.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(msg.readAt).toBeNull();
    expect(msg.broadcastId).toBeNull();
    expect(store.getMessage(msg.id)).toEqual(msg);
    expect(store.listMessages()).toEqual([msg]);

    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(msg);
  });

  it("rejects messages with missing required fields", () => {
    const store = newStore();
    expect(() => store.appendMessage({ from: "", to: "beta", body: "x" })).toThrow(/from/);
    expect(() => store.appendMessage({ from: "alpha", to: "", body: "x" })).toThrow(/to/);
    expect(() => store.appendMessage({ from: "alpha", to: "beta", body: "" })).toThrow(/body/);
  });

  it("tracks unread per agent: unreadFor, unreadCount, unreadSenders", () => {
    const store = newStore();
    const m1 = store.appendMessage({ from: "alpha", to: "beta", body: "1" });
    const m2 = store.appendMessage({ from: "gamma", to: "beta", body: "2" });
    const m3 = store.appendMessage({ from: "alpha", to: "beta", body: "3" });
    store.appendMessage({ from: "beta", to: "alpha", body: "to another recipient" });

    expect(store.unreadFor("beta").map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(store.unreadCount("beta")).toBe(3);
    expect(store.unreadSenders("beta")).toEqual(["alpha", "gamma"]); // unique, in order
    expect(store.unreadCount("alpha")).toBe(1);

    store.markRead(m1.id);
    store.markRead(m2.id);
    expect(store.unreadCount("beta")).toBe(1);
    expect(store.unreadSenders("beta")).toEqual(["alpha"]);
  });

  it("markRead appends a read event instead of editing the message line", () => {
    const store = newStore();
    const msg = store.appendMessage({ from: "alpha", to: "beta", body: "read me" });
    expect(store.markRead(msg.id)).toBe(true);
    expect(store.getMessage(msg.id)?.readAt).not.toBeNull();

    const lines = rawLines();
    expect(lines).toHaveLength(2);
    // original line untouched: still readAt null
    expect(JSON.parse(lines[0])).toMatchObject({ id: msg.id, readAt: null });
    // appended read event
    expect(JSON.parse(lines[1])).toMatchObject({ type: "read", messageId: msg.id });

    // idempotent: no duplicate event, unknown id is a warn + false
    expect(store.markRead(msg.id)).toBe(false);
    expect(store.markRead("00000000000000000000000000")).toBe(false);
    expect(rawLines()).toHaveLength(2);
    expect(warnings.some((w) => w.includes("unknown"))).toBe(true);
  });

  it("message getters return copies — mutating them never bypasses markRead", () => {
    const store = newStore();
    const msg = store.appendMessage({ from: "alpha", to: "beta", body: "do not mute me" });

    // a Phase 2 slip like `getMessage(id)!.readAt = ...` (instead of markRead)
    // must NOT drain the unread state without appending the read event
    store.getMessage(msg.id)!.readAt = new Date().toISOString();
    store.listMessages()[0]!.readAt = new Date().toISOString();
    store.unreadFor("beta")[0]!.readAt = new Date().toISOString();

    expect(store.getMessage(msg.id)?.readAt).toBeNull();
    expect(store.unreadCount("beta")).toBe(1);
    expect(rawLines()).toHaveLength(1); // no read event was appended

    // memory and JSONL still agree after a reboot
    const rebooted = newStore();
    expect(rebooted.unreadCount("beta")).toBe(1);
  });

  it("stores broadcast copies as-is (expansion is the caller's job)", () => {
    const store = newStore();
    const b1 = store.appendMessage({ from: "operator", to: "alpha", body: "b", broadcastId: "bcast-1" });
    const b2 = store.appendMessage({ from: "operator", to: "beta", body: "b", broadcastId: "bcast-1" });
    expect(b1.broadcastId).toBe("bcast-1");
    expect(b2.broadcastId).toBe("bcast-1");
    expect(b1.id).not.toBe(b2.id);
    expect(store.unreadCount("alpha")).toBe(1);
    expect(store.unreadCount("beta")).toBe(1);
  });
});

describe("rename (the history follows the agent)", () => {
  it("appends ONE rename event, leaves the message lines untouched, and moves the unread", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    const m1 = store.appendMessage({ from: "operator", to: "alpha", body: "before the rename" });
    const m2 = store.appendMessage({ from: "beta", to: "alpha", body: "also before" });
    store.markRead(m2.id);

    store.renameAgent("alpha", "payments-api");

    // The unread moved with the agent — under the new address, not the old one.
    expect(store.unreadFor("payments-api").map((m) => m.id)).toEqual([m1.id]);
    expect(store.unreadCount("payments-api")).toBe(1);
    expect(store.unreadSenders("payments-api")).toEqual(["operator"]);
    expect(store.unreadCount("alpha")).toBe(0);

    const lines = rawLines();
    expect(lines).toHaveLength(4); // m1, m2, read(m2), rename
    // the original message lines are byte-for-byte what they always were:
    // still addressed to "alpha", never rewritten
    expect(JSON.parse(lines[0])).toEqual(m1);
    expect(JSON.parse(lines[1])).toMatchObject({ id: m2.id, to: "alpha", readAt: null });
    expect(JSON.parse(lines[2])).toMatchObject({ type: "read", messageId: m2.id });
    // exactly one rename event, and it carries the full redirection
    const renameLines = lines.map((l) => JSON.parse(l)).filter((r) => r.type === "rename");
    expect(renameLines).toHaveLength(1);
    expect(renameLines[0]).toMatchObject({
      type: "rename",
      from: "alpha",
      to: "payments-api",
    });
    expect(typeof renameLines[0].at).toBe("string");
  });

  it("the moved unread SURVIVES a reboot (the replay rebuilds the rename map)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    const m1 = store.appendMessage({ from: "operator", to: "alpha", body: "unread forever" });
    store.renameAgent("alpha", "beta");

    const rebooted = newStore(); // same dir, fresh instance — replay only
    expect(rebooted.getAgent("beta")).toBeDefined();
    expect(rebooted.getAgent("alpha")).toBeUndefined();
    expect(rebooted.unreadFor("beta").map((m) => m.id)).toEqual([m1.id]);
    expect(rebooted.unreadCount("beta")).toBe(1);
    expect(rebooted.unreadCount("alpha")).toBe(0);
    // and the redirected message is still readable through its own id
    expect(rebooted.markRead(m1.id)).toBe(true);
    expect(rebooted.unreadCount("beta")).toBe(0);
    expect(newStore().unreadCount("beta")).toBe(0);
  });

  it("follows a rename CHAIN: a → b → c resolves a's mail to c", () => {
    const store = newStore();
    registerAgent(store, "aaa");
    const m1 = store.appendMessage({ from: "operator", to: "aaa", body: "addressed to aaa" });
    store.renameAgent("aaa", "bbb");
    const m2 = store.appendMessage({ from: "operator", to: "bbb", body: "addressed to bbb" });
    store.renameAgent("bbb", "ccc");
    const m3 = store.appendMessage({ from: "operator", to: "ccc", body: "addressed to ccc" });

    expect(store.unreadFor("ccc").map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(store.unreadCount("aaa")).toBe(0);
    expect(store.unreadCount("bbb")).toBe(0);

    // and the chain replays identically from the JSONL alone
    const rebooted = newStore();
    expect(rebooted.unreadCount("ccc")).toBe(3);
  });

  it("resolves the SENDER's name too, so unreadSenders is always replyable", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");
    store.appendMessage({ from: "alpha", to: "beta", body: "hi from the old name" });
    store.renameAgent("alpha", "payments-api");

    // beta must be told who to answer TODAY — "alpha" no longer routes anywhere
    expect(store.unreadSenders("beta")).toEqual(["payments-api"]);
    expect(newStore().unreadSenders("beta")).toEqual(["payments-api"]);
  });

  it("a NEW agent registered under the freed old name keeps its own mail", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    const old = store.appendMessage({ from: "operator", to: "alpha", body: "the first alpha's" });
    store.renameAgent("alpha", "beta");

    // the operator frees the name and starts a brand-new, unrelated agent on it
    registerAgent(store, "alpha");
    const fresh = store.appendMessage({ from: "operator", to: "alpha", body: "the new alpha's" });

    // mail written BEFORE the rename followed the renamed agent…
    expect(store.unreadFor("beta").map((m) => m.id)).toEqual([old.id]);
    // …and mail written AFTER it belongs to whoever holds the address now
    expect(store.unreadFor("alpha").map((m) => m.id)).toEqual([fresh.id]);

    const rebooted = newStore();
    expect(rebooted.unreadFor("beta").map((m) => m.id)).toEqual([old.id]);
    expect(rebooted.unreadFor("alpha").map((m) => m.id)).toEqual([fresh.id]);
  });

  it("skips corrupted and nonsensical rename events on replay without crashing", () => {
    const store = newStore();
    const m1 = store.appendMessage({ from: "operator", to: "alpha", body: "keep me routed" });

    const file = path.join(dir, "messages.jsonl");
    fs.writeFileSync(
      file,
      [
        rawLines()[0],
        '{"type":"rename","from":"alpha"}', // no "to" → unrecognized record
        '{"type":"rename","from":"alpha","to":"","at":"2026-07-08T00:00:00.000Z"}', // empty target
        '{"type":"rename","from":"alpha","to":"alpha","at":"2026-07-08T00:00:00.000Z"}', // no-op
        '{"type":"rename","from":"alpha","to":"beta","at":"2026-07-08T00:00:00.000Z"}', // the good one
      ].join("\n") + "\n",
    );

    warnings = [];
    const rebooted = newStore();
    expect(warnings).toHaveLength(3); // one per bad line, none fatal
    expect(rebooted.listMessages().map((m) => m.id)).toEqual([m1.id]);
    // the one valid event still applies
    expect(rebooted.unreadCount("beta")).toBe(1);
    expect(rebooted.unreadCount("alpha")).toBe(0);
  });
});

describe("replay (reboot)", () => {
  it("rebuilds agents, messages and reads after a reboot", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    registerAgent(store, "beta");
    const m1 = store.appendMessage({ from: "alpha", to: "beta", body: "first" });
    const m2 = store.appendMessage({ from: "alpha", to: "beta", body: "second" });
    store.markRead(m1.id);

    const rebooted = newStore(); // same dir, fresh instance
    expect(rebooted.listAgents().map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    expect(rebooted.listMessages()).toHaveLength(2);
    expect(rebooted.getMessage(m1.id)?.readAt).not.toBeNull();
    expect(rebooted.getMessage(m2.id)?.readAt).toBeNull();
    expect(rebooted.unreadFor("beta").map((m) => m.id)).toEqual([m2.id]);
    expect(rebooted.unreadCount("beta")).toBe(1);
    expect(rebooted.unreadSenders("beta")).toEqual(["alpha"]);
  });

  it("skips corrupted lines in the middle of the file without crashing", () => {
    const store = newStore();
    const m1 = store.appendMessage({ from: "alpha", to: "beta", body: "before" });
    const m2 = store.appendMessage({ from: "alpha", to: "beta", body: "after" });
    store.markRead(m1.id);

    // corrupt the file: garbage between valid records + unrecognized JSON record
    const file = path.join(dir, "messages.jsonl");
    const lines = rawLines();
    fs.writeFileSync(
      file,
      [
        lines[0],
        "{this line is not valid JSON",
        '{"type":"read","messageId":"01MISSINGMESSAGE0000000000","readAt":"2026-07-08T00:00:00.000Z"}',
        '{"thing":"that is neither a message nor an event"}',
        lines[1],
        lines[2],
      ].join("\n") + "\n",
    );

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listMessages().map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(rebooted.getMessage(m1.id)?.readAt).not.toBeNull();
    expect(rebooted.unreadFor("beta").map((m) => m.id)).toEqual([m2.id]);
    expect(warnings).toHaveLength(3); // one per bad line, none fatal
  });

  it("seals a truncated final line (crash mid-append) so the next message survives", () => {
    const store = newStore();
    const m1 = store.appendMessage({ from: "alpha", to: "beta", body: "intact" });
    // simulate a crash mid-write: torn last line WITHOUT trailing newline
    fs.appendFileSync(path.join(dir, "messages.jsonl"), '{"id":"01TRUNCAD');

    warnings = [];
    const boot2 = newStore();
    // torn line skipped, file sealed with a newline
    expect(boot2.listMessages().map((m) => m.id)).toEqual([m1.id]);
    expect(warnings.some((w) => w.includes("newline"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "messages.jsonl"), "utf8").endsWith("\n")).toBe(true);

    // the next append must start on a fresh line, not glue onto the torn one
    const m2 = boot2.appendMessage({ from: "alpha", to: "beta", body: "new" });

    const boot3 = newStore();
    expect(boot3.getMessage(m2.id)).toBeDefined();
    expect(boot3.listMessages().map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(boot3.unreadCount("beta")).toBe(2); // only the torn line was lost
  });

  it("skips duplicated message lines (same id) on replay — unread can still drain", () => {
    const store = newStore();
    const m1 = store.appendMessage({ from: "alpha", to: "beta", body: "dup" });
    const line = rawLines()[0];
    fs.appendFileSync(path.join(dir, "messages.jsonl"), line + "\n");

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listMessages()).toHaveLength(1);
    expect(rebooted.unreadCount("beta")).toBe(1);
    expect(warnings.some((w) => w.includes("duplicated"))).toBe(true);

    // without the guard, the array copy would keep readAt null forever
    expect(rebooted.markRead(m1.id)).toBe(true);
    expect(rebooted.unreadCount("beta")).toBe(0);

    const boot3 = newStore();
    expect(boot3.unreadCount("beta")).toBe(0);
  });

  it("survives a corrupted agents.json snapshot (warn + empty)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    fs.writeFileSync(path.join(dir, "agents.json"), "{corrupted");

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listAgents()).toEqual([]);
    expect(warnings.some((w) => w.includes("agents.json"))).toBe(true);
  });

  it("survives agents.json that is valid JSON but not an array (warn + empty)", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    fs.writeFileSync(path.join(dir, "agents.json"), '{"not":"array"}');

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listAgents()).toEqual([]);
    expect(warnings.some((w) => w.includes("is not an array"))).toBe(true);
  });

  it("skips an invalid record inside agents.json but loads the valid ones", () => {
    const store = newStore();
    registerAgent(store, "alpha");
    // reuse the snapshot the store itself wrote as the valid record
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8"));
    fs.writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify([snapshot[0], { name: "broken" }]),
    );

    warnings = [];
    const rebooted = newStore();
    expect(rebooted.listAgents().map((a) => a.name)).toEqual(["alpha"]);
    expect(warnings.some((w) => w.includes("invalid"))).toBe(true);
  });
});
