// Subgroups: an agency's own agents in a group, one subgroup per client
// (owner, 30/09). The wall rule the owner chose: the agency reaches each
// client and each client reaches the agency — but one client NEVER reaches
// another client, so nothing of one leaks into the other.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROUP_NAME_RE, Store, groupsTouch, parentGroup, type StoreLogger } from "../src/server/store.js";
import { EventBus, broadcastTargets, deliverMessage, reachableFrom, validateRecipient } from "../src/server/api.js";
import { startHub, type Hub } from "../src/server/hub.js";

let dir: string;
const logger: StoreLogger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-subgroups-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function agency(): Store {
  const store = new Store(dir, logger);
  const add = (name: string, group: string) =>
    store.registerAgent({ name, tmuxSession: `sb-${name}`, cwd: `/tmp/${name}`, group });
  add("chefe", "ai-panorama");
  add("secretario", "ai-panorama");
  add("acme-social", "ai-panorama/acme");
  add("acme-video", "ai-panorama/acme");
  add("globex-social", "ai-panorama/globex");
  add("site", "studio");
  return store;
}

describe("group names", () => {
  it("allow one level of subgroup and nothing deeper", () => {
    expect(GROUP_NAME_RE.test("ai-panorama")).toBe(true);
    expect(GROUP_NAME_RE.test("ai-panorama/acme")).toBe(true);
    expect(GROUP_NAME_RE.test("ai-panorama/acme/team")).toBe(false);
    expect(GROUP_NAME_RE.test("ai-panorama/")).toBe(false);
    expect(GROUP_NAME_RE.test("/acme")).toBe(false);
    expect(GROUP_NAME_RE.test("Ai-Panorama/acme")).toBe(false);
  });

  it("know their parent", () => {
    expect(parentGroup("ai-panorama/acme")).toBe("ai-panorama");
    expect(parentGroup("ai-panorama")).toBeNull();
  });

  it("touch across one parent/child boundary, never between siblings", () => {
    expect(groupsTouch("ai-panorama", "ai-panorama/acme")).toBe(true);
    expect(groupsTouch("ai-panorama/acme", "ai-panorama")).toBe(true);
    expect(groupsTouch("ai-panorama/acme", "ai-panorama/globex")).toBe(false);
    expect(groupsTouch("ai-panorama/acme", "studio")).toBe(false);
  });
});

describe("who reaches whom", () => {
  it("the agency reaches every client, and each client reaches the agency", () => {
    const s = agency();
    expect(s.canReach("chefe", "acme-social")).toBe(true);
    expect(s.canReach("chefe", "globex-social")).toBe(true);
    expect(s.canReach("acme-social", "chefe")).toBe(true);
    expect(s.canReach("acme-social", "acme-video")).toBe(true);
  });

  it("a client never reaches another client", () => {
    const s = agency();
    expect(s.canReach("acme-social", "globex-social")).toBe(false);
    expect(s.canReach("globex-social", "acme-video")).toBe(false);
  });

  it("other groups stay walled off from the whole family", () => {
    const s = agency();
    expect(s.canReach("site", "chefe")).toBe(false);
    expect(s.canReach("site", "acme-social")).toBe(false);
    expect(s.canReach("acme-social", "site")).toBe(false);
  });

  it("an agent is shown exactly who it can message", () => {
    const s = agency();
    expect(reachableFrom(s, "acme-social")).toEqual(["acme-video", "chefe", "secretario"]);
    expect(reachableFrom(s, "chefe")).toEqual(["acme-social", "acme-video", "globex-social", "secretario"]);
    expect(s.listReachable("globex-social").map((a) => a.name).sort()).toEqual(["chefe", "globex-social", "secretario"]);
  });
});

describe("broadcast", () => {
  it("stays inside the sender's own group", () => {
    // The agency saying "all" to its team must not land in every client's room.
    const s = agency();
    expect(broadcastTargets(s, "chefe")).toEqual(["secretario"]);
    expect(broadcastTargets(s, "acme-social")).toEqual(["acme-video"]);
  });

  it("from the operator reaches the whole board", () => {
    expect(broadcastTargets(agency(), "operator")).toHaveLength(6);
  });
});

describe("renaming", () => {
  it("carries a parent's subgroups along with it", () => {
    // Left behind, the clients would sit under a parent that no longer
    // exists — outside its wall.
    const s = agency();
    s.renameGroup("ai-panorama", "panorama");
    expect(s.getAgent("chefe")?.group).toBe("panorama");
    expect(s.getAgent("acme-social")?.group).toBe("panorama/acme");
    expect(s.getAgent("globex-social")?.group).toBe("panorama/globex");
    expect(s.canReach("chefe", "acme-social")).toBe(true);
  });

  it("renames one subgroup without touching its siblings", () => {
    const s = agency();
    s.renameGroup("ai-panorama/acme", "ai-panorama/acme-corp");
    expect(s.getAgent("acme-video")?.group).toBe("ai-panorama/acme-corp");
    expect(s.getAgent("globex-social")?.group).toBe("ai-panorama/globex");
  });

  it("refuses to push a group with subgroups one level deeper", () => {
    const s = agency();
    expect(() => s.renameGroup("ai-panorama", "other/ai-panorama")).toThrow(/one level deep/);
  });

  it("persists across a restart", () => {
    agency().renameGroup("ai-panorama", "panorama");
    const again = new Store(dir, logger);
    expect(again.getAgent("acme-video")?.group).toBe("panorama/acme");
  });
});

