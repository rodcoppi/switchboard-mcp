// create_agent (owner, 08/10): an agent interviews the operator, drafts the
// PRD and asks for a new agent — a normal one or its own child. Nothing is
// made until the operator approves it with one click (owner's choice); any
// agent may ask, inside its own walls (owner's choice).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type StoreLogger } from "../src/server/store.js";
import {
  AgentRequests,
  CREATE_AGENT_DESCRIPTION,
  MAX_PENDING_PER_AGENT,
  claudeMdPointer,
  planAgentRequest,
  prdFileFor,
  type AgentRequest,
} from "../src/server/agent-requests.js";

let dir: string;
let store: Store;
let pending: AgentRequests;
const logger: StoreLogger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-agentreq-"));
  fs.mkdirSync(path.join(dir, "proj"));
  fs.mkdirSync(path.join(dir, "clients"));
  store = new Store(dir, logger);
  store.registerAgent({ name: "proj", tmuxSession: "sb-proj", cwd: path.join(dir, "proj"), group: "ai-panorama", agentType: "claude" });
  store.registerAgent({ name: "acme-social", tmuxSession: "sb-acme-social", cwd: dir, group: "ai-panorama/acme" });
  store.registerAgent({ name: "codexy", tmuxSession: "sb-codexy", cwd: dir, group: "ai-panorama", agentType: "codex" });
  pending = new AgentRequests();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ask = (from: string, input: Record<string, unknown>) =>
  planAgentRequest(store, pending, from, { prd: "# Brief\n\nDo the thing.", ...input } as never, dir);

describe("what an agent may ask for", () => {
  it("a new agent in its own group, in an existing folder", () => {
    const r = ask("proj", { name: "writer", folder: path.join(dir, "clients") });
    expect(r.ok && r.request).toMatchObject({ name: "writer", asChild: false, group: "ai-panorama", createFolder: false });
  });

  it("a new agent in a client subgroup of its group", () => {
    const r = ask("proj", { name: "writer", folder: path.join(dir, "clients"), group: "ai-panorama/acme" });
    expect(r.ok).toBe(true);
  });

  it("nothing outside its walls — another client, another agency", () => {
    expect(ask("acme-social", { name: "spy", folder: dir, group: "ai-panorama/globex" })).toMatchObject({ ok: false });
    const r = ask("proj", { name: "spy", folder: dir, group: "studio" });
    expect(!r.ok && r.error).toMatch(/outside your walls/);
  });

  it("the faz-tudo may place an agent in any group (in a folder of its own)", () => {
    store.registerAgent({ name: "faz-tudo", tmuxSession: "sb-faz-tudo", cwd: dir });
    store.updateAgent("faz-tudo", { everywhere: true });
    // Apart from the fixture's root, where agents of other groups work.
    const site = fs.mkdtempSync(path.join(os.tmpdir(), "sb-site-"));
    try {
      expect(ask("faz-tudo", { name: "site-helper", folder: site, group: "studio" }).ok).toBe(true);
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
    }
  });

  it("a child of itself: its folder and group, whatever was passed", () => {
    const r = ask("proj", { name: "proj-helper", as_child: true, folder: "/elsewhere", group: "studio" });
    expect(r.ok && r.request).toMatchObject({ asChild: true, parent: "proj", folder: path.join(dir, "proj"), group: "ai-panorama" });
  });

  it("a child asking for a child gives its own parent another one", () => {
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: path.join(dir, "proj"), parent: "proj", group: "ai-panorama" });
    const r = ask("proj-1", { name: "proj-2", as_child: true });
    expect(r.ok && r.request.parent).toBe("proj");
  });

  it("no children for an agent on another engine", () => {
    expect(ask("codexy", { name: "kid", as_child: true })).toMatchObject({ ok: false });
  });
});

describe("folders", () => {
  it("a missing folder is created only when asked — the model is told to ask the operator", () => {
    const target = path.join(dir, "clients", "acme-rev");
    const r = ask("proj", { name: "rev", folder: target });
    expect(!r.ok && r.error).toMatch(/Ask the operator whether to create it/);
    const r2 = ask("proj", { name: "rev", folder: target, create_folder: true });
    expect(r2.ok && r2.request.createFolder).toBe(true);
  });

  it("only its last level — a missing parent is an error", () => {
    const r = ask("proj", { name: "rev", folder: path.join(dir, "nope", "acme-rev"), create_folder: true });
    expect(!r.ok && r.error).toMatch(/Only the last folder is created/);
  });

  it("~ is the home it is given; relative paths are refused", () => {
    expect(ask("proj", { name: "rev", folder: "~/clients" }).ok).toBe(true);
    expect(ask("proj", { name: "rev", folder: "clients" })).toMatchObject({ ok: false });
  });
});

describe("the request itself", () => {
  it("needs a PRD, a free valid name, and no duplicate waiting", () => {
    expect(ask("proj", { name: "rev", folder: dir, prd: "  " })).toMatchObject({ ok: false });
    expect(ask("proj", { name: "Bad Name", folder: dir })).toMatchObject({ ok: false });
    expect(ask("proj", { name: "acme-social", folder: dir })).toMatchObject({ ok: false });
    expect(ask("proj", { name: "operator", folder: dir })).toMatchObject({ ok: false });
    const r = ask("proj", { name: "rev", folder: dir });
    if (r.ok) pending.add(r.request);
    expect(ask("proj", { name: "rev", folder: dir })).toMatchObject({ ok: false });
  });

  it("caps what one agent may have waiting, so a loop cannot flood the operator", () => {
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) {
      const r = ask("proj", { name: `rev-${i}`, folder: dir });
      if (r.ok) pending.add(r.request);
    }
    const r = ask("proj", { name: "one-more", folder: dir });
    expect(!r.ok && r.error).toMatch(/waiting for the operator/);
  });

  it("tells the model to interview the operator first, and that approval is the operator's", () => {
    expect(CREATE_AGENT_DESCRIPTION).toMatch(/CHILD of you/);
    expect(CREATE_AGENT_DESCRIPTION).toMatch(/draft its PRD/);
    expect(CREATE_AGENT_DESCRIPTION).toMatch(/approves it with one click/);
  });
});

describe("where the PRD goes", () => {
  const base = (over: Partial<AgentRequest>): AgentRequest => ({
    id: "x", from: "proj", name: "rev", asChild: false, folder: path.join(dir, "clients"), createFolder: false,
    group: "ai-panorama", prd: "p", createdAt: "", ...over,
  });

  it("PRD.md for a new agent; PRD-<name>.md when one is already there, or for a child", () => {
    expect(prdFileFor(base({}))).toBe(path.join(dir, "clients", "PRD.md"));
    fs.writeFileSync(path.join(dir, "clients", "PRD.md"), "theirs");
    expect(prdFileFor(base({}))).toBe(path.join(dir, "clients", "PRD-rev.md"));
    expect(prdFileFor(base({ asChild: true, folder: path.join(dir, "proj") }))).toBe(path.join(dir, "proj", "PRD-rev.md"));
  });

  it("the new folder's CLAUDE.md points at it", () => {
    expect(claudeMdPointer("PRD.md")).toContain("`PRD.md`");
  });
});
