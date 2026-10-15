// Claude Code's "Heads up" notes, completed from Claude Code's own store when
// the pane cuts them short (owner, 15/10: "cliquei em learn more e deu pau").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultHeadsUpKeys, findHeadsUp, headsUpEntries, headsUpLines } from "../src/server/headsup.js";
import { parseHeadsUp } from "../src/server/dispatcher.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-headsup-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function store(sessions: unknown[]): void {
  fs.writeFileSync(path.join(dir, "cc-plugin-you-should-know_builtin-abc123.json"), JSON.stringify({ sessions, seen: [], known: [] }));
}

describe("the heads-up store", () => {
  it("reads each session's note: its one-liner, full text and state", () => {
    store([
      { id: "s1", tag: "Heads up", view: { kind: "explained", line: "The public repo still holds old names in its history.", text: "**Names stay in the history**\n- The repo is public.\n- Old commits still carry them." } },
      { id: "s2", tag: "Heads up", view: { kind: "offer", line: "A test account can send a fake signup to the ad platform.", explanation: "**Fake signups**\n* Creating an account fires the event." } },
      { id: "s3" },
    ]);
    const entries = headsUpEntries(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      line: "The public repo still holds old names in its history.",
      detail: ["Names stay in the history", "- The repo is public.", "- Old commits still carry them."],
      kind: "explained",
    });
    expect(entries[1].detail).toEqual(["Fake signups", "- Creating an account fires the event."]);
  });

  it("finds the note on screen by its one-liner, wrapped or not", () => {
    store([{ id: "s1", view: { kind: "offer", line: "The public repo still holds old names in its history, even with the files clean.", explanation: "x" } }]);
    const entries = headsUpEntries(dir);
    expect(findHeadsUp("The public repo still holds old names in its   history, even with the files clean.", entries)?.kind).toBe("offer");
    expect(findHeadsUp("Something else entirely, not in the store at all", entries)).toBeNull();
  });

  it("is empty, not an error, when there is no store", () => {
    expect(headsUpEntries(path.join(dir, "missing"))).toEqual([]);
  });

  it("knows the keys of each state, for when they scroll off the pane", () => {
    expect(defaultHeadsUpKeys("offer").map((k) => k.label)).toEqual(["Learn more", "Knew this already", "Dismiss"]);
    expect(defaultHeadsUpKeys("explained").map((k) => k.key)).toEqual(["1", "2", "0"]);
    expect(defaultHeadsUpKeys("something-new")).toEqual([]);
  });

  it("takes the markdown off", () => {
    expect(headsUpLines("**Bold** title\n\n* point with `code`")).toEqual(["Bold title", "- point with code"]);
  });
});

describe("a note cut short on screen", () => {
  it("does not read the scroll hint or a labelled rule as part of the note", () => {
    const pane = [
      "✦ Heads up · The public repo still holds old names in its history,",
      "  even with the files clean.",
      "",
      "  Names stay in the history",
      "  - The repo is public.",
      "↓ 12 more",
      "",
      "──────────────────────────── SOME-PROJECT ─",
      "❯ ",
    ].join("\n");
    expect(parseHeadsUp(pane)).toEqual({
      text: "The public repo still holds old names in its history, even with the files clean.",
      detail: ["Names stay in the history", "- The repo is public."],
      options: [],
    });
  });
});
