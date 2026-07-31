import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";

describe("GET /api/agents/:name/files/resolve", () => {
  let base: string;
  let project: string;
  let hub: Hub;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-filemention-"));
    project = path.join(base, "project");
    fs.mkdirSync(path.join(project, "docs", "handoff"), { recursive: true });
    fs.writeFileSync(path.join(project, "docs", "handoff", "VacaGorda-IMPLEMENTACAO-FASE3.md"), "phase 3\n");
    hub = await startHub({
      baseDir: path.join(base, "data"),
      port: 0,
      quiet: true,
      onMessage: () => "queued_offline",
    });
    const registered = await fetch(`${hub.url}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "vaca-gorda-front",
        role: "frontend",
        cwd: project,
        tmuxSession: "sb-vaca-gorda-front",
      }),
    });
    expect(registered.status).toBe(201);
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolves one exact bare filename beneath the agent cwd", async () => {
    const res = await fetch(
      `${hub.url}/api/agents/vaca-gorda-front/files/resolve?file=${encodeURIComponent("VacaGorda-IMPLEMENTACAO-FASE3.md")}`,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      path: path.join(project, "docs", "handoff", "VacaGorda-IMPLEMENTACAO-FASE3.md"),
    });
  });

  it("rejects paths and returns 404 for an unresolved filename", async () => {
    let res = await fetch(
      `${hub.url}/api/agents/vaca-gorda-front/files/resolve?file=${encodeURIComponent("../secret.md")}`,
    );
    expect(res.status).toBe(400);

    res = await fetch(`${hub.url}/api/agents/vaca-gorda-front/files/resolve?file=missing.md`);
    expect(res.status).toBe(404);
  });
});
