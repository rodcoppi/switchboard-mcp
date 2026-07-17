// Codex rollout parsing + locating — the chat casca's codex data source.
// Fixture shapes are drawn from a REAL rollout written by codex-cli 0.144.5.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSessionsDir, findCodexRolloutForCwd, parseCodexRollout } from "../src/server/codexlog.js";

const line = (obj: unknown): string => JSON.stringify(obj);

describe("parseCodexRollout", () => {
  it("keeps user/agent event_msg text and matches tool outputs by call_id", () => {
    const items = parseCodexRollout([
      line({ type: "session_meta", payload: { id: "t1", cwd: "/x" } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "acha o bug aí" }, timestamp: "T1" }),
      line({
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "ls -la /tmp\necho done" },
      }),
      line({
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "total 0\n" }] },
      }),
      line({ type: "event_msg", payload: { type: "agent_message", message: "Achei. Era o hook." }, timestamp: "T2" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect((items[0] as any).text).toBe("acha o bug aí");
    const tool = items[1] as any;
    expect(tool.name).toBe("exec");
    expect(tool.summary).toBe("exec: ls -la /tmp");
    expect(tool.result).toBe("total 0\n");
    expect((items[2] as any).text).toBe("Achei. Era o hook.");
  });

  it("skips developer/env response_item messages and encrypted reasoning", () => {
    const items = parseCodexRollout([
      line({
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions...>" }] },
      }),
      line({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] },
      }),
      line({
        type: "response_item",
        payload: { type: "reasoning", summary: [], encrypted_content: "gAAAA…" },
      }),
      line({ type: "event_msg", payload: { type: "user_message", message: "oi" } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("user");
  });

  it("renders a READABLE reasoning summary as thinking", () => {
    const items = parseCodexRollout([
      line({
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "preciso checar o hook" }] },
      }),
    ]);
    expect(items).toEqual([{ kind: "thinking", text: "preciso checar o hook", ts: undefined }]);
  });

  it("skips a half-written tail line instead of throwing", () => {
    const items = parseCodexRollout([
      line({ type: "event_msg", payload: { type: "agent_message", message: "ok" } }),
      '{"type":"event_msg","payload":{"type":"agent_mess', // truncated
    ]);
    expect(items).toHaveLength(1);
  });
});

describe("findCodexRolloutForCwd", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-codex-"));
    dirs.push(root);
    return root;
  }
  function writeRollout(root: string, rel: string, cwd: string, mtime: Date): string {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line({ type: "session_meta", payload: { id: rel, cwd } }) + "\n");
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it("returns the NEWEST rollout whose session_meta.cwd matches", () => {
    const root = makeTree();
    writeRollout(root, "2026/07/10/rollout-a.jsonl", "/proj/a", new Date("2026-07-10"));
    const newer = writeRollout(root, "2026/07/16/rollout-b.jsonl", "/proj/a", new Date("2026-07-16"));
    writeRollout(root, "2026/07/17/rollout-c.jsonl", "/proj/OTHER", new Date("2026-07-17"));
    expect(findCodexRolloutForCwd("/proj/a", root)).toBe(newer);
  });

  it("matches even when session_meta is a HUGE line (embedded base_instructions)", () => {
    // Real 0.144.5 rollouts embed the CLI's whole system prompt in the first
    // line (>16 KB) — the locator must not depend on reading the line whole.
    const root = makeTree();
    const file = path.join(root, "2026/07/16/rollout-big.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const meta = {
      type: "session_meta",
      payload: { id: "big", cwd: "/proj/big", base_instructions: { text: "x".repeat(40_000) } },
    };
    fs.writeFileSync(file, JSON.stringify(meta) + "\n");
    expect(findCodexRolloutForCwd("/proj/big", root)).toBe(file);
  });

  it("returns null when nothing matches or the tree is missing", () => {
    const root = makeTree();
    writeRollout(root, "2026/07/16/rollout-b.jsonl", "/somewhere", new Date());
    expect(findCodexRolloutForCwd("/proj/none", root)).toBeNull();
    expect(findCodexRolloutForCwd("/proj/none", path.join(root, "ghost"))).toBeNull();
  });
});

describe("codexSessionsDir", () => {
  it("honours CODEX_HOME and falls back to ~/.codex", () => {
    expect(codexSessionsDir({ CODEX_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe("/custom/sessions");
    expect(codexSessionsDir({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), ".codex", "sessions"));
  });
});

describe("codexTokensToday", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("sums the last token_count of each of the day's rollouts", async () => {
    const { codexTokensToday } = await import("../src/server/codexlog.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-ctok-"));
    dirs.push(root);
    const now = new Date(2026, 6, 17, 3, 0, 0); // 2026-07-17 local
    const day = path.join(root, "2026", "07", "17");
    fs.mkdirSync(day, { recursive: true });
    const tc = (total: number, input: number, output: number, reasoning: number) =>
      JSON.stringify({ type: "response_item", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } } } });
    // rollout A: two token_counts — the LAST (cumulative) is what counts
    fs.writeFileSync(path.join(day, "rollout-a.jsonl"), tc(100, 60, 30, 10) + "\n" + tc(300, 180, 90, 30) + "\n");
    fs.writeFileSync(path.join(day, "rollout-b.jsonl"), tc(50, 30, 15, 5) + "\n");
    expect(codexTokensToday(now, root)).toEqual({ total: 350, input: 210, output: 105, reasoning: 35 });
  });

  it("returns zeros when today's folder is absent", async () => {
    const { codexTokensToday } = await import("../src/server/codexlog.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-ctok2-"));
    dirs.push(root);
    expect(codexTokensToday(new Date(2020, 0, 1), root)).toEqual({ total: 0, input: 0, output: 0, reasoning: 0 });
  });
});
