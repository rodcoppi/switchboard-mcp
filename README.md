<h1 align="center">⇄ Switchboard</h1>

<p align="center"><b>Let your Claude Code agents talk to each other.</b></p>

<!-- DEMO-GIF: dashboard in action (agents coordinating) — added after the redesign lands. -->

Run several Claude Code agents at once — one on the backend, one on the frontend, one on
infra — and today they're blind to each other. Every "the API contract changed" has to go
through **you**, copy-pasting between terminals. You become the message broker.

**Switchboard is the wire between them.** A local hub that lets your already-running agents
message each other directly (over MCP), nudges the recipient awake in its terminal, and shows
the whole conversation on one dashboard. It **connects** sessions you already have — it does
not spawn, orchestrate, or manage them.

The trick that keeps it safe and reliable: **tmux delivers only a one-line nudge; the message
content always travels over MCP.** Agent A calls `send_message` → the Hub appends it to
`~/.switchboard/messages.jsonl` (the source of truth) and pokes agent B's terminal with a
single `[switchboard]` line → B wakes up and calls `check_messages` to read it over MCP.

> Runs on **WSL / Windows**. Local-only by design — the Hub binds `127.0.0.1` and nothing is
> exposed to the network. MIT licensed.

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

## Setup — two commands

```bash
git clone <repo-url> switchboard-mcp && cd switchboard-mcp && npm install
node bin/switchboard.mjs setup
```

The `setup` wizard does everything the manual steps below describe — checking prerequisites
(and offering a **sudo-less tmux install** when tmux is missing), registering the MCP server
in Claude Code, installing the agent-protocol snippet into your `~/.claude/CLAUDE.md`, adding
the permission allow rules, running `npm link`, offering the Windows one-click shortcut
(Desktop and/or Startup, WSL setups), and bringing the Hub up. It asks before touching any of
your files, is **idempotent** (safe to re-run anytime), and `--yes` makes it fully
non-interactive.

When it finishes: dashboard at `http://localhost:4577/`, launch agents from the **Launch
agent** form there, and run `switchboard wire` inside any already-open claude window's folder
to adopt it into the network.

<details>
<summary><b>Manual setup</b> (what the wizard automates, step by step)</summary>

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

### 2. Start the Hub (`serve`) — usually automatic

**You normally don't need this step:** `switchboard start` and `switchboard wire`
auto-start the Hub in the background when it is not running (a detached tmux session
`sb-hub` — no terminal window stays open). After a reboot, just `wire`/`start` your first
agent and the Hub comes up with it.

To run it manually (e.g. to watch the logs live):

```bash
switchboard serve
```

Starts the Hub in the foreground (logs on stdout + `~/.switchboard/logs/hub.log`). The
**first line** prints the addresses and the MCP registration command ready to copy, something
like:

```
Dashboard: http://127.0.0.1:4577/  |  MCP: http://127.0.0.1:4577/mcp  |  Register (once): claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

To inspect the auto-started Hub: `tmux attach -t sb-hub` (detach with `Ctrl-b d`) or
`switchboard logs -f`. Useful flags of `serve`: `--port <port>` and
`--log-level debug|info|warn|error`.

#### One-click launch from Windows (no WSL terminal)

On Windows + WSL you can skip the terminal entirely. Once, inside WSL:

```bash
switchboard shortcut            # creates Switchboard.bat on your Windows Desktop
switchboard shortcut --startup  # or: installs it in the Startup folder (runs on every boot)
```

Double-clicking `Switchboard.bat` (or booting Windows, with `--startup`) brings the Hub up in
the background and opens the dashboard at `http://localhost:4577/` in your Windows browser —
WSL2's built-in localhost forwarding reaches the Hub, which still binds `127.0.0.1` inside WSL
only (nothing is exposed to the network). From the dashboard, launch/wire agents with the
**Launch agent** form. To undo, just delete the `.bat` file.

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

</details>

### Adopting an already-open agent (`wire`)

Already have a Claude Code window open (a plain `claude` in bash, **without** tmux) and want to
join it to the network **without losing the conversation**? Use `wire` instead of `start`:

1. In that window, **leave claude** (`Ctrl-C` twice, or `/exit`).
2. In the **same folder**, run:
   ```bash
   switchboard wire
   ```
3. The conversation **comes back** — now inside a tmux session, connected to the Hub. The agent
   **name defaults to the folder name** (sanitized to lowercase letters, digits and hyphens; pass
   `--name <name>` if the folder name can't be used).

Under the hood `wire` reopens claude with `-c` (continue the folder's conversation) and
`--dangerously-skip-permissions` (so the agent reads its token and calls `join` with no prompt) —
these are the `wire` defaults, unlike `start`. Any extra `--claude-args` are added **after** them.
If a tmux session for that name already exists, `wire` **replaces it** (kills the old one and
recreates it — no confirmation), then runs the same automatic kickoff as `start`.

**Auto-fallback:** if the folder has no resumable conversation (never opened claude there, or the
last one ran in `-p`/print mode), `claude -c` exits right away — `wire` detects that and
automatically reopens a **fresh** session (without `-c`), telling you so. It never fails into a
dead window; worst case you get a brand-new conversation already wired to the network.

`wire` flags: `--name <name>`, `--role "<description>"`, `--dir <path>` (default: current folder),
`--no-kickoff`, `--claude-args "<extra args for claude>"`.

### Launching agents from the dashboard

The dashboard (`http://127.0.0.1:4577/`) has a **Launch agent** form (bottom of the sidebar):
type the project **directory**, optionally a name (defaults to the folder name) and a role,
tick **continue conversation** to resume the folder's last claude conversation (same
auto-fallback as `wire`), and hit Launch. The Hub itself creates the agent's tmux session and
runs the automatic kickoff — no terminal needed. The new card appears live via SSE; attach to
the agent anytime with `tmux attach -t sb-<name>`. Under the hood it is
`POST /api/agents/launch {dir, name?, role?, continue?}` — localhost-only, like everything else.

---

## Other subcommands

| Command | What it does |
|---------|--------------|
| `switchboard wire` | **Adopts the current window** into the network, continuing its conversation (see below). |
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
