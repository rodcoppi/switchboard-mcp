<h1 align="center">⇄ Switchboard</h1>

<p align="center"><b>Let your coding agents talk to each other.</b><br>
<sub>Claude Code and Codex CLI, on the same network, in the same conversation.</sub></p>

<p align="center">
  <img src="assets/dashboard.png" alt="The Switchboard dashboard — an operator's patchbay: agents on the left, the transcript of their messages in the center" width="860">
</p>

You have **Claude Code** (Anthropic's CLI) open on the backend, **Codex CLI** (OpenAI's) on the
frontend, another agent on infra. None of them knows the others exist. So when the API contract
changes, you are the one who carries the news: copy from this terminal, paste into that one,
repeat. You are the message broker.

Switchboard is the wire between them. It's a local hub. Your agents message each other over MCP,
the recipient gets nudged awake in its own terminal, and you watch the whole conversation on one
dashboard. It connects sessions you already have. It won't spawn, orchestrate or manage them.

What keeps it safe: **tmux carries a one-line nudge, and nothing else. The message itself travels
over MCP.** Agent A calls `send_message`, the Hub appends it to `~/.switchboard/messages.jsonl`
(the source of truth) and pokes agent B's terminal with a single `[switchboard]` line. B wakes up
and calls `check_messages` to read it.

> **Platform: Windows + WSL (Ubuntu).** That's what Switchboard is built and tested on. The core
> (hub, MCP, tmux nudges) is plain Unix and tmux, so Linux and macOS may well work, but nobody has
> tested it. Treat them as unsupported for now. The parts that make it click on Windows (the
> one-click launcher, opening a real terminal window, `\\wsl$\…` folder paths) are WSL-specific,
> and say so instead of breaking when you run them elsewhere.
>
> Local-only by design: the Hub binds `127.0.0.1` and nothing reaches the network. MIT licensed.

---

## Prerequisites

- **Node.js >= 20**. Runs as ESM, with TypeScript executed by `tsx`. No build step.
- **tmux >= 3.2** (tested on 3.4).
- **Claude Code >= 2.x**, the `claude` binary on your PATH.
- **Codex CLI**, optional: the `codex` binary on your PATH. You need it only to run agents with
  `--agent codex`, or the dashboard's **Codex** button. Everything else works without it.
- `jq`, optional. Handy for reading the JSONL while debugging.

> **One WSL distro, one user.** The tmux server belongs to a user on a distro. Run the Hub
> (`serve`) and every agent (`start`) as the same user on the same distro. Split them across two
> and `tmux send-keys` won't find the session, so the nudge never lands.

---

## Setup: two commands

```bash
git clone https://github.com/rodcoppi/switchboard-mcp.git && cd switchboard-mcp && npm install
node bin/switchboard.mjs setup
```

`setup` does every manual step below for you: it checks the prerequisites (and offers a
sudo-less tmux install if tmux is missing), registers the MCP server in Claude Code, puts the
agent-protocol snippet in your `~/.claude/CLAUDE.md`, adds the permission rules, runs
`npm link`, offers the Windows shortcut, and brings the Hub up. It asks before it touches a
file of yours. Re-run it whenever you like, it changes nothing that is already right. Pass
`--yes` and it stops asking.

When it finishes, the dashboard is at `http://127.0.0.1:4577/`. Launch agents from the **Launch
agent** form there, or run `switchboard wire` in the folder of a claude window you already have
open to bring that one in.

<details>
<summary><b>Manual setup</b> (what the wizard automates, step by step)</summary>

### 1. Install

```bash
git clone https://github.com/rodcoppi/switchboard-mcp.git
cd switchboard-mcp
npm install
```

The TypeScript runs straight through `tsx`, so there is nothing to build. Three ways to call
the `switchboard` CLI:

- `npm link` puts `switchboard` on your PATH. This is the one to use:
  ```bash
  npm link
  switchboard --help
  ```
- The bin shim, without linking:
  ```bash
  node bin/switchboard.mjs --help
  ```
- The entry point, without linking:
  ```bash
  npx tsx src/index.ts --help
  ```

The examples below say `switchboard <subcommand>` and assume you linked. If you didn't, read
them as `node bin/switchboard.mjs <subcommand>`.

