// The faces engine (public/faces/faces.js), built standalone before it goes
// into the dashboard. These lock its contract with the board: the state names
// it animates are exactly the ones the dashboard already derives, and the
// colour rule (the agent's colour, never the state's) is written into it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const engineSrc = fs.readFileSync(path.join(process.cwd(), "public", "faces", "faces.js"), "utf8");
const dashboard = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");

describe("the faces engine", () => {
  it("draws exactly the shapes the dashboard lets you pick", async () => {
    // @ts-expect-error — plain browser JS module, no type declarations
    const { SHAPES } = await import("../public/faces/faces.js");
    const list = dashboard.match(/const BLOB_SHAPE_NAMES = (\[[^\]]*\])/)?.[1] ?? "[]";
    expect(JSON.parse(list)).toEqual(SHAPES);
  });

  it("loads without a DOM and exports its vocabulary", async () => {
    // @ts-expect-error — plain browser JS module, no type declarations
    const mod = await import("../public/faces/faces.js");
    expect(typeof mod.createFace).toBe("function");
    expect(mod.SHAPES).toContain("blob");
    expect(mod.REACTIONS).toEqual(expect.arrayContaining(["poke", "cheer", "spin", "startle"]));
  });

  it("animates exactly the states the dashboard already derives", async () => {
    // @ts-expect-error — plain browser JS module, no type declarations
    const { STATES } = await import("../public/faces/faces.js");
    // BLOB_LABEL names every state the dashboard's blobStateOf can report.
    const labels = dashboard.match(/const BLOB_LABEL = \{([\s\S]*?)\};/)?.[1] ?? "";
    const dashStates = [...labels.matchAll(/\b([a-z]+):\s*"/g)].map((m) => m[1]);
    expect(dashStates.length).toBeGreaterThan(5);
    expect([...STATES].sort()).toEqual([...dashStates].sort());
  });

  it("never lets a state choose the body colour", () => {
    // Expressions carry intensity (glow) and accents — no body colour field.
    const expr = engineSrc.match(/const EXPRESSIONS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    expect(expr).not.toMatch(/\bcolor:/);
    expect(expr).toMatch(/glow: \{ base:/);
  });

  it("keeps one shared animation loop that sleeps off screen and in hidden tabs", () => {
    expect(engineSrc).toContain("IntersectionObserver");
    expect(engineSrc).toMatch(/document\.hidden \? .*requestAnimationFrame|!document\.hidden\) rafId = requestAnimationFrame/);
  });
});

/**
 * What the old CSS engine's tests guarded, carried over to the new engine so
 * the lessons behind them are not lost with the code.
 */
describe("the faces engine keeps the old lessons", () => {
  it("rations idle quirks across every face: one at a time, with a gap", () => {
    // A rail of twenty-four creatures each doing its own thing is a screensaver.
    expect(engineSrc).toContain("let lastQuirkAt = -Infinity");
    expect(engineSrc).toMatch(/nowS - lastQuirkAt >= quirkGap/);
    // A face that loses the turn retries later, at random — or the first face
    // in the list would win every time.
    expect(engineSrc).toMatch(/nowS - lastQuirkAt < quirkGap\) nextQuirk = 0\.5 \+ rand\(\) \* 3/);
  });

  it("never plays the same quirk twice running", () => {
    expect(engineSrc).toMatch(/QUIRK_WEIGHTS\.filter\(\(\[n\]\) => n !== lastQuirk\)/);
  });

  it("keeps quirks to the resting states — none while working, asking, erroring or asleep", () => {
    const expr = engineSrc.match(/const EXPRESSIONS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    for (const busy of ["working", "speaking", "thinking", "asking", "error", "launching", "offline"]) {
      const block = expr.match(new RegExp(`\\n  ${busy}: \\{[\\s\\S]*?\\n  \\},`))?.[0] ?? "";
      expect(block, busy).toContain("quirks: false");
    }
  });

  it("does not let motion vanish on a tiny face", () => {
    // The old faces moved "less than a millimetre" at rail size.
    expect(engineSrc).toMatch(/const boost = 1 \+ clamp\(\(90 - pxSize\) \/ 90, 0, 1\)/);
    // …and eyes never shrink below a couple of real pixels.
    expect(engineSrc).toMatch(/const minPx = 2\.4 \* \(100 \/ pxSize\)/);
  });

  it("never cuts on a state change: oscillators accumulate phase", () => {
    expect(engineSrc).toMatch(/phase\.breathe \+= TAU \* hz\.breathe\.x \* dt/);
  });
});

describe("the look the owner asked for (29/09)", () => {
  it("is flat — no shaded, glassy body", () => {
    expect(engineSrc).not.toContain("radialGradient\", { id: `${id}g`");
    expect(engineSrc).toContain('body.setAttribute("fill", css(c))');
  });

  it("is round unless someone picked a shape", async () => {
    // @ts-expect-error — plain browser JS module, no type declarations
    const { DEFAULT_SHAPE } = await import("../public/faces/faces.js");
    expect(DEFAULT_SHAPE).toBe("circle");
    expect(dashboard).toMatch(/BLOB_SHAPE_NAMES\.includes\(chosen\) \? chosen : "circle"/);
  });

  it("is big enough to read in the rail", () => {
    expect(dashboard).toMatch(/\.agent-portrait\.blob \{[^}]*width: 42px/);
    expect(dashboard).toMatch(/\.agent-portrait\.blob > \.sb-face-host \{ width: 56px; height: 56px/);
  });
});
