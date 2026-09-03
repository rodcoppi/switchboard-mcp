// Remote access: the lock that lets the dashboard sit behind a tunnel.
//
// The hub binds to 127.0.0.1 and always will, so reaching it from a phone
// means some tunnel process forwarding back into loopback — which makes every
// remote request indistinguishable from a local one. That single fact drives
// almost every assertion here: there is no "it came from localhost" exemption
// to be found, so the gate has to challenge everything, and the tests have to
// prove it does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  emptyRecord,
  hashPassword,
  loadRemoteAuth,
  parseCookies,
  passwordProblem,
  saveRemoteAuth,
  sessionCookie,
  verifyPassword,
} from "../src/server/remote-auth.js";
import { loginPage, safeNext } from "../src/server/login-page.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-remote-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the password itself", () => {
  it("accepts the right password and refuses a near miss", () => {
    const rec = { ...emptyRecord(), ...hashPassword("correct horse battery") };
    expect(verifyPassword("correct horse battery", rec)).toBe(true);
    expect(verifyPassword("correct horse batterY", rec)).toBe(false);
    expect(verifyPassword("", rec)).toBe(false);
  });

  it("refuses EVERYTHING when no password is set", () => {
    // The dangerous reading of "no password configured" is "no password
    // required". An unconfigured record must be a closed door, not an open one.
    const rec = emptyRecord();
    expect(rec.hash).toBe("");
    expect(verifyPassword("", rec)).toBe(false);
    expect(verifyPassword("anything at all", rec)).toBe(false);
  });

  it("salts, so the same password hashes differently for two people", () => {
    const a = hashPassword("the same password");
    const b = hashPassword("the same password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("holds a floor on what it will accept, at the point it is set", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("  padded password  ")).toMatch(/whitespace/);
    expect(passwordProblem("aaaaaaaaaaaaaaa")).toMatch(/distinct/);
    expect(passwordProblem("a reasonable passphrase")).toBeNull();
  });
});

describe("the record on disk", () => {
  it("reads as OFF when there is no file — the ordinary local hub", () => {
    expect(loadRemoteAuth(dir).enabled).toBe(false);
  });

  it("fails CLOSED when the file exists but cannot be understood", () => {
    // The dangerous reading of a corrupt byte is "remote access is off", which
    // would silently REMOVE the lock — and the worst possible moment for that
    // is while a tunnel is pointed at the machine. Armed and openable by
    // nobody is the safe answer; the CLI writes this file directly, so
    // `switchboard remote off` still recovers it from the host.
    for (const junk of ["{not json", "null", "[]", ""]) {
      fs.writeFileSync(path.join(dir, "remote.json"), junk);
      const rec = loadRemoteAuth(dir);
      expect(rec.enabled, `"${junk}" must not disarm the gate`).toBe(true);
      expect(rec.hash).toBe("");
      // …and no password opens it, including the empty one.
      expect(verifyPassword("", rec)).toBe(false);
      expect(verifyPassword("a reasonable passphrase", rec)).toBe(false);
    }
  });

  it("never hands out a guessable local token when sealed", () => {
    fs.writeFileSync(path.join(dir, "remote.json"), "{corrupt");
    const a = loadRemoteAuth(dir).localToken;
    const b = loadRemoteAuth(dir).localToken;
    // Two reads of a sealed record must not agree on a token, or the "local
    // CLI" path would become a way in.
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(64);
  });

  it("does not throw on any of it — the hub has to boot", () => {
    fs.writeFileSync(path.join(dir, "remote.json"), "{not json");
    expect(() => loadRemoteAuth(dir)).not.toThrow();
  });

  it("is created 0600, never briefly world-readable", () => {
    saveRemoteAuth(dir, { ...emptyRecord(), ...hashPassword("a reasonable passphrase") });
    const mode = fs.statSync(path.join(dir, "remote.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips, and gives every agent a distinct local token", () => {
    const rec = { ...emptyRecord(), enabled: true, ...hashPassword("a reasonable passphrase") };
    saveRemoteAuth(dir, rec);
    const back = loadRemoteAuth(dir);
    expect(back.enabled).toBe(true);
    expect(verifyPassword("a reasonable passphrase", back)).toBe(true);
    expect(emptyRecord().localToken).not.toBe(emptyRecord().localToken);
  });
});

describe("sessions", () => {
  it("expire on their own clock", () => {
    let now = 1_000_000;
    const store = new SessionStore(() => now);
    const { token } = store.create(1);
    expect(store.verify(token)).toBe(true);
    now += 3600_000 - 1;
    expect(store.verify(token)).toBe(true);
    now += 2;
    expect(store.verify(token)).toBe(false);
    // …and the expired entry is dropped rather than kept forever.
    expect(store.size).toBe(0);
  });

  it("refuses tokens it never issued", () => {
    const store = new SessionStore();
    expect(store.verify("deadbeef")).toBe(false);
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify("")).toBe(false);
  });

  it("can drop one session or all of them", () => {
    const store = new SessionStore();
    const a = store.create(1).token;
    const b = store.create(1).token;
    store.destroy(a);
    expect(store.verify(a)).toBe(false);
    expect(store.verify(b)).toBe(true);
    store.destroyAll();
    expect(store.verify(b)).toBe(false);
  });
});

describe("the login throttle", () => {
  it("locks out after a burst of failures and stays locked", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    expect(throttle.retryAfterMs()).toBe(0);
    for (let i = 0; i < 5; i++) throttle.recordFailure();
    const wait = throttle.retryAfterMs();
    // The lockout, not the sliding window: minutes, not a second.
    expect(wait).toBeGreaterThan(60_000);
    now += 14 * 60_000;
    expect(throttle.retryAfterMs()).toBeGreaterThan(0);
    now += 2 * 60_000;
    expect(throttle.retryAfterMs()).toBe(0);
  });

  it("forgives once a login succeeds", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    throttle.recordFailure();
    throttle.recordFailure();
    throttle.recordSuccess();
    for (let i = 0; i < 4; i++) throttle.recordFailure();
    // Four failures after a reset must not be five.
    expect(throttle.retryAfterMs()).toBe(0);
  });
});

