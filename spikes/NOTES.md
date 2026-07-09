# NOTES — findings from the Phase 0 spikes

> **Note (PRD v1.1 addendum):** a competitor survey (claude-peers-mcp, Walkie-Talkie)
> confirmed that Switchboard's combination does not exist off the shelf. Three ideas evaluated
> from claude-peers-mcp: **capability token** → adopted in v1 (see PRD 9.1/11/15); **urgency
> tiers** → v2 (PRD section 20); **bracketed-paste in send-keys** → DISCARDED BY DESIGN:
> it mitigates typing arbitrary content into the pane, something Switchboard never does
> (body only via MCP; what enters the pane is a fixed-format nudge, one line, with names
> validated by regex). Do not re-evaluate without changing that premise.

File required by the Done When of spikes 0.3 and 0.4 of the PRD (section 16). It records the
findings that the Phase 1–7 implementation needs to know. The source of truth remains the PRD;
this here is execution evidence + API gotchas.

## Phase 5 finding (autonomous kickoff, 2026-07-09)

The Phase 5 Done When was verified live with the real Claude Code 2.1.205: `start alpha` with
no human prompt → kickoff detects readiness → injects the text → alpha calls `join` on its own →
`status` shows `MCP: yes` (join in ~12s). Two findings along the way:

1. **Readiness vs permission-mode:** the `"? for shortcuts"` marker is REPLACED in the footer
   when the agent runs under `--permission-mode bypassPermissions` (it becomes `"⏵⏵ bypass
   permissions on (shift+tab to cycle)"`). `isTuiReady` was hardened to also accept
   `"shift+tab to cycle"` / `"bypass permissions on"` / `"accept edits on"` /
   `"plan mode on"` — otherwise the kickoff of a bypass-mode agent (which section 9.5 says is
   "covered") would time out and never fire.

2. **v1.1 token vs Bash permission:** the snippet tells the agent to read `SWITCHBOARD_AGENT_TOKEN`
   via `printenv` before `join`. That is a shell command — the allow rule
   `mcp__switchboard__*` (which covers the tools) does NOT cover `printenv`, so the agent stops
   once at the approval prompt. A fully autonomous flow requires `bypassPermissions` OR
   `Bash(printenv:*)` in the allow rule. Documented in the README (step 3).

## Spike status

| Spike | Status | Evidence |
|-------|--------|----------|
| 0.2 `01-sendkeys-basic.sh` | **PASS** (3/3 runs, tmux 3.4) — 2026-07-08 | section below |
| 0.3 `02-sendkeys-claude.sh` | **PASS** (PONG + queue test with capture evidence) — 2026-07-08 | section below |
| 0.4 `03-mcp-http/` | **PASS** — Done When actually executed with real Claude Code on 2026-07-08 | section below |

**Phase 0 gate: CLOSED (0.2 ✅ 0.3 ✅ 0.4 ✅).**

### Environment (0.1)

Node v24.7.0 · claude 2.1.205 · **tmux 3.4** · jq 1.7.1 · ports 4577/4578 free · WSL2
(kernel 6.6.87.2-microsoft-standard-WSL2), Ubuntu 24.04 noble.

Install note: tmux and jq were installed **without sudo** from the official Ubuntu `.deb`
packages (`apt-get download` + `dpkg -x`) into `~/.local/opt/switchboard-tools/`, with wrappers
in `~/.local/bin/{tmux,jq}` that set `LD_LIBRARY_PATH`. Functionally identical to the system
package (tmux runs 100% in user-space). To switch to the system install later:
`sudo apt install tmux jq` and delete the two wrappers + `~/.local/opt/switchboard-tools/`.

## Spike 0.2 — basic send-keys (2026-07-08)

`./spikes/01-sendkeys-basic.sh` → **PASS 3/3**: `PASS (tmux 3.4; submitted line appeared 2x
in the pane)`. Validated technique: text with `send-keys -l --`, ~500 ms, Enter in a separate
command.

**Critical finding for `tmux.ts` (Phase 3) — exact-match target syntax:**

