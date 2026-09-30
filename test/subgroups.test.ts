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
