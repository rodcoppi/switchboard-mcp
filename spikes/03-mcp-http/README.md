# Spike 0.4 — MCP Streamable HTTP (stateful)

Mini MCP server from the PRD (section 16, item 0.4): 1 tool `ping` that returns `pong`, served via
`StreamableHTTPServerTransport` at `http://127.0.0.1:4578/mcp`, stateful mode (one MCP session
per Claude Code instance). Proves risk R2: multiple Claude Code sessions on the same server.

## Start the server

```bash
cd spikes/03-mcp-http
npm install        # first time
npx tsx server.ts  # logs each session started/ended and each ping
```

## Test script (PRD 0.4)

1. With the server running, register the MCP in local scope:

   ```bash
   claude mcp add --transport http --scope local spike http://127.0.0.1:4578/mcp
   ```

2. First instance:

   ```bash
   claude -p "Use the ping tool from the spike MCP server and report its output."
   ```

3. Repeat step 2 in a SECOND SIMULTANEOUS instance (another terminal) — two MCP sessions
   on the same server. Both must receive `pong`; the server log must show two distinct
   `session initialized`.

4. Restart test: with an interactive `claude` connected, kill the server (Ctrl+C), start it
   again (`npx tsx server.ts`) and request the ping once more. Observe the recovery: the old
   session id gets a 404 `Session not found` and the client must re-initialize. Document the
   observed behavior in `spikes/NOTES.md` (PRD pitfall P6).

5. Cleanup:

   ```bash
   claude mcp remove spike
   ```

**Done When:** both instances receive `pong`; post-restart behavior documented in NOTES.md.

## Execution status — PASS (2026-07-08, real script, not just curl)

Run with claude 2.1.205 + SDK 1.29.0 (full evidence and findings in
[`../NOTES.md`](../NOTES.md)):

- Steps 1–3 and 4: `claude mcp add` connected (`✔ Connected`); **two simultaneous `claude -p`
  received `pong`**, with **two distinct `session initialized`** in the server log
  (pings ~0.8 s apart). Risk R2 proven.
- Step 4 of the script above (restart, P6): run with a real Claude Code client kept alive
  during the restart (a headless approximation of "interactive claude": the turn held by a
  blocking 30 s Bash command between two pings — the same MCP HTTP client stack).
  Observed: old session id → 404 `Session not found` → **the client re-initializes on its own
  and re-runs the tool call, transparent to the model** (the second ping returned `pong`).
- Step 5: `claude mcp remove spike` run.

This PASS closes only spike 0.4. The **Phase 0 gate remains OPEN**: spikes 0.2 and 0.3
(`01-sendkeys-basic.sh`, `02-sendkeys-claude.sh`) depend on tmux, absent in the current
environment — status tracked in `../NOTES.md`.

## Smoke test without Claude Code (curl)

```bash
# initialize (the response carries the mcp-session-id header)
curl -sS -D - -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  http://127.0.0.1:4578/mcp

# then, with SID=<returned mcp-session-id>:
#   notifications/initialized  -> HTTP 202
#   tools/call ping            -> data: {"result":{"content":[{"type":"text","text":"pong"}]},...}
curl -sS -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' http://127.0.0.1:4578/mcp
curl -sS -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}' http://127.0.0.1:4578/mcp
```
