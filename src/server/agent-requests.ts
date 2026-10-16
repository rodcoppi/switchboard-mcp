// Agents asking for new agents (owner, 08/10: "uma tool do MCP do switchboard
// de criar agente novo ... ele me pergunta onde, cria a pasta, prepara o PRD
// ... e já boota no switchboard esse agente, que pode ser um agente normal do
// zero ou um filho do próprio agente").
//
// The agent does the talking — it interviews the operator and drafts the PRD —
// and then files ONE request through the create_agent tool. Nothing is created
// by the request itself: it waits here until the operator approves it with
// one click in the dashboard (the owner's choice), because this is the first
// power on the network that lets an agent bring another agent — with full
// permissions — into the world, and an agent can be talked into things by
// what it reads. The tool answers at once (never block an agent's turn); the
// outcome reaches the asking agent as a [switchboard] message.
//
// Who may ask for what (also the owner's choice): any agent, inside its own
// walls — its own group, a client subgroup of it (or its agency, the groups it
// can already talk to), or a child of itself. The faz-tudo, which reaches
// everyone, may place an agent anywhere.
//
// Or a group of its OWN (owner, 16/10: an AI "CEO" that runs a microbusiness
// in a group apart, "AGENTIC BUSINESS", and makes its own teammates there):
// one request brings a new top-level group — name, display name, what it is
// for — with its first agent inside, and may ask for lines to groups the
// asker already reaches (allow_messages_with), so the new team can talk to
// it. Same one-click approval; nothing exists until then. Whatever group it
// lands in, a new agent never gets a folder that belongs to an agent of a
// group it does not share walls with.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import { AGENT_NAME_RE, DEFAULT_GROUP, GROUP_NAME_RE, RESERVED_AGENT_NAMES, groupsTouch, parentGroup, resolveGroup, type Store } from "./store.js";
import { resolveAgentType } from "../shared/agent-types.js";

/** What an agent sends with create_agent (snake_case, as models write it). */
export interface CreateAgentInput {
  name: string;
  display_name?: string;
  role?: string;
  as_child?: boolean;
  folder?: string;
  create_folder?: boolean;
  group?: string;
  prd: string;
  first_message?: string;
  /** A NEW top-level group for this agent (kebab-case). */
  new_group?: string;
  new_group_display_name?: string;
  new_group_description?: string;
  /** Groups the new group's agents may message (each one the asker already reaches). */
  allow_messages_with?: string[];
}

/** A request waiting for the operator. */
export interface AgentRequest {
  id: string;
  /** The agent that asked. */
  from: string;
  name: string;
  displayName?: string;
  role?: string;
  /** A child of `parent` (the asker, or the asker's own parent when it is a child). */
  asChild: boolean;
  parent?: string;
  /** Absolute folder it will work in — for a child, its parent's. */
  folder: string;
  /** The folder does not exist yet and is made on approval (one level). */
  createFolder: boolean;
  group: string;
  prd: string;
  firstMessage?: string;
  /** The group this request brings into being, with its lines to others. */
  newGroup?: { name: string; displayName?: string; description?: string; linkWith: string[] };
  createdAt: string;
}

export const MAX_PRD_BYTES = 64 * 1024;
/** Requests one agent may have waiting at once — a loop cannot flood the operator. */
export const MAX_PENDING_PER_AGENT = 3;

/** The tool description — written for the model that calls it. */
export const CREATE_AGENT_DESCRIPTION =
  "Create a NEW agent on this Switchboard — only when the operator asks you for one. " +
  "Before calling, talk it through with the operator, one question at a time: " +
  "(1) Is it a CHILD of you (a second session in YOUR folder with its own conversation, shown under you, killed when its job is done) or a new agent of its own? " +
  "(2) For a new agent: which folder (absolute path), should it be created if it does not exist, and which group will it be in (default: yours)? " +
  "(3) Its name (lowercase letters, digits and hyphens) and, if the operator wants, a display name. " +
  "(4) What it is for: draft its PRD in markdown with the operator — goal, scope, inputs, deliverables, constraints, which agents it works with — " +
  "and offer a few questions that would make the PRD richer; the operator may skip them. " +
  "Then call this tool ONCE with everything. It creates nothing by itself: the request goes to the operator, who approves it with one click " +
  "in the dashboard. You will receive a [switchboard] message with the outcome — do not call again for the same agent meanwhile. " +
  "You may create agents in your own group, in a client subgroup of it, or a child of yourself. " +
  "When the operator wants the agent in a NEW group of its own, pass new_group (lowercase-hyphen name, top level), " +
  "new_group_display_name and new_group_description, and — only if the operator wants the two teams to talk — " +
  "allow_messages_with: groups you already reach whose agents the new group may message. The group and the agent are made " +
  "together, on the same approval. An agent never gets a folder that belongs to another group's agent.";

