// How a Switchboard-launched Claude session gets the brain's hook: through
// --settings, for that one session — the operator's own settings are never
// touched (the same route sessions.ts takes for a child's session log).
// Claude Code reads ONE --settings value, so when the argv already carries one
// (a child's SessionStart log), the brain's hooks are merged into it.

import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = fileURLToPath(new URL("../../../bin/brain-hook.mjs", import.meta.url));

/** POSIX single-quote escaping — the hook runs through sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}
type HookSettings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export function brainHookCommand(port: number, nodeBin = process.execPath, script = HOOK_SCRIPT): string {
  return `${shq(nodeBin)} ${shq(script)} ${Math.trunc(port)}`;
}

/** The argv with the brain's UserPromptSubmit + SessionStart hooks in its --settings. */
export function withBrainHooks(argv: readonly string[], port: number, command = brainHookCommand(port)): string[] {
  const hook = { type: "command" as const, command, timeout: 3 };
  const out = [...argv];
  const at = out.indexOf("--settings");
  let settings: HookSettings = {};
  if (at !== -1 && at + 1 < out.length) {
    try {
      settings = JSON.parse(out[at + 1]) as HookSettings;
    } catch {
      // Not inline JSON (a settings FILE path): leave it alone rather than guess.
      return out;
    }
  }
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of ["UserPromptSubmit", "SessionStart"]) {
    const list = [...(hooks[event] ?? [])];
    if (!list.some((e) => e.hooks?.some((h) => h.command === command))) list.push({ hooks: [hook] });
    hooks[event] = list;
  }
  const value = JSON.stringify({ ...settings, hooks });
  if (at !== -1) out[at + 1] = value;
  else out.push("--settings", value);
  return out;
}
