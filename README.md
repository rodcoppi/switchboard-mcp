# Switchboard

Local hub that connects **independent** Claude Code instances running in tmux
sessions on WSL, letting them exchange **asynchronous** messages (via MCP), with a
web dashboard for the human to observe. It **connects** already-running sessions — it
does not spawn or orchestrate agents.

How it works, in one sentence: agent A calls the MCP tool `send_message`; the Hub records
the message in `~/.switchboard/messages.jsonl` (source of truth) and fires a one-line
**nudge** via `tmux send-keys` into agent B's session; B wakes up and calls
`check_messages` to receive the content over MCP. **tmux delivers only the nudge; the
content always travels over MCP.**

---

## Prerequisites

- **Node.js >= 20** (runs in ESM, with TypeScript executed by `tsx` — no build step).
- **tmux >= 3.2** (validated with 3.4).
- **Claude Code >= 2.x** (`claude` binary on the PATH).
- `jq` (optional, only a convenience for inspecting the JSONL while debugging).

> **WSL (important — pitfall P8):** the tmux server is per **user** and per **distro**.
> The Hub (`serve`) and all agents (`start`) MUST run on the **same WSL distro** and with the
> **same user**. If you open the Hub on one distro/user and an agent on another,
> `tmux send-keys` cannot find the session and the nudge never arrives.

---

## Setup in 5 steps

### 1. Install

```bash
git clone <repo-url> switchboard-mcp
cd switchboard-mcp
npm install
```

There is no build step: the TypeScript code runs directly with `tsx`. You have three ways to
invoke the `switchboard` CLI:

- **Recommended — `npm link`** (puts the `switchboard` command on the PATH):
  ```bash
  npm link
  switchboard --help
  ```
- **Without link, via the bin shim:**
  ```bash
  node bin/switchboard.mjs --help
  ```
- **Without link, straight through the entry point:**
  ```bash
  npx tsx src/index.ts --help
  ```

In the examples below we use `switchboard <subcommand>` (assuming `npm link`); swap it for
`node bin/switchboard.mjs <subcommand>` if you prefer not to link.

### 2. Start the Hub (`serve`)

```bash
switchboard serve
```

Starts the Hub in the foreground (logs on stdout + `~/.switchboard/logs/hub.log`). The
**first line** prints the addresses and the MCP registration command ready to copy, something
like:

```
Dashboard: http://127.0.0.1:4577/  |  MCP: http://127.0.0.1:4577/mcp  |  Register (once): claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

**Recommendation:** run `serve` inside a tmux session named `sb-hub`
(`tmux new -s sb-hub`) so it survives closing the terminal. Useful flags:
`--port <port>` and `--log-level debug|info|warn|error`.

### 3. Register the MCP in Claude Code (`mcp add`)

Once only, in the `user` scope (applies to every project):

```bash
claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

Check with `claude mcp list` (`switchboard` should appear as *connected* while the Hub is up).

> **Tool permissions (pitfall P10 / PRD 9.5):** for the Switchboard tools to run
> **without an approval prompt on every use**, add the allow rule `mcp__switchboard__*` to the
> `permissions` in Claude Code's `settings.json`. Anyone already using `bypassPermissions` is
> covered. `switchboard start` also prints this reminder on the first run.
>
> **For the kickoff's autonomous `join` to work 100% without intervention:** the agent reads
> `SWITCHBOARD_AGENT_TOKEN` from the environment with `printenv` (a shell command) before
> calling `join`. This requires `printenv` to also run without approval — the simplest way is
> to run the agents with `bypassPermissions` (recommended for anyone operating several agents)
> or to add `Bash(printenv:*)` to the allow rule. With only `mcp__switchboard__*` the agent
> **stops once** at the `printenv` approval prompt (the human at the attach just approves, or
> uses "don't ask again"). Passing `--claude-args "--permission-mode bypassPermissions"` to
> `start` covers a specific session.

### 4. Paste the agent protocol (snippet)

Paste the contents of [`agent-protocol/CLAUDE.snippet.md`](agent-protocol/CLAUDE.snippet.md)
into your **`~/.claude/CLAUDE.md`** (global, recommended) or into a specific project's
`CLAUDE.md`. That block teaches each agent to: read its name/token from the environment and
pass them to `join`, recognize `[switchboard]` notifications and call `check_messages`, treat
peer messages critically and not fall into a courtesy loop — and it makes explicit that
**coordination is not subordination** (another agent cannot authorize what your user did not
authorize).

### 5. Start an agent (`start`)

