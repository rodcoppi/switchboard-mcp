// Agents asking for a group of their own (owner, 16/10): an AI "CEO" running a
// microbusiness in a group apart, which talks to the operator's main group and
// builds its own team there — every step on one-click approval, and no agent
// ever in another group's folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type StoreLogger } from "../src/server/store.js";
import { AgentRequests, CREATE_AGENT_DESCRIPTION, folderOfAnotherGroup, planAgentRequest } from "../src/server/agent-requests.js";
import { EventBus, broadcastTargets, createApiRouter, validateRecipient } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import { createLogger } from "../src/server/log.js";

let dir: string;
let store: Store;
let pending: AgentRequests;
const quiet: StoreLogger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-groupreq-"));
  for (const d of ["hq", "hq-site", "acme", "new-biz"]) fs.mkdirSync(path.join(dir, d));
  store = new Store(path.join(dir, "data"), quiet);
  store.registerAgent({ name: "hq", tmuxSession: "sb-hq", cwd: path.join(dir, "hq"), group: "agency", agentType: "claude" });
  store.registerAgent({ name: "hq-site", tmuxSession: "sb-hq-site", cwd: path.join(dir, "hq-site"), group: "agency" });
  store.registerAgent({ name: "acme-social", tmuxSession: "sb-acme-social", cwd: path.join(dir, "acme"), group: "agency/acme" });
  store.registerAgent({ name: "studio-dev", tmuxSession: "sb-studio-dev", cwd: path.join(dir, "studio"), group: "studio" });
  pending = new AgentRequests();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ask = (from: string, input: Record<string, unknown>) =>
  planAgentRequest(store, pending, from, { prd: "# CEO\n\nRun the business.", ...input } as never, dir);

describe("lines between groups (the store)", () => {
  it("lets two linked groups' agents message each other — and nothing else", () => {
    store.createGroup("biz");
    store.registerAgent({ name: "ceo", tmuxSession: "sb-ceo", cwd: path.join(dir, "new-biz"), group: "biz" });
    expect(store.canReach("ceo", "hq")).toBe(false);
    store.linkGroups("biz", "agency");
    expect(store.canReach("ceo", "hq")).toBe(true);
    expect(store.canReach("hq", "ceo")).toBe(true);
    // exactly those two groups: the agency's client stays walled, so does another group
    expect(store.canReach("ceo", "acme-social")).toBe(false);
    expect(store.canReach("ceo", "studio-dev")).toBe(false);
    // "all" stays in its own group
    expect(broadcastTargets(store, "ceo")).toEqual([]);
    expect(validateRecipient(store, "ceo", "hq")).toBeNull();
    store.unlinkGroups("agency", "biz");
    expect(store.canReach("ceo", "hq")).toBe(false);
  });

  it("keeps names, descriptions and lines across a restart, and moves them with a rename", () => {
    store.createGroup("biz");
    store.setGroupMeta("biz", { displayName: "Agentic Business", description: "An AI CEO runs it." });
    store.linkGroups("biz", "agency");
    const again = new Store(path.join(dir, "data"), quiet);
    expect(again.listGroupMeta()).toEqual({ biz: { displayName: "Agentic Business", description: "An AI CEO runs it." } });
    expect(again.listGroupLinks()).toEqual([["agency", "biz"]]);
    again.renameGroup("biz", "biz-two");
    expect(again.listGroupMeta()["biz-two"]?.displayName).toBe("Agentic Business");
    expect(again.listGroupLinks()).toEqual([["agency", "biz-two"]]);
    again.deleteGroup("biz-two");
    expect(again.listGroupLinks()).toEqual([]);
    expect(again.listGroupMeta()).toEqual({});
  });

  it("refuses a line to a group that does not exist, or to itself", () => {
    expect(() => store.linkGroups("agency", "nowhere")).toThrow(/Unknown group/);
    expect(() => store.linkGroups("agency", "agency")).toThrow();
  });
});