### 2. Start the Hub (`serve`), usually automatic

Skip this step: `switchboard start` and `switchboard wire` bring the Hub up for you when it
isn't running, in a detached tmux session called `sb-hub`. No terminal window stays open. After
a reboot, `wire` or `start` your first agent and the Hub comes up with it.

Run it yourself when you want to watch the logs live:

```bash
switchboard serve
```

The Hub runs in the foreground and logs to stdout and `~/.switchboard/logs/hub.log`. Its first
line gives you the addresses and the MCP registration command, ready to copy:

```
Dashboard: http://127.0.0.1:4577/  |  MCP: http://127.0.0.1:4577/mcp  |  Register (once): claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

To look inside the Hub that started itself: `tmux attach -t sb-hub`, and `Ctrl-b d` to leave it
running. Or `switchboard logs -f`. `serve` takes `--port <port>` and
`--log-level debug|info|warn|error`.

#### One-click launch from Windows (no WSL terminal)

On Windows and WSL you can skip the terminal. Once, inside WSL:

```bash
switchboard shortcut            # creates Switchboard.lnk on your Windows Desktop
switchboard shortcut --startup  # or: installs it in the Startup folder (runs on every boot)
```

Double-click `Switchboard` (or just boot Windows, with `--startup`) and the Hub comes up in the
background, with the dashboard open at `http://127.0.0.1:4577/` in your Windows browser. WSL2
forwards localhost for you; the Hub still binds `127.0.0.1` inside WSL, so nothing reaches the
network. Launch or wire agents from the **Launch agent** form. Delete the shortcut to undo it.

<sub>The shortcut is a `.lnk` carrying the Switchboard icon and opening minimized; the `.bat` it
drives, and the icon, live in `%LOCALAPPDATA%\Switchboard` (a `.bat` cannot carry an icon, and an
icon on the WSL filesystem renders blank at boot, when the distro is not running yet). Regenerate
the icon with `node scripts/make-icon.mjs`.</sub>

### 3. Register the MCP in Claude Code (`mcp add`)

Once only, in the `user` scope (applies to every project):

```bash
claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

`claude mcp list` shows `switchboard` as *connected* while the Hub is up.

Running Codex agents too? Point Codex at the same Hub. Same streamable-HTTP endpoint, spelled
differently (`setup` offers this when it finds the `codex` binary):

```bash
codex mcp add switchboard --url http://127.0.0.1:4577/mcp
```

> **Tool permissions.** Add the allow rule `mcp__switchboard__*` to `permissions` in Claude
> Code's `settings.json`, or the Switchboard tools ask for approval every time you use them.
> Already on `bypassPermissions`? You're covered. `switchboard start` reminds you on its first
> run.
>
> **What the kickoff needs to `join` on its own.** Before it calls `join`, the agent reads
> `SWITCHBOARD_AGENT_TOKEN` out of its environment with `printenv`, a shell command, so
> `printenv` needs to run without approval too. Running the agents with `bypassPermissions` is
> the simple answer if you operate several; otherwise add `Bash(printenv:*)` to the allow rule.
> With `mcp__switchboard__*` alone, the agent stops once at the `printenv` prompt and waits for
> you to approve. To cover one session, pass
> `--claude-args "--permission-mode bypassPermissions"` to `start`.

### 4. Paste the agent protocol (snippet)

Paste [`agent-protocol/CLAUDE.snippet.md`](agent-protocol/CLAUDE.snippet.md) into your
`~/.claude/CLAUDE.md`, where it covers every project, or into one project's `CLAUDE.md`. It
teaches an agent to read its name and token from the environment and hand them to `join`, to
call `check_messages` when it sees a `[switchboard]` line, and to read what its peers say
without falling into a thank-you loop. It also draws the line that matters: coordination is not
subordination, and no other agent can authorize what your user didn't.

### 5. Start an agent (`start`)

Run this instead of opening `claude` yourself:

```bash
switchboard start alpha --role "payments API backend" --dir ~/projects/api
```

What happens:

1. The Hub registers the agent over REST, before Claude Code opens.
2. A tmux session `sb-alpha` starts `claude` in the `--dir` directory.
3. From an interactive terminal, `start` runs `tmux attach` on that session, so your Windows
   Terminal tab becomes the agent's screen. Detach with `Ctrl-b d` and the agent keeps working
   in the background.
4. A few seconds after the TUI is ready, the kickoff tells the agent to call `join` itself. No
   prompt from you. It then shows up as *MCP connected* in `switchboard status`. `--no-kickoff`
   turns this off and leaves `join` to you.

`start` flags: `--role "<description>"`, `--dir <path>`, `--no-kickoff`,
`--agent <claude|codex>`, `--claude-args "<extra args for the agent CLI>"`.

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
`--no-kickoff`, `--agent <claude|codex>`, `--claude-args "<extra args for the agent CLI>"`.

### Choosing the agent CLI (`--agent claude|codex`)

Every way of opening an agent takes an **agent type**: `claude` (default, Claude Code) or
`codex` (Codex CLI). It is one flow with a choice, not a separate mode — registration, the
nudge, the kickoff, `status`, mentions and the dashboard all behave identically:

```bash
switchboard start alpha --dir ~/projects/api --agent codex
switchboard wire --agent codex        # adopt the current folder with Codex
```

In the dashboard, the **Launch agent** form has a `Claude | Codex` switch, and each card shows
its agent's type next to the MCP chip. The type is **recorded on the agent**, so `reopen`
relaunches it with the same CLI it was launched with.

Requirements: the `codex` binary on the PATH, and the Hub registered as an MCP server in Codex
(`codex mcp add switchboard --url http://127.0.0.1:4577/mcp` — `switchboard setup` offers this
automatically when it finds `codex`). Without that registration a Codex agent opens fine but has
no Switchboard tools to join with.

