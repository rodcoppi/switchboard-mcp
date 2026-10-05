// Children (owner, 05/10): "o agente cria um filho ... com uma sessao nova do
// mesmo projeto ... da pra matar ele quando terminar o trampo". A child is a
// second Claude session in its parent's folder, so the one thing that must
// never happen is the two swapping conversations — on screen or on a wake.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLauncher, type Launcher, type LauncherTmux } from "../src/server/launcher.js";
import { EventBus, nextChildName } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import { createLogger } from "../src/server/log.js";
import { Store } from "../src/server/store.js";
import { projectDirForCwd } from "../src/server/conversation.js";
import {
  claimedElsewhere,
  sessionHistory,
  sessionHookSettings,
  sessionLogPath,
  transcriptFor,
} from "../src/server/sessions.js";

let dir: string;
let home: string;
let project: string;
let savedHome: string | undefined;
let store: Store;

const ID = {
  parentOld: "11111111-1111-4111-8111-111111111111",
  parentNow: "22222222-2222-4222-8222-222222222222",
  child: "33333333-3333-4333-8333-333333333333",
  childAfterClear: "44444444-4444-4444-8444-444444444444",
};

/** A conversation file in the project's Claude dir, `ageS` seconds old. */
function transcript(id: string, ageS: number): string {
  const file = path.join(projectDirForCwd(project), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  const t = Date.now() / 1000 - ageS;
  fs.utimesSync(file, t, t);
  return file;
}

/** What the child's SessionStart hook would have appended. */
function hookSaw(name: string, id: string, source: string): void {
  fs.mkdirSync(path.dirname(sessionLogPath(dir, name)), { recursive: true });
  fs.appendFileSync(
    sessionLogPath(dir, name),
    JSON.stringify({ session_id: id, transcript_path: "x", cwd: project, hook_event_name: "SessionStart", source }) + "\n",
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-children-"));
  home = path.join(dir, "home");
  project = path.join(dir, "proj");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  savedHome = process.env.HOME;
  process.env.HOME = home; // projectDirForCwd reads ~/.claude through os.homedir()
  const log = createLogger({ level: "error", filePath: path.join(dir, "logs", "hub.log"), stdout: false });
  store = new Store(dir, log);
  store.registerAgent({ name: "proj", tmuxSession: "sb-proj", cwd: project, agentType: "claude" });
});

afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("whose conversation is whose", () => {
  it("with no child around, the parent's is the folder's newest — exactly as before", () => {
    transcript(ID.parentOld, 100);
    const now = transcript(ID.parentNow, 10);
    expect(transcriptFor(dir, store.getAgent("proj")!, store.listAgents())).toBe(now);
  });

  it("a child's conversation is never the parent's, even when it is newer", () => {
    const parent = transcript(ID.parentNow, 100);
    transcript(ID.child, 5);
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project, parent: "proj" });
    store.updateAgent("proj-1", { sessionId: ID.child });
    hookSaw("proj-1", ID.child, "startup");
    expect(transcriptFor(dir, store.getAgent("proj")!, store.listAgents())).toBe(parent);
  });

  it("a child shows ITS conversation — and nothing before its first message", () => {
    transcript(ID.parentNow, 10);
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project, parent: "proj" });
    store.updateAgent("proj-1", { sessionId: ID.child });
    // Not yet talked: no file → nothing, never the parent's newest.
    expect(transcriptFor(dir, store.getAgent("proj-1")!, store.listAgents())).toBeNull();
    const mine = transcript(ID.child, 1);
    expect(transcriptFor(dir, store.getAgent("proj-1")!, store.listAgents())).toBe(mine);
  });

  it("after a child's /clear, both its old and new conversations stay out of the parent's chat", () => {
    const parent = transcript(ID.parentNow, 300);
    transcript(ID.child, 60);
    const fresh = transcript(ID.childAfterClear, 5);
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project, parent: "proj" });
    hookSaw("proj-1", ID.child, "startup");
    hookSaw("proj-1", ID.childAfterClear, "clear");
    expect(sessionHistory(dir, "proj-1")).toEqual([ID.child, ID.childAfterClear]);
    expect(transcriptFor(dir, store.getAgent("proj-1")!, store.listAgents())).toBe(fresh);
    expect(transcriptFor(dir, store.getAgent("proj")!, store.listAgents())).toBe(parent);
  });

  it("a KILLED child's conversations stay claimed (its log outlives it)", () => {
    const parent = transcript(ID.parentNow, 300);
    transcript(ID.child, 5);
    hookSaw("gone-child", ID.child, "startup"); // no agent record any more
    expect(claimedElsewhere(dir, store.getAgent("proj")!, store.listAgents()).has(ID.child)).toBe(true);
    expect(transcriptFor(dir, store.getAgent("proj")!, store.listAgents())).toBe(parent);
  });

  it("a torn line in a session log is skipped, not fatal", () => {
    fs.mkdirSync(path.dirname(sessionLogPath(dir, "proj-1")), { recursive: true });
    fs.writeFileSync(sessionLogPath(dir, "proj-1"), `{"session_id":"${ID.child}","cwd":"${project}"}\n{"session_id":"tor`);
    expect(sessionHistory(dir, "proj-1")).toEqual([ID.child]);
  });
});