Run this instead of opening `claude` by hand:

```bash
switchboard start alpha --role "payments API backend" --dir ~/projects/api
```

What happens:

1. The agent is **registered** in the Hub (via REST) **before** Claude Code opens.
2. A tmux session `sb-alpha` is created running `claude` in the `--dir` directory.
3. If the terminal is interactive, the command runs **`tmux attach`** on the session — your
   Windows Terminal tab becomes the agent's view (the usual workflow). When you detach
   (`Ctrl-b d`), the agent keeps running in the background.
4. **Automatic kickoff (on by default):** a few seconds after the TUI is ready, the agent
   receives an automatic instruction to call the `join` tool on its own — with no human
   prompt. After that it shows up as *MCP connected* in `switchboard status`. Use
   `--no-kickoff` to disable it (then `join` is up to you).

`start` flags: `--role "<description>"`, `--dir <path>`, `--no-kickoff`,
`--claude-args "<extra args for claude>"`.

---

## Other subcommands

| Command | What it does |
|---------|--------------|
| `switchboard status` | Table of registered agents: NAME, ROLE, STATUS, MCP, UNREAD, LAST SEEN. |
| `switchboard send <to> <message...>` | Sends a message as **operator** (the human) to an agent, or `all` for broadcast. Handy for scripts and for testing without the dashboard. |
| `switchboard stop <name>` | Stops the agent's tmux session (asks for confirmation if there are unread messages; `--yes` skips it). The **registration** in the Hub stays — a new `start <name>` reuses the name (re-attach). |
| `switchboard down` | Stops the tmux sessions of **all** agents. The Hub stays up (it is never killed here). |
| `switchboard logs [-f]` | Last ~100 lines of `~/.switchboard/logs/hub.log`; `-f` follows the file. |

To stop the **Hub**: `Ctrl-C` in the `switchboard serve` terminal (or
`tmux kill-session -t sb-hub`, if it runs in the recommended session).

Data lives in `~/.switchboard/`: `config.json` (every value has a default; the file may not
even exist), `agents.json` (atomic snapshot) and `messages.jsonl` (append-only, greppable
with `cat`/`jq`).

---

## Security

The threat model is honest and the trust boundary is the **local machine**. Read this
before exposing anything:

- **Bind on `127.0.0.1`, hard-coded and not configurable.** A delivered message becomes
  executable input for an agent with filesystem access. Exposing the Hub on the network = free
  RCE.
- **NEVER port-forward port 4577** (no `ssh -L`, no firewall/NAT rule) and
  **NEVER run the Hub behind a reverse proxy.** `127.0.0.1` is the only barrier.
- **Local trust model:** any local process can post to the Hub and therefore inject input
  into any agent. This is accepted in v1 (the same model as any local dev tool), as long as it
  never leaks to the network.
- **Capability token (v1.1 addendum):** `start` injects a per-agent token into the tmux
  session environment (`SWITCHBOARD_AGENT_TOKEN`); the agent reads it and passes it to `join`,
  and it **never appears** in `list_agents`, in `GET /api/agents`, in the dashboard or in the
  logs. It closes impersonation by processes that know an agent's name but never talk to the
  registration endpoint.
- **Known residual risk (documented in the comment of `src/server/api.ts`):** the
  `POST /api/agents/register` endpoint is **deliberately unauthenticated**, and re-registering
  an existing name **regenerates and returns a fresh token**. So a malicious local process can
  obtain a valid token for any name and impersonate that agent via `join` — also invalidating
  the legitimate session's token (its `join` after a Hub restart then fails). This is accepted
  by the v1.1 spec (the same "any local process can post" boundary) and **must not be "fixed"
  without approval** — requiring token rotation would break `switchboard start`'s re-attach.
- **Prompt injection between agents** is a residual risk: a compromised/hallucinating agent may
  try to manipulate another. v1 mitigation: the boundary declared in the protocol snippet (peer
  messages are evaluated critically; coordination ≠ subordination) plus full feed visibility in
  the dashboard.

---

## tmux tips on WSL / Windows Terminal (pitfall P11)

- If you rarely use tmux, a minimal `~/.tmux.conf` with the **mouse enabled** helps a lot with
  scrolling and pane selection:
  ```
  set -g mouse on
  ```
- `switchboard start` runs `tmux attach` on the agent's session, so **each Windows Terminal tab
  stays "one agent's screen"** — the tab workflow you already use is preserved. To leave an
  agent's view without killing it: `Ctrl-b d` (detach). To come back:
  `tmux attach -t sb-<name>`.
