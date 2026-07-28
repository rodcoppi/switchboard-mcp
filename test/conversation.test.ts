// Conversation JSONL parser — the foundation of the chat view. Pure: real log
// lines in, clean chat items out.

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanUserText,
  parseConversation,
  projectDirForCwd,
  toolSummary,
} from "../src/server/conversation.js";

const line = (obj: unknown): string => JSON.stringify(obj);

describe("projectDirForCwd", () => {
  it("encodes cwd the way Claude Code names its project dir", () => {
    expect(projectDirForCwd("/home/rod/projects/ClaudeMaster")).toBe(
      path.join(os.homedir(), ".claude", "projects", "-home-rod-projects-ClaudeMaster"),
    );
    // Every non-alphanumeric collapses to "-", so a space and a hyphen collide
    // (Claude Code's own encoding, verified against real dirs).
    expect(projectDirForCwd("/home/rod/ai panorama")).toContain("-home-rod-ai-panorama");
    expect(projectDirForCwd("/home/rod/ai-panorama")).toContain("-home-rod-ai-panorama");
  });
});

describe("toolSummary", () => {
  it("labels the common tools by their meaningful argument", () => {
    expect(toolSummary("Bash", { command: "npm test\n--watch" })).toBe("Bash: npm test");
    expect(toolSummary("Edit", { file_path: "/a/b/api.ts" })).toBe("Edit api.ts");
    expect(toolSummary("Read", { file_path: "/x/y/foo.md" })).toBe("Read foo.md");
    expect(toolSummary("Grep", { pattern: "TODO" })).toBe("Grep TODO");
    expect(toolSummary("Whatever", {})).toBe("Whatever");
  });
});

describe("cleanUserText", () => {
  it("strips harness machinery and keeps the human's words", () => {
    expect(cleanUserText("<system-reminder>ignore me</system-reminder>hello")).toBe("hello");
    expect(cleanUserText("<command-name>/model</command-name>")).toBe("");
    expect(cleanUserText("<local-command-stdout>Set model</local-command-stdout>")).toBe("");
    expect(cleanUserText("<task-notification>done</task-notification>")).toBe("");
    expect(cleanUserText("real question\n<system-reminder>x</system-reminder>")).toBe(
      "real question",
    );
  });
});

describe("parseConversation", () => {
  it("keeps user text, assistant text, and matches tool results by id", () => {
    const items = parseConversation([
      line({ type: "user", message: { role: "user", content: "fix the bug" } }),
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "5 passed", is_error: false }],
        },
      }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect((items[0] as any).text).toBe("fix the bug");
    expect((items[1] as any).text).toBe("On it.");
    const tool = items[2] as any;
    expect(tool.summary).toBe("Bash: npm test");
    expect(tool.result).toBe("5 passed");
    expect(tool.isError).toBe(false);
  });

  it("drops meta and sidechain lines, and command-only user turns", () => {
    const items = parseConversation([
      line({ type: "user", isMeta: true, message: { role: "user", content: "meta noise" } }),
      line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
      line({ type: "user", message: { role: "user", content: "<command-name>/x</command-name>" } }),
      line({ type: "user", message: { role: "user", content: "keep me" } }),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as any).text).toBe("keep me");
  });

  it("surfaces a QUEUED mid-turn message (attachment/queued_command) as a user turn", () => {
    // Shape verified on a live transcript: a message sent while the agent was
    // working never becomes a type:"user" record — it arrives as queue-operation
    // bookkeeping plus one attachment carrying the prompt. Dropping it left the
    // chat casca's optimistic echo stuck on "sending…" forever.
    const items = parseConversation([
      line({ type: "queue-operation", operation: "enqueue", content: "tamo com 64 gb aqui irmao" }),
      line({ type: "queue-operation", operation: "remove", content: "tamo com 64 gb aqui irmao" }),
      line({
        type: "attachment",
        isSidechain: false,
        timestamp: "2026-07-21T00:21:28.335Z",
        attachment: {
          type: "queued_command",
          prompt: "tamo com 64 gb aqui irmao",
          commandMode: "prompt",
          origin: { kind: "human" },
        },
      }),
    ]);
    expect(items).toEqual([
      { kind: "user", text: "tamo com 64 gb aqui irmao", ts: "2026-07-21T00:21:28.335Z" },
    ]);
  });

  it("ignores non-queued attachments and machinery-only queued prompts", () => {
    const items = parseConversation([
      line({ type: "attachment", attachment: { type: "file", path: "/x.png" } }),
      line({ type: "attachment", attachment: { type: "queued_command", prompt: "<system-reminder>x</system-reminder>" } }),
    ]);
    expect(items).toHaveLength(0);
  });

  // The casca hid what the terminal showed between turns — these three signals
  // exist in the transcript and now surface as quiet "marker" lines.
  it("surfaces turn_duration and away_summary system records as markers", () => {
    const items = parseConversation([
      line({ type: "system", subtype: "turn_duration", durationMs: 139866, timestamp: "T1" }),
      line({ type: "system", subtype: "turn_duration", durationMs: 400 }), // sub-second: dropped
      line({ type: "system", subtype: "away_summary", content: "Testando lip-sync no RunPod", timestamp: "T2" }),
      line({ type: "system", subtype: "stop_hook_summary", hookCount: 1 }), // still noise
    ]);
    expect(items).toEqual([
      { kind: "marker", text: "worked for 2m 20s", ts: "T1" },
      { kind: "marker", text: "while you were away: Testando lip-sync no RunPod", ts: "T2" },
    ]);
  });

  it("surfaces a task-notification (monitor event) as a marker, not a user bubble", () => {
    const notif =
      "<task-notification>\n<task-id>bg5eio3fd</task-id>\n<summary>Monitor event: \"Vigiando teste A relançado\"</summary>\n</task-notification>";
    const items = parseConversation([
      line({ type: "user", message: { role: "user", content: notif }, timestamp: "T3" }),
      line({ type: "attachment", attachment: { type: "queued_command", prompt: notif }, timestamp: "T4" }),
    ]);
    expect(items).toEqual([
      { kind: "marker", text: 'task: Monitor event: "Vigiando teste A relançado"', ts: "T3" },
      { kind: "marker", text: 'task: Monitor event: "Vigiando teste A relançado"', ts: "T4" },
    ]);
  });

  it("marks an errored tool result", () => {
    const items = parseConversation([
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "false" } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] } }),
    ]);
    const tool = items[0] as any;
    expect(tool.isError).toBe(true);
    expect(tool.result).toBe("boom");
  });

  it("skips a half-written trailing line instead of throwing", () => {
    const items = parseConversation([
      line({ type: "user", message: { role: "user", content: "ok" } }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"tru', // truncated
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as any).text).toBe("ok");
  });
});
