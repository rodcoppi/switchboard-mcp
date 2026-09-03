// Remote access: the lock, not the door.
//
// The hub binds to 127.0.0.1 and that is never going to change (D6): a
// delivered message becomes executable input for an agent with filesystem
// access, so a hub listening on a LAN interface is remote code execution for
// free. Reaching the dashboard from a phone therefore means a TUNNEL — some
// process that holds an outbound connection and forwards back to loopback
// (cloudflared, ngrok, tailscale serve, an SSH -R, whatever the operator
// prefers). Switchboard does not pick one for you.
//
// What Switchboard owns is the lock BEHIND that door. Every tunnel worth using
// terminates on 127.0.0.1, which means the hub cannot tell a request that came
// from the phone apart from one that came from the machine itself — so when
// remote access is on, EVERYTHING is challenged and there is no "but it came
// from localhost" exemption to get wrong. The CLI carries a token read from a
// 0600 file; the browser carries a session cookie earned with the password.
//
// Threat model, stated plainly so the choices below can be judged: the
// attacker knows the tunnel URL (it is public, or it leaked) and can send
// unlimited requests. They do not have a shell on the machine, so they cannot
// read ~/.switchboard. Everything here is aimed at that attacker.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where the secret lives, next to the rest of the hub's state. */
export function remoteAuthFile(baseDir: string): string {
  return path.join(baseDir, "remote.json");
}

/** scrypt parameters. N=2^15 puts a single guess at ~100ms on this class of
 *  machine, which is invisible to the operator typing a password once and
 *  brutal for anyone working through a wordlist. */
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** Sessions live in memory ONLY: restarting the hub logs every browser out,
 *  which is the behaviour you want from a thing you turn on for an afternoon. */
const SESSION_BYTES = 32;

export interface RemoteAuthRecord {
  /** Whether the gate is armed. Persisted so a hub restart mid-trip does not
   *  silently drop the lock while the tunnel is still up. */
  enabled: boolean;
  /** scrypt hash of the password, hex. Empty when no password is set yet. */
  hash: string;
  salt: string;
  /** Bearer token for the LOCAL cli, which cannot be asked to type a password
   *  in the middle of a script. Its security is the file mode: an attacker who
   *  can read this file already has the machine. */
  localToken: string;
  /** How long a browser session survives, in hours. */
  sessionHours: number;
  createdAt: string;
  updatedAt: string;
}

export function emptyRecord(): RemoteAuthRecord {
  const now = new Date().toISOString();
  return {
    enabled: false,
    hash: "",
    salt: "",
    localToken: crypto.randomBytes(24).toString("hex"),
    sessionHours: 12,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A record that refuses everyone, used when the file exists but cannot be
 * understood. Armed (so the gate keeps challenging) with no password and no
 * usable token (so nothing opens it).
 */
function sealedRecord(): RemoteAuthRecord {
  const now = new Date().toISOString();
  return {
    enabled: true,
    hash: "",
    salt: "",
    // Not a token anyone can present: 64 random bytes that are never written
    // down, so the local-token path cannot match either.
    localToken: crypto.randomBytes(64).toString("hex"),
    sessionHours: 12,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Reads the record.
 *
 * The two failure modes look similar and mean opposite things, so they are
 * handled separately:
 *
 *  - **No file at all** — remote access was never set up. Off. This is the
 *    normal case for every local hub and must stay silent and free.
 *  - **A file that exists but cannot be read or parsed** — something is wrong
 *    with state that was deliberately created. Treating that as "off" would
 *    mean a corrupt byte silently REMOVES the lock, and the worst moment for
 *    that is precisely when a tunnel is pointed at the machine. So it fails
 *    CLOSED: armed, and openable by nobody.
 *
 * A sealed hub is recoverable from the machine itself, where the CLI writes
 * this file directly rather than going through the gate: `switchboard remote
 * off` or `switchboard remote password` both replace it.
 */
export function loadRemoteAuth(baseDir: string): RemoteAuthRecord {
  const file = remoteAuthFile(baseDir);
  if (!fs.existsSync(file)) return emptyRecord();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return sealedRecord();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sealedRecord();
  }
  // Array.isArray matters: `[]` is typeof "object" and not null, so a JSON
  // array would otherwise slide past this check and be read as a record of
  // all-defaults — which means DISARMED. It is corrupt; seal it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return sealedRecord();
  }
  const base = emptyRecord();
  const rec = parsed as Partial<RemoteAuthRecord>;
  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : base.enabled,
    hash: typeof rec.hash === "string" ? rec.hash : base.hash,
    salt: typeof rec.salt === "string" ? rec.salt : base.salt,
    localToken:
      typeof rec.localToken === "string" && rec.localToken.length >= 16
        ? rec.localToken
        : base.localToken,
    sessionHours:
      typeof rec.sessionHours === "number" && rec.sessionHours > 0 && rec.sessionHours <= 720
        ? rec.sessionHours
        : base.sessionHours,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : base.createdAt,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : base.updatedAt,
  };
}

/**
 * Writes the record with mode 0600, and — this is the part that matters —
 * creates it 0600 from the start rather than writing then chmod'ing, so the
 * password hash is never briefly world-readable. Written to a temp file and
 * renamed, like the agents snapshot.
 */
export function saveRemoteAuth(baseDir: string, record: RemoteAuthRecord): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = remoteAuthFile(baseDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2) + "\n";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Hashes a password with a fresh salt. */
export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const useSalt = salt ?? crypto.randomBytes(SALT_BYTES).toString("hex");
  const derived = crypto.scryptSync(password.normalize("NFKC"), useSalt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    // scrypt needs memory proportional to N*r*128; node's default cap (32 MB)
    // is below what N=32768 asks for and it would throw instead of hashing.
    maxmem: 256 * 1024 * 1024,
  });
  return { hash: derived.toString("hex"), salt: useSalt };
}

