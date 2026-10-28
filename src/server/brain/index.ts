// The group brain's index: everything it knows, in memory, searchable in
// milliseconds (owner, 24/10; reviewed 28/10). No database — v1's rule — and
// nothing it holds that cannot be rebuilt from the sources: the index is
// derived, the files are the truth.
//
// Two ranked lists are fused (reciprocal rank fusion): BM25 over the words —
// the title counting three times — and identifiers matched by equality
// (`s60`, `rodada-2026-10-20`, a path). Then each hit is weighed by its source
// (a curated memory over a conversation) and by its age: the newer wins, the
// old never drops to zero, and a chunk that keeps being found ages slower.
// Hits that contradict each other about the same thing are flagged, newest
// first — the very failure that started this ("S60 pendente" vs "S60 publicado").

import { entities as entitiesOf, fold, snippet, terms as termsOf } from "./text.js";

export type BrainSource = "memories" | "messages" | "projectFiles" | "sessions" | "git";
export const BRAIN_SOURCES: readonly BrainSource[] = ["memories", "messages", "projectFiles", "sessions", "git"];

/** One searchable piece of the network's knowledge. */
export interface Chunk {
  /** Stable key: source + path + anchor. Re-adding the same id replaces it. */
  id: string;
  source: BrainSource;
  /** The groups whose agents may find it (a message belongs to both sides). */
  groups: string[];
  /** The agent it came from. */
  agent: string;
  title: string;
  text: string;
  /** ISO 8601. */
  date: string;
  /** Where the original is: a file, a transcript, a repository. */
  path: string;
  /** Line, section, message id or commit within `path`. */
  anchor: string;
}

/** What a search answers, per hit. */
export interface Hit {
  title: string;
  snippet: string;
  source: BrainSource;
  agent: string;
  group: string;
  date: string;
  path: string;
  anchor: string;
  score: number;
  /** Set when another hit says the opposite about the same thing (the newer is shown first). */
  conflict?: { with: string; date: string; note: string };
}