describe("the session cookie", () => {
  it("is HttpOnly and SameSite=Lax", () => {
    const c = sessionCookie("abc", 3600, false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
  });

  it("is Secure over https and NOT over plain http", () => {
    // A Secure cookie is silently discarded over http, which is exactly how a
    // login page ends up "doing nothing" for someone running the hub locally.
    expect(sessionCookie("abc", 3600, true)).toContain("Secure");
    expect(sessionCookie("abc", 3600, false)).not.toContain("Secure");
  });

  it("parses cookie headers, including the ones with junk in them", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("novalue; a=1")).toEqual({ a: "1" });
    expect(parseCookies("a=hello%20there")).toEqual({ a: "hello there" });
  });
});

describe("the login page cannot be turned against its visitor", () => {
  it("refuses to bounce anywhere but back into this hub", () => {
    // ?next= arrives from the URL. Each of these would make our own login page
    // the last hop before somebody else's.
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    // …and does not send you back to the login page you just left.
    expect(safeNext("/login?next=/x")).toBe("/");
    expect(safeNext("/agents/foo")).toBe("/agents/foo");
  });

  it("escapes the value it does accept", () => {
    const html = loginPage({ next: '/x"</script><img src=x onerror=alert(1)>' });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('"</script>');
  });

  it("carries its own styles and script, because assets would 401", () => {
    const html = loginPage();
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

describe("the gate, on a running hub", () => {
  let hub: Hub;

  async function boot(): Promise<void> {
    hub = await startHub({
      baseDir: dir,
      port: 0,
      quiet: true,
      onMessage: () => "queued_offline",
    });
  }

  function url(pathname: string): string {
    return `http://127.0.0.1:${hub.port}${pathname}`;
  }

  function arm(password: string): string {
    const rec = { ...emptyRecord(), enabled: true, ...hashPassword(password) };
    saveRemoteAuth(dir, rec);
    return rec.localToken;
  }

  afterEach(async () => {
    await hub?.close();
  });

  it("changes nothing at all while it is off", async () => {
    await boot();
    const res = await fetch(url("/api/agents"));
    expect(res.status).toBe(200);
  });

  it("challenges the API once armed", async () => {
    await boot();
    arm("a reasonable passphrase");
    const res = await fetch(url("/api/agents"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("serves the login page to a browser instead of a bare 401", async () => {
    await boot();
    arm("a reasonable passphrase");
    const res = await fetch(url("/"), { headers: { accept: "text/html" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("SWITCHBOARD");
  });

  it("lets the local CLI through on its file-mode token", async () => {
    await boot();
    const token = arm("a reasonable passphrase");
    const res = await fetch(url("/api/agents"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a token that is merely close", async () => {
    await boot();
    const token = arm("a reasonable passphrase");
    const wrong = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    const res = await fetch(url("/api/agents"), { headers: { authorization: `Bearer ${wrong}` } });
    expect(res.status).toBe(401);
  });

  it("trades the password for a cookie that then works", async () => {
    await boot();
    arm("a reasonable passphrase");
    const login = await fetch(url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a reasonable passphrase" }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE);
    expect(setCookie).toContain("HttpOnly");

    const token = /sb_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const res = await fetch(url("/api/agents"), {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("says the same thing for a wrong password as for any other failure", async () => {
    await boot();
    arm("a reasonable passphrase");
    const res = await fetch(url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not the passphrase" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    // No hint about length, no "user not found", nothing to work with.
    expect(body.error).toBe("Wrong password.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("throttles a guessing run", async () => {
    await boot();
    arm("a reasonable passphrase");
    let sawLimit = false;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(url("/api/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `guess-${i}` }),
      });
      if (res.status === 429) {
        sawLimit = true;
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("keeps /api/health open, because the CLI probes it to decide to boot", async () => {
    await boot();
    arm("a reasonable passphrase");
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
  });

  it("does not put itself in front of /mcp, which would deafen every agent", async () => {
    await boot();
    arm("a reasonable passphrase");
    // The MCP endpoint carries its own per-agent bearer token and is spoken by
    // local processes that have no cookie. Whatever it answers here, it must
    // not be the gate's 401 — that would cut off the agents on the machine the
    // moment remote access came on.
    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await res.text();
    expect(body).not.toContain("sign in at /login");
  });

  it("refuses a cross-site write even with a valid cookie", async () => {
    await boot();
    arm("a reasonable passphrase");
    const login = await fetch(url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a reasonable passphrase" }),
    });
    const token = /sb_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const res = await fetch(url("/api/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ from: "a", to: "b", body: "hi" }),
    });
    expect(res.status).toBe(403);
  });

  it("drops every open session when it is disarmed and armed again", async () => {
    await boot();
    arm("a reasonable passphrase");
    const login = await fetch(url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a reasonable passphrase" }),
    });
    const token = /sb_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect((await fetch(url("/api/agents"), { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).status).toBe(200);

    // Off, then on again — yesterday's cookie must not still open the door.
    saveRemoteAuth(dir, { ...loadRemoteAuth(dir), enabled: false });
    await fetch(url("/api/health"));
    saveRemoteAuth(dir, { ...loadRemoteAuth(dir), enabled: true });

    const res = await fetch(url("/api/agents"), { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
  });
});
