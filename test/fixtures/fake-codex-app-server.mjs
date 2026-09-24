// A stand-in for `codex app-server` (codex-ratelimits.test.ts). Speaks the same
// newline-delimited JSON-RPC as codex-cli 0.154.0; argv[2] picks a behaviour.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "ok";
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (mode === "hang") {
  // Ignores SIGTERM: the reader must escalate to SIGKILL.
  writeFileSync(process.argv[3], String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
if (mode === "flood") {
  const junk = "x".repeat(64 * 1024);
  const t = setInterval(() => process.stdout.write(junk + "\n"), 1);
  process.on("SIGTERM", () => { clearInterval(t); process.exit(0); });
}

let initialized = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (mode === "hang" || mode === "flood") return;
  if (msg.method === "initialize") {
    if (mode === "init-error") out({ id: msg.id, error: { code: -32600, message: "unavailable" } });
    else out({ id: msg.id, result: { userAgent: "fake/0.154.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (msg.method === "initialized") {
    initialized = true;
  } else if (!initialized) {
    out({ id: msg.id, error: { message: "not initialized" } });
  } else if (msg.method === "account/rateLimits/read") {
    // Noise and a server notification first: neither is the reply.
    process.stdout.write("not json\nnull\n");
    out({ method: "remoteControl/status/changed", params: { status: "disabled" } });
    if (mode === "no-login") {
      out({ id: msg.id, error: { message: "ChatGPT login required" } });
      return;
    }
    const soon = Math.floor(Date.now() / 1000) + 3_600;
    out({
      id: msg.id,
      result: {
        rateLimits: {
          limitId: "codex", limitName: null, planType: "plus",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: soon },
          secondary: mode === "no-duration"
            ? { usedPercent: 7, resetsAt: soon + 86_400 }
            : { usedPercent: 7, windowDurationMins: 10_080, resetsAt: soon + 86_400 },
        },
        accountId: "private-account",
        rateLimitResetCredits: { availableCount: 1, credits: [{ id: "private" }] },
      },
    });
  }
});