export interface SearchOptions {
  limit?: number;
  sources?: BrainSource[];
  /** Only hits on or after this ISO date. */
  since?: string;
  agent?: string;
  /** Leave out what this agent itself wrote (the briefing). */
  excludeAgent?: string;
  /**
   * Only hits that clearly match: a distinctive identifier, or most of the
   * query's words. For what is injected unasked (the prompt hook), where
   * noise costs more than silence; a search the agent asked for gets the best
   * partial matches instead.
   */
  strict?: boolean;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const RRF_K = 60;
const SOURCE_WEIGHT: Record<BrainSource, number> = {
  memories: 1.5,
  projectFiles: 1.2,
  git: 1.1,
  messages: 1.0,
  sessions: 0.7,
};
const DAY = 86_400_000;

/**
 * One indexed chunk, compact: its terms as ids into the index's dictionary
 * (sorted, for a binary search) with their counts, and its identifiers. A Map
 * per chunk cost fifteen times the text it indexed (447 MB for 29 MB, 28/10).
 */
interface Doc {
  chunk: Chunk;
  terms: Uint32Array; // ascending
  freqs: Uint16Array; // title terms counted TITLE_WEIGHT times
  len: number;
  entities: Uint32Array; // ascending, ids of "#<entity>"
  time: number;
}

function tfOf(doc: Doc, id: number): number {
  let lo = 0;
  let hi = doc.terms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = doc.terms[mid];
    if (v === id) return doc.freqs[mid];
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

/** Newer wins, capped at +50%, never zeroing the old: 1 + 0.5 · 0.5^(age/30d). */
export function recencyBoost(date: number, now: number): number {
  const ageDays = Math.max(0, (now - date) / DAY);
  return 1 + 0.5 * Math.pow(0.5, ageDays / 30);
}

/**
 * Words that say a thing's STATE, in opposite pairs. Two hits naming the same
 * identifier, one on each side, contradict each other.
 */
const STATE_PAIRS: Array<[RegExp, RegExp, string]> = [
  [/\b(pendente|pending|aguardando|esperando|falta)\b/, /\b(publicad[oa]|published|no ar|subiu|live|postad[oa])\b/, "pending vs published"],
  [/\b(agendad[oa]|scheduled)\b/, /\b(publicad[oa]|published|no ar|postad[oa])\b/, "scheduled vs published"],
  [/\b(no ar|publicad[oa]|live)\b/, /\b(apagad[oa]|removid[oa]|deleted|tirad[oa] do ar|derrubad[oa])\b/, "live vs removed"],
  [/\b(aberto|open|em andamento|in progress)\b/, /\b(fechad[oa]|closed|concluid[oa]|done|feito|resolvid[oa])\b/, "open vs done"],
  [/\b(aprovad[oa]|approved)\b/, /\b(recusad[oa]|vetad[oa]|rejected|cancelad[oa]|cancelled)\b/, "approved vs rejected"],
];

export class BrainIndex {
  /** Every term (and every "#identifier") seen, to a small id. */
  private readonly dict = new Map<string, number>();
  private readonly names: string[] = [];
  /** id → the slots of the docs that hold it. */
  private readonly postings: number[][] = [];
  private readonly slots: Array<Doc | undefined> = [];
  private readonly free: number[] = [];
  private readonly byId = new Map<string, number>();
  private totalLen = 0;
  /** When a chunk was last among a search's top results (it ages slower). */
  private readonly lastUsed = new Map<string, number>();

  get size(): number {
    return this.byId.size;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Chunk | undefined {
    const slot = this.byId.get(id);
    return slot === undefined ? undefined : this.slots[slot]?.chunk;
  }

  /** Every chunk id from one source (to find the ones a scan no longer produced). */
  idsOf(source: BrainSource, prefix = ""): string[] {
    const out: string[] = [];
    for (const d of this.slots) if (d && d.chunk.source === source && d.chunk.id.startsWith(prefix)) out.push(d.chunk.id);
    return out;
  }

  chunks(): IterableIterator<Chunk> {
    const slots = this.slots;
    return (function* () {
      for (const d of slots) if (d) yield d.chunk;
    })();
  }

  private idOf(key: string): number {
    let id = this.dict.get(key);
    if (id === undefined) {
      id = this.names.length;
      this.dict.set(key, id);
      this.names.push(key);
      this.postings.push([]);
    }
    return id;
  }

  /** Adds or replaces a chunk. */
  add(chunk: Chunk): void {
    if (this.byId.has(chunk.id)) this.remove(chunk.id);
    const counts = new Map<number, number>();
    for (const t of termsOf(chunk.title)) {
      const id = this.idOf(t);
      counts.set(id, (counts.get(id) ?? 0) + TITLE_WEIGHT);
    }
    for (const t of termsOf(chunk.text)) {
      const id = this.idOf(t);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const ids = [...counts.keys()].sort((a, b) => a - b);
    const terms = Uint32Array.from(ids);
    const freqs = Uint16Array.from(ids, (id) => Math.min(counts.get(id)!, 65535));
    let len = 0;
    for (const n of counts.values()) len += n;
    const ents = Uint32Array.from(
      [...new Set(entitiesOf(`${chunk.title}\n${chunk.text}`).map((e) => this.idOf(`#${e}`)))].sort((a, b) => a - b),
    );
    const time = Date.parse(chunk.date);
    const slot = this.free.length ? this.free.pop()! : this.slots.length;
    this.slots[slot] = { chunk, terms, freqs, len, entities: ents, time: Number.isNaN(time) ? 0 : time };
    this.byId.set(chunk.id, slot);
    this.totalLen += len;
    for (const id of terms) this.postings[id].push(slot);
    for (const id of ents) this.postings[id].push(slot);
  }

  remove(id: string): boolean {
    const slot = this.byId.get(id);
    if (slot === undefined) return false;
    const doc = this.slots[slot]!;
    const drop = (key: number) => {
      const list = this.postings[key];
      const at = list.indexOf(slot);
      if (at === -1) return;
      list[at] = list[list.length - 1];
      list.pop();
    };
    for (const t of doc.terms) drop(t);
    for (const e of doc.entities) drop(e);
    this.slots[slot] = undefined;
    this.free.push(slot);
    this.byId.delete(id);
    this.totalLen -= doc.len;
    this.lastUsed.delete(id);
    return true;
  }

  /**
   * The best hits for `query` among chunks of the groups in `scope`. The
   * scope is decided by the caller from WHO asks — never by the query.
   */
  search(query: string, scope: ReadonlySet<string>, options: SearchOptions = {}, now = Date.now()): Hit[] {
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
    const qTerms = [...new Set(termsOf(query))];
    const qEntities = entitiesOf(query);
    if (qTerms.length === 0 && qEntities.length === 0) return [];
    const since = options.since ? Date.parse(options.since) : NaN;
    const sources = options.sources?.length ? new Set(options.sources) : null;
    const allowed = (doc: Doc) =>
      doc.chunk.groups.some((g) => scope.has(g)) &&
      (!sources || sources.has(doc.chunk.source)) &&
      (Number.isNaN(since) || doc.time >= since) &&
      (!options.agent || doc.chunk.agent === options.agent) &&
      (!options.excludeAgent || doc.chunk.agent !== options.excludeAgent);

    // 1. BM25 (title-weighted), over the docs that hold any query term.
    const n = this.byId.size || 1;
    const avg = this.totalLen / n || 1;
    const bm25 = new Map<number, number>();
    const matched = new Map<number, number>(); // how many distinct query terms a doc holds
    let known = 0;
    for (const t of qTerms) {
      const id = this.dict.get(t);
      const list = id === undefined ? undefined : this.postings[id];
      if (!list || list.length === 0) continue;
      known++;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const slot of list) {
        const doc = this.slots[slot]!;
        if (!allowed(doc)) continue;
        const f = tfOf(doc, id!);
        const s = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avg)));
        bm25.set(slot, (bm25.get(slot) ?? 0) + s);
        matched.set(slot, (matched.get(slot) ?? 0) + 1);
      }
    }
    // 2. Identifiers, by equality: the more named, the higher; then the newer.
    // Unasked (strict), an identifier half the index shares identifies nothing.
    const entityHits = new Map<number, number>();
    for (const e of qEntities) {
      const id = this.dict.get(`#${e}`);
      const list = id === undefined ? undefined : this.postings[id];
      if (!list || list.length === 0) continue;
      if (options.strict && list.length > Math.max(20, n * 0.01)) continue;
      for (const slot of list) {
        if (!allowed(this.slots[slot]!)) continue;
        entityHits.set(slot, (entityHits.get(slot) ?? 0) + 1);
      }
    }
    // A hit needs a real match: an identifier, or enough of the query's words.
    // Asked, only the words the index knows count (an unknown word cannot
    // punish what matches the rest); unasked, every word counts, so one stray
    // common word in a long prompt is not a match.
    const need = options.strict
      ? Math.max(2, Math.min(6, Math.ceil(qTerms.length * 0.5)))
      : Math.max(1, Math.ceil(known * 0.4));
    const bmRanked = [...bm25.entries()]
      .filter(([slot]) => (matched.get(slot) ?? 0) >= need || entityHits.has(slot))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300);
    const entRanked = [...entityHits.entries()]
      .sort((a, b) => b[1] - a[1] || this.slots[b[0]]!.time - this.slots[a[0]]!.time)
      .slice(0, 300);

