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
  it("loads without a DOM and exports its vocabulary", async () => {
    const mod = await import("../public/faces/faces.js");
    expect(typeof mod.createFace).toBe("function");
    expect(mod.SHAPES).toContain("blob");
    expect(mod.REACTIONS).toEqual(expect.arrayContaining(["poke", "cheer", "spin", "startle"]));
  });

  it("animates exactly the states the dashboard already derives", async () => {
    const { STATES } = await import("../public/faces/faces.js");
    const spec = dashboard.match(/const BLOB_SPEC = \{([\s\S]*?)\n    \};/)?.[1] ?? "";
    const dashStates = [...spec.matchAll(/^\s{6}([a-z]+):\s+\{/gm)].map((m) => m[1]);
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
