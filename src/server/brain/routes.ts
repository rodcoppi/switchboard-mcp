// The group brain over HTTP: the dashboard's switches and the agents' hook.
//
//   GET  /api/brain                 status + which groups are on (dashboard)
//   POST /api/brain/groups/:group   { enabled?, sources? }  (dashboard)
//   POST /api/brain/reindex         read everything again   (dashboard)
//   GET  /api/brain/search?q=       a search: an agent's scope with its token, the operator's without
//   POST /api/brain/hook            { event: "prompt", prompt } | { event: "session" } → { context }
//
// The hook route carries its OWN credential — the agent's name and token, the
// same pair its MCP connection sends — so it stays reachable when remote
// access is on (remote-gate.ts exempts it, like /mcp): the hook is a local
// process that has no browser cookie. Its scope is the token's agent, never
// a parameter.

import express from "express";
import type { Store } from "../store.js";
import { tokenMatches } from "../mcp.js";
import type { Brain } from "./brain.js";
import { BRAIN_SOURCES, type BrainSource } from "./index.js";

/** The agent a request proves to be (name header + its bearer token), or null. */
function agentOf(req: express.Request, store: Store): string | null {
  const auth = req.headers.authorization;
  const rawName = req.headers["x-switchboard-agent-name"];
  if (typeof auth !== "string" || typeof rawName !== "string") return null;
  const name = rawName.trim();
  const agent = store.getAgent(name);
  if (!agent?.token || !tokenMatches(agent.token, auth.replace(/^Bearer\s+/i, ""))) return null;
  return name;
}

function sourcesOf(raw: unknown): BrainSource[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const list = raw.split(",").map((s) => s.trim()) as BrainSource[];
  return list.filter((s) => BRAIN_SOURCES.includes(s));
}

export function createBrainRouter(brain: Brain, store: Store): express.Router {
  const router = express.Router();

  router.get("/api/brain", (_req, res) => {
    res.json({ ok: true, ...brain.status() });
  });

  router.post("/api/brain/groups/:group", async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown; sources?: unknown };
    const patch: { enabled?: boolean; sources?: Partial<Record<BrainSource, boolean>> } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.sources && typeof body.sources === "object") {
      patch.sources = {};
      for (const s of BRAIN_SOURCES) {
        const v = (body.sources as Record<string, unknown>)[s];
        if (typeof v === "boolean") patch.sources[s] = v;
      }
    }
    try {
      // Answers once the group's first read is done (a few seconds to a
      // minute on a big group); the dashboard shows it as "reading…".
      const group = await brain.setGroup(req.params.group, patch);
      res.json({ ok: true, group, status: brain.status() });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/brain/reindex", async (_req, res) => {
    await brain.reindex();
    res.json({ ok: true, status: brain.status() });
  });

  router.get("/api/brain/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q.trim()) {
      res.status(400).json({ ok: false, error: "q is required." });
      return;
    }
    // With an agent's credentials, that agent's scope; a request that names
    // an agent but cannot prove it is refused, never widened to the operator's.
    let caller = "operator";
    if (req.headers["x-switchboard-agent-name"] !== undefined || req.headers.authorization !== undefined) {
      const agent = agentOf(req, store);
      if (!agent) {
        res.status(401).json({ ok: false, error: "Agent name or token not recognised." });
        return;
      }
      caller = agent;
    }
    const limit = Number(req.query.limit);
    const out = brain.search(caller, q, {
      limit: Number.isFinite(limit) ? limit : undefined,
      sources: sourcesOf(req.query.sources),
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      agent: typeof req.query.agent === "string" && req.query.agent ? req.query.agent : undefined,
    });
    res.json({ ok: true, groups: out.scope, results: out.results, stale: out.stale });
  });

  router.post("/api/brain/hook", (req, res) => {
    const agent = agentOf(req, store);
    if (!agent) {
      res.status(401).json({ ok: false, error: "Agent name or token not recognised." });
      return;
    }
    const body = (req.body ?? {}) as { event?: unknown; prompt?: unknown };
    const context =
      body.event === "session"
        ? brain.briefing(agent)
        : body.event === "prompt" && typeof body.prompt === "string"
          ? brain.promptContext(agent, body.prompt)
          : "";
    res.json({ ok: true, context });
  });

  return router;
}
