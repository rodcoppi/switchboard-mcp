// The dashboard's file-path detector (FILE_PATH_RE in public/index.html).
//
// The dashboard is one vanilla HTML file with no module system, so there is
// nothing to import: the test READS the regex literal out of the page and runs
// it. If the extraction fails the test fails loudly, which is the signal to fix
// it here — better than a copy that silently drifts from the real one.
//
// This exists because the regex is subtle and shipped two latent bugs:
//   - "~/x.md" matched as "/x.md" (a DIFFERENT, absolute path), because the
//     shape demanded a name character straight after "~".
//   - a space inside a segment let "/a/b.md e tambem c/d.json" match as ONE
//     path, swallowing the prose between the two.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, "..", "public", "index.html");

/** Pulls `const FILE_PATH_RE = /…/g;` out of the page and rebuilds it. */
function regexNamed(name: string): RegExp {
  const src = fs.readFileSync(PAGE, "utf8");
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*/(.+)/([gimsuy]*);`));
  if (!m) throw new Error(`${name} not found in public/index.html — did it move or change shape?`);
  return new RegExp(m[1], m[2]);
}

const matches = (text: string): string[] => {
  const re = regexNamed("FILE_PATH_RE");
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => m[0]);
};

describe("FILE_PATH_RE", () => {
  it("matches absolute paths", () => {
    expect(matches("/home/rod/x.md")).toEqual(["/home/rod/x.md"]);
    expect(matches("editei /a/b/c/deep.tsx hoje")).toEqual(["/a/b/c/deep.tsx"]);
  });

  it("keeps the ~ on a home path (it used to match /x.md — another file)", () => {
    expect(matches("~/notes/y.md")).toEqual(["~/notes/y.md"]);
    expect(matches("gravei em ~/.config/twitter-cli/env.sh")).toEqual(["~/.config/twitter-cli/env.sh"]);
  });

  it("matches RELATIVE paths — how an agent names its own cwd's files", () => {
    expect(matches("Saiu! resultados/teste2_pruna.mp4")).toEqual(["resultados/teste2_pruna.mp4"]);
    expect(matches("revisa em config/sources.json amanha")).toEqual(["config/sources.json"]);
    expect(matches("editei src/server/api.ts hoje")).toEqual(["src/server/api.ts"]);
  });

  it("stops at whitespace instead of swallowing the prose between two paths", () => {
    expect(matches("veja /a/b.md e tambem c/d.json")).toEqual(["/a/b.md", "c/d.json"]);
  });

  it("does NOT litter ordinary prose with false links", () => {
    expect(matches("rodando node.js aqui")).toEqual([]); // no separator
    expect(matches("Fabrica de shorts (TTS + lip-sync)")).toEqual([]); // no extension
    expect(matches("suporte 24/7 pra voce")).toEqual([]); // no extension
    expect(matches("custo ~US$0,70 (coberto)")).toEqual([]); // "~" but not a path
    expect(matches("15.7s em 1088x1920")).toEqual([]);
  });
});

describe("BARE_FILE_RE candidates", () => {
  const candidates = (text: string): string[] => {
    const re = regexNamed("BARE_FILE_RE");
    return [...text.matchAll(re)].map((match) => match[0]);
  };

  it("finds a filename cited in prose so the hub can resolve it", () => {
    expect(candidates("o arquivo VacaGorda-IMPLEMENTACAO-FASE3.md está no Downloads")).toEqual([
      "VacaGorda-IMPLEMENTACAO-FASE3.md",
    ]);
  });

  it("does not take a basename out of an existing full path", () => {
    expect(candidates("veja /home/rod/VacaGorda-IMPLEMENTACAO-FASE3.md")).toEqual([]);
  });
});

describe("FILE_PATH_RE vs URLs (the localhost mangling)", () => {
  // "http://localhost:8737/gen/x.png" grew a path-link over "/gen/x.png"
  // and the URL died split in half — the absolute branch had no lookbehind.
  it("never matches the path part of a bare URL", () => {
    expect(matches("abre em http://localhost:8737/generations/images/SUC_V001_WIP.png .")).toEqual([]);
    expect(matches("veja https://example.com/docs/guide.html hoje")).toEqual([]);
  });

  it("still matches real paths in the same sentence as a URL", () => {
    expect(matches("salvei /tmp/shot.png e subi em http://localhost:8737/x/shot.png")).toEqual(["/tmp/shot.png"]);
  });

  it("still matches paths after ordinary punctuation and at line start", () => {
    expect(matches("(/etc/config/app.toml)")).toEqual(["/etc/config/app.toml"]);
    expect(matches("~/notes/y.md no começo")).toEqual(["~/notes/y.md"]);
  });
});
