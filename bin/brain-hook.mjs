#!/usr/bin/env node
// The group brain's hook (src/server/brain/): Claude Code runs it on every
// prompt the agent receives (UserPromptSubmit) and when a session starts
// (SessionStart), and whatever it prints is added to the agent's context —
// the network's own record of what the prompt is about, or of what changed
// in the group since the agent was last here.
//
// Plain Node, no tsx: it runs on every prompt and must cost a few tens of
// milliseconds. It asks the hub at 127.0.0.1:<port> with the agent's own name
// and token (the pair its MCP connection uses), and gives up in silence on
// anything — hub down, brain off, timeout, a session not started by the hub.
// A hook must never be the reason an agent's turn fails or waits.
//
// usage (spelled by the launcher into --settings): node brain-hook.mjs <port>

const port = Number(process.argv[2]) || 4577;
const name = process.env.SWITCHBOARD_AGENT_NAME;
const token = process.env.SWITCHBOARD_AGENT_TOKEN;
const TIMEOUT_MS = 1500;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (!name || !token) return;
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const hookEvent = input.hook_event_name;
  let body;
  if (hookEvent === "UserPromptSubmit" && typeof input.prompt === "string") body = { event: "prompt", prompt: input.prompt };
  else if (hookEvent === "SessionStart" && (input.source === "startup" || input.source === "resume" || input.source === "clear")) body = { event: "session" };
  else return;
  const res = await fetch(`http://127.0.0.1:${port}/api/brain/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-switchboard-agent-name": name },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return;
  const out = await res.json();
  if (typeof out?.context !== "string" || !out.context.trim()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: out.context } }));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
