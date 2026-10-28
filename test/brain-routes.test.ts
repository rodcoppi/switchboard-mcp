// The group brain over HTTP and through the real hook script: the scope is
// the token's agent and never a parameter, the hook prints Claude Code's
// additionalContext shape, and it stays reachable — and only with a valid
// token — when remote access is on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import { emptyRecord, hashPassword, saveRemoteAuth } from "../src/server/remote-auth.js";

const HOOK = fileURLToPath(new URL("../bin/brain-hook.mjs", import.meta.url));

let base: string;
let hub: Hub;
let url: string;
const tokens: Record<string, string> = {};

function memory(projects: string, cwd: string, name: string, description: string, body: string): void {
  const dir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`);
}

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-brain-routes-"));
  const projects = path.join(base, "projects");
  hub = await startHub({ baseDir: path.join(base, "data"), port: 0, quiet: true, onMessage: () => "queued_offline", claudeProjectsDir: projects });
  url = `http://127.0.0.1:${hub.port}`;
  for (const g of ["agency", "studio"]) await fetch(`${url}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: g }) });
  for (const [name, group] of [["hq", "agency"], ["studio-dev", "studio"]]) {
    const cwd = path.join(base, "work", name);
    fs.mkdirSync(cwd, { recursive: true });
    const r = await json(await fetch(`${url}/api/agents/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, tmuxSession: `sb-${name}`, cwd, group }) }));
    tokens[name] = r.token;
    memory(projects, cwd, `${name}-nota`, `Nota secreta de ${name}`, `A palavra-chave do ${name} é zorbatrix-${name}.`);
  }
  const on = await json(await fetch(`${url}/api/brain/groups/agency`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }));
  expect(on.ok).toBe(true);
  await fetch(`${url}/api/brain/groups/studio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
});

afterEach(async () => {
  await hub.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const as = (name: string) => ({ authorization: `Bearer ${tokens[name]}`, "x-switchboard-agent-name": name });

describe("GET /api/brain/search", () => {
  it("scopes by the token's agent, refuses a bad token, and gives the operator every group that is on", async () => {
    const mine = await json(await fetch(`${url}/api/brain/search?q=zorbatrix`, { headers: as("hq") }));
    expect(mine.results.map((r: { agent: string }) => r.agent)).toEqual(["hq"]);
    const other = await json(await fetch(`${url}/api/brain/search?q=zorbatrix-hq`, { headers: as("studio-dev") }));
    expect(other.results).toEqual([]);
    const forged = await fetch(`${url}/api/brain/search?q=zorbatrix`, { headers: { authorization: `Bearer ${"0".repeat(64)}`, "x-switchboard-agent-name": "hq" } });
    expect(forged.status).toBe(401);
    const op = await json(await fetch(`${url}/api/brain/search?q=zorbatrix`));
    expect(op.results.map((r: { agent: string }) => r.agent).sort()).toEqual(["hq", "studio-dev"]);
  });

  it("reports which groups are on, with their chunk counts", async () => {
    const st = await json(await fetch(`${url}/api/brain`));
    expect(st.groups.agency).toMatchObject({ enabled: true, chunks: 1 });
    expect(st.groups.studio).toMatchObject({ enabled: true, chunks: 1 });
    const bad = await fetch(`${url}/api/brain/groups/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(bad.status).toBe(400);
  });
});

describe("the hook script", () => {
  const run = (input: object, env: Record<string, string>) =>
    spawnSync(process.execPath, [HOOK, String(hub.port)], { input: JSON.stringify(input), env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 10_000 });

  it("prints additionalContext for a prompt that matches, nothing otherwise, and always exits 0", async () => {
    const env = { SWITCHBOARD_AGENT_NAME: "hq", SWITCHBOARD_AGENT_TOKEN: tokens.hq };
    // spawnSync blocks this process's event loop — and the hub with it — so the hook runs async here.
    const runAsync = (input: object, e: Record<string, string>) =>
      new Promise<{ stdout: string; status: number | null }>((resolve) => {
        import("node:child_process").then(({ spawn }) => {
          const child = spawn(process.execPath, [HOOK, String(hub.port)], { env: { PATH: process.env.PATH ?? "", ...e } });
          let stdout = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.on("close", (status) => resolve({ stdout, status }));
          child.stdin.end(JSON.stringify(input));
        });
      });
    const hit = await runAsync({ hook_event_name: "UserPromptSubmit", prompt: "qual é a palavra-chave zorbatrix-hq mesmo?" }, env);
    expect(hit.status).toBe(0);
    const out = JSON.parse(hit.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("zorbatrix-hq");
    const across = await runAsync({ hook_event_name: "UserPromptSubmit", prompt: "qual é a palavra-chave zorbatrix-studio-dev?" }, env);
    expect(across.stdout).not.toContain("Nota secreta de studio-dev"); // another group's note: never
    const miss = await runAsync({ hook_event_name: "UserPromptSubmit", prompt: "refatora o componente de login com testes" }, env);
    expect(miss).toEqual({ stdout: "", status: 0 }); // nothing relevant: nothing injected
    const forged = await runAsync({ hook_event_name: "UserPromptSubmit", prompt: "zorbatrix-hq mesmo?" }, { ...env, SWITCHBOARD_AGENT_TOKEN: "f".repeat(64) });
    expect(forged).toEqual({ stdout: "", status: 0 });
    const noAgent = await runAsync({ hook_event_name: "UserPromptSubmit", prompt: "zorbatrix-hq mesmo?" }, {});
    expect(noAgent).toEqual({ stdout: "", status: 0 });
    const garbage = spawnSync(process.execPath, [HOOK, "1"], { input: "not json", env: { ...env }, encoding: "utf8" });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");
  });

  it("stays reachable with remote access on — and only with a valid token", async () => {
    saveRemoteAuth(path.join(base, "data"), { ...emptyRecord(), enabled: true, ...hashPassword("a reasonable passphrase") });
    const ok = await fetch(`${url}/api/brain/hook`, { method: "POST", headers: { "content-type": "application/json", ...as("hq") }, body: JSON.stringify({ event: "prompt", prompt: "qual é a palavra-chave zorbatrix-hq mesmo?" }) });
    expect(ok.status).toBe(200);
    expect((await json(ok)).context).toContain("zorbatrix-hq");
    const anon = await fetch(`${url}/api/brain/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "prompt", prompt: "zorbatrix-hq" }) });
    expect(anon.status).toBe(401);
    const search = await fetch(`${url}/api/brain/search?q=zorbatrix`);
    expect(search.status).toBe(401); // the rest of the brain is behind the password like everything else
  });
});