const exists = (p: string): boolean => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** "~" expanded, normalized; null when it is not an absolute path. */
function absoluteFolder(raw: string, home: string): string | null {
  let p = raw.trim().replace(/^["']|["']$/g, "");
  if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
  p = path.normalize(p);
  return path.isAbsolute(p) ? p : null;
}

/**
 * Checks one create_agent call and turns it into a request — or an error
 * written for the model to read and correct (same contract as every tool).
 */
export function planAgentRequest(
  store: Store,
  pending: AgentRequests,
  from: string,
  input: CreateAgentInput,
  home: string = os.homedir(),
): { ok: true; request: Omit<AgentRequest, "id" | "createdAt"> } | { ok: false; error: string } {
  const caller = store.getAgent(from);
  if (!caller) return { ok: false, error: `Unknown agent "${from}". Call join first.` };

  if (pending.pendingFrom(from).length >= MAX_PENDING_PER_AGENT) {
    return {
      ok: false,
      error: `You already have ${MAX_PENDING_PER_AGENT} agent requests waiting for the operator. Wait for their outcome before asking again.`,
    };
  }

  const name = (input.name ?? "").trim();
  if (!AGENT_NAME_RE.test(name) || RESERVED_AGENT_NAMES.has(name)) {
    return {
      ok: false,
      error: `Invalid name "${name}": use 2 to 31 lowercase letters, digits and hyphens, starting with a letter or digit (e.g. "revisor-copy").`,
    };
  }
  if (store.getAgent(name)) return { ok: false, error: `"${name}" already exists on the board. Pick another name with the operator.` };
  if (pending.list().some((r) => r.name === name)) {
    return { ok: false, error: `A request for "${name}" is already waiting for the operator.` };
  }

  const prd = typeof input.prd === "string" ? input.prd.trim() : "";
  if (!prd) return { ok: false, error: "The PRD is empty. Draft it with the operator first — what the agent is for, its scope and deliverables." };
  if (Buffer.byteLength(prd, "utf8") > MAX_PRD_BYTES) {
    return { ok: false, error: `The PRD is over ${MAX_PRD_BYTES / 1024} KB. Tighten it — the agent can be pointed at longer documents in its folder.` };
  }
  const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 64) : "";
  const role = typeof input.role === "string" ? input.role.trim().slice(0, 200) : "";
  const firstMessage = typeof input.first_message === "string" ? input.first_message.trim() : "";
  if (Buffer.byteLength(firstMessage, "utf8") > 16 * 1024) {
    return { ok: false, error: "first_message is over 16 KB — put the long part in the PRD." };
  }
  const common = {
    from,
    name,
    ...(displayName && displayName !== name ? { displayName } : {}),
    ...(role ? { role } : {}),
    prd,
    ...(firstMessage ? { firstMessage } : {}),
  };

  if (input.as_child) {
    // One level: a child asking for a child gives its own parent a new one.
    const root = (caller.parent && store.getAgent(caller.parent)) || caller;
    if (resolveAgentType(root.agentType) !== "claude") {
      return { ok: false, error: "Children are Claude sessions, and you run on another engine. Ask for a new agent of its own instead." };
    }
    return {
      ok: true,
      request: { ...common, asChild: true, parent: root.name, folder: root.cwd, createFolder: false, group: resolveGroup(root.group) },
    };
  }

  const folder = typeof input.folder === "string" ? absoluteFolder(input.folder, home) : null;
  if (!folder) {
    return { ok: false, error: "folder must be an absolute path (\"~/...\" is fine). Ask the operator where the agent should work." };
  }
  let createFolder = false;
  if (exists(folder)) {
    if (!isDir(folder)) return { ok: false, error: `${folder} is a file, not a folder.` };
  } else {
    if (!input.create_folder) {
      return {
        ok: false,
        error: `${folder} does not exist. Ask the operator whether to create it, then call again with create_folder: true.`,
      };
    }
    if (!isDir(path.dirname(folder))) {
      return {
        ok: false,
        error: `Cannot create ${folder}: the folder it goes in (${path.dirname(folder)}) does not exist. Only the last folder is created.`,
      };
    }
    createFolder = true;
  }

  const mine = resolveGroup(caller.group);
  if (typeof input.new_group === "string" && input.new_group.trim()) {
    const plan = planNewGroup(store, pending, caller.everywhere === true, mine, input);
    if (!plan.ok) return plan;
    const clash = folderOfAnotherGroup(store, folder, plan.newGroup.name);
    if (clash) return { ok: false, error: clash };
    return { ok: true, request: { ...common, asChild: false, folder, createFolder, group: plan.newGroup.name, newGroup: plan.newGroup } };
  }
  const rawGroup = typeof input.group === "string" && input.group.trim() ? input.group.trim() : mine;
  if (rawGroup !== DEFAULT_GROUP && !GROUP_NAME_RE.test(rawGroup)) {
    return { ok: false, error: `Invalid group "${rawGroup}": lowercase letters, digits and hyphens, with at most one "/" for a client ("agency/client").` };
  }
  if (!caller.everywhere && !groupsTouch(mine, rawGroup)) {
    return {
      ok: false,
      error: `You can only create agents in your own group (${mine}), a client subgroup of it, or as your child — "${rawGroup}" is outside your walls. Ask the operator to create it from the dashboard.`,
    };
  }
  const clash = folderOfAnotherGroup(store, folder, rawGroup);
  if (clash) return { ok: false, error: clash };
  return { ok: true, request: { ...common, asChild: false, folder, createFolder, group: rawGroup } };
}

/** The new group a request asks for, checked — or an error the model can act on. */
function planNewGroup(
  store: Store,
  pending: AgentRequests,
  everywhere: boolean,
  mine: string,
  input: CreateAgentInput,
): { ok: true; newGroup: NonNullable<AgentRequest["newGroup"]> } | { ok: false; error: string } {
  const name = (input.new_group ?? "").trim();
  if (name === DEFAULT_GROUP || !GROUP_NAME_RE.test(name) || name.includes("/")) {
    return {
      ok: false,
      error: `Invalid new_group "${name}": a top-level group name — 2 to 31 lowercase letters, digits and hyphens, no "/" (e.g. "agentic-business").`,
    };
  }
  if (store.listGroups().includes(name)) {
    return { ok: false, error: `Group "${name}" already exists. Use group: "${name}" if you may create agents there, or pick another new_group name with the operator.` };
  }
  if (pending.list().some((r) => r.newGroup?.name === name)) {
    return { ok: false, error: `A request for a new group "${name}" is already waiting for the operator.` };
  }
  if (typeof input.group === "string" && input.group.trim() && input.group.trim() !== name) {
    return { ok: false, error: `group ("${input.group.trim()}") and new_group ("${name}") disagree. For an agent in a new group, pass new_group only.` };
  }
  const raw = Array.isArray(input.allow_messages_with) ? input.allow_messages_with : [];
  const linkWith: string[] = [];
  for (const g of raw) {
    if (typeof g !== "string" || !g.trim()) continue;
    const other = g.trim();
    if (!store.listGroups().includes(other) || other === DEFAULT_GROUP) {
      return { ok: false, error: `allow_messages_with: there is no group "${other}". Existing groups: ${store.listGroups().filter((x) => x !== DEFAULT_GROUP).join(", ") || "(none)"}.` };
    }
    if (!everywhere && !groupsTouch(mine, other)) {
      return {
        ok: false,
        error: `allow_messages_with: "${other}" is outside your walls — you may only open a line to a group you already reach (${mine}${parentGroup(mine) ? `, ${parentGroup(mine)}` : ""}). The operator can link other groups in the dashboard.`,
      };
    }
    if (!linkWith.includes(other)) linkWith.push(other);
  }
  const displayName = typeof input.new_group_display_name === "string" ? input.new_group_display_name.trim().slice(0, 48) : "";
  const description = typeof input.new_group_description === "string" ? input.new_group_description.trim().slice(0, 300) : "";
  return {
    ok: true,
    newGroup: { name, ...(displayName ? { displayName } : {}), ...(description ? { description } : {}), linkWith },
  };
}

/**
 * A folder already belonging to an agent of a group the new agent does not
 * share walls with — the same folder, inside it, or around it — is refused:
 * the owner's rule is "nem agente de um grupo mexendo na pasta de outro".
 * A line between groups lets them TALK; it never lends a folder.
 */
export function folderOfAnotherGroup(store: Store, folder: string, group: string): string | null {
  const within = (outer: string, inner: string) => {
    const rel = path.relative(outer, inner);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  for (const a of store.listAgents()) {
    if (!a.cwd || groupsTouch(group, resolveGroup(a.group))) continue;
    const cwd = path.normalize(a.cwd);
    if (within(cwd, folder) || within(folder, cwd)) {
      return (
        `${folder} belongs to "${a.name}" (group ${resolveGroup(a.group)}, working in ${cwd}) — an agent never gets ` +
        `a folder of another group's agent. Ask the operator for a folder of its own.`
      );
    }
  }
  return null;
}

/** The requests waiting for the operator (in memory: a restart drops them, and the agent can ask again). */
export class AgentRequests {
  private readonly items = new Map<string, AgentRequest>();

  add(request: Omit<AgentRequest, "id" | "createdAt">): AgentRequest {
    const full: AgentRequest = { ...request, id: ulid(), createdAt: new Date().toISOString() };
    this.items.set(full.id, full);
    return full;
  }
  get(id: string): AgentRequest | undefined {
    return this.items.get(id);
  }
  remove(id: string): boolean {
    return this.items.delete(id);
  }
  list(): AgentRequest[] {
    return [...this.items.values()];
  }
  pendingFrom(name: string): AgentRequest[] {
    return this.list().filter((r) => r.from === name);
  }
}

/** The file the PRD is written to on approval: PRD.md, or PRD-<name>.md beside someone else's. */
export function prdFileFor(request: AgentRequest): string {
  if (request.asChild) return path.join(request.folder, `PRD-${request.name}.md`);
  const plain = path.join(request.folder, "PRD.md");
  return exists(plain) ? path.join(request.folder, `PRD-${request.name}.md`) : plain;
}

/** The CLAUDE.md a NEW agent's folder gets when it has none: read the PRD first. */
export function claudeMdPointer(prdName: string): string {
  return `# Start here\n\nYour brief is \`${prdName}\` in this folder. Read it before anything else — it is what you are here to do.\n`;
}
