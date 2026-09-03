// `switchboard remote` — turn the dashboard's remote access on and off.
//
// Switchboard deliberately does NOT ship a tunnel provider. The hub binds to
// 127.0.0.1 and always will (D6), so reaching it from a phone means running
// something that holds an outbound connection and forwards back to loopback.
// Which one is the operator's call — cloudflared, ngrok, `tailscale serve`,
// an SSH -R into a VPS they already own — and every one of them terminates on
// 127.0.0.1, so from the hub's side they are indistinguishable. Baking one in
// would mean picking a vendor for everybody who clones this repo, and picking
// it wrong for the ones who already have infrastructure.
//
// So this command owns the half that is genuinely ours: the password, the
// session, and the switch. `remote on` arms the gate; the tunnel is a separate
// command the operator runs, and `remote on` prints the ones it can find.

import type { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { defaultBaseDir } from "../server/config.js";
import {
  emptyRecord,
  hashPassword,
  loadRemoteAuth,
  passwordProblem,
  saveRemoteAuth,
  type RemoteAuthRecord,
} from "../server/remote-auth.js";
import { CliError, defaultHubUrl, runCliAction, type OutFn } from "./common.js";

/**
 * Reads a password without echoing it.
 *
 * `readline` with `terminal: true` still prints what you type, and the usual
 * trick of muting the output stream leaves the terminal in raw mode if the
 * process dies mid-prompt — so the restore runs from a finally, and SIGINT is
 * handled rather than left to kill the process with the echo still off.
 */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "A password can only be typed at an interactive terminal (stdin is not a TTY). " +
        "Run this command directly in your shell.",
    );
  }
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const wasRaw = process.stdin.isRaw === true;
  try {
    process.stdin.setRawMode(true);
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        for (const ch of s) {
          if (ch === "\r" || ch === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          // Ctrl-C: leave without a password, and without a wrecked terminal.
          if (ch === "\u0003") {
            cleanup();
            process.stdout.write("\n");
            reject(new CliError("Cancelled."));
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          // Ignore other control characters rather than storing them.
          if (ch >= " ") value += ch;
        }
      };
      const cleanup = () => {
        process.stdin.off("data", onData);
      };
      process.stdin.on("data", onData);
    });
  } finally {
    if (!wasRaw) process.stdin.setRawMode(false);
    rl.close();
  }
}

