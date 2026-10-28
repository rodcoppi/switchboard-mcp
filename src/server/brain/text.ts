// Text for the group brain: how a chunk and a query become terms.
//
// Plain-text search (BM25) only finds what the words on both sides share, so
// this is where most of its quality is won or lost: lowercase, accents off
// ("publicacao" finds "publicação"), a light stem so "publicou", "publicado" and
// "publicação" meet, and identifiers kept WHOLE beside their parts — `S60`,
// `rodada-2026-10-20`, `redes/data/publicacoes.json`, `vide-editor` — because
// those are what the network's questions are full of.

/** Lowercase, accents and other combining marks off. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Words that carry no search weight (Portuguese and English). Kept short on
 * purpose: a word that is rare in this network's text is never in it.
 */
const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das no na nos nas em por para pra pro com sem sob " +
    "e ou mas que se ja nao sim ao aos ate como mais menos muito pouco isso isto esse essa este esta " +
    "ele ela eles elas eu voce voces nos me te lhe seu sua seus suas meu minha meus minhas " +
    "foi era ser ter tem tinha vai vou estou esta estao sao fica ficou " +
    "sobre qual quais quem quando onde porque entre tambem ainda aqui depois antes cada todo toda todos todas " +
    "outro outra mesmo mesma so la pelo pela pelos pelas num numa dele dela nisso disso desse dessa deste desta " +
    "what which who when where why how about there here also just any all some has have had can will would should could " +
    "the an of to in on at for with without by from and or but not no yes is are was were be been " +
    "it its this that these those he she they we you i me my your our their as if then than so do does did"
  ).split(/\s+/),
);

/**
 * The stem of one folded word: words longer than six letters are cut to six.
 * Crude, dependency-free, and good enough for Portuguese and English alike
 * ("publicou"/"publicado"/"publicacao" → "public", "published" → "publis",
 * "publishing" → "publis"). Applied identically to chunks and queries.
 */
export function stem(word: string): string {
  return /^[a-z]+$/.test(word) && word.length > 6 ? word.slice(0, 6) : word;
}

/** A token that identifies something: has a digit or joins parts with - _ . / */
function isIdentifier(token: string): boolean {
  return token.length >= 2 && (/\d/.test(token) || /[-_./]/.test(token)) && /[a-z0-9]/.test(token);
}

const COMPOUND_RE = /[a-z0-9]+(?:[-_./][a-z0-9]+)*/g;

/**
 * Search terms of a text: every word (stopwords out, stemmed), plus every
 * identifier whole. Used for both the index and the query.
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const compound of fold(text).match(COMPOUND_RE) ?? []) {
    if (isIdentifier(compound) && /[-_./]/.test(compound)) out.push(compound);
    for (const part of compound.split(/[-_./]/)) {
      if (!part || STOPWORDS.has(part)) continue;
      if (part.length === 1 && !/\d/.test(part)) continue;
      out.push(stem(part));
    }
  }
  return out;
}

/**
 * The identifiers a text names — matched by equality, as a second ranking
 * list beside BM25: `s60`, `2026-10-20`,
 * `rodada-2026-10-20`, `publicacoes.json`, agent names with a hyphen.
 */
export function entities(text: string): string[] {
  const out = new Set<string>();
  for (const compound of fold(text).match(COMPOUND_RE) ?? []) {
    if (!isIdentifier(compound)) continue;
    out.add(compound);
    // A path's file name stands alone too: "redes/data/publicacoes.json" → "publicacoes.json".
    if (compound.includes("/")) {
      const last = compound.slice(compound.lastIndexOf("/") + 1);
      if (isIdentifier(last)) out.add(last);
    }
  }
  return [...out];
}

// --- Secrets never enter the brain ------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-f0-9]{64}\b/gi, // the agent token's shape
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[bpas]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /^(\s*(?:set-cookie|cookie)\s*:).*$/gim,
];
const SECRET_ASSIGNMENT = /((?:senha|password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\w*["']?\s*[:=]\s*)["']?[^\s"',;]{4,}/gi;

/** Every secret-shaped run replaced by [REDACTED], before anything is stored. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, lead?: string) => (typeof lead === "string" && /cookie/i.test(lead) ? `${lead} [REDACTED]` : "[REDACTED]"));
  }
  return out.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

/** Whether a text still holds something secret-shaped (the audit, test B). */
export function looksSecret(text: string): boolean {
  return redact(text) !== text;
}

// --- Showing a hit ------------------------------------------------------------

/**
 * Up to `max` characters of the ORIGINAL text, around the place most query
 * terms meet — never a rewrite: an answer quotes what was written.
 */
export function snippet(text: string, queryTerms: string[], max = 600): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const folded = fold(clean);
  const wanted = queryTerms.filter((t) => t.length >= 3);
  let best = 0;
  let bestHits = -1;
  const step = Math.max(40, Math.floor(max / 4));
  for (let start = 0; start < clean.length; start += step) {
    const window = folded.slice(start, start + max);
    const hits = wanted.reduce((n, t) => n + (window.includes(t) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = start;
    }
  }
  const from = Math.max(0, Math.min(best, clean.length - max));
  return `${from > 0 ? "…" : ""}${clean.slice(from, from + max).trim()}${from + max < clean.length ? "…" : ""}`;
}
