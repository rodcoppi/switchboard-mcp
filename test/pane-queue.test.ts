// What the hub reads off a live Claude Code 2.1.296 pane in bypass mode, with
// a message waiting in the CLI's queue (captured 11/10 with -e, as the
// dispatcher captures it). The footer is coloured WORD BY WORD, which is what
// made every bypass agent read "idle" mid-turn.

import { describe, expect, it } from "vitest";
import { parsePaneStatus } from "../src/server/dispatcher.js";

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
