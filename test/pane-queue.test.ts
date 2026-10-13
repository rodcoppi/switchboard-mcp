// What the hub reads off a live Claude Code 2.1.296 pane in bypass mode, with
// a message waiting in the CLI's queue (captured 11/10 with -e, as the
// dispatcher captures it). The footer is coloured WORD BY WORD, which is what
// made every bypass agent read "idle" mid-turn.

import { describe, expect, it } from "vitest";
import { parseHeadsUp, parsePaneStatus, parseSpinner } from "../src/server/dispatcher.js";

const E = "\u001b";
const grey = (t: string) => `${E}[38;5;246m${t}${E}[39m`;
const pink = (t: string) => `${E}[38;5;211m${t}${E}[39m`;
const dim = (t: string) => `${E}[2m${t}${E}[0m`;

const QUEUED_PANE = [
  "● Bash(timeout 45 tail -f /dev/null; echo finished)",
  "  ⎿  Running… (7s)",
  `${E}[38;5;246m${E}[48;5;237m❯ QUEUED-PROBE: what is 3+3?${E}[39m${E}[49m`,
  `  ${grey("ctrl+x ctrl+s to send now")}`,
  "* Kneading… (9s · ↓ 113 tokens)",
  "────────────────────────────────────────",
  `${grey("❯ ")}${dim("Press")} ${dim("up")} ${dim("to")} ${dim("edit")} ${dim("queued")} ${dim("messages")}`,
  "────────────────────────────────────────",
  `  ${pink("⏵⏵")} ${pink("bypass")} ${pink("permissions")} ${pink("on")}${grey(" ·")} ${grey("1")} ${grey("shell")}${grey(" ·")} ${grey("esc")} ${grey("to")} ${grey("interrupt")}`,
].join("\n");

describe("a bypass pane, mid-turn, with a queued message", () => {
  const st = parsePaneStatus(QUEUED_PANE);

  it("reads working although each footer word has its own colour", () => {
    expect(st.working).toBe(true);
  });

  it("sees the queue by the CLI's own send-now hint", () => {
    expect(st.queued).toBe(true);
    expect(parsePaneStatus(QUEUED_PANE.replace("ctrl+x ctrl+s", "ctrl+enter")).queued).toBe(true);
    expect(parsePaneStatus(QUEUED_PANE.replace(/.*send now.*\n/, "")).queued).toBe(false);
  });

  it("reads the permission mode from the mid-turn footer, which has no shift+tab", () => {
    expect(st.permission).toBe("bypass");
  });

  it("does not take the dim queue placeholder for half-typed text", () => {
    expect(st.composerBusy).toBe(false);
    expect(st.blocked).toBe(false);
  });
});

describe("the CLI's live line", () => {
  it("gives the verb, this turn's clock and the note, without tokens or key hints", () => {
    expect(parseSpinner("· Canoodling… (23s · thinking more with xhigh effort)")).toEqual({
      verb: "Canoodling…",
      seconds: 23,
      note: "thinking more with xhigh effort",
    });
    expect(parseSpinner("* Kneading… (1m 9s · ↓ 113 tokens)")).toEqual({ verb: "Kneading…", seconds: 69, note: "" });
    expect(parseSpinner("• Working (12s • esc to interrupt)")).toEqual({ verb: "Working", seconds: 12, note: "" });
    expect(parseSpinner("· Transfiguring… (1h 2m · ↓ 108k tokens)")?.seconds).toBe(3720);
    // "+" is one of its frames on the owner's terminal (screenshot, 11/10)
    expect(parseSpinner("+ Topsy-turvying… (19s · still thinking with xhigh effort)")?.verb).toBe("Topsy-turvying…");
  });

  it("is not a finished turn's summary, and the last running line wins", () => {
    expect(parseSpinner("✻ Cooked for 3s · done 1:09 AM")).toBeNull();
    expect(parseSpinner("✻ Brewed for 7s · done 1:02 AM\n✶ Musing… (4s · ↓ 20 tokens)")?.verb).toBe("Musing…");
  });

  it("rides the pane status only while it works", () => {
    expect(parsePaneStatus(QUEUED_PANE).spinner).toEqual({ verb: "Kneading…", seconds: 9, note: "" });
    expect(parsePaneStatus("· Canoodling… (23s)\n❯ \n").spinner).toBeNull(); // no "esc to interrupt": not working
  });
});