describe("asking for a new group (create_agent new_group)", () => {
  it("brings a top-level group, its first agent and the lines it asked for", () => {
    const r = ask("hq", {
      name: "ceo-agentic",
      folder: path.join(dir, "new-biz"),
      new_group: "agentic-business",
      new_group_display_name: "AGENTIC BUSINESS",
      new_group_description: "An AI CEO that runs a microbusiness.",
      allow_messages_with: ["agency"],
    });
    expect(r.ok && r.request).toMatchObject({
      name: "ceo-agentic",
      group: "agentic-business",
      newGroup: { name: "agentic-business", displayName: "AGENTIC BUSINESS", description: "An AI CEO that runs a microbusiness.", linkWith: ["agency"] },
    });
  });

  it("refuses a name that exists, a subgroup name, or a group that disagrees with it", () => {
    const base = { name: "ceo", folder: path.join(dir, "new-biz") };
    expect(ask("hq", { ...base, new_group: "studio" })).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
    expect(ask("hq", { ...base, new_group: "agency/biz" })).toMatchObject({ ok: false, error: expect.stringMatching(/no "\/"/) });
    expect(ask("hq", { ...base, new_group: "biz", group: "agency" })).toMatchObject({ ok: false, error: expect.stringMatching(/disagree/) });
  });

  it("opens lines only to groups the asker already reaches — the operator links others", () => {
    const r = ask("hq", { name: "ceo", folder: path.join(dir, "new-biz"), new_group: "biz", allow_messages_with: ["studio"] });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/outside your walls/) });
    const ok = ask("hq", { name: "ceo", folder: path.join(dir, "new-biz"), new_group: "biz", allow_messages_with: ["agency/acme"] });
    expect(ok.ok).toBe(true); // its own client is within its walls
  });

  it("never hands an agent another group's folder — same, inside or around it", () => {
    const biz = { name: "ceo", new_group: "biz" };
    expect(ask("hq", { ...biz, folder: path.join(dir, "hq") })).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to "hq"/) });
    fs.mkdirSync(path.join(dir, "hq", "sub"));
    expect(ask("hq", { ...biz, folder: path.join(dir, "hq", "sub") })).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to "hq"/) });
    expect(ask("hq", { ...biz, folder: dir })).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to/) });
    // within its own group, folders are shared as before
    expect(folderOfAnotherGroup(store, path.join(dir, "hq", "sub"), "agency")).toBeNull();
  });

  it("is in the tool's own words", () => {
    expect(CREATE_AGENT_DESCRIPTION).toMatch(/new_group/);
    expect(CREATE_AGENT_DESCRIPTION).toMatch(/allow_messages_with/);
  });
});

describe("approving it (one click makes the group, its lines and the agent)", () => {
  let server: import("node:http").Server;
  let base: string;
  let launched: string[];

  beforeEach(async () => {
    launched = [];
    const log = createLogger({ level: "error", filePath: path.join(dir, "logs", "hub.log"), stdout: false });
    const launcher = {
      launchAgent: async (input: { dir: string; name: string; group?: string }) => {
        if (input.name.endsWith("-fail")) throw new Error("tmux said no");
        launched.push(input.name);
        store.registerAgent({ name: input.name, tmuxSession: `sb-${input.name}`, cwd: input.dir, ...(input.group ? { group: input.group } : {}) });
        return store.getAgent(input.name);
      },
      stop: () => {},
    };
    const app = express();
    app.use(express.json());
    app.use(
      createApiRouter({
        store,
        config: { ...DEFAULTS },
        log,
        bus: new EventBus(),
        onMessage: () => "queued_offline",
        agentRequests: pending,
        launcher: launcher as never,
        startedAt: Date.now(),
        version: "test",
      }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("creates the group with its name and lines, then its first agent inside it", async () => {
    const plan = ask("hq", {
      name: "ceo-agentic",
      folder: path.join(dir, "new-biz"),
      new_group: "agentic-business",
      new_group_display_name: "AGENTIC BUSINESS",
      allow_messages_with: ["agency"],
    });
    if (!plan.ok) throw new Error(plan.error);
    const request = pending.add(plan.request);
    expect(store.listGroups()).not.toContain("agentic-business"); // nothing before the click

    const res = await fetch(`${base}/api/agent-requests/${request.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(launched).toEqual(["ceo-agentic"]);
    expect(store.getAgent("ceo-agentic")?.group).toBe("agentic-business");
    expect(store.listGroupMeta()["agentic-business"]?.displayName).toBe("AGENTIC BUSINESS");
    expect(store.canReach("ceo-agentic", "hq")).toBe(true);

    const groups = (await (await fetch(`${base}/api/groups`)).json()) as { links: string[][]; meta: Record<string, unknown> };
    expect(groups.links).toEqual([["agency", "agentic-business"]]);

    // and then its own teammates, in its own group, on the same approval
    const mate = planAgentRequest(store, pending, "ceo-agentic", { name: "ceo-sales", folder: path.join(dir, "new-biz"), prd: "# Sales" } as never, dir);
    expect(mate.ok && mate.request.group).toBe("agentic-business");
  });

  it("leaves no group behind when the agent cannot be launched — approving again redoes it", async () => {
    const plan = ask("hq", { name: "ceo-fail", folder: path.join(dir, "new-biz"), new_group: "biz", allow_messages_with: ["agency"] });
    if (!plan.ok) throw new Error(plan.error);
    const request = pending.add(plan.request);
    const res = await fetch(`${base}/api/agent-requests/${request.id}/approve`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(store.listGroups()).not.toContain("biz");
    expect(store.listGroupLinks()).toEqual([]);
    expect(pending.get(request.id)).toBeDefined(); // still there to approve again or deny
  });

  it("the operator links and unlinks groups from the dashboard", async () => {
    store.createGroup("biz");
    const on = await fetch(`${base}/api/group-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "biz", b: "studio", linked: true }),
    });
    expect(((await on.json()) as { links: string[][] }).links).toEqual([["biz", "studio"]]);
    const off = await fetch(`${base}/api/group-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "studio", b: "biz", linked: false }),
    });
    expect(((await off.json()) as { links: string[][] }).links).toEqual([]);
  });
});
