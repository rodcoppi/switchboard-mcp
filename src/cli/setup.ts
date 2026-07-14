// `switchboard setup` — ONE interactive wizard that takes a fresh clone to a
// fully working install: the README's manual steps collapse into `npm install`
// + `switchboard setup`. Seven steps, in order, each IDEMPOTENT (a re-run
// prints "✓ already ..." instead of redoing work):
//
//   1. prerequisites (node, claude, tmux — offering the sudo-less user-space
//      tmux install proven in spikes/NOTES.md when tmux is missing);
//   2. MCP registration (`claude mcp add ... switchboard`, plus the same for
//      Codex when its binary exists — optional and never fatal);
//   3. agent protocol snippet into ~/.claude/CLAUDE.md (between markers,
//      replaced in place — user content around the block is never touched);
//   4. permissions.allow rules in ~/.claude/settings.json (merge, no dupes,
//      everything else preserved);
//   5. `npm link` for the global `switchboard` command (failure non-fatal);
//   6. Windows shortcut via the existing runShortcut (WSL sessions only);
//   7. hub up (existing ensureHubUp) + the "You're all set" summary.
//
// Every confirmation is y/N over readline/promises (same pattern as stop.ts);
// `--yes` assumes yes everywhere (non-interactive). A non-TTY without --yes
// fails upfront with a clear instruction. Every filesystem/exec surface is
// injectable for tests; nothing here ever prints or logs a token (setup never
// even sees one).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  claudeAgentType,
  codexAgentType,
  type AgentTypeDescriptor,
} from "../shared/agent-types.js";
import { runShortcut } from "./shortcut.js";
import {
  CliError,
  defaultHubUrl,
  ensureHubUp,
  runCliAction,
  type OutFn,
} from "./common.js";

// ---------------------------------------------------------------------------
// Injectable surfaces.
// ---------------------------------------------------------------------------

/**
 * Injectable executor (tests record commands instead of running them). MUST
 * reject on non-zero exit, like promisified execFile does. `cwd` is used by
 * `apt-get download` (drops .deb files into it) and `npm link` (repo root).
 */
export type SetupExecFn = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

const defaultSetupExec: SetupExecFn = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    encoding: "utf8",
    cwd: opts?.cwd,
  });
  return { stdout, stderr };
};