/**
 * Constant-time verification. Returns false for an unset password instead of
 * accepting anything — "no password configured" must never mean "open".
 */
export function verifyPassword(password: string, record: RemoteAuthRecord): boolean {
  if (!record.hash || !record.salt) return false;
  const { hash } = hashPassword(password, record.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(record.hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * A password this thing will accept. The gate stands in front of remote code
 * execution, so the floor is higher than a login form's would be — and it is
 * enforced where the password is SET, not merely suggested in the docs.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) {
    return "Password must be at least 12 characters — this gate stands in front of an agent that can run commands.";
  }
  if (/^\s|\s$/.test(password)) {
    return "Password must not start or end with whitespace (it is almost always an accident, and impossible to see later).";
  }
  if (new Set(password).size < 5) {
    return "Password must use at least 5 distinct characters.";
  }
  return null;
}

/** An in-memory session table. Nothing here survives a restart, by design. */
export class SessionStore {
  private readonly sessions = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  create(ttlHours: number): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(SESSION_BYTES).toString("hex");
    const expiresAt = this.now() + ttlHours * 3600_000;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** True iff the token is known and unexpired. Expired entries are dropped. */
  verify(token: string | undefined): boolean {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Used when the password changes: every existing session must die. */
  destroyAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Login throttle.
 *
 * Deliberately GLOBAL rather than per-IP: every request arrives through the
 * tunnel and therefore from 127.0.0.1, so per-IP buckets would all be the same
 * bucket wearing a disguise — and trusting X-Forwarded-For to separate them
 * would hand the attacker the key to their own rate limit.
 *
 * The cost of that choice is honest: an attacker can lock the owner out by
 * failing on purpose. That is the right trade for a gate in front of command
 * execution — a locked-out owner has the machine itself and can turn remote
 * access off; an unthrottled attacker has a password oracle.
 */
export class LoginThrottle {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
    private readonly maxInWindow = 5,
    private readonly lockoutMs = 15 * 60_000,
  ) {}

  /** Milliseconds the caller must wait, or 0 when a try is allowed now. */
  retryAfterMs(): number {
    const t = this.now();
    if (this.lockedUntil > t) return this.lockedUntil - t;
    this.failures = this.failures.filter((at) => at > t - this.windowMs);
    if (this.failures.length >= this.maxInWindow) {
      return this.windowMs - (t - this.failures[0]);
    }
    return 0;
  }

  recordFailure(): void {
    const t = this.now();
    this.failures = this.failures.filter((at) => at > t - this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.maxInWindow) {
      this.lockedUntil = t + this.lockoutMs;
      this.failures = [];
    }
  }

  recordSuccess(): void {
    this.failures = [];
    this.lockedUntil = 0;
  }
}

/** Parses a Cookie header into a map. No dependency, no surprises. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export const SESSION_COOKIE = "sb_session";

/**
 * Serialises the session cookie.
 *
 * `secure` is decided by the caller from the forwarded protocol rather than
 * hard-coded: a Secure cookie is silently dropped over plain http, which is
 * how you get a login page that "does nothing" when someone runs the hub
 * without TLS on their own machine.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: Strict withholds the cookie on the first navigation
    // INTO the dashboard from an external link, which reads as "logged out"
    // every time you open it from a message. Lax still withholds it from
    // cross-site POSTs, which is the CSRF case that matters.
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}