describe("Claude Code's heads-up notes (pane only, never in the transcript)", () => {
  const PANE = [
    "+ Canoodling… (7m 18s · ↓ 35.0k tokens · thought for 2s)",
    "                                                   [-]",
    "✦ Heads up · When the agent is busy, a message carrying a picture is read only when the",
    "  whole task ends.",
    "  1: Learn more   2: Knew this already   0: Dismiss",
    "",
    "────────────",
    "❯ ",
    "────────────",
    "  ⏵⏵ bypass permissions on · esc to interrupt",
  ].join("\n");

  it("reads the note across its wrapped lines, with its keyed choices", () => {
    expect(parseHeadsUp(PANE)).toEqual({
      text: "When the agent is busy, a message carrying a picture is read only when the whole task ends.",
      detail: [],
      options: [
        { key: "1", label: "Learn more" },
        { key: "2", label: "Knew this already" },
        { key: "0", label: "Dismiss" },
      ],
    });
    expect(parsePaneStatus(PANE).headsUp?.options).toHaveLength(3);
  });

  it("reads a note expanded by Learn more — its detail and its NEW keys, past the blank line", () => {
    const expanded = [
      "✦ Heads up · The mailer does not notice when someone marks a message as spam, so it can drift into",
      "  spam unseen.",
      "",
      "  Spam can grow without the mailer noticing",
      "  - It pauses on its own in 2 cases: an address that does not exist and a reply asking out.",
      "  - The most dangerous signal is another: \"Mark as spam\". That notice never reaches",
      "    us.",
      "",
      "  1: Understood   2: Chat in main session   0: Dismiss",
      "────────────",
      "❯ ",
    ].join("\n");
    expect(parseHeadsUp(expanded)).toEqual({
      text: "The mailer does not notice when someone marks a message as spam, so it can drift into spam unseen.",
      detail: [
        "Spam can grow without the mailer noticing",
        "- It pauses on its own in 2 cases: an address that does not exist and a reply asking out.",
        '- The most dangerous signal is another: "Mark as spam". That notice never reaches us.',
      ],
      options: [
        { key: "1", label: "Understood" },
        { key: "2", label: "Chat in main session" },
        { key: "0", label: "Dismiss" },
      ],
    });
  });

  it("is null when no note is on screen", () => {
    expect(parseHeadsUp("❯ \n  ⏵⏵ bypass permissions on")).toBeNull();
    expect(parsePaneStatus(QUEUED_PANE).headsUp).toBeNull();
  });
});

describe("only the CLI's own lines count, never the conversation (12/10)", () => {
  // An idle agent whose last reply QUOTED the phrases read as working and
  // queued — the reply sits above the input box like any other text.
  const IDLE_QUOTING = [
    "● The footer says \"esc to interrupt\" while it works, and",
    "  ctrl+x ctrl+s to send now",
    "  ✻ Working… (12s · esc to interrupt)",
    "✻ Cooked for 3s · done 1:09 AM",
    "────────────",
    "❯ ",
    "────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  it("reads an idle pane as idle, whatever its conversation says", () => {
    const st = parsePaneStatus(IDLE_QUOTING);
    expect(st.working).toBe(false);
    expect(st.spinner).toBeNull();
  });

  it("does not take a quoted hint inside a reply for the CLI's queue", () => {
    expect(parsePaneStatus(IDLE_QUOTING.replace("  ctrl+x ctrl+s to send now", "  see the ctrl+x ctrl+s to send now hint")).queued).toBe(false);
  });
});

describe("the terminal's first frame", () => {
  it("sends a main-screen pane's history and clears the viewer's old copy first", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/server/terminal.ts", import.meta.url), "utf8");
    expect(src).toContain("#{alternate_on} #{history_size}");
    expect(src).toContain("-S -${history}");
    expect(src).toContain('"\\x1b[?25l\\x1b[0m\\x1b[3J\\x1b[2J\\x1b[H"');
  });
});