    // 3. Fusion, then source and age.
    const fused = new Map<number, number>();
    bmRanked.forEach(([slot], i) => fused.set(slot, (fused.get(slot) ?? 0) + 1 / (RRF_K + i + 1)));
    entRanked.forEach(([slot], i) => fused.set(slot, (fused.get(slot) ?? 0) + 1 / (RRF_K + i + 1)));
    const scored = [...fused.entries()].map(([slot, rrf]) => {
      const doc = this.slots[slot]!;
      // Found again lately: it is still alive, so it ages as if newer.
      const used = this.lastUsed.get(doc.chunk.id);
      const effective = used && used > doc.time ? doc.time + (used - doc.time) / 2 : doc.time;
      return { doc, score: rrf * SOURCE_WEIGHT[doc.chunk.source] * recencyBoost(effective, now) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    for (const { doc } of top.slice(0, 3)) this.lastUsed.set(doc.chunk.id, now);

    const hits: Hit[] = top.map(({ doc, score }) => ({
      title: doc.chunk.title,
      snippet: snippet(doc.chunk.text, [...qTerms, ...qEntities]),
      source: doc.chunk.source,
      agent: doc.chunk.agent,
      group: doc.chunk.groups[0] ?? "",
      date: doc.chunk.date,
      path: doc.chunk.path,
      anchor: doc.chunk.anchor,
      score: Math.round(score * 1e6) / 1e6,
    }));
    flagConflicts(
      hits,
      top.map((t) => t.doc),
      (e) => this.names[e].slice(1),
      (e) => this.postings[e].length <= Math.max(20, n * 0.01),
    );
    return hits;
  }

  /** The newest chunks in scope since `sinceMs` — what changed (the session briefing). */
  recent(scope: ReadonlySet<string>, sinceMs: number, options: { excludeAgent?: string; sources?: BrainSource[]; limit?: number } = {}): Chunk[] {
    const sources = options.sources?.length ? new Set(options.sources) : null;
    const out: Doc[] = [];
    for (const doc of this.slots) {
      if (!doc || doc.time < sinceMs) continue;
      if (!doc.chunk.groups.some((g) => scope.has(g))) continue;
      if (sources && !sources.has(doc.chunk.source)) continue;
      if (options.excludeAgent && doc.chunk.agent === options.excludeAgent) continue;
      out.push(doc);
    }
    out.sort((a, b) => b.time - a.time);
    return out.slice(0, options.limit ?? 10).map((d) => d.chunk);
  }
}

/**
 * Two hits about the same thing — an identifier with a letter AND a digit
 * (`s60`, `ep02`, `rodada-2026-10-20`) that few chunks share; a bare year or
 * date names nothing in particular — one saying "pending" and the other
 * "published" (and the like): the older is flagged, and the newer is moved
 * ahead of it if it was not already.
 */
function flagConflicts(hits: Hit[], docs: Doc[], nameOf: (e: number) => string, distinctive: (e: number) => boolean): void {
  const subject = (e: number) => {
    const name = nameOf(e);
    return /[a-z]/.test(name) && /\d/.test(name) && distinctive(e);
  };
  for (let i = 0; i < docs.length; i++) {
    for (let j = 0; j < docs.length; j++) {
      if (i === j) continue;
      const a = docs[i];
      const b = docs[j];
      if (a.time >= b.time) continue; // a is the older one
      let shared: number | undefined;
      for (const e of a.entities) {
        if (subject(e) && b.entities.includes(e)) {
          shared = e;
          break;
        }
      }
      if (shared === undefined) continue;
      const ta = fold(`${a.chunk.title} ${a.chunk.text}`);
      const tb = fold(`${b.chunk.title} ${b.chunk.text}`);
      for (const [left, right, note] of STATE_PAIRS) {
        const opposite = (left.test(ta) && right.test(tb)) || (right.test(ta) && left.test(tb));
        if (!opposite) continue;
        if (!hits[i].conflict) hits[i].conflict = { with: b.chunk.id, date: b.chunk.date, note: `${note} about ${nameOf(shared)} — the newer one says otherwise` };
        break;
      }
    }
  }
  // Newer first among the conflicting: never leave the outdated one on top.
  for (let i = 0; i < hits.length; i++) {
    const c = hits[i].conflict;
    if (!c) continue;
    const newer = hits.findIndex((h, k) => k !== i && h.date === c.date);
    if (newer > i) {
      const [moved] = hits.splice(newer, 1);
      hits.splice(i, 0, moved);
    }
  }
}
