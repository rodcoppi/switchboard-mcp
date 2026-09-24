// Conversation JSONL parser — the foundation of the chat view. Pure: real log
// lines in, clean chat items out.

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexContextFrom,
  contextUsageFrom,
  contextWindowFor,
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

describe("contextUsageFrom — how full the window is", () => {
  // Claude Code stamps `usage` on every assistant message; the LAST one
  // describes what carries into the next turn. Cache reads dominate a long
  // session and ARE the conversation, so they count. Output does not — the
  // CLI's own meter leaves it out, and so do we.
  const line = (usage: Record<string, unknown>, model = "claude-opus-5", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", ...extra, message: { model, usage } });

  it("sums prompt + cache from the most recent stamp, excluding output", () => {
    const usage = contextUsageFrom([
      line({ input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 10 }),
      line({
        input_tokens: 2,
        cache_creation_input_tokens: 891,
        cache_read_input_tokens: 291_776,
        output_tokens: 640,
      }),
    ]);
    expect(usage).toEqual({ used: 292_669, window: 1_000_000, model: "claude-opus-5" });
  });

  it("takes the window from the model, not from how full the session is", () => {
    // Opus 5 runs with 1M even while it is still under 200k — the old guess
    // (">200k means 1M") showed a fresh 1M session as nearly full.
    expect(contextUsageFrom([line({ cache_read_input_tokens: 40_000, output_tokens: 500 })])).toEqual({
      used: 40_000,
      window: 1_000_000,
      model: "claude-opus-5",
    });
    expect(contextUsageFrom([line({ cache_read_input_tokens: 40_000 }, "claude-haiku-4-5")])?.window).toBe(200_000);
  });

  it("an unmapped model past 200k is bumped to 1M rather than shown over 100%", () => {
    expect(contextUsageFrom([line({ cache_read_input_tokens: 300_000 }, "claude-mystery-1")])?.window).toBe(1_000_000);
    expect(contextUsageFrom([line({ cache_read_input_tokens: 30_000 }, "claude-mystery-1")])?.window).toBe(200_000);
  });

  it("skips sidechain (subagent) stamps", () => {
    expect(
      contextUsageFrom([
        line({ cache_read_input_tokens: 70_000 }),
        line({ cache_read_input_tokens: 5 }, "claude-haiku-4-5", { isSidechain: true }),
      ]),
    ).toEqual({ used: 70_000, window: 1_000_000, model: "claude-opus-5" });
  });

  it("skips corrupt lines and lines without usage, and never throws", () => {
    expect(
      contextUsageFrom([
        line({ cache_read_input_tokens: 10 }, "claude-opus-4-5"),
        '{"broken": ',
        JSON.stringify({ type: "user", message: { content: "hi" } }),
      ]),
    ).toEqual({ used: 10, window: 200_000, model: "claude-opus-4-5" });
  });

  it("no usage anywhere → null (the dashboard then shows no gauge)", () => {
    expect(contextUsageFrom([])).toBeNull();
    expect(contextUsageFrom(['{"type":"user"}'])).toBeNull();
    // A zero-token stamp is not a reading either (output alone is not context).
    expect(contextUsageFrom([line({ input_tokens: 0, output_tokens: 50 })])).toBeNull();
  });
});

describe("contextWindowFor — the model table", () => {
  it("maps the ids this machine's transcripts actually record", () => {
    for (const m of [
      "claude-opus-5", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
      "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5[1m]",
      "opus", "sonnet", "fable",
    ]) {
      expect(contextWindowFor(m), m).toBe(1_000_000);
    }
    for (const m of ["claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-4-5", "", null, undefined]) {
      expect(contextWindowFor(m), String(m)).toBe(200_000);
    }
  });

  it("the [1m] suffix wins even on an otherwise-200k model", () => {
    expect(contextWindowFor("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });
});

describe("codexContextFrom — the Codex gauge", () => {
  // Shapes from a real rollout (codex-cli 0.154.0).
  const count = (last: number, window: number | null) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 977_431 },
          last_token_usage: { input_tokens: last - 553, output_tokens: 553, total_tokens: last },
          ...(window === null ? {} : { model_context_window: window }),
        },
      },
    });
  const turn = (model: string) => JSON.stringify({ type: "turn_context", payload: { model, cwd: "/x" } });

  it("reads the last request size against the session's active window", () => {
    expect(codexContextFrom([turn("gpt-6-astra"), count(50_000, 258_400), count(92_449, 258_400)])).toEqual({
      used: 92_449,
      window: 258_400,
      model: "gpt-6-astra",
    });
  });

  it("is reachable through contextUsageFrom(lines, \"codex\") with the same shape", () => {
    const lines = [count(1_000, 258_400)];
    expect(contextUsageFrom(lines, "codex")).toEqual({ used: 1_000, window: 258_400, model: null });
    // The claude reader finds nothing in a rollout.
    expect(contextUsageFrom(lines)).toBeNull();
  });

  it("no window → null (never borrows Claude's numbers); info:null is skipped", () => {
    expect(codexContextFrom([count(1_000, null)])).toBeNull();
    expect(
      codexContextFrom([count(2_000, 258_400), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } })]),
    ).toEqual({ used: 2_000, window: 258_400, model: null });
    expect(codexContextFrom(["{bad", ""])).toBeNull();
  });
});
