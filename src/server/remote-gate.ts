// The gate that sits in front of everything when remote access is on.
//
// Mounted FIRST in the hub's middleware chain, before the MCP router, the API
// and the static dashboard, so there is exactly one place to read to know what
// is reachable without a password. When remote access is off it calls next()
// immediately and the hub behaves exactly as it always has — a local tool with
// no login, which is what it is for the overwhelming majority of runs.

import crypto from "node:crypto";
import express from "express";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  clearedSessionCookie,
  loadRemoteAuth,
  parseCookies,
  passwordProblem,
  saveRemoteAuth,
  sessionCookie,
  verifyPassword,
  type RemoteAuthRecord,
} from "./remote-auth.js";
import { loginPage } from "./login-page.js";

export interface RemoteGateOptions {
  baseDir: string;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Paths that stay reachable without a session while the gate is armed.
 *
 * `/mcp` is here because it carries its OWN credential — the per-agent bearer
 * token in the Authorization header — and because the agents talking through
 * it are local processes that cannot be handed a browser cookie. Putting the
 * session check in front of it would break every agent on the machine the
 * moment the operator turned remote access on.
 */
function isExempt(pathname: string): boolean {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return true;
  if (pathname === "/login" || pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/status") return true;
  // The health probe answers a flat "is the hub up", with no data in it, and
  // the CLI leans on it to decide whether to auto-start the hub.
  if (pathname === "/api/health") return true;
  return false;
}

/** True when the request reached us over TLS (directly or through a tunnel). */
function isSecureRequest(req: express.Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return typeof first === "string" && first.split(",")[0].trim() === "https";
}

/**
 * Rejects a state-changing request whose Origin belongs to somebody else.
 *
 * SameSite=Lax already withholds the cookie from cross-site POSTs, so this is
 * the second lock on the same door — cheap, and it catches the browser that
 * gets SameSite wrong. Requests with no Origin at all (curl, the CLI) are
 * allowed through: they are not browsers and cannot be tricked by a page.
 */
function crossSiteWrite(req: express.Request): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;
  const host = req.headers.host;
  if (typeof host !== "string") return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export interface RemoteGate {
  /** Mounted before everything else in the hub. */
  middleware: express.RequestHandler;
  /** Login / logout / status, plus the login page itself. */
  router: express.Router;
  isEnabled(): boolean;
  /** Re-reads the record from disk — the CLI edits it in another process. */
  refresh(): void;
  record(): RemoteAuthRecord;
}

export function createRemoteGate(options: RemoteGateOptions): RemoteGate {
  const { baseDir, log } = options;
  const now = options.now ?? Date.now;
  const sessions = new SessionStore(now);
  const throttle = new LoginThrottle(now);

  let record = loadRemoteAuth(baseDir);
  let armedNotice = record.enabled;
  if (record.enabled) {
    log("warn", "[switchboard] remote access is ON — every request needs the password or the local token.");
  }

  /** The record can be rewritten by `switchboard remote …` in another
   *  process, so it is re-read whenever the answer would depend on it. */
  function current(): RemoteAuthRecord {
    const fresh = loadRemoteAuth(baseDir);
    if (fresh.enabled !== armedNotice) {
      armedNotice = fresh.enabled;
      log("info", `[switchboard] remote access ${fresh.enabled ? "ARMED" : "disarmed"}.`);
      // Arming or disarming invalidates every browser session: turning it off
      // and on again must not leave yesterday's cookie working.
      sessions.destroyAll();
    }
    record = fresh;
    return fresh;
  }

  /** A request is authenticated by a session cookie or by the local token. */
  function authenticated(req: express.Request, rec: RemoteAuthRecord): boolean {
    const cookies = parseCookies(req.headers.cookie);
    if (sessions.verify(cookies[SESSION_COOKIE])) return true;
    const auth = req.headers.authorization;
    if (typeof auth === "string" && /^Bearer\s+/i.test(auth) && rec.localToken) {
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      // Length check first so timingSafeEqual cannot throw on a short token.
      if (token.length === rec.localToken.length) {
        const a = Buffer.from(token);
        const b = Buffer.from(rec.localToken);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      }
    }
    return false;
  }

  const middleware: express.RequestHandler = (req, res, next) => {
    const rec = current();
    if (!rec.enabled) return next();

    if (crossSiteWrite(req)) {
      res.status(403).json({ ok: false, error: "Cross-site request refused." });
      return;
    }

    const pathname = req.path;
    if (isExempt(pathname)) return next();
    if (authenticated(req, rec)) return next();

    // A browser navigating to a page gets the login page; anything else gets a
    // machine-readable 401 rather than a screenful of HTML it cannot use.
    const accept = req.headers.accept ?? "";
    const wantsHtml = req.method === "GET" && accept.includes("text/html");
    if (wantsHtml) {
      res.status(401).type("html").send(loginPage({ next: req.originalUrl }));
      return;
    }
    res.status(401).json({ ok: false, error: "Remote access is on — sign in at /login." });
  };

  const router = express.Router();

  router.get("/login", (req, res) => {
    const rec = current();
    if (!rec.enabled) {
      res.redirect("/");
      return;
    }
    const nextUrl = typeof req.query.next === "string" ? req.query.next : "/";
    res.type("html").send(loginPage({ next: nextUrl }));
  });

  router.get("/api/auth/status", (req, res) => {
    const rec = current();
    res.json({
      ok: true,
      enabled: rec.enabled,
      hasPassword: Boolean(rec.hash),
      authenticated: rec.enabled ? authenticated(req, rec) : true,
    });
  });

  router.post("/api/auth/login", (req, res) => {
    const rec = current();
    if (!rec.enabled) {
      res.json({ ok: true, enabled: false });
      return;
    }
    if (!rec.hash) {
      res.status(503).json({
        ok: false,
        error: 'No password is set. Run "switchboard remote password" on the hub machine.',
      });
      return;
    }
    const wait = throttle.retryAfterMs();
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      res.status(429)
        .set("Retry-After", String(seconds))
        .json({ ok: false, error: `Too many attempts. Try again in ${seconds}s.` });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || !verifyPassword(password, rec)) {
      throttle.recordFailure();
      log("warn", "[switchboard] remote login FAILED.");
      // One message for both "no such password" and "wrong password": the
      // response must not become an oracle for anything.
      res.status(401).json({ ok: false, error: "Wrong password." });
      return;
    }
    throttle.recordSuccess();
    const { token } = sessions.create(rec.sessionHours);
    res.set(
      "Set-Cookie",
      sessionCookie(token, rec.sessionHours * 3600, isSecureRequest(req)),
    );
    log("info", "[switchboard] remote login succeeded.");
    res.json({ ok: true });
  });

  router.post("/api/auth/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    sessions.destroy(cookies[SESSION_COOKIE]);
    res.set("Set-Cookie", clearedSessionCookie(isSecureRequest(req)));
    res.json({ ok: true });
  });

  return {
    middleware,
    router,
    isEnabled: () => current().enabled,
    refresh: () => {
      current();
    },
    record: () => current(),
  };
}

/** Re-exported so the CLI can validate a password with the same rule. */
export { passwordProblem, saveRemoteAuth, loadRemoteAuth };