- On **target-session** commands (`has-session`, `kill-session`): `-t "=NAME"` works.
- On **target-pane/window** commands (`send-keys`, `capture-pane`, `list-panes`):
  `-t "=NAME"` **fails** with `can't find pane: =NAME` (tmux 3.4, live session!). The correct
  form is **`-t "=NAME:"`** (the colon qualifies `session:window`).

That detail cost the spike's first FAIL (the session never died; it was the target that would
not resolve). Without the `=`, tmux resolves by prefix and a `kill-session -t sb-alpha` could
kill `sb-alpha-other` — always use `=` + `:` according to the command type.

## Spike 0.3 — send-keys into the real Claude Code (2026-07-08)

`./spikes/02-sendkeys-claude.sh` → **PASS**. Observed metrics (200x50 pane, `claude` in
`/tmp`):

- TUI readiness: **4 s** (including 1 trust dialog handled with Enter).
- Model response after Enter: **3 s** (anti-false-positive detection: a line with PONG without
  "Answer", outside the input box, case-insensitive).
- The text→Enter delay of **500 ms worked reliably in every run**
  (spikes 0.2 x3, 0.3 and the queue test x2) → **PRD's `nudgeEnterDelayMs: 500` confirmed,
  no recalibration**.

**Trust dialog (wording of claude 2.1.205):** opening in a new directory, the text is
"Quick safety check: Is this a project you created or one you trust?" with the option
"❯ 1. Yes, I trust this folder" — it NO LONGER contains the old phrase "Do you trust the files
in this folder?". Detect by `trust this folder` / `quick safety check` (case-insensitive).
Enter accepts the default. **Consequence for Phase 4 (`switchboard start` + kickoff):** in a
`--dir` never trusted before, the TUI sits on the dialog; a blind kickoff after 8 s would type
text into a MENU (digits select options!). The kickoff must check TUI readiness (or the human
accepts the dialog in the attach — `start` with attach leaves the human in front of the
screen, which mitigates this in practice).

**Queue test (P3, step 4 of 0.3) — PASS with capture evidence.** Method: prompt 1
"Count from 1 to 50, one number per line, slowly" submitted; at t+4 s (count clearly at 7/50,
turn plainly active, spinner running) a second send-keys delivered "When you finish
counting, write only QUEUE-OK." + a separate Enter. Captures:

1. **Mid-turn** (t=7 s): the transcript shows `● 1 … 7` streaming — turn 1 active at the
   moment of injection.
2. **End** (t=15 s): count complete up to 50, end-of-turn marker, and ONLY THEN the echo
   `❯ When you finish counting, write only QUEUE-OK.` followed by `● QUEUE-OK`.

Conclusion: input typed during an active turn **is queued and processed at the end of the
turn, without breaking the TUI** — exactly the behavior the dispatcher assumes (P3 is not an
error). No input loss observed.

## Spike 0.4 — Done When execution (2026-07-08)

Environment: Node v24.7.0, claude 2.1.205, `@modelcontextprotocol/sdk` 1.29.0, WSL2.

The PRD 0.4 script executed in full (not just curl):

