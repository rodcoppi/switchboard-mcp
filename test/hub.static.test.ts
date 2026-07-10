// Phase 6: the hub serves the static dashboard (public/index.html) at "/"
// alongside /api and /mcp on the same process/port (PRD sections 6, 10, 13).
// These tests confirm the wiring is live — GET / returns the dashboard HTML
// with the STABLE semantic classes that are the redesign contract, and
// /api/health keeps answering next to it. No browser is opened here (the
// orchestrator does that); this only asserts the serving surface.
//
// The hub is started with a deterministic onMessage stub so NO dispatcher and
// NO tmux are ever created (this suite is about static serving, not delivery).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";

let dir: string;
let hub: Hub;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-static-"));
  hub = await startHub({
    baseDir: dir,
    port: 0,
    quiet: true,
    // No tmux: replaces the dispatcher entirely (PRD hub.ts extension point).
    onMessage: () => "queued_offline",
  });
});

afterEach(async () => {
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function url(pathname: string): string {
  return `http://127.0.0.1:${hub.port}${pathname}`;
}

describe("Phase 6 — static dashboard serving", () => {
  it("GET / serves the dashboard HTML with the stable semantic classes", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);

    const html = await res.text();
    expect(html).toContain("<title>Switchboard</title>");
    // Semantic classes that are the contract for the owner's later redesign
    // (PRD section 13): they MUST stay present in the served markup.
    for (const cls of [
      "agent-card",
      "msg-row",
      "msg-from",
      "msg-to",
      "msg-body",
      "status-dot",
      "unread-badge",
      "launcher",
      "launch-btn",
    ]) {
      expect(html, `missing semantic class .${cls}`).toContain(cls);
    }
    // The dashboard consumes the live SSE stream and the REST surface.
    expect(html).toContain("/api/events");
    expect(html).toContain("/api/agents");
    expect(html).toContain("/api/messages");
    // The "Launch agent" form posts to the server-side launcher.
    expect(html).toContain("/api/agents/launch");
  });

  it("GET /index.html serves the same dashboard file", async () => {
    const res = await fetch(url("/index.html"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Switchboard</title>");
  });

  it("GET /api/health stays OK next to the static dashboard", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; uptime: number; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("POST /api/agents/launch answers 501 when the hub was started without the launcher", async () => {
    // This hub runs with a custom onMessage stub — no dispatcher, no tmux and
    // therefore NO launcher: the endpoint must answer 501 in-protocol (same
    // contract as the manual-nudge placeholder), never touch tmux.
    const res = await fetch(url("/api/agents/launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "/tmp" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/launcher unavailable/i);
  });

  it("does NOT leak a capability token in the /api/agents listing the dashboard reads", async () => {
    // Register an agent (which mints a token) then confirm the shape the
    // dashboard bootstraps from never carries it (v1.1 addendum, PRD 15).
    await fetch(url("/api/agents/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alpha", role: "backend" }),
    });
    const res = await fetch(url("/api/agents"));
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty("token");
  });
});