/** Terminal yes/no prompt ("y"/"yes" confirms). Injectable for tests. */
export type ConfirmFn = (question: string) => Promise<boolean>;

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Free-form terminal prompt (the shortcut step's 4-way menu). Injectable. */
export type ChooseFn = (question: string) => Promise<string>;

async function defaultChoose(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/setup.test.ts).
// ---------------------------------------------------------------------------

/** Markers that delimit the managed protocol block in ~/.claude/CLAUDE.md. */
export const PROTOCOL_START = "<!-- switchboard:protocol:start -->";
export const PROTOCOL_END = "<!-- switchboard:protocol:end -->";

/**
 * Inserts/replaces the protocol snippet BETWEEN the markers, never touching
 * anything outside them (idempotent by construction):
 * - both markers present → the block is replaced IN PLACE;
 * - neither present → the block is appended (one blank line of separation);
 * - only one marker → clear error (a corrupted block must not be guessed at).
 */
export function upsertProtocolBlock(existing: string, snippet: string): string {
  const block = `${PROTOCOL_START}\n${snippet.trim()}\n${PROTOCOL_END}`;
  const startIdx = existing.indexOf(PROTOCOL_START);
  const endIdx = existing.indexOf(PROTOCOL_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    return (
      existing.slice(0, startIdx) + block + existing.slice(endIdx + PROTOCOL_END.length)
    );
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new CliError(
      `The switchboard protocol block in your CLAUDE.md looks corrupted: one of the markers ` +
        `("${PROTOCOL_START}" / "${PROTOCOL_END}") is present without the other. ` +
        `Fix or remove the markers manually and re-run "switchboard setup".`,
    );
  }
  if (existing.trim() === "") return block + "\n";
  return existing.replace(/\n*$/, "\n\n") + block + "\n";
}

/** The two allow rules the agents need (README step 3 / spikes NOTES finding 2). */
export const PERMISSION_ALLOW_RULES = ["mcp__switchboard__*", "Bash(printenv:*)"] as const;

/**
 * Merges the allow rules into a settings.json content string: creates the
 * object/keys when missing, PRESERVES every unrelated key and every existing
 * allow entry, never duplicates, pretty-prints with 2 spaces. `raw` is the
 * current file content (undefined = file missing). Invalid JSON or
 * wrongly-typed permissions/allow → clear error (never clobber a user file
 * we cannot faithfully preserve).
 */
export function mergePermissionAllow(
  raw: string | undefined,
  rules: readonly string[],
): { next: string; added: string[] } {
  let parsed: unknown = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CliError(
        `Your Claude Code settings.json is not valid JSON (${String(err)}). ` +
          `Fix the file and re-run "switchboard setup".`,
      );
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      `Your Claude Code settings.json is not a JSON object — cannot merge permissions. ` +
        `Fix the file and re-run "switchboard setup".`,
    );
  }
  const settings = parsed as Record<string, unknown>;
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    throw new CliError(
      `The "permissions" key in your Claude Code settings.json is not an object — ` +
        `cannot merge the allow rules. Fix the file and re-run "switchboard setup".`,
    );
  }
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) {
    throw new CliError(
      `The "permissions.allow" key in your Claude Code settings.json is not an array — ` +
        `cannot merge the allow rules. Fix the file and re-run "switchboard setup".`,
    );
  }
  const added = rules.filter((rule) => !allow.includes(rule));
  permissions.allow = [...allow, ...added];
  settings.permissions = permissions;
  return { next: JSON.stringify(settings, null, 2) + "\n", added: [...added] };
}