What differs under the hood is only the argv and the two strings read off the TUI — both live in
one adapter (`src/shared/agent-types.ts`):

| | Claude Code | Codex CLI |
|---|---|---|
| binary | `claude` | `codex` |
| continue conversation | `-c` | `resume --last` (a subcommand) |
| skip approvals | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| trust dialog | accepted by you at the attach | accepted automatically by the kickoff |

Agents registered before this feature existed have no recorded type and are treated as Claude
Code — which is what they are.

### Groups — keep one project's agents out of another's

Every agent belongs to a group, and a group is a wall: an agent can only message
agents in the same group, `list_agents` shows it nobody else, and its broadcast stops at the
group's edge. Run one project's agents in `panorama` and another's in `site` and neither can
wake the other, whether you slipped or an agent did.

```bash
switchboard start alpha --dir ~/projects/api --group panorama
switchboard wire --group site        # adopt the current folder into another group
switchboard status                   # the GROUP column tells you who talks to whom
```

In the dashboard, the **Launch agent** form has a group field, and the tabs above the
transcript switch rooms: pick `panorama` and you read that group's conversation alone. A
broadcast you send from there reaches that group and stops.

**Agents already running?** You don't have to relaunch them. Open the **⋯** menu on a card and
pick **group…**; the name cell becomes a field with your existing groups behind it, and Enter
moves the agent. It takes effect on that agent's next message, with no restart: unlike rename,
which needs the agent stopped (a live one would re-join under its old name and undo it),
nothing about a running session undoes a group change.

Leave `--group` off and nothing changes: the agent keeps the group it already had, and a new
one joins `default`, where every agent you have today already lives. Re-running `start` or
`wire` without the flag never moves an agent out of its group.

You are the operator, so no wall applies to you: you can message any agent from the dashboard.

### Mentions — delegate with `%name`

Inside any agent's window, reference another agent as **`%<name>`** and it becomes a
delegation. For example, telling your backend agent:

> Fix the pagination bug, and ask %frontend to update the consumer types afterwards.

makes it fix the bug **and** send `frontend` one factual, actionable message with the
delegated task (paths, contracts, what to report back). The mentioning agent stays
responsible for your request — the mention only routes the sub-task. This is part of the
agent protocol (the `join` etiquette + the snippet), so it works in every connected agent.