/** Which tunnels are installed here, so `remote on` can name one. */
function detectTunnels(): string[] {
  const found: string[] = [];
  const which = (bin: string): boolean => {
    const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
    for (const dir of dirs) {
      try {
        fs.accessSync(`${dir}/${bin}`, fs.constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
    return false;
  };
  if (which("cloudflared")) found.push("cloudflared");
  if (which("tailscale")) found.push("tailscale");
  if (which("ngrok")) found.push("ngrok");
  return found;
}

function tunnelHelp(port: number, installed: string[]): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Now expose it with ONE of these, in another terminal:");
  lines.push("");
  if (installed.includes("cloudflared")) {
    lines.push(`    cloudflared tunnel --url http://127.0.0.1:${port}`);
    lines.push("      → prints a https://….trycloudflare.com address (new one each run)");
  }
  if (installed.includes("tailscale")) {
    lines.push(`    tailscale serve ${port}`);
    lines.push("      → reachable on your tailnet only, with a real certificate");
  }
  if (installed.includes("ngrok")) {
    lines.push(`    ngrok http ${port}`);
  }
  if (installed.length === 0) {
    lines.push("    cloudflared:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    lines.push(`                  then: cloudflared tunnel --url http://127.0.0.1:${port}`);
    lines.push(`    tailscale:    https://tailscale.com/download  then: tailscale serve ${port}`);
    lines.push("");
    lines.push("    (none of them is installed here — Switchboard does not pick one for you)");
  }
  return lines;
}

export interface RemoteResult {
  enabled: boolean;
  hasPassword: boolean;
}

export async function runRemoteStatus(out: OutFn, baseDir = defaultBaseDir()): Promise<RemoteResult> {
  const rec = loadRemoteAuth(baseDir);
  out(`Remote access: ${rec.enabled ? "ON" : "off"}`);
  out(`Password:      ${rec.hash ? "set" : "NOT SET"}`);
  out(`Session life:  ${rec.sessionHours}h`);
  if (rec.enabled && !rec.hash) {
    out("");
    out('  WARNING: armed with no password — nobody can get in, including you.');
    out('  Fix it with "switchboard remote password".');
  }
  return { enabled: rec.enabled, hasPassword: Boolean(rec.hash) };
}

/**
 * A generated passphrase, for the case the typed one cannot serve: setting the
 * password over SSH, from a hook, or from anywhere else without a real TTY —
 * which is exactly when you most want to turn remote access on and least want
 * to `echo` a password into your shell history.
 *
 * Words rather than characters: it has to survive being typed on a phone
 * keyboard, and four words out of this list carry more entropy (~62 bits) than
 * the ten-character line noise anyone would actually retype.
 */
const WORDS = [
  "amber", "anchor", "atlas", "beacon", "bishop", "boulder", "cabin", "cactus",
  "canyon", "cedar", "cinder", "clover", "cobalt", "compass", "copper", "coral",
  "cotton", "crimson", "cypress", "dahlia", "delta", "domino", "ember", "falcon",
  "fennel", "fjord", "flint", "galaxy", "garnet", "glacier", "granite", "harbor",
  "hazel", "heron", "indigo", "ivory", "jasper", "juniper", "kettle", "lagoon",
  "lantern", "lattice", "lemon", "lichen", "lumber", "magnet", "mango", "marble",
  "meadow", "mesa", "meteor", "mint", "mosaic", "nectar", "nickel", "nomad",
  "oasis", "obsidian", "onyx", "opal", "orchid", "otter", "paprika", "pebble",
  "pepper", "pewter", "pigeon", "pine", "piston", "plateau", "pollen", "prairie",
  "quartz", "quiver", "raven", "reef", "ripple", "rocket", "rosemary", "saffron",
  "sage", "sandal", "sapphire", "sequoia", "shale", "sierra", "silo", "sparrow",
  "spruce", "summit", "sundial", "tandem", "teal", "thistle", "timber", "topaz",
  "trellis", "tundra", "velvet", "walnut", "willow", "zenith",
];

function generatePassphrase(words = 4): string {
  const picked: string[] = [];
  for (let i = 0; i < words; i++) {
    // crypto.randomInt, not Math.random: this is a password.
    picked.push(WORDS[crypto.randomInt(WORDS.length)]);
  }
  return picked.join("-");
}

export async function runRemotePassword(
  out: OutFn,
  baseDir = defaultBaseDir(),
  options: { generate?: boolean } = {},
): Promise<void> {
  const existing = loadRemoteAuth(baseDir);
  const rec: RemoteAuthRecord = existing.hash || existing.localToken ? existing : emptyRecord();

  if (options.generate) {
    const generated = generatePassphrase();
    const bad = passwordProblem(generated);
    if (bad) throw new CliError(`Generated a password the rules reject (${bad}). This is a bug.`);
    const hashed = hashPassword(generated);
    saveRemoteAuth(baseDir, { ...rec, hash: hashed.hash, salt: hashed.salt });
    out("");
    out(`  ${generated}`);
    out("");
    out("  ^ this is shown ONCE and stored only as a hash — copy it now.");
    out('  Replace it with one of your own later: "switchboard remote password".');
    return;
  }

  const password = await readSecret("New remote password: ");
  const problem = passwordProblem(password);
  if (problem) throw new CliError(problem);
  const again = await readSecret("Repeat it: ");
  if (again !== password) throw new CliError("The two entries do not match. Nothing was changed.");

  const { hash, salt } = hashPassword(password);
  saveRemoteAuth(baseDir, { ...rec, hash, salt });
  out("Password set. Every browser session that was open has been invalidated.");
  if (!rec.enabled) out('Turn remote access on with "switchboard remote on".');
}

export async function runRemoteOn(out: OutFn, baseDir = defaultBaseDir()): Promise<void> {
  const rec = loadRemoteAuth(baseDir);
  if (!rec.hash) {
    throw new CliError(
      'No password is set — arming remote access now would lock everyone out. ' +
        'Run "switchboard remote password" first.',
    );
  }
  saveRemoteAuth(baseDir, { ...rec, enabled: true });
  const port = Number(new URL(defaultHubUrl(baseDir)).port || 4577);
  out("Remote access is ON. The hub now asks for the password on every request.");
  out("");
  out("  The hub still listens on 127.0.0.1 only — that does not change.");
  for (const line of tunnelHelp(port, detectTunnels())) out(line);
  out("");
  out('  Turn it off again with "switchboard remote off".');
}

export async function runRemoteOff(out: OutFn, baseDir = defaultBaseDir()): Promise<void> {
  const rec = loadRemoteAuth(baseDir);
  saveRemoteAuth(baseDir, { ...rec, enabled: false });
  out("Remote access is off. Open sessions were dropped; the password is kept for next time.");
  out("Remember to stop the tunnel process too — the hub cannot see it.");
}

export function registerRemoteCommand(program: Command): void {
  const remote = program
    .command("remote")
    .description(
      "Password-protects the dashboard so it can be reached through a tunnel (off by default).",
    );

  remote
    .command("status", { isDefault: true })
    .description("Shows whether remote access is armed and whether a password is set.")
    .action(async () => {
      await runCliAction(async () => {
        await runRemoteStatus((line) => console.log(line));
      });
    });

  remote
    .command("password")
    .description("Sets or replaces the remote password (typed, never passed as an argument).")
    .option(
      "--generate",
      "Generate a strong passphrase and print it once, instead of prompting (for shells with no TTY).",
    )
    .action(async (opts: { generate?: boolean }) => {
      await runCliAction(async () => {
        await runRemotePassword((line) => console.log(line), defaultBaseDir(), {
          generate: Boolean(opts.generate),
        });
      });
    });

  remote
    .command("on")
    .description("Arms the gate: every request needs the password or the local CLI token.")
    .action(async () => {
      await runCliAction(async () => {
        await runRemoteOn((line) => console.log(line));
      });
    });

  remote
    .command("off")
    .description("Disarms the gate and drops every open browser session.")
    .action(async () => {
      await runCliAction(async () => {
        await runRemoteOff((line) => console.log(line));
      });
    });
}