describe("the hook a child is launched with", () => {
  it("appends to the child's own log and prints nothing", () => {
    const settings = JSON.parse(sessionHookSettings(dir, "proj-1"));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain(`>> '${sessionLogPath(dir, "proj-1")}'`); // append, never overwrite
    expect(command).toContain("tr -d '\\n'"); // one line per event
  });

  it("refuses a name that is not an agent name", () => {
    expect(() => sessionHookSettings(dir, "../x")).toThrow(/Invalid agent name/);
  });
});

describe("launching and waking a family", () => {
  let launcher: Launcher;
  let argvs: Map<string, string[]>;

  beforeEach(() => {
    argvs = new Map();
    const sessions = new Set<string>();
    const tmux: LauncherTmux = {
      hasSession: async (s) => sessions.has(s),
      killSession: async (s) => {
        sessions.delete(s);
      },
      newSession: async (s, _cwd, cmd) => {
        sessions.add(s);
        argvs.set(s, Array.isArray(cmd) ? cmd : [String(cmd)]);
      },
      capturePane: async () => "? for shortcuts",
      nudgeSession: async () => ({ sent: true }),
    };
    const log = createLogger({ level: "error", filePath: path.join(dir, "logs", "hub2.log"), stdout: false });
    launcher = createLauncher({
      store, tmux, config: { ...DEFAULTS }, log, bus: new EventBus(), settleMs: 1, sleep: async () => {}, claudeBin: "/bin/true",
    });
  });
  afterEach(() => launcher.stop());

  const tail = (session: string): string[] => {
    const argv = argvs.get(session)!;
    return argv.slice(argv.indexOf("/bin/true") + 1);
  };

  it("a child starts under its own session id, with the hook", async () => {
    await launcher.launchAgent({ dir: project, name: "proj-1", parent: "proj", continueConversation: false });
    const child = store.getAgent("proj-1")!;
    expect(child.parent).toBe("proj");
    expect(child.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const args = tail("sb-proj-1");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(child.sessionId);
    expect(args).toContain("--settings");
    expect(args).not.toContain("-c");
  });

  it("waking a child resumes ITS conversation by id", async () => {
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project, parent: "proj" });
    hookSaw("proj-1", ID.child, "startup");
    transcript(ID.child, 5);
    await launcher.launchAgent({ dir: project, name: "proj-1", continueConversation: true });
    const args = tail("sb-proj-1");
    expect(args[args.indexOf("--resume") + 1]).toBe(ID.child);
    expect(args).not.toContain("-c");
    expect(store.getAgent("proj-1")!.parent).toBe("proj"); // a wake keeps it a child
  });

  it("waking the parent resumes its own conversation — never -c, which would pick the child's", async () => {
    transcript(ID.parentNow, 300);
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project, parent: "proj" });
    hookSaw("proj-1", ID.child, "startup");
    transcript(ID.child, 5); // the child spoke last
    await launcher.launchAgent({ dir: project, name: "proj", continueConversation: true });
    const args = tail("sb-proj");
    expect(args).not.toContain("-c");
    expect(args[args.indexOf("--resume") + 1]).toBe(ID.parentNow);
  });

  it("an agent with no child around keeps the plain -c it always had", async () => {
    await launcher.launchAgent({ dir: project, name: "proj", continueConversation: true });
    expect(tail("sb-proj")).toContain("-c");
  });
});

describe("a child's default name", () => {
  it("is the first free <parent>-<n>", () => {
    expect(nextChildName(store, "proj")).toBe("proj-1");
    store.registerAgent({ name: "proj-1", tmuxSession: "sb-proj-1", cwd: project });
    expect(nextChildName(store, "proj")).toBe("proj-2");
  });

  it("shortens a long parent so the whole stays a valid name", () => {
    const long = "a".repeat(31);
    const name = nextChildName(store, long);
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name.endsWith("-1")).toBe(true);
  });
});