1. Server up at `127.0.0.1:4578/mcp`.
2. `claude mcp add --transport http --scope local spike http://127.0.0.1:4578/mcp` → `claude mcp list` showed `✔ Connected`.
3. + 4. **Two SIMULTANEOUS `claude -p`** ("Use the ping tool from the spike MCP server and
   report its output."), launched in the background at the same instant. Result: **both
   received `pong`** (exit 0 for both) and the server log showed **two distinct sessions**
   (`10796b54-…` and `64d7b75e-…`) with pings ~0.8 s apart (22:47:31.626Z and 22:47:32.388Z).
   Risk R2 (multiple Claude Code sessions on the same stateful server) eliminated.
5. **Restart test with a real client** (P6): with no TTY available, the "interactive claude" was
   approximated by a `claude -p` kept alive during the restart — the turn was held with a
   blocking 30 s Bash command (`node -e "setTimeout(()=>{},30000)"`) between two pings; the
   server was killed and restarted within that window. It is the SAME MCP HTTP client stack as
   the interactive mode. Observed behavior (server log):

   ```
   [spike] session initialized: 621ff6e5-…          # ping 1 ok (old server)
   [spike] MCP Streamable HTTP … listening …        # restart
   [spike] unknown session id rejected (404): 621ff6e5-…
   [spike] session initialized: 0dd64b5d-…          # client RE-INITIALIZED on its own
   [spike] ping called …                            # ping 2 ok, new session
   ```

   **Central P6 finding: the Claude Code 2.1.205 MCP client recovers on its own from the 404
   `Session not found` — it re-initializes the session (new `initialize`, new session id) and
   re-runs the tool call, completely transparently to the model** (the agent's report said "no
   error occurred"; both pings returned `pong`).
6. `claude mcp remove spike` executed (config cleaned up).

The curl smoke test was also green: `initialize` (returns `mcp-session-id` in the header) →
`notifications/initialized` (HTTP 202) → `tools/call ping` (`data: {"result":{"content":
[{"type":"text","text":"pong"}]…}`); unknown session id → 404 JSON `-32001`; malformed JSON
body → 400 JSON `-32700` (see finding 5).

### Consequence of the P6 finding for Phase 2 (mcp.ts)

The reconnection is transparent to the MODEL, but **not to the Hub**: the new session arrives
with no link to the agent. Since the session→agent Map lives in memory, after a Hub restart
every tool called on an unmapped session (the client re-initializes on its own and keeps
calling tools) must answer with an error written for the model to self-correct: "you are not
registered on this session; call the join tool again". Replaying the JSONL + `agents.json`
recovers the rest of the state. Do not count on the client "announcing" that it reconnected —
it does not.

## SDK API findings (@modelcontextprotocol/sdk 1.29.0)

1. **Correct version and imports (v1.x, NOT v2-alpha).** The context7 docs mix v2-alpha
   examples, whose paths do not exist in 1.x. The correct imports in 1.29.0 are:

   ```ts
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
   import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
   ```

   The subpath `server/streamableHttp.js` only exists from ~1.10; `registerTool` and
   `onsessionclosed` are later than 1.0. That is why the spike's `package.json` pins
   `"^1.29.0"` — a `^1.0.0` range would accept versions where the import crashes
   (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Keep the range tight in Phase 2 and **commit the
   `package-lock.json`** when the git repo is initialized.

2. **`server.registerTool(name, config, handler)` is the current API; `server.tool()` is
   deprecated.** Use `registerTool` with `{ description, inputSchema }` (raw zod as the shape,
   no `z.object()` around it) in Phase 2.

3. **Stateful HTTP handler pattern + the `req.body` gotcha:** with `express.json()` in the
   pipeline, the stream is already consumed; it is MANDATORY to pass the parsed body as the 3rd
   argument — `transport.handleRequest(req, res, req.body)`. Forgetting the 3rd arg makes the
   transport try to re-read the stream and the request hangs/fails. One transport (+ one
   `McpServer`) per session, reused via the `mcp-session-id` header; a new session only when
   `isInitializeRequest(req.body)` and no session id; unknown session id → 404 JSON-RPC
   `-32001` (the client re-initializes — see P6 above).

4. **The session lifecycle is incomplete by design: `onclose`/`onsessionclosed` do NOT cover
   abrupt client death.** Verified live: an explicit DELETE fires `onsessionclosed` +
   `onclose` and clears the Map (reusing the SID afterwards → 404). But a client that dies
   without DELETE fires NOTHING — during the Done When run, the `claude -p` and curl sessions
   stayed orphaned in the Map until the process ended (no `transport closed` line in the log).
   **Phase 2: mandatory to expire sessions by inactivity** (last-request timestamp per session
   + periodic sweep) and/or reconcile via re-join; otherwise the Hub accumulates orphan
   transports and "ghost" agents stay listed as connected.

5. **A malformed JSON body blows up BEFORE the handler.** The `express.json()` error happens in
   the middleware, out of reach of the handler's try/catch; without handling, Express returns
   an HTML error page (outside the JSON-RPC envelope) and logs a 10-line stack trace per client
   typo. Fixed in the spike with a 4-argument error middleware after the routes, answering
   `{jsonrpc:"2.0", error:{code:-32700, message:"Parse error"}, id:null}` with status 400
   (verified via curl with body `{invalid`). **Mandatory in Phase 2** — `api.ts` requires
   errors always in JSON, and a parse-error stack trace masks the real error in the log
   (debuggability > elegance).
