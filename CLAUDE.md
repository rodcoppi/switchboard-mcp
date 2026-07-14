# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

**Switchboard** project: a local hub that connects independent Claude Code instances running
in tmux sessions on WSL, enabling asynchronous message exchange between them (via MCP) with a
web dashboard for observation. It **connects** already-running sessions — it does not spawn or
orchestrate agents.

**`PRD-switchboard.md` is the source of truth.** The implementation follows the PRD's phases
0–7, in order. Before working on any area, read the corresponding PRD section (and the pitfalls
table, section 17).

## Executor rules (from the PRD, mandatory)

- Run the phases IN ORDER. Phase 0 (validation spikes) is mandatory and cannot be skipped. Only
  advance to Phase N+1 with all of Phase N's "Done When" truly verified (by running the command,
  not assuming).
- Each phase ends with its own commit: `feat(phase-N): <summary>`.
- If a Phase 0 spike fails → STOP and report the full error. Do not improvise an alternative
  architecture without approval.
- Do not add dependencies outside the locked stack (PRD section 5). Need something? Ask first.
- Do not invent features outside the PRD. A divergence becomes a question, not a unilateral
  decision.
- Priority order in conflicts (section 4): local security > convenience; debuggability >
  elegance; delivery reliability > real time; never block the agent's turn (every MCP tool
  answers in < 1s); MVP (Phases 0–5) before any pixel of the dashboard.

## Locked stack

- Node.js >= 20 (ESM), TypeScript 5.x executed with `tsx` — **no build step, no bundler**.
- Production: `@modelcontextprotocol/sdk`, `express`, `zod`, `ulid`, `commander`. Dev:
  `vitest`, `@types/express`, `@types/node`.
- System prerequisites: tmux >= 3.2, claude >= 2.x, jq (debug).
- **Forbidden in v1:** websockets, database, ORM, frontend framework, bundler, docker.

## Commands

```bash
npx vitest run                          # all tests
npx vitest run test/store.test.ts      # a single test file
npx tsx src/index.ts <subcommand>      # CLI in dev (bin "switchboard" via npm link)

# CLI (subcommands): serve | start <name> | status | send <to> <msg> | stop <name> | down | logs [-f]
# Registering the MCP in Claude Code (once, user scope):
claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

The dispatcher's integration tests use real tmux (automatically skipped if tmux is absent).
The gate for each phase is the PRD's "Done When", not coverage.

## Architecture (big picture)

A single Node process (the **Hub**, `127.0.0.1:4577`) serves everything: MCP Streamable HTTP
endpoint at `/mcp` (official SDK, stateful mode), REST + SSE at `/api/*` for the dashboard and
CLI, and the static dashboard at `/`.

Message flow: agent A calls the MCP tool `send_message` → the Hub writes to
`~/.switchboard/messages.jsonl` (append-only, source of truth) → the dispatcher fires a
**nudge** via `tmux send-keys` into the recipient's session (one notification line + a separate
Enter) → agent B wakes up and calls `check_messages` to receive the content over MCP.

Fundamental split: **tmux delivers only the nudge (1 line); the content always travels over
MCP.** The fragile channel (simulated keyboard) stays minimal; the robust channel (HTTP) is the
source of truth.

Components in `src/server/` (full structure in PRD section 6):
- `mcp.ts` — 4 tools: `join`, `send_message`, `check_messages`, `list_agents`. The tool
  descriptions in PRD section 9 are part of the spec — copy them verbatim. Session-to-agent
  mapping in an in-memory `Map`, created on `join`.
- `dispatcher.ts` — per-agent cooldown (15s), nudge coalescing (bursts become 1 nudge), queue
  for mute/offline.
- `tmux.ts` — the only layer that executes tmux, always via `execFile` (never `exec` with a
  string).
- `store.ts` — append-only `messages.jsonl` + `agents.json` snapshot (write-temp + atomic
  `fs.rename`). Boot replays the JSONL; corrupted lines: log and skip, never crash. Marking as
  read = appending a `{"type":"read",...}` event, never an in-place edit.

Agent types (`claude` | `codex`) live in **`src/shared/agent-types.ts`** — one descriptor per
type (binary, argv shape, TUI-ready/trust-dialog markers, `mcp add` spelling). It sits in
`src/shared/` because both `src/cli/*` and `src/server/launcher.ts` import it and the direction
"server may read pure cli helpers, never the reverse" makes a neutral module the only legal
home. Adding a type = adding a descriptor; nothing downstream branches on `if codex`. The claude
descriptor's argv is asserted exactly in `test/agent-types.test.ts` — it is the regression lock
for the default type. Codex's `resume` is a SUBCOMMAND and its bypass flag MUST follow it (a
flag placed before the subcommand parses and is silently dropped); the file header records how
that was verified.

Identity: agents are addressed by **name** (never session id — names survive restarts). The
registration happens on `switchboard start` via REST, BEFORE Claude Code opens; the `join` via
MCP only confirms the connection.

## Security invariants (non-negotiable)

- Bind **exclusively** on `127.0.0.1`, hard-coded, not configurable (a delivered message becomes
  executable input for an agent — exposing it on the network = RCE).
- **Pane-command guard:** before any `send-keys`, check `pane_current_command`. If the pane
  runs a shell (`bash`, `zsh`, `sh`, `fish`), ABORT the nudge (the text would be executed as a
  command). Only nudge if it runs `node`/`claude`. An automated test for this is mandatory.
- Message body never travels over tmux — only the nudge. A nudge is always one line
  (`replace(/[\r\n]+/g, " ")`).
- `send-keys` always with `-l` (literal) and `--` before the text; the Enter is a SEPARATE tmux
  command after a ~500ms delay (sending them together types but does not submit in TUIs —
  pitfall P1).

## Conventions

- Everything is in **English** — code, identifiers, comments, and user-facing text (nudge, CLI
  help, README, protocol snippet). The package/repo is named `switchboard-mcp`, but the product
  display name stays **Switchboard**, the CLI command stays `switchboard`, and the MCP server id
  stays `switchboard` (changing it would break the `mcp__switchboard__*` tools).
- Anti-loop between agents: rate limit per ordered pair (12/min default), tool error messages
  written FOR the model to read and self-correct, `maxMessageBytes` 16 KB (large payload → file
  + path).
- Config in `~/.switchboard/config.json`, every value with a default (the file may not exist).
