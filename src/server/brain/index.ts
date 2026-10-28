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

interface Doc {
  chunk: Chunk;
  tf: Map<string, number>; // title terms counted TITLE_WEIGHT times
  len: number;
  entities: Set<string>;
  time: number;
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
  private readonly docs = new Map<string, Doc>();
  private readonly postings = new Map<string, Set<string>>();
  private readonly entityPostings = new Map<string, Set<string>>();
  private totalLen = 0;
  /** When a chunk was last among a search's top results (it ages slower). */
  private readonly lastUsed = new Map<string, number>();

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get(id: string): Chunk | undefined {
    return this.docs.get(id)?.chunk;
  }

  /** Every chunk id from one source (to find the ones a scan no longer produced). */
  idsOf(source: BrainSource, prefix = ""): string[] {
    const out: string[] = [];
    for (const [id, d] of this.docs) if (d.chunk.source === source && id.startsWith(prefix)) out.push(id);
    return out;
  }

  chunks(): IterableIterator<Chunk> {
    const it = this.docs.values();
    return (function* () {
      for (const d of it) yield d.chunk;
    })();
  }

  /** Adds or replaces a chunk. */
  add(chunk: Chunk): void {
    if (this.docs.has(chunk.id)) this.remove(chunk.id);
    const tf = new Map<string, number>();
    for (const t of termsOf(chunk.title)) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
    for (const t of termsOf(chunk.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let len = 0;
    for (const n of tf.values()) len += n;
    const ents = new Set(entitiesOf(`${chunk.title}\n${chunk.text}`));
    const time = Date.parse(chunk.date);
    const doc: Doc = { chunk, tf, len, entities: ents, time: Number.isNaN(time) ? 0 : time };
    this.docs.set(chunk.id, doc);
    this.totalLen += len;
    for (const t of tf.keys()) {
      let set = this.postings.get(t);
      if (!set) this.postings.set(t, (set = new Set()));
      set.add(chunk.id);
    }
    for (const e of ents) {
      let set = this.entityPostings.get(e);
      if (!set) this.entityPostings.set(e, (set = new Set()));
      set.add(chunk.id);
    }
  }

  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.delete(id);
    this.totalLen -= doc.len;
    for (const t of doc.tf.keys()) {
      const set = this.postings.get(t);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.postings.delete(t);
      }
    }
    for (const e of doc.entities) {
      const set = this.entityPostings.get(e);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.entityPostings.delete(e);
      }
    }
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
    const n = this.docs.size || 1;
    const avg = this.totalLen / n || 1;
    const bm25 = new Map<string, number>();
    const matched = new Map<string, number>(); // how many distinct query terms a doc holds
    for (const t of qTerms) {
      const set = this.postings.get(t);
      if (!set) continue;
      const idf = Math.log(1 + (n - set.size + 0.5) / (set.size + 0.5));
      for (const id of set) {
        const doc = this.docs.get(id)!;
        if (!allowed(doc)) continue;
        const f = doc.tf.get(t) ?? 0;
        const s = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avg)));
        bm25.set(id, (bm25.get(id) ?? 0) + s);
        matched.set(id, (matched.get(id) ?? 0) + 1);
      }
    }
    // 2. Identifiers, by equality: the more named, the higher; then the newer.
    // Unasked (strict), a bare number or an identifier half the index shares
    // ("2026") identifies nothing.
    const entityHits = new Map<string, number>();
    for (const e of qEntities) {
      const posting = this.entityPostings.get(e);
      if (!posting) continue;
      if (options.strict && (/^\d+$/.test(e) || posting.size > Math.max(20, n * 0.01))) continue;
      for (const id of posting) {
        const doc = this.docs.get(id)!;
        if (!allowed(doc)) continue;
        entityHits.set(id, (entityHits.get(id) ?? 0) + 1);
      }
    }
    // A hit needs a real match: an identifier, or enough of the query's words.
    // Asked, only the words the index knows count (an unknown word cannot
    // punish what matches the rest); unasked, every word counts, so one stray
    // common word in a long prompt is not a match.
    const known = qTerms.filter((t) => this.postings.has(t)).length;
    const need = options.strict
      ? Math.max(2, Math.min(6, Math.ceil(qTerms.length * 0.5)))
      : Math.max(1, Math.ceil(known * 0.4));
    const bmRanked = [...bm25.entries()]
      .filter(([id]) => (matched.get(id) ?? 0) >= need || entityHits.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300);
    const entRanked = [...entityHits.entries()]
      .sort((a, b) => b[1] - a[1] || this.docs.get(b[0])!.time - this.docs.get(a[0])!.time)
      .slice(0, 300);

    // 3. Fusion, then source and age.
    const fused = new Map<string, number>();
    bmRanked.forEach(([id], i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    entRanked.forEach(([id], i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    const scored = [...fused.entries()].map(([id, rrf]) => {
      const doc = this.docs.get(id)!;
      // Found again lately: it is still alive, so it ages as if newer.
      const used = this.lastUsed.get(id);
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
    flagConflicts(hits, top.map((t) => t.doc));
    return hits;
  }

  /** The newest chunks in scope since `sinceMs` — what changed (the session briefing). */
  recent(scope: ReadonlySet<string>, sinceMs: number, options: { excludeAgent?: string; sources?: BrainSource[]; limit?: number } = {}): Chunk[] {
    const sources = options.sources?.length ? new Set(options.sources) : null;
    const out: Doc[] = [];
    for (const doc of this.docs.values()) {
      if (doc.time < sinceMs) continue;
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
 * Two hits about the same identifier, one saying "pending" and the other
 * "published" (and the like): the older is flagged, and the newer is moved
 * ahead of it if it was not already.
 */
function flagConflicts(hits: Hit[], docs: Doc[]): void {
  for (let i = 0; i < docs.length; i++) {
    for (let j = 0; j < docs.length; j++) {
      if (i === j) continue;
      const a = docs[i];
      const b = docs[j];
      if (a.time >= b.time) continue; // a is the older one
      const shared = [...a.entities].find((e) => b.entities.has(e) && /\d/.test(e));
      if (!shared) continue;
      const ta = fold(`${a.chunk.title} ${a.chunk.text}`);
      const tb = fold(`${b.chunk.title} ${b.chunk.text}`);
      for (const [left, right, note] of STATE_PAIRS) {
        const opposite = (left.test(ta) && right.test(tb)) || (right.test(ta) && left.test(tb));
        if (!opposite) continue;
        if (!hits[i].conflict) hits[i].conflict = { with: b.chunk.id, date: b.chunk.date, note: `${note} about ${shared} — the newer one says otherwise` };
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
