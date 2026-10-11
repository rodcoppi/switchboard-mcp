// The last thing each agent said, for its card (design pass, owner 11/10:
// "a última coisa que ele falou").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type StoreLogger } from "../src/server/store.js";
import { LAST_REPLY_MAX, LastReplies, lastReplyIn, plainReply } from "../src/server/last-reply.js";
import { projectDirForCwd } from "../src/server/conversation.js";

const logger: StoreLogger = { info: () => {}, warn: () => {} };
let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-lastreply-"));
  savedHome = process.env.HOME;
  process.env.HOME = path.join(dir, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

const user = (text: string, ts: string) =>
  JSON.stringify({ type: "user", uuid: `u${ts}`, timestamp: ts, message: { role: "user", content: text } });
const said = (text: string, ts: string) =>
  JSON.stringify({ type: "assistant", uuid: `a${ts}`, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (ts: string) =>
  JSON.stringify({ type: "assistant", uuid: `t${ts}`, timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: `x${ts}`, name: "Bash", input: { command: "ls" } }] } });

describe("plainReply", () => {
  it("takes the markdown off and flattens it to one line", () => {
    expect(plainReply("## Done\n\n- **Size:** 44s\n- see `out.mp4` and [the notes](http://x)")).toBe("Done Size: 44s see out.mp4 and the notes");
  });
  it("drops code blocks and cuts long replies with an ellipsis", () => {
    expect(plainReply("Ran it:\n```\nnpm test\n```\nAll green.")).toBe("Ran it: All green.");
    const long = plainReply("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(LAST_REPLY_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("lastReplyIn", () => {
  it("is the last thing the agent SAID — tool calls after it do not count", () => {
    const lines = [user("go", "2026-10-11T10:00:00.000Z"), said("First.", "2026-10-11T10:01:00.000Z"), said("Second.", "2026-10-11T10:02:00.000Z"), tool("2026-10-11T10:03:00.000Z")];
    expect(lastReplyIn(lines, false)).toEqual({ text: "Second.", at: "2026-10-11T10:02:00.000Z" });
  });
  it("skips a provider error logged as a reply", () => {
    const lines = [said("Real answer.", "2026-10-11T10:01:00.000Z"), said("API Error: 529 overloaded", "2026-10-11T10:02:00.000Z")];
    expect(lastReplyIn(lines, false)?.text).toBe("Real answer.");
  });
  it("is null when it has said nothing yet", () => {
    expect(lastReplyIn([user("hello", "2026-10-11T10:00:00.000Z")], false)).toBeNull();
  });
});

describe("LastReplies.sweep", () => {
  it("puts the reply on the agent once, and again only when the transcript changes", () => {
    const store = new Store(path.join(dir, "sb"), logger);
    const cwd = path.join(dir, "proj");
    fs.mkdirSync(cwd);
    store.registerAgent({ name: "editor", tmuxSession: "sb-editor", cwd });
    const file = path.join(projectDirForCwd(cwd), "11111111-1111-4111-8111-111111111111.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [user("go", "2026-10-11T10:00:00.000Z"), said("Rendered.", "2026-10-11T10:05:00.000Z")].join("\n") + "\n");
    const replies = new LastReplies(store);
    expect(replies.sweep()).toEqual(["editor"]);
    expect(store.getAgent("editor")).toMatchObject({ lastReply: "Rendered.", lastReplyAt: "2026-10-11T10:05:00.000Z" });
    expect(replies.sweep()).toEqual([]); // nothing changed: nothing written
    fs.appendFileSync(file, said("Trimmed 1s off the end.", "2026-10-11T10:09:00.000Z") + "\n");
    expect(replies.sweep()).toEqual(["editor"]);
    expect(store.getAgent("editor")?.lastReply).toBe("Trimmed 1s off the end.");
  });

  it("reads only the end of a long transcript", () => {
    const store = new Store(path.join(dir, "sb"), logger);
    const cwd = path.join(dir, "big");
    fs.mkdirSync(cwd);
    store.registerAgent({ name: "big", tmuxSession: "sb-big", cwd });
    const file = path.join(projectDirForCwd(cwd), "22222222-2222-4222-8222-222222222222.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = Array.from({ length: 3000 }, (_, i) => said(`old reply ${i} ${"x".repeat(80)}`, "2026-10-11T09:00:00.000Z"));
    fs.writeFileSync(file, [...filler, said("The newest.", "2026-10-11T10:00:00.000Z")].join("\n") + "\n");
    new LastReplies(store).sweep();
    expect(store.getAgent("big")?.lastReply).toBe("The newest.");
  });
});