/** Parses "tmux 3.4" / "tmux 3.3a" / "tmux next-3.6" into [major, minor]. */
export function parseTmuxVersion(output: string): [number, number] | undefined {
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/** Switchboard needs tmux >= 3.2 (README prerequisites, validated with 3.4). */
export function isTmuxVersionSupported(output: string): boolean {
  const version = parseTmuxVersion(output);
  if (!version) return false;
  const [major, minor] = version;
  return major > 3 || (major === 3 && minor >= 2);
}

/** Maps the shortcut menu answer to an action ("skip" for anything else). */
export function parseShortcutChoice(answer: string): "desktop" | "startup" | "both" | "skip" {
  const a = answer.trim().toLowerCase();
  if (a === "d" || a === "desktop") return "desktop";
  if (a === "s" || a === "startup") return "startup";
  if (a === "b" || a === "both") return "both";
  return "skip";
}

// ---------------------------------------------------------------------------
// User-space tmux install (sudo-less technique proven in spikes/NOTES.md,
// "Environment (0.1)": apt-get download + dpkg -x into ~/.local/opt, wrapper
// in ~/.local/bin exporting LD_LIBRARY_PATH — functionally identical to the
// system package, tmux runs 100% in user-space).
// ---------------------------------------------------------------------------

/**
 * The exact packages the NOTES.md technique unpacks (Ubuntu 24.04 "noble"
 * names — on another Debian/Ubuntu release the libevent package name may
 * differ, apt-get download then fails and we fall back to the sudo
 * instruction; that failure path IS the design, not a bug).
 */
export const TMUX_USERSPACE_PACKAGES = [
  "tmux",
  "libevent-core-2.1-7t64",
  "libutempter0",
] as const;

export interface TmuxInstallIo {
  exec: SetupExecFn;
  homeDir: string;
  out: OutFn;
  /** Temp dir for the .deb downloads (default: a fresh mkdtemp). */
  mkTempDir?: () => string;
}

function sudoFallback(detail: string): CliError {
  return new CliError(
    `Could not install tmux without sudo (${detail}). ` +
      `Install it manually — on Debian/Ubuntu: sudo apt install tmux — ` +
      `and then re-run "switchboard setup".`,
  );
}

/**
 * Installs tmux WITHOUT sudo: downloads the official .deb packages, unpacks
 * them into ~/.local/opt/switchboard-tools and writes an executable wrapper
 * at ~/.local/bin/tmux that exports LD_LIBRARY_PATH and execs the real
 * binary. Verifies `tmux -V` >= 3.2 on the wrapper afterwards. Any download
 * failure (offline, non-Debian, renamed packages) aborts with the sudo
 * instruction. Returns the wrapper path.
 */
export async function installTmuxUserSpace(io: TmuxInstallIo): Promise<string> {
  const tmpDir =
    io.mkTempDir?.() ?? fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-tmux-"));
  try {
    try {
      await io.exec("apt-get", ["download", ...TMUX_USERSPACE_PACKAGES], { cwd: tmpDir });
    } catch (err) {
      throw sudoFallback(
        `the package download failed — offline or non-Debian system? ${String(
          err instanceof Error ? err.message : err,
        )}`,
      );
    }
    const debs = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".deb"));
    if (debs.length === 0) {
      throw sudoFallback("apt-get download produced no .deb files");
    }

    const toolsDir = path.join(io.homeDir, ".local", "opt", "switchboard-tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    for (const deb of debs) {
      await io.exec("dpkg", ["-x", path.join(tmpDir, deb), toolsDir]);
    }

    // Wrapper: same shape as the one validated in the spikes (bash, exports
    // LD_LIBRARY_PATH pointing into the unpacked tree, execs the real binary).
    const binDir = path.join(io.homeDir, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const libDir = path.join(toolsDir, "usr", "lib", "x86_64-linux-gnu");
    const realTmux = path.join(toolsDir, "usr", "bin", "tmux");
    const wrapperPath = path.join(binDir, "tmux");
    const wrapper = [
      "#!/bin/bash",
      `export LD_LIBRARY_PATH="${libDir}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
      `exec "${realTmux}" "$@"`,
      "",
    ].join("\n");
    fs.writeFileSync(wrapperPath, wrapper);
    fs.chmodSync(wrapperPath, 0o755);

    // Verify on the WRAPPER path (this process's PATH may not have ~/.local/bin).
    let versionOut: string;
    try {
      versionOut = (await io.exec(wrapperPath, ["-V"])).stdout;
    } catch (err) {
      throw sudoFallback(
        `the installed tmux does not run: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
    if (!isTmuxVersionSupported(versionOut)) {
      throw sudoFallback(
        `the installed tmux reports "${versionOut.trim()}" — Switchboard needs >= 3.2`,
      );
    }
    io.out(`✓ tmux installed without sudo: ${wrapperPath} (${versionOut.trim()})`);
    return wrapperPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The wizard.
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** Assume yes for every confirmation (flag --yes; non-interactive mode). */
  yes?: boolean;
  // -- injectables (index.ts uses the defaults; tests override) --------------
  /** Config dir for loadConfig/hub URL (default ~/.switchboard). */
  baseDir?: string;
  /** Home dir for ~/.claude and ~/.local (default os.homedir()). */
  homeDir?: string;
  out?: OutFn;
  confirm?: ConfirmFn;
  choose?: ChooseFn;
  isTTY?: boolean;
  exec?: SetupExecFn;
  /** Env for WSL detection + the PATH hint (default process.env). */
  env?: NodeJS.ProcessEnv;
  hubUrl?: string;
  /** Hub liveness strategy (default ensureHubUp — auto-starts sb-hub). */
  ensureHub?: (hubUrl: string, opts: { out: OutFn }) => Promise<void>;
  /** Shortcut runner (default: the existing runShortcut — reuse, no copy). */
  shortcut?: (opts: { startup?: boolean }) => Promise<void>;
  /** Path of the protocol snippet (default: agent-protocol/CLAUDE.snippet.md). */
  snippetPath?: string;
  /** Repo root where `npm link` runs (default: resolved from this module). */
  repoRoot?: string;
  /** TmuxInstallIo.mkTempDir passthrough (tests). */
  mkTempDir?: () => string;
}

/** Everything a step needs, resolved once (defaults applied). */
interface SetupCtx {
  yes: boolean;
  out: OutFn;
  confirm: ConfirmFn;
  choose: ChooseFn;
  exec: SetupExecFn;
  homeDir: string;
  baseDir?: string;
  env: NodeJS.ProcessEnv;
  hubUrl: string;
  snippetPath: string;
  repoRoot: string;
  mkTempDir?: () => string;
}

/**
 * y/N gate: --yes short-circuits; Ctrl-C at the prompt (AbortError from
 * readline/promises) is the user declining, not a bug — same as stop.ts.
 */
async function askYesNo(ctx: SetupCtx, question: string): Promise<boolean> {
  if (ctx.yes) return true;
  try {
    return await ctx.confirm(question);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return false;
    throw err;
  }
}

function repoRootDefault(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

// -- step 1: prerequisites ----------------------------------------------------

async function stepPrereqs(ctx: SetupCtx): Promise<void> {
  ctx.out("[1/7] Prerequisites");
  ctx.out(`✓ node ${process.version}`);

  // claude on the PATH — without it nothing else makes sense.
  try {
    const { stdout } = await ctx.exec("claude", ["--version"]);
    ctx.out(`✓ claude ${stdout.trim()}`);
  } catch {
    throw new CliError(
      `Claude Code ("claude") was not found on the PATH. Install it first — ` +
        `npm install -g @anthropic-ai/claude-code (or see https://docs.claude.com/en/docs/claude-code) — ` +
        `and re-run "switchboard setup".`,
    );
  }

  // tmux on the PATH; when missing, offer the sudo-less user-space install.
  try {
    const { stdout } = await ctx.exec("tmux", ["-V"]);
    const version = stdout.trim();
    if (isTmuxVersionSupported(version)) {
      ctx.out(`✓ ${version}`);
    } else {
      ctx.out(
        `→ ${version} detected, but Switchboard needs tmux >= 3.2 — nudge delivery may ` +
          `misbehave. Upgrade it (e.g. sudo apt install tmux) when you can.`,
      );
    }
    return;
  } catch {
    // tmux missing — fall through to the install offer.
  }

  // Only offer the user-space install where apt-get exists (Debian/Ubuntu).
  try {
    await ctx.exec("apt-get", ["--version"]);
  } catch {
    throw new CliError(
      `tmux was not found on the PATH and this system has no apt-get to download it with. ` +
        `Install tmux >= 3.2 with your system's package manager and re-run "switchboard setup".`,
    );
  }

  const install = await askYesNo(
    ctx,
    `tmux is not installed. Install it now into your user space (~/.local — no sudo needed)? [y/N] `,
  );
  if (!install) {
    throw new CliError(
      `tmux is required (every agent runs in a tmux session). Install it — ` +
        `sudo apt install tmux — or re-run "switchboard setup" and accept the ` +
        `user-space install.`,
    );
  }

  const wrapperPath = await installTmuxUserSpace({
    exec: ctx.exec,
    homeDir: ctx.homeDir,
    out: ctx.out,
    mkTempDir: ctx.mkTempDir,
  });

  // Make the wrapper reachable for the REST of this run (step 7 boots the hub
  // through `tmux` from the PATH) and tell the user about their shell.
  const binDir = path.dirname(wrapperPath);
  const pathEntries = (ctx.env.PATH ?? "").split(path.delimiter);
  if (!pathEntries.includes(binDir)) {
    ctx.env.PATH = binDir + path.delimiter + (ctx.env.PATH ?? "");
    ctx.out(
      `→ ${binDir} was added to the PATH for this run. Make sure it is on your PATH ` +
        `permanently (Ubuntu's default ~/.profile already adds ~/.local/bin — a new ` +
        `login shell picks it up).`,
    );
  }
}

// -- step 2: MCP registration -------------------------------------------------

/** The MCP server id — changing it breaks the mcp__switchboard__* tools. */
export const MCP_SERVER_NAME = "switchboard";

/**
 * Registers the Hub as an MCP server in ONE agent CLI, idempotently.
 *
 * Empirical finding (claude 2.1.205, codex-cli 0.144.3): `<bin> mcp get <name>`
 * exits 0 whenever the server is REGISTERED — even when it is unreachable
 * (claude prints "✘ Failed to connect" but still exits 0) — and exits non-zero
 * when it is not configured. The exit code therefore cleanly means "registered
 * or not", independent of hub health. Both CLIs speak the same streamable-HTTP
 * transport the Hub already serves at /mcp; only the `mcp add` spelling
 * differs, which is why the argv comes from the agent-type descriptor.
 *
 * `required: false` (codex) makes every failure non-fatal: Codex is an OPTIONAL
 * prerequisite, so a hiccup there must never break a Claude-only install.
 */
async function registerMcpIn(
  ctx: SetupCtx,
  descriptor: AgentTypeDescriptor,
  opts: { required: boolean },
): Promise<void> {
  try {
    await ctx.exec(descriptor.bin, descriptor.mcpGetArgs(MCP_SERVER_NAME));
    ctx.out(`✓ MCP server "${MCP_SERVER_NAME}" already registered in ${descriptor.label}`);
    return;
  } catch {
    // Not registered — offer to add it.
  }

  const mcpUrl = `${ctx.hubUrl}/mcp`;
  const addArgs = descriptor.mcpAddArgs(MCP_SERVER_NAME, mcpUrl);
  const cmd = `${descriptor.bin} ${addArgs.join(" ")}`;
  const proceed = await askYesNo(
    ctx,
    `Register the Switchboard MCP server in ${descriptor.label} (${cmd})? [y/N] `,
  );
  if (!proceed) {
    ctx.out(
      `→ Skipped. Without the registration the ${descriptor.label} agents have no ` +
        `Switchboard tools — register it later with: ${cmd}`,
    );
    return;
  }
  try {
    await ctx.exec(descriptor.bin, addArgs);
    ctx.out(`✓ MCP server "${MCP_SERVER_NAME}" registered in ${descriptor.label} (${mcpUrl})`);
  } catch (err) {
    if (opts.required) throw err;
    ctx.out(
      `→ Could not register it in ${descriptor.label} ` +
        `(${String(err instanceof Error ? err.message : err)}) — not fatal. ` +
        `Retry later with: ${cmd}`,
    );
  }
}

async function stepMcpRegistration(ctx: SetupCtx): Promise<void> {
  ctx.out("[2/7] MCP registration");

  // Claude Code is the required prerequisite (step 1 already refused to
  // continue without it), so its registration failing IS an error.
  await registerMcpIn(ctx, claudeAgentType, { required: true });

  // Codex is OPTIONAL: only offer it to someone who actually has the binary,
  // and never let it fail the wizard. Without this an operator who picks
  // "Codex" in the dashboard would launch an agent with no Switchboard tools.
  try {
    await ctx.exec(codexAgentType.bin, ["--version"]);
  } catch {
    return; // no codex on this machine — nothing to offer
  }
  await registerMcpIn(ctx, codexAgentType, { required: false });
}

// -- step 3: agent protocol snippet -------------------------------------------

async function stepProtocolSnippet(ctx: SetupCtx): Promise<void> {
  ctx.out("[3/7] Agent protocol snippet");

  let snippet: string;
  try {
    snippet = fs.readFileSync(ctx.snippetPath, "utf8");
  } catch {
    throw new CliError(
      `Could not read the protocol snippet at ${ctx.snippetPath} — is the clone complete?`,
    );
  }

  const claudeMdPath = path.join(ctx.homeDir, ".claude", "CLAUDE.md");
  const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
  const next = upsertProtocolBlock(existing, snippet);
  if (next === existing) {
    ctx.out(`✓ Protocol snippet already up to date in ${claudeMdPath}`);
    return;
  }

  const verb = existing.includes(PROTOCOL_START) ? "Update" : "Install";
  const proceed = await askYesNo(
    ctx,
    `${verb} the agent protocol block in ${claudeMdPath} (between the switchboard markers — ` +
      `nothing else in the file is touched)? [y/N] `,
  );
  if (!proceed) {
    ctx.out(
      `→ Skipped. The agents will not know the Switchboard etiquette — paste ` +
        `agent-protocol/CLAUDE.snippet.md into ${claudeMdPath} yourself (README step 4).`,
    );
    return;
  }
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
  fs.writeFileSync(claudeMdPath, next);
  ctx.out(`✓ Protocol snippet ${verb === "Update" ? "updated" : "installed"} in ${claudeMdPath}`);
}

// -- step 4: permissions -------------------------------------------------------

async function stepPermissions(ctx: SetupCtx): Promise<void> {
  ctx.out("[4/7] Claude Code permissions");

  const settingsPath = path.join(ctx.homeDir, ".claude", "settings.json");
  const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : undefined;
  const { next, added } = mergePermissionAllow(raw, PERMISSION_ALLOW_RULES);
  if (added.length === 0) {
    ctx.out(`✓ Allow rules already present in ${settingsPath}`);
    return;
  }

  const proceed = await askYesNo(
    ctx,
    `Add the allow rules ${added.map((r) => `"${r}"`).join(" and ")} to permissions.allow in ` +
      `${settingsPath} (everything else is preserved)? [y/N] `,
  );
  if (!proceed) {
    ctx.out(
      `→ Skipped. Without the allow rules the agents stop at approval prompts — they will ` +
        `need to run with bypassPermissions instead (wire's default; for start pass ` +
        `--claude-args "--permission-mode bypassPermissions").`,
    );
    return;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, next);
  ctx.out(`✓ Allow rules added to ${settingsPath}: ${added.join(", ")}`);
}

// -- step 5: global command ----------------------------------------------------

async function stepGlobalCommand(ctx: SetupCtx): Promise<void> {
  ctx.out("[5/7] Global command");

  try {
    await ctx.exec("which", ["switchboard"]);
    ctx.out(`✓ "switchboard" already on the PATH`);
    return;
  } catch {
    // Not linked — offer npm link.
  }

  const alternative = `node ${path.join(ctx.repoRoot, "bin", "switchboard.mjs")} <subcommand>`;
  const proceed = await askYesNo(
    ctx,
    `Put the "switchboard" command on the PATH (npm link in ${ctx.repoRoot})? [y/N] `,
  );
  if (!proceed) {
    ctx.out(`→ Skipped. You can always run it without the link: ${alternative}`);
    return;
  }
  try {
    await ctx.exec("npm", ["link"], { cwd: ctx.repoRoot });
    ctx.out(`✓ npm link done — "switchboard" is on the PATH`);
  } catch (err) {
    // Non-fatal by design: the bin shim always works.
    ctx.out(
      `→ npm link failed (${String(err instanceof Error ? err.message : err)}) — not fatal. ` +
        `Run it without the link: ${alternative}`,
    );
  }
}

// -- step 6: Windows shortcut (WSL only) ----------------------------------------

async function stepWindowsShortcut(
  ctx: SetupCtx,
  shortcut: (opts: { startup?: boolean }) => Promise<void>,
): Promise<void> {
  ctx.out("[6/7] Windows shortcut");

  if (!ctx.env.WSL_DISTRO_NAME) {
    ctx.out("→ Skipped (not a WSL session — there is no Windows side for a shortcut).");
    return;
  }

  let choice: ReturnType<typeof parseShortcutChoice>;
  if (ctx.yes) {
    choice = "both"; // --yes default: Desktop AND Startup (one-click + on boot).
  } else {
    const answer = await ctx.choose(
      `Create a one-click Windows launcher (Switchboard.bat)? ` +
        `[d]esktop / [s]tartup (runs on boot) / [b]oth / [N]one: `,
    ).catch((err) => {
      if (err instanceof Error && err.name === "AbortError") return "";
      throw err;
    });
    choice = parseShortcutChoice(answer);
  }
  if (choice === "skip") {
    ctx.out(`→ Skipped. You can create it anytime with "switchboard shortcut" (--startup for boot).`);
    return;
  }

  // Reuse the existing shortcut command (never duplicated). Failure here is
  // cosmetic (PowerShell hiccup, OneDrive folder…) — report it and move on.
  try {
    if (choice === "desktop" || choice === "both") await shortcut({ startup: false });
    if (choice === "startup" || choice === "both") await shortcut({ startup: true });
    ctx.out(`✓ Windows shortcut created (${choice})`);
  } catch (err) {
    ctx.out(
      `→ Shortcut creation failed (${String(err instanceof Error ? err.message : err)}) — ` +
        `not fatal. Retry later with "switchboard shortcut".`,
    );
  }
}

// -- step 7: hub up + summary ----------------------------------------------------

async function stepHubUp(
  ctx: SetupCtx,
  ensureHub: (hubUrl: string, opts: { out: OutFn }) => Promise<void>,
): Promise<void> {
  ctx.out("[7/7] Hub");
  await ensureHub(ctx.hubUrl, { out: ctx.out });
  ctx.out(`✓ Hub is running at ${ctx.hubUrl}`);
  ctx.out("");
  ctx.out("You're all set!");
  ctx.out(`  Dashboard:    ${ctx.hubUrl}/`);
  ctx.out(`  Open windows: run "switchboard wire" in each project folder to adopt them.`);
  ctx.out(
    `  New agents:   use the "Launch agent" form in the dashboard, or ` +
      `"switchboard start <name> --dir <project>".`,
  );
}

/**
 * The wizard entry point: runs the 7 steps in order. Idempotent end to end —
 * a second run detects each already-done step and reports "✓ already ...".
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const yes = options.yes ?? false;
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  if (!yes && !isTTY) {
    throw new CliError(
      `switchboard setup asks for confirmation at several steps and this terminal is not ` +
        `interactive. Re-run with --yes to accept every step: switchboard setup --yes`,
    );
  }

  const ctx: SetupCtx = {
    yes,
    out: options.out ?? console.log,
    confirm: options.confirm ?? defaultConfirm,
    choose: options.choose ?? defaultChoose,
    exec: options.exec ?? defaultSetupExec,
    homeDir: options.homeDir ?? os.homedir(),
    baseDir: options.baseDir,
    env: options.env ?? process.env,
    hubUrl: options.hubUrl ?? defaultHubUrl(options.baseDir),
    snippetPath:
      options.snippetPath ??
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../agent-protocol/CLAUDE.snippet.md",
      ),
    repoRoot: options.repoRoot ?? repoRootDefault(),
    mkTempDir: options.mkTempDir,
  };

  const defaultShortcut = (opts: { startup?: boolean }) =>
    runShortcut({ startup: opts.startup, baseDir: ctx.baseDir, out: ctx.out });

  await stepPrereqs(ctx);
  await stepMcpRegistration(ctx);
  await stepProtocolSnippet(ctx);
  await stepPermissions(ctx);
  await stepGlobalCommand(ctx);
  await stepWindowsShortcut(ctx, options.shortcut ?? defaultShortcut);
  await stepHubUp(ctx, options.ensureHub ?? ensureHubUp);
}

// ---------------------------------------------------------------------------
// commander wiring.
// ---------------------------------------------------------------------------

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Interactive wizard that takes a fresh clone to a fully working install: checks the " +
        "prerequisites (offering a sudo-less tmux install when it is missing), registers the " +
        "MCP server in Claude Code, installs the agent protocol snippet and the permission " +
        "allow rules, links the global command, offers the Windows shortcut (WSL) and brings " +
        "the Hub up. Idempotent — safe to re-run anytime.",
    )
    .option("--yes", "assume yes for every confirmation (non-interactive)")
    .action(async (opts: { yes?: boolean }) => {
      await runCliAction(() => runSetup({ yes: opts.yes }));
    });
}