describe("the path an agent's send_message actually takes", () => {
  // The REST /api/messages always sends as the operator (who reaches
  // everyone), so the wall has to be proven on the MCP path: validateRecipient
  // then deliverMessage.
  it("refuses a client writing to another client", () => {
    const err = validateRecipient(agency(), "acme-social", "globex-social");
    expect(err?.code).toBe("unknown_recipient");
    // …and names who it CAN write to, so the model can correct itself.
    const canMessage = err?.error.split("You can message:")[1] ?? "";
    expect(canMessage).toContain("chefe");
    expect(canMessage).not.toContain("globex");
  });

  it("lets a client write to its agency, and the agency to the client", () => {
    const s = agency();
    expect(validateRecipient(s, "acme-social", "chefe")).toBeNull();
    expect(validateRecipient(s, "chefe", "globex-social")).toBeNull();
  });

  it("delivers an agency's broadcast to its own team only", () => {
    const s = agency();
    const result = deliverMessage(s, new EventBus(), () => "queued_offline", { from: "chefe", to: "all", body: "team" });
    expect(result.messages.map((m) => m.to).sort()).toEqual(["secretario"]);
  });
});

describe("a group made before its agents", () => {
  // Owner, 01/10: "quero poder criar um subgrupo antes de por um agente". A
  // group used to exist only because an agent was in it.
  it("exists empty, and survives a restart", () => {
    const s = agency();
    s.createGroup("ai-panorama/initech");
    expect(s.listGroups()).toContain("ai-panorama/initech");
    expect(new Store(dir, logger).listGroups()).toContain("ai-panorama/initech");
  });

  it("brings its agency along when the agency is new too", () => {
    const s = new Store(dir, logger);
    s.createGroup("studio/client");
    expect(s.listGroups()).toEqual(["studio", "studio/client"]);
  });

  it("refuses a bad name and never stores 'default'", () => {
    const s = agency();
    expect(() => s.createGroup("a/b/c")).toThrow(/Invalid group name/);
    expect(() => s.createGroup("default")).toThrow(/Invalid group name/);
  });

  it("stays when its last agent leaves — gone only when deleted", () => {
    const s = agency();
    s.updateAgent("globex-social", { group: "ai-panorama" });
    expect(s.listGroups()).toContain("ai-panorama/globex");
    s.deleteGroup("ai-panorama/globex");
    expect(s.listGroups()).not.toContain("ai-panorama/globex");
  });

  it("cannot be deleted while an agent is in it or in one of its clients", () => {
    const s = agency();
    expect(() => s.deleteGroup("ai-panorama/acme")).toThrow(/not empty: acme-social, acme-video/);
    expect(() => s.deleteGroup("ai-panorama")).toThrow(/not empty/);
  });

  it("takes its empty clients with it when deleted", () => {
    const s = new Store(dir, logger);
    s.createGroup("studio/one");
    s.createGroup("studio/two");
    s.deleteGroup("studio");
    expect(s.listGroups()).toEqual([]);
  });

  it("can be renamed while empty, and an agency's empty clients follow it", () => {
    const s = agency();
    s.createGroup("ai-panorama/initech");
    s.renameGroup("ai-panorama", "panorama");
    expect(s.listGroups()).toContain("panorama/initech");
    expect(s.listGroups()).not.toContain("ai-panorama/initech");
    s.renameGroup("panorama/initech", "panorama/initrode");
    expect(s.listGroups()).toContain("panorama/initrode");
  });

  it("rebuilds the list from the agents when groups.json is missing or broken", () => {
    agency();
    fs.writeFileSync(path.join(dir, "groups.json"), "{not json");
    const s = new Store(dir, logger);
    expect(s.listGroups()).toEqual(["ai-panorama", "ai-panorama/acme", "ai-panorama/globex", "studio"]);
  });
});

describe("the groups REST endpoints", () => {
  let hub: Hub;
  const url = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
  beforeEach(async () => {
    hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline", stt: null });
  });
  afterEach(async () => {
    await hub.close();
  });

  it("create, list and delete an empty client", async () => {
    const made = await fetch(url("/api/groups"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ai-panorama/initech" }),
    });
    expect(made.status).toBe(200);
    const list = (await (await fetch(url("/api/groups"))).json()) as { groups: string[] };
    expect(list.groups).toEqual(["ai-panorama", "ai-panorama/initech"]);
    const gone = await fetch(url(`/api/groups/${encodeURIComponent("ai-panorama/initech")}`), { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { groups: string[] }).groups).toEqual(["ai-panorama"]);
  });

  it("answers 400 to a bad name and 409 to deleting a group with agents", async () => {
    const bad = await fetch(url("/api/groups"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Not A Name" }),
    });
    expect(bad.status).toBe(400);
    hub.store.registerAgent({ name: "acme-social", tmuxSession: "sb-acme-social", cwd: "/tmp/a", group: "ai-panorama/acme" });
    const busy = await fetch(url(`/api/groups/${encodeURIComponent("ai-panorama/acme")}`), { method: "DELETE" });
    expect(busy.status).toBe(409);
  });
});