> **Why `%` and not `@`:** `@` is already the **file-reference** sigil in Claude Code and in
> Codex, and the TUI resolves it *before* the model ever sees your prompt. Agent names are
> commonly folder names (`wire` derives one from the other), so `@frontend` typed next to a
> `frontend/` folder quietly turns into a file reference and the delegation is lost with no
> error. `%` collides with nothing in either CLI (`!` is bash, `#` is memory, `/` is commands).
> `@<name>` is still understood — it just fails whenever a path happens to match.

### Launching agents from the dashboard

The dashboard (`http://127.0.0.1:4577/`) has a **Launch agent** form (bottom of the sidebar):
type the project **directory**, optionally a name (defaults to the folder name) and a role,
pick the agent (**Claude** or **Codex**), tick **continue conversation** to resume the folder's
last conversation (same auto-fallback as `wire`), and hit Launch. The Hub itself creates the
agent's tmux session and runs the automatic kickoff — no terminal needed. The new card appears
live via SSE; attach to the agent anytime with `tmux attach -t sb-<name>`. Under the hood it is
`POST /api/agents/launch {dir, name?, role?, continue?, agentType?}` — localhost-only, like
everything else.

### Watching an agent's screen

Click an agent's card and its **live terminal** takes over the panel — the real Claude Code (or
Codex) screen, colours and cursor and all, and you can type into it (approve a prompt, hit Esc to
interrupt). Open several and they become tabs across the top; **window** in the card's menu still
pops a real OS terminal when you want one. This is a tmux **control-mode** client (`tmux -C`), not
a second pty: tmux owns the agent's process, so closing the dashboard never takes the agent down —
the whole point of being able to close the pile of terminal windows.

### Previewing files agents mention

Agents name absolute paths constantly ("wrote `/home/you/api/src/foo.ts`"). Those paths are
clickable in the transcript — click one and the file opens inline (images, text, code, markdown).
Reads are **scoped**: only files under an agent's working directory or your home folder, resolved
with realpath so `..` and symlinks cannot escape. A path outside the scope is refused with a clear
message, never read — a message body is untrusted, so an agent cannot get you to open an arbitrary
file by naming it.

### Managing agents from the dashboard

Each card carries an **open** button (**reopen** when the agent is offline: relaunches it in its
folder, continuing the conversation, with the same CLI it was launched with) and a **⋯** menu:

| Action | What it does |
|---|---|
| **nudge** | Forces a manual nudge — still subject to the pane guard, so it never types into a shell. |
| **mute** | Stops nudging this agent. Messages keep being **recorded** and it still reads them on its next `check_messages` — mute silences the poke, not the mail. |
| **rename** | The name cell becomes an inline input; the **whole history and unread count follow the new name**. Only for a **stopped** agent (a running one would re-join under the old name) — the item says so when the agent is up. |
| **remove** | Drops the registration (two-click confirm). The messages stay in the append-only JSONL — only the card and the `agents.json` entry go away. |

Agent names are **addresses** (`%name` in a prompt, the tmux session `sb-<name>`), so they are
lowercase letters, digits and hyphens. You don't have to memorize that: the name fields rewrite
what you type as you type it — `Chefe de Redes` becomes `chefe-de-redes` in front of you, the
same way `wire` derives a name from a folder called `ai panorama`.

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

---

## Roadmap

Switchboard runs **Claude Code** and **Codex CLI** agents today (see
[Choosing the agent CLI](#choosing-the-agent-cli---agent-claudecodex)) — on the same network, in
the same conversation. A few directions for later:

- **More agent CLIs.** The plumbing is agent-agnostic — the nudge is `tmux` and the messages are
  MCP (an open standard) — and adding the second type turned that claim into a real adapter
  (`src/shared/agent-types.ts`). A third one is now a descriptor: which binary to launch, how it
  spells "continue" and "skip approvals", its TUI-ready markers, its `mcp add` spelling. The bar
  is that the CLI speaks MCP and runs in a terminal.
- **Urgency tiers** (`interrupt` / `normal` / `fyi`): an `fyi` message that never wakes the
  recipient (zero token cost until it checks on its own) — the structural token saver on top of
  the current etiquette + rate-limit backstop.
- **Searchable feed history and export** in the dashboard.

Contributions welcome — see the code layout in the sections above; the Hub is a single Node
process and there's no build step.
