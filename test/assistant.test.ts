// The faz-tudo (owner, 05/10): "um agente especial ... que eu falo sobre
// qualquer assunto a qualquer hora, ele tem acesso a todos os agentes ... e eu
// tenho um botão que apaga a sessão dele e abre uma nova limpa".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type StoreLogger } from "../src/server/store.js";
import {
  ASSISTANT_BRIEF,
  assistantDir,
  broadcastTargets,
  freeAssistantName,
  reachableFrom,
  validateRecipient,
} from "../src/server/api.js";
import { startHub, type Hub } from "../src/server/hub.js";
import { projectDirForCwd } from "../src/server/conversation.js";
import { transcriptFor } from "../src/server/sessions.js";

let dir: string;
let savedHome: string | undefined;
const logger: StoreLogger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-assistant-"));
  savedHome = process.env.HOME;
  process.env.HOME = path.join(dir, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

function board(): Store {
  const s = new Store(dir, logger);
  const add = (name: string, group?: string) =>
    s.registerAgent({ name, tmuxSession: `sb-${name}`, cwd: `/tmp/${name}`, ...(group ? { group } : {}) });
  add("acme-social", "ai-panorama/acme");
  add("globex-social", "ai-panorama/globex");
  add("site", "studio");
  add("faz-tudo");
  s.updateAgent("faz-tudo", { everywhere: true });
  return s;
}

describe("the one agent past every wall", () => {
  it("reaches every agent, in every group", () => {
    const s = board();
    expect(reachableFrom(s, "faz-tudo")).toEqual(["acme-social", "globex-social", "site"]);
    expect(s.listReachable("faz-tudo").map((a) => a.name).sort()).toEqual(["acme-social", "faz-tudo", "globex-social", "site"]);
    expect(validateRecipient(s, "faz-tudo", "globex-social")).toBeNull();
  });

  it("and every agent can answer it", () => {
    const s = board();
    expect(s.canReach("acme-social", "faz-tudo")).toBe(true);
    expect(s.canReach("site", "faz-tudo")).toBe(true);
  });

  it("lifts the wall for itself only — clients still never reach each other", () => {
    const s = board();
    expect(s.canReach("acme-social", "globex-social")).toBe(false);
  });

  it("broadcasts no wider than its own group", () => {
    // "all" from the assistant must not land in every client's room.
    expect(broadcastTargets(board(), "faz-tudo")).toEqual([]);
  });

  it("keeps the mark across a restart", () => {
    board();
    expect(new Store(dir, logger).getAgent("faz-tudo")?.everywhere).toBe(true);
  });
});

describe("where it lives and what it is told", () => {
  it("lives beside the projects when there is a ~/projects", () => {
    const home = process.env.HOME!;
    expect(assistantDir(home)).toBe(path.join(home, "faz-tudo"));
    fs.mkdirSync(path.join(home, "projects"));
    expect(assistantDir(home)).toBe(path.join(home, "projects", "faz-tudo"));
  });

  it("takes another name if 'faz-tudo' is someone else's", () => {
    const s = new Store(dir, logger);
    expect(freeAssistantName(s)).toBe("faz-tudo");
    s.registerAgent({ name: "faz-tudo", tmuxSession: "sb-faz-tudo", cwd: "/tmp" });
    expect(freeAssistantName(s)).toBe("faz-tudo-2");
  });

  it("is briefed to ask the owning agent instead of guessing, and to mind the walls", () => {
    expect(ASSISTANT_BRIEF).toContain("`list_agents`");
    expect(ASSISTANT_BRIEF).toContain("`send_message`");
    expect(ASSISTANT_BRIEF).toContain("`check_messages`");
    expect(ASSISTANT_BRIEF).toMatch(/Carry information from\s+one group to another only when the operator asks/);
  });

  it("shows only ITS conversation — a fresh session is an empty chat, not the folder's newest", () => {
    const s = board();
    const cwd = "/tmp/faz-tudo";
    const old = path.join(projectDirForCwd(cwd), "11111111-1111-4111-8111-111111111111.jsonl");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "{}\n");
    s.updateAgent("faz-tudo", { sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(transcriptFor(dir, s.getAgent("faz-tudo")!, s.listAgents())).toBeNull();
  });
});

describe("the conversation stream follows the agent", () => {
  // It used to 404 when there was no conversation yet, and the browser's
  // EventSource gives up for good on that — the chat sat on "reconnecting…".
  let hub: Hub;
  beforeEach(async () => {
    hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline", stt: null });
  });
  afterEach(async () => {
    await hub.close();
  });

  async function readEvents(name: string, ms: number, during?: () => void): Promise<Array<{ items: Array<{ text?: string }>; initial: boolean }>> {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/agents/${name}/conversation`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const events: Array<{ items: Array<{ text?: string }>; initial: boolean }> = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const stop = setTimeout(() => ctrl.abort(), ms);
    if (during) setTimeout(during, 300);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let at;
        while ((at = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    } catch {
      /* aborted */
    } finally {
      clearTimeout(stop);
    }
    return events;
  }

  it("opens empty, then picks the conversation up the moment it is written", async () => {
    const cwd = path.join(dir, "assistant");
    fs.mkdirSync(cwd);
    const id = "33333333-3333-4333-8333-333333333333";
    hub.store.registerAgent({ name: "faz-tudo", tmuxSession: "sb-faz-tudo", cwd });
    hub.store.updateAgent("faz-tudo", { everywhere: true, sessionId: id });
    const events = await readEvents("faz-tudo", 2600, () => {
      const file = path.join(projectDirForCwd(cwd), `${id}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ type: "user", message: { role: "user", content: "oi" }, uuid: "u1", timestamp: "2026-10-05T19:00:00.000Z" }) + "\n",
      );
    });
    expect(events[0]).toMatchObject({ items: [], initial: true });
    const later = events.slice(1).find((e) => e.initial && e.items.some((i) => i.text === "oi"));
    expect(later, JSON.stringify(events)).toBeTruthy();
  });

  it("empties when the agent moves to a new, unwritten conversation", async () => {
    const cwd = path.join(dir, "assistant2");
    fs.mkdirSync(cwd);
    const oldId = "44444444-4444-4444-8444-444444444444";
    const file = path.join(projectDirForCwd(cwd), `${oldId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "antes" }, uuid: "u1" }) + "\n");
    hub.store.registerAgent({ name: "faz-tudo", tmuxSession: "sb-faz-tudo", cwd });
    hub.store.updateAgent("faz-tudo", { everywhere: true, sessionId: oldId });
    const events = await readEvents("faz-tudo", 2600, () => {
      hub.store.updateAgent("faz-tudo", { sessionId: "55555555-5555-4555-8555-555555555555" });
    });
    expect(events[0].items.some((i) => i.text === "antes")).toBe(true);
    expect(events.slice(1).some((e) => e.initial && e.items.length === 0)).toBe(true);
  });
});
