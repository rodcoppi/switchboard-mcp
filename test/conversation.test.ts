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
