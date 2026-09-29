// Switchboard faces — the little creatures that stand for each agent.
//
// A JavaScript engine, not CSS keyframes. A keyframe runs a fixed loop: it
// cannot blend one state into the next, cannot be interrupted halfway, and on
// every state change it CUTS to the new loop — which is where the "jumping"
// faces came from. Here every measurable thing about a face (eye size, squash,
// lean, colour intensity…) is a spring chasing a target. Changing state only
// moves the targets; the body travels there. Reactions push the springs
// (impulses) and lay short-lived overrides on top of the state, so they stack
// and interrupt naturally.
//
// Colour is the AGENT's, chosen by the owner, and never changes with state
// (owner, 29/09). States and reactions move its INTENSITY — dimmer asleep,
// brighter at work, flickering on an error — and add accents in other colours
// in their own places (a blush, a sweat drop, a "!", sparkles), but the body
// is always the chosen colour.
//
// No dependencies. One shared requestAnimationFrame loop drives every face and
// stops when none is on screen or the tab is hidden.

export const DEFAULT_COLOR = "#4ade80";

export const STATES = [
  "idle", "working", "speaking", "thinking", "asking",
  "waiting", "reply", "error", "launching", "offline",
];

export const REACTIONS = [
  "poke", "cheer", "startle", "flinch", "perk", "spin", "nod", "wiggle", "bounce",
];

export const SHAPES = [
  "blob", "circle", "squircle", "capsule", "teardrop", "clover", "hexagon", "triangle", "diamond",
];

// --------------------------------------------------------------------------
// Small maths
// --------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Deterministic PRNG from a string, so a face's rhythm is its own. */
function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A damped spring. `k` stiffness, `d` damping ratio (1 = no overshoot, <1 =
 * bouncy). Integrated with sub-steps so a long frame cannot blow it up.
 */
class Spring {
  constructor(value, k = 120, d = 0.7) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.k = k;
    this.d = d;
  }
  step(dt) {
    const c = 2 * Math.sqrt(this.k) * this.d;
    let left = dt;
    while (left > 0) {
      const h = Math.min(left, 1 / 120);
      const a = this.k * (this.target - this.x) - c * this.v;
      this.v += a * h;
      this.x += this.v * h;
      left -= h;
    }
    return this.x;
  }
  kick(v) {
    this.v += v;
  }
  snap(value) {
    this.x = this.target = value;
    this.v = 0;
  }
}

// --------------------------------------------------------------------------
// Colour
// --------------------------------------------------------------------------

let colorProbe = null;
/** Any CSS colour → [r,g,b] 0..255 (resolved by the browser itself). */
function toRGB(css) {
  if (!colorProbe) colorProbe = document.createElement("canvas").getContext("2d");
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = css;
  const v = colorProbe.fillStyle; // normalised to #rrggbb or rgba()
  if (v.startsWith("#")) {
    return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  }
  const m = v.match(/[\d.]+/g) || [0, 0, 0];
  return [+m[0], +m[1], +m[2]];
}
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css = (c, a = 1) =>
  a >= 1
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
const luminance = (c) => {
  const f = (x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const GRAY = [63, 63, 70];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/**
 * The body colour at an intensity. Below 1 it fades toward a dark grey (asleep,
 * booting); above 1 it lifts toward white. Same hue either way — the owner's
 * colour, never swapped.
 */
function intensityColor(base, i) {
  if (i < 1) return mix(GRAY, base, clamp(0.25 + 0.75 * i, 0, 1));
  return mix(base, WHITE, clamp((i - 1) * 0.45, 0, 0.35));
}

// Accent colours — the "other colours in some places".
const ACCENT = {
  blush: "#f472b6",
  sweat: "#7dd3fc",
  bang: "#f87171",
  question: "#fbbf24",
  sparkle: "#fde047",
  zzz: "#a1a1aa",
  dots: "#c4b5fd",
  flash: "#ef4444",
};

// --------------------------------------------------------------------------
// Shapes: every silhouette is a radius function r(θ), smoothed so corners
// come out heavily rounded (the reference set), area-normalised so a
// triangle does not look bigger than a circle, and sampled at N points. Any
// two shapes interpolate, so switching shape morphs instead of swapping.
// --------------------------------------------------------------------------

const N = 32; // body sample points
const FINE = 360;

function polygon(n, offset) {
  return (th) => {
    const seg = TAU / n;
    const a = (((th - offset) % seg) + seg) % seg - seg / 2;
    return Math.cos(Math.PI / n) / Math.cos(a);
  };
}
function superellipse(n, ax = 1, ay = 1) {
  return (th) => {
    const c = Math.abs(Math.cos(th)) / ax;
    const s = Math.abs(Math.sin(th)) / ay;
    return Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
  };
}
// θ is screen-space: 0 = right, π/2 = DOWN, -π/2 = up.
const SHAPE_FN = {
  blob: (th) => 1 + 0.045 * Math.sin(3 * th + 0.7) + 0.03 * Math.sin(5 * th + 2.1),
  circle: () => 1,
  squircle: superellipse(4.2),
  capsule: superellipse(2.8, 1.16, 0.84),
  teardrop: (th) => 0.93 + 0.34 * Math.pow(Math.max(0, -Math.sin(th)), 6),
  clover: (th) => 1 + 0.12 * Math.cos(4 * th),
  hexagon: polygon(6, 0),
  triangle: polygon(3, -Math.PI / 2),
  diamond: polygon(4, -Math.PI / 2),
};
const SMOOTH = { hexagon: 9, triangle: 15, diamond: 13 }; // corner rounding window

const shapeCache = new Map();
function shapeRadii(name) {
  if (shapeCache.has(name)) return shapeCache.get(name);
  const fn = SHAPE_FN[name] || SHAPE_FN.blob;
  let fine = Array.from({ length: FINE }, (_, i) => fn((i / FINE) * TAU));
  const win = SMOOTH[name] || 0;
  if (win) {
    fine = fine.map((_, i) => {
      let sum = 0;
      for (let k = -win; k <= win; k++) sum += fine[(i + k + FINE) % FINE];
      return sum / (2 * win + 1);
    });
  }
  // Equal area with a unit circle: area ∝ mean(r²).
  const meanSq = fine.reduce((a, r) => a + r * r, 0) / FINE;
  const norm = 1 / Math.sqrt(meanSq);
  const out = Array.from({ length: N }, (_, i) => fine[Math.round((i / N) * FINE) % FINE] * norm);
  shapeCache.set(name, out);
  return out;
}

/** Closed Catmull-Rom through points → SVG path. */
function smoothPath(pts) {
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d + "Z";
}

/**
 * One eye: a single path that morphs from an oval (smile 0) to a thick "^"
 * arc (smile 1) by bending its lower edge up to parallel the upper one — so
 * "happy" is a transition, not a swap. `open` closes it for a blink.
 */
function eyePath(cx, cy, w, h, smile, open, thick) {
  const hh = Math.max(0.6, (h / 2) * open);
  const hw = w / 2;
  const top = cy - (4 / 3) * hh;
  const t = Math.min(thick, hh * 1.6);
  const bottomCtl = lerp(cy + (4 / 3) * hh, cy - (4 / 3) * (hh - t), clamp(smile, 0, 1));
  return (
    `M${(cx - hw).toFixed(2)},${cy.toFixed(2)}` +
    `C${(cx - hw).toFixed(2)},${top.toFixed(2)} ${(cx + hw).toFixed(2)},${top.toFixed(2)} ${(cx + hw).toFixed(2)},${cy.toFixed(2)}` +
    `C${(cx + hw).toFixed(2)},${bottomCtl.toFixed(2)} ${(cx - hw).toFixed(2)},${bottomCtl.toFixed(2)} ${(cx - hw).toFixed(2)},${cy.toFixed(2)}Z`
  );
}

// --------------------------------------------------------------------------
// Expressions. Each state is a set of TARGETS; the engine springs toward them.
//   eye:    w, h, gap (between centres), y (from face centre), tilt (deg, inner
//           corners down when positive), smile 0..1
//   body:   squat (vertical scale), breathe (amp) + breatheHz, bob (vertical
//           bounce amp) + bobHz, sway (lean amp, deg) + swayHz, jitter
//   gaze:   how the eyes move — idle | scan | up | dart | center | down
//   glow:   intensity base + pulse amp + pulseHz
//   accents: which accent layers are on
// --------------------------------------------------------------------------

const EXPRESSIONS = {
  idle: {
    eye: { w: 12, h: 24, gap: 26, y: -4, tilt: 0, smile: 0 },
    body: { squat: 1, breathe: 0.035, breatheHz: 0.32, bob: 1.6, bobHz: 0.24, sway: 2.5, swayHz: 0.16, jitter: 0 },
    gaze: "idle", glow: { base: 1, pulse: 0, pulseHz: 0 }, accents: [], blink: 1, quirks: true,
  },
  working: {
    eye: { w: 11, h: 17, gap: 24, y: -3, tilt: -4, smile: 0 },
    body: { squat: 0.97, breathe: 0.05, breatheHz: 1.9, bob: 2.4, bobHz: 1.9, sway: 3, swayHz: 0.9, jitter: 0 },
    gaze: "scan", glow: { base: 1.12, pulse: 0.05, pulseHz: 1.9 }, accents: [], blink: 0.6, quirks: false,
  },
  speaking: {
    eye: { w: 12, h: 21, gap: 26, y: -4, tilt: 0, smile: 0.25 },
    body: { squat: 1, breathe: 0.07, breatheHz: 2.8, bob: 1.8, bobHz: 2.8, sway: 2, swayHz: 0.7, jitter: 0 },
    gaze: "center", glow: { base: 1.08, pulse: 0.04, pulseHz: 2.8 }, accents: [], blink: 1, quirks: false,
  },
  thinking: {
    eye: { w: 12, h: 20, gap: 25, y: -6, tilt: 0, smile: 0 },
    body: { squat: 0.93, breathe: 0.03, breatheHz: 0.45, bob: 0.8, bobHz: 0.3, sway: 7, swayHz: 0.25, jitter: 0 },
    gaze: "up", glow: { base: 1, pulse: 0.03, pulseHz: 0.6 }, accents: ["dots"], blink: 0.7, quirks: false,
  },
  asking: {
    eye: { w: 14, h: 27, gap: 27, y: -5, tilt: -6, smile: 0 },
    body: { squat: 1.05, breathe: 0.03, breatheHz: 0.5, bob: 1.4, bobHz: 0.55, sway: 9, swayHz: 0.4, jitter: 0 },
    gaze: "center", glow: { base: 1.06, pulse: 0.08, pulseHz: 1.1 }, accents: ["question"], blink: 1.2, quirks: false,
  },
  waiting: {
    eye: { w: 12, h: 22, gap: 26, y: -4, tilt: 0, smile: 0 },
    body: { squat: 1, breathe: 0.03, breatheHz: 0.4, bob: 1.2, bobHz: 0.3, sway: 5, swayHz: 0.3, jitter: 0 },
    gaze: "dart", glow: { base: 0.96, pulse: 0, pulseHz: 0 }, accents: [], blink: 1, quirks: true,
  },
  reply: {
    eye: { w: 14, h: 18, gap: 27, y: -4, tilt: 0, smile: 1 },
    body: { squat: 1, breathe: 0.05, breatheHz: 1.2, bob: 3.4, bobHz: 1.15, sway: 4, swayHz: 0.6, jitter: 0 },
    gaze: "center", glow: { base: 1.1, pulse: 0.06, pulseHz: 1.15 }, accents: ["blush", "sparkle"], blink: 0.4, quirks: true,
  },
  error: {
    eye: { w: 12, h: 18, gap: 23, y: -3, tilt: 18, smile: 0 },
    body: { squat: 0.92, breathe: 0.02, breatheHz: 0.8, bob: 0.4, bobHz: 0.6, sway: 1.5, swayHz: 1.5, jitter: 1.1 },
    gaze: "center", glow: { base: 1.05, pulse: 0.22, pulseHz: 3.2 }, accents: ["flash", "sweat"], blink: 1.4, quirks: false,
  },
  launching: {
    eye: { w: 11, h: 16, gap: 24, y: -3, tilt: 0, smile: 0 },
    body: { squat: 0.9, breathe: 0.08, breatheHz: 1.4, bob: 1.4, bobHz: 1.4, sway: 1, swayHz: 0.6, jitter: 0 },
    gaze: "dart", glow: { base: 0.62, pulse: 0.2, pulseHz: 1.4 }, accents: [], blink: 2.2, quirks: false,
  },
  offline: {
    eye: { w: 15, h: 3.4, gap: 25, y: 0, tilt: 0, smile: 0 },
    body: { squat: 0.86, breathe: 0.045, breatheHz: 0.22, bob: 0, bobHz: 0.2, sway: 0, swayHz: 0.1, jitter: 0 },
    gaze: "down", glow: { base: 0.42, pulse: 0.03, pulseHz: 0.22 }, accents: ["zzz"], blink: 0, quirks: false,
  },
};

const ACCENT_NAMES = ["blush", "sweat", "bang", "question", "sparkle", "zzz", "dots", "flash"];

// --------------------------------------------------------------------------
// The shared animation loop
// --------------------------------------------------------------------------

const live = new Set();
let rafId = 0;
let lastT = 0;
let motionForced = false;

function motionAllowed() {
  return motionForced || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function loop(now) {
  const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
  lastT = now;
  let any = false;
  for (const f of live) {
    if (!f._visible) continue;
    any = true;
    f._tick(dt, now / 1000);
  }
  rafId = any && !document.hidden ? requestAnimationFrame(loop) : 0;
  if (!rafId) lastT = 0;
}
function wake() {
  if (!rafId && !document.hidden) rafId = requestAnimationFrame(loop);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake();
  });
}

/** Opt out of prefers-reduced-motion (the dashboard's own override). */
export function forceMotion(on) {
  motionForced = !!on;
  wake();
}

let observer = null;
function watch(face) {
  if (typeof IntersectionObserver === "undefined") {
    face._visible = true;
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const f = e.target.__face;
        if (f) f._visible = e.isIntersecting;
      }
      wake();
    });
  }
  observer.observe(face.el);
}

// --------------------------------------------------------------------------
// A face
// --------------------------------------------------------------------------

const SVGNS = "http://www.w3.org/2000/svg";
let uid = 0;
const svg = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

const CX = 50;
const CY = 54;
const R = 36;

/**
 * Creates a face inside `host` (it fills the host box).
 *
 * options: color, shape, state, seed (a stable string — the agent's name),
 *          follow ("pointer" | null) — eyes track the mouse/finger.
 */
export function createFace(host, options = {}) {
  const id = `sbf${++uid}`;
  const rand = seeded(options.seed || id);
  const root = svg("svg", {
    viewBox: "0 0 100 100",
    class: "sb-face",
    style: "width:100%;height:100%;overflow:visible;display:block",
    "aria-hidden": "true",
  });
  const defs = svg("defs", {}, root);
  const grad = svg("radialGradient", { id: `${id}g`, cx: "0.36", cy: "0.3", r: "0.8" }, defs);
  const stopHi = svg("stop", { offset: "0" }, grad);
  const stopMid = svg("stop", { offset: "0.55" }, grad);
  const stopLo = svg("stop", { offset: "1" }, grad);
  const glowGrad = svg("radialGradient", { id: `${id}w`, r: "0.5" }, defs);
  const glowIn = svg("stop", { offset: "0.55" }, glowGrad);
  svg("stop", { offset: "1", "stop-opacity": "0" }, glowGrad);

  const glow = svg("circle", { cx: CX, cy: CY, r: R * 1.55, fill: `url(#${id}w)`, opacity: "0" }, root);
  const shadow = svg("ellipse", { cx: CX, cy: CY + R + 5, rx: R * 0.72, ry: 3.2, fill: "#000", opacity: "0.28" }, root);
  const ring = svg("path", { fill: "none", "stroke-width": "2", opacity: "0" }, root);
  const body = svg("path", { fill: `url(#${id}g)` }, root);
  const flash = svg("path", { fill: "none", stroke: ACCENT.flash, "stroke-width": "3", "stroke-linejoin": "round", opacity: "0" }, root);
  const blushL = svg("ellipse", { rx: "6.5", ry: "3.6", fill: ACCENT.blush, opacity: "0" }, root);
  const blushR = svg("ellipse", { rx: "6.5", ry: "3.6", fill: ACCENT.blush, opacity: "0" }, root);
  const eyeL = svg("path", { "stroke-linejoin": "round", "stroke-width": "2" }, root);
  const eyeR = svg("path", { "stroke-linejoin": "round", "stroke-width": "2" }, root);
  const glintL = svg("circle", { r: "2.2", fill: "#fff", opacity: "0" }, root);
  const glintR = svg("circle", { r: "2.2", fill: "#fff", opacity: "0" }, root);
  const accents = svg("g", {}, root);
  const sweat = svg("path", { fill: ACCENT.sweat, opacity: "0", d: "M0,-7 C3,-2 5,1 5,3.5 A5,5 0 0 1 -5,3.5 C-5,1 -3,-2 0,-7Z" }, accents);
  const mkText = (txt, fill, size) => {
    const t = svg("text", {
      "font-family": "system-ui, sans-serif", "font-weight": "900", "font-size": size,
      "text-anchor": "middle", "dominant-baseline": "middle", fill, stroke: "#0b0b0f",
      "stroke-width": "2.2", "paint-order": "stroke", opacity: "0",
    }, accents);
    t.textContent = txt;
    return t;
  };
  const bang = mkText("!", ACCENT.bang, 26);
  const question = mkText("?", ACCENT.question, 24);
  const zzz = [0, 1, 2].map(() => mkText("z", ACCENT.zzz, 12));
  const dots = [0, 1, 2].map(() => svg("circle", { r: "3", fill: ACCENT.dots, opacity: "0" }, accents));
  const star = "M0,-5 C0.8,-1.2 1.2,-0.8 5,0 C1.2,0.8 0.8,1.2 0,5 C-0.8,1.2 -1.2,0.8 -5,0 C-1.2,-0.8 -0.8,-1.2 0,-5Z";
  const sparkles = [0, 1, 2].map(() => svg("path", { d: star, fill: ACCENT.sparkle, opacity: "0" }, accents));

  host.appendChild(root);

  // ---- state -------------------------------------------------------------
  const S = (v, k, d) => new Spring(v, k, d);
  const sp = {
    eyeW: S(12, 170, 0.62), eyeH: S(24, 170, 0.55), gap: S(26, 140, 0.8), eyeY: S(-4, 140, 0.8),
    tilt: S(0, 160, 0.7), smile: S(0, 150, 0.75),
    squat: S(1, 110, 0.6), sx: S(1, 260, 0.32), sy: S(1, 260, 0.32), ty: S(0, 170, 0.42), tx: S(0, 150, 0.6),
    rot: S(0, 140, 0.5), gazeX: S(0, 90, 0.75), gazeY: S(0, 90, 0.75), glow: S(1, 50, 1),
    open: S(1, 900, 1),
  };
  const amp = { breathe: S(0.035, 30, 1), bob: S(1.6, 30, 1), sway: S(2.5, 30, 1), jitter: S(0, 40, 1), pulse: S(0, 30, 1) };
  const hz = { breathe: S(0.32, 15, 1), bob: S(0.24, 15, 1), sway: S(0.16, 15, 1), pulse: S(0, 15, 1) };
  const phase = { breathe: rand() * TAU, bob: rand() * TAU, sway: rand() * TAU, pulse: 0, wob: rand() * 100 };
  const accent = Object.fromEntries(ACCENT_NAMES.map((n) => [n, S(0, 70, 0.8)]));

  let shape = SHAPE_FN[options.shape] ? options.shape : "blob";
  let fromShape = shape;
  let shapeT = 1;
  let baseRGB = toRGB(options.color || DEFAULT_COLOR);
  let state = EXPRESSIONS[options.state] ? options.state : "idle";
  let expr = EXPRESSIONS[state];
  let overrides = []; // {until, eye:{…}, accents:[…], gaze:{x,y}}
  // A 3D spin: a full turn (spinAng 0→±2π) about an axis lying in the screen
  // plane at angle spinAxis. Each spin draws its axis and direction at random
  // — sideways, a forward or backward flip, a diagonal roll — because one axis
  // every time read as a tic, not as life (owner, 29/09).
  let spinAng = 0, spinTo = 0, spinT = 1, spinDur = 0.9, spinAxis = Math.PI / 2;
  let nextBlink = 1 + rand() * 3;
  let nextQuirk = 3 + rand() * 5;
  let nextDart = 0;
  let dartX = 0, dartY = 0;
  let lastQuirk = "";
  let pxSize = 60;
  let followPointer = options.follow === "pointer";
  let pointer = null;
  let dirty = true; // reduced-motion repaint flag

  const applyExpression = (snap) => {
    expr = EXPRESSIONS[state];
    const e = expr.eye;
    for (const [k, key] of [["eyeW", "w"], ["eyeH", "h"], ["gap", "gap"], ["eyeY", "y"], ["tilt", "tilt"], ["smile", "smile"]]) {
      sp[k].target = e[key];
      if (snap) sp[k].snap(e[key]);
    }
    sp.squat.target = expr.body.squat;
    for (const k of ["breathe", "bob", "sway", "jitter"]) amp[k].target = expr.body[k];
    for (const k of ["breathe", "bob", "sway"]) hz[k].target = expr.body[`${k}Hz`];
    sp.glow.target = expr.glow.base;
    amp.pulse.target = expr.glow.pulse;
    hz.pulse.target = expr.glow.pulseHz;
    if (snap) {
      sp.squat.snap(expr.body.squat);
      sp.glow.snap(expr.glow.base);
      for (const k of Object.keys(amp)) amp[k].snap(amp[k].target);
      for (const k of Object.keys(hz)) hz[k].snap(hz[k].target);
    }
  };
  applyExpression(true);

  // Reactions -------------------------------------------------------------
  const later = []; // [time, fn]
  let clock = 0;
  const after = (s, fn) => later.push([clock + s, fn]);
  const override = (dur, o) => overrides.push({ until: clock + dur, ...o });
  const REACT = {
    poke() {
      sp.sx.kick(3.2); sp.sy.kick(-3.2);
      override(0.55, { eye: { smile: 0.9, h: 14 }, accents: ["blush"] });
    },
    cheer() {
      sp.ty.kick(-95); sp.sy.kick(2.6); sp.sx.kick(-1.6);
      after(0.38, () => { sp.ty.kick(-80); sp.sy.kick(2.2); sp.sx.kick(-1.4); });
      override(1.3, { eye: { smile: 1, h: 17, w: 14 }, accents: ["sparkle", "blush"] });
    },
    startle() {
      sp.ty.kick(-70); sp.sy.kick(3); sp.sx.kick(-2);
      override(0.8, { eye: { w: 15, h: 31, smile: 0, tilt: -6 }, accents: ["bang"] });
    },
    flinch() {
      sp.sx.kick(2.8); sp.sy.kick(-3.4); sp.tx.kick(-40);
      override(0.5, { eye: { h: 4, smile: 0.3 }, accents: ["sweat"] });
    },
    perk() {
      sp.sy.kick(2.4); sp.sx.kick(-1.4); sp.ty.kick(-30);
      override(0.7, { eye: { w: 14, h: 29 } });
    },
    spin() {
      // axis angle: π/2 = vertical axis (turns sideways), 0 = horizontal axis
      // (flips over), and the diagonals in between; plus a random direction.
      const AXES = [[Math.PI / 2, 4], [0, 3], [Math.PI / 4, 2], [(3 * Math.PI) / 4, 2]];
      let r = rand() * AXES.reduce((a, [, w]) => a + w, 0);
      spinAxis = AXES[0][0];
      for (const [ax, w] of AXES) {
        if ((r -= w) <= 0) {
          spinAxis = ax + (rand() - 0.5) * 0.35; // never exactly the same line
          break;
        }
      }
      spinTo = (rand() < 0.5 ? -1 : 1) * TAU;
      spinT = 0;
      spinDur = 0.8 + rand() * 0.35;
      sp.sy.kick(1.2);
    },
    nod() {
      sp.ty.kick(35);
      after(0.22, () => sp.ty.kick(30));
      override(0.6, { eye: { smile: 0.4 } });
    },
    wiggle() {
      sp.rot.kick(160);
      after(0.14, () => sp.rot.kick(-240));
      after(0.3, () => sp.rot.kick(160));
    },
    bounce() {
      sp.sy.kick(-3); sp.sx.kick(2.4);
      after(0.12, () => { sp.ty.kick(-85); sp.sy.kick(3.4); sp.sx.kick(-2); });
    },
  };
  // Idle quirks: small unprompted life, never the same twice in a row.
  const QUIRKS = {
    look() {
      override(1.4 + rand(), { gaze: { x: rand() * 2 - 1, y: rand() * 0.8 - 0.5 } });
    },
    blink2() {
      nextBlink = 0;
      after(0.26, () => { nextBlink = 0; });
    },
    stretch() {
      sp.sy.kick(1.6); sp.sx.kick(-1);
      override(0.9, { eye: { h: 8, smile: 0.2 } });
    },
    hop: () => REACT.bounce(),
    spin: () => REACT.spin(),
    wiggle: () => REACT.wiggle(),
    peek() {
      const side = rand() < 0.5 ? -1 : 1;
      sp.tx.kick(side * 60);
      override(1.2, { gaze: { x: side, y: 0 } });
    },
  };
  const QUIRK_WEIGHTS = [["look", 5], ["blink2", 3], ["stretch", 2], ["hop", 2], ["wiggle", 2], ["peek", 2], ["spin", 1]];
  const pickQuirk = () => {
    const pool = QUIRK_WEIGHTS.filter(([n]) => n !== lastQuirk);
    let r = rand() * pool.reduce((a, [, w]) => a + w, 0);
    for (const [n, w] of pool) {
      if ((r -= w) <= 0) return n;
    }
    return pool[0][0];
  };

  // Pointer follow ----------------------------------------------------------
  const onPointer = (ev) => {
    pointer = { x: ev.clientX, y: ev.clientY, at: performance.now() };
    wake();
  };
  if (followPointer) window.addEventListener("pointermove", onPointer, { passive: true });

  // Size tracking: motion is exaggerated on tiny faces so it stays visible.
  let resizeObs = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver(() => {
      pxSize = root.getBoundingClientRect().width || pxSize;
    });
    resizeObs.observe(root);
  }

  // ---- the frame -----------------------------------------------------------
  const face = {
    el: root,
    _visible: true,
    _tick(dt, t) {
      const moving = motionAllowed();
      // Reduced motion: jump straight to the pose, paint it once, and stop
      // until something changes (no loops, no idle quirks, no wasted frames).
      if (!moving) {
        if (!dirty) return;
        dirty = false;
      }
      clock += dt;

      // timers
      for (let i = later.length - 1; i >= 0; i--) {
        if (later[i][0] <= clock) {
          const fn = later[i][1];
          later.splice(i, 1);
          fn();
        }
      }
      overrides = overrides.filter((o) => o.until > clock);

      // targets = expression, then overrides on top (latest wins)
      const e = { ...expr.eye };
      let accentsOn = new Set(expr.accents);
      let gazeOv = null;
      for (const o of overrides) {
        if (o.eye) Object.assign(e, o.eye);
        if (o.accents) for (const a of o.accents) accentsOn.add(a);
        if (o.gaze) gazeOv = o.gaze;
      }
      sp.eyeW.target = e.w;
      sp.eyeH.target = e.h;
      sp.gap.target = e.gap;
      sp.eyeY.target = e.y;
      sp.tilt.target = e.tilt;
      sp.smile.target = e.smile;
      for (const n of ACCENT_NAMES) accent[n].target = accentsOn.has(n) ? 1 : 0;

      // gaze
      let gx = 0, gy = 0;
      if (gazeOv) {
        gx = gazeOv.x; gy = gazeOv.y;
      } else if (followPointer && pointer && performance.now() - pointer.at < 4000) {
        const r = root.getBoundingClientRect();
        const dx = pointer.x - (r.left + r.width / 2);
        const dy = pointer.y - (r.top + r.height / 2);
        const dist = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, dist / 180);
        gx = (dx / dist) * reach;
        gy = (dy / dist) * reach;
      } else {
        switch (expr.gaze) {
          case "scan": gx = Math.sin(t * 2.6 + phase.sway) * 0.7; gy = 0.25; break;
          case "up": gx = 0.55 + Math.sin(t * 0.7) * 0.15; gy = -0.75; break;
          case "down": gx = 0; gy = 0.3; break;
          case "dart":
            if (clock >= nextDart) {
              dartX = rand() * 1.8 - 0.9;
              dartY = rand() * 1 - 0.5;
              nextDart = clock + 0.7 + rand() * 1.6;
            }
            gx = dartX; gy = dartY; break;
          case "idle": gx = Math.sin(t * 0.37 + phase.bob) * 0.25; gy = Math.sin(t * 0.29) * 0.12; break;
          default: gx = 0; gy = 0;
        }
      }
      sp.gazeX.target = gx;
      sp.gazeY.target = gy;

      // blink
      if (expr.blink > 0 && moving) {
        nextBlink -= dt * expr.blink;
        if (nextBlink <= 0) {
          sp.open.x = 0.08;
          nextBlink = 1.6 + rand() * 4.4;
        }
      }
      sp.open.target = 1;

      // quirks
      if (moving && expr.quirks) {
        nextQuirk -= dt;
        if (nextQuirk <= 0) {
          const q = pickQuirk();
          lastQuirk = q;
          QUIRKS[q]();
          nextQuirk = 3.5 + rand() * 6;
        }
      }

      // springs
      const all = [...Object.values(sp), ...Object.values(amp), ...Object.values(hz), ...Object.values(accent)];
      if (moving) for (const s of all) s.step(dt);
      else for (const s of all) s.snap(s.target);
      // Squash/stretch and position relax back to rest.
      sp.sx.target = 1; sp.sy.target = 1; sp.ty.target = 0; sp.tx.target = 0; sp.rot.target = 0;

      // oscillators: phase accumulates, so a frequency change never jumps
      if (moving) {
        phase.breathe += TAU * hz.breathe.x * dt;
        phase.bob += Math.PI * hz.bob.x * dt; // |sin| bounces twice a cycle: hz = bounces/s
        phase.sway += TAU * hz.sway.x * dt;
        phase.pulse += TAU * hz.pulse.x * dt;
        phase.wob += dt;
      }
      // Tiny faces get bigger motion, or a 26px face "barely moves".
      const boost = 1 + clamp((90 - pxSize) / 90, 0, 1) * 1.1;
      const breathe = Math.sin(phase.breathe) * amp.breathe.x;
      const bob = -Math.abs(Math.sin(phase.bob)) * amp.bob.x * boost;
      const sway = Math.sin(phase.sway) * amp.sway.x;
      const jit = amp.jitter.x > 0.01 && moving ? (rand() - 0.5) * amp.jitter.x * 3 : 0;
      const intensity = sp.glow.x + Math.sin(phase.pulse) * amp.pulse.x;

      // spin (a full 3D turn), tweened rather than sprung
      if (spinT < 1) {
        spinT = Math.min(1, spinT + dt / spinDur);
        spinAng = easeInOut(spinT) * spinTo;
        if (spinT >= 1) spinAng = 0;
      }
      // Rotation axis (in the screen plane) and the direction the surface
      // travels across it.
      const axX = Math.cos(spinAxis), axY = Math.sin(spinAxis);
      const mvX = -axY, mvY = axX;
      const cosA = Math.cos(spinAng), sinA = Math.sin(spinAng);
      const facing = cosA;
      /** Rodrigues: a point on the body's surface, turned by the spin. */
      const turn3 = (x, y, z) => {
        const dot = axX * x + axY * y;
        // axis × v, with the axis (axX, axY, 0)
        const cx = axY * z, cy = -axX * z, cz = axX * y - axY * x;
        return [
          x * cosA + cx * sinA + axX * dot * (1 - cosA),
          y * cosA + cy * sinA + axY * dot * (1 - cosA),
          z * cosA + cz * sinA,
        ];
      };

      // ---- body geometry
      if (shapeT < 1) shapeT = Math.min(1, shapeT + dt * 3);
      const ra = shapeRadii(fromShape);
      const rb = shapeRadii(shape);
      const st = easeInOut(shapeT);
      const sx = sp.sx.x * (1 - breathe * 0.5);
      const sy = sp.sy.x * sp.squat.x * (1 + breathe);
      const pivotY = CY + R; // squash from the feet: it stays on the ground
      // Springs are in face units already: a cheer's kick lifts ~7% of the
      // face, a wiggle leans ~13°. (Scaling these down again is how the old
      // faces ended up moving "less than a millimetre" at rail size.)
      const oy = sp.ty.x * boost + bob;
      const ox = sp.tx.x + jit;
      const rotDeg = sp.rot.x + sway;
      const wobAmt = shape === "blob" ? 0.022 : 0.008;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const th = (i / N) * TAU;
        let r = lerp(ra[i], rb[i], st);
        r *= 1 + wobAmt * Math.sin(th * 3 + phase.wob * 1.3) + wobAmt * 0.7 * Math.sin(th * 2 - phase.wob * 0.9);
        const x = CX + R * r * Math.cos(th) * sx;
        const y = pivotY + (CY + R * r * Math.sin(th) - pivotY) * sy;
        pts.push([x, y]);
      }
      const d = smoothPath(pts);
      const tf = `translate(${ox.toFixed(2)},${oy.toFixed(2)}) rotate(${rotDeg.toFixed(2)},${CX},${pivotY})`;
      body.setAttribute("d", d);
      body.setAttribute("transform", tf);
      flash.setAttribute("d", d);
      flash.setAttribute("transform", tf);

      // shadow shrinks as the body leaves the ground
      const lift = clamp(-oy / 14, 0, 1);
      shadow.setAttribute("rx", (R * 0.72 * sx * (1 - lift * 0.35)).toFixed(2));
      shadow.setAttribute("opacity", (0.28 * (1 - lift * 0.6)).toFixed(3));

      // ---- colour: the owner's hue, only its intensity moves
      const c = intensityColor(baseRGB, intensity);
      stopHi.setAttribute("stop-color", css(mix(c, WHITE, 0.38)));
      stopMid.setAttribute("stop-color", css(c));
      stopLo.setAttribute("stop-color", css(mix(c, BLACK, 0.3)));
      // the highlight slides as it turns — the cheapest honest 3D cue
      grad.setAttribute("cx", (0.36 + mvX * sinA * 0.28).toFixed(3));
      grad.setAttribute("cy", (0.3 + mvY * sinA * 0.28).toFixed(3));
      const glowA = clamp((intensity - 1) * 3.2, 0, 0.55);
      glow.setAttribute("opacity", glowA.toFixed(3));
      glowIn.setAttribute("stop-color", css(c));
      ring.setAttribute("opacity", "0");

      // ---- eyes: they travel across the surface when it turns (a 3D spin),
      // foreshortening toward the edge and hiding behind it.
      // Eye colour follows the CHOSEN colour, not this frame's intensity: a
      // dimmed (asleep, booting) face flipping to white eyes looked like a
      // different creature.
      // Always BLACK eyes — they are the creature's face, and a light eye on
      // a dark body swallowed the white glint (owner, 29/09). On a dark body
      // the black eye gets a light rim instead, so it still reads.
      const eyeFill = "#0b0b0f";
      const darkBody = luminance(baseRGB) < 0.12;
      const eyeRim = darkBody ? css(mix(baseRGB, WHITE, 0.6)) : eyeFill;
      const gap = sp.gap.x;
      const ew = Math.max(sp.eyeW.x, 3);
      const eh = Math.max(sp.eyeH.x, 2);
      // tiny faces: eyes may never shrink below ~2.4px or they vanish
      const minPx = 2.4 * (100 / pxSize);
      const baseY = CY + sp.eyeY.x + sp.gazeY.x * 4.5;
      const thick = Math.max(4.2, minPx * 1.3);
      const RS = R * 0.95; // the sphere the eyes sit on
      const moveDeg = (Math.atan2(mvY, mvX) * 180) / Math.PI;
      for (const [side, eye, glint, blush] of [[-1, eyeL, glintL, blushL], [1, eyeR, glintR, blushR]]) {
        // the eye as a point on the sphere, facing us at rest, then turned
        const x0 = side * gap / 2;
        const y0 = baseY - CY;
        const z0 = Math.sqrt(Math.max(RS * RS - x0 * x0 - y0 * y0, 1));
        const [rx, ry, rz] = turn3(x0, y0, z0);
        const fore = rz / RS; // 1 = facing us, 0 = at the rim, <0 = behind
        const visible = fore > 0.08;
        const ex = CX + rx + sp.gazeX.x * 6 * facing;
        const ey = CY + ry;
        const w = Math.max(ew, minPx);
        const h = Math.max(eh, minPx);
        // foreshortened along the direction the surface is travelling
        const squeeze = clamp(fore / (z0 / RS), 0.15, 1);
        const p = eyePath(0, 0, w, h, sp.smile.x, clamp(sp.open.x, 0.08, 1), thick);
        // world position follows the body's squash, lift and lean
        const wx = CX + (ex - CX) * sx + ox;
        const wy = pivotY + (ey - pivotY) * sy + oy;
        eye.setAttribute("d", p);
        eye.setAttribute(
          "transform",
          `rotate(${rotDeg.toFixed(2)},${(CX + ox).toFixed(2)},${pivotY}) translate(${wx.toFixed(2)},${wy.toFixed(2)}) ` +
            `rotate(${moveDeg.toFixed(1)}) scale(${squeeze.toFixed(3)},1) rotate(${(-moveDeg).toFixed(1)}) ` +
            `rotate(${(-side * sp.tilt.x).toFixed(2)})`,
        );
        eye.setAttribute("fill", eyeFill);
        eye.setAttribute("stroke", eyeRim);
        eye.setAttribute("stroke-width", darkBody ? "1.6" : "2");
        eye.setAttribute("opacity", visible ? "1" : "0");
        const glintA = visible ? clamp(1 - sp.smile.x * 1.4, 0, 1) * clamp(sp.open.x * 1.2 - 0.2, 0, 1) * (h > 9 ? 0.9 : 0) : 0;
        glint.setAttribute("cx", (wx - w * 0.2 + sp.gazeX.x * 1.2).toFixed(2));
        glint.setAttribute("cy", (wy - h * 0.22).toFixed(2));
        glint.setAttribute("r", Math.max(w * 0.17, 1.2).toFixed(2));
        glint.setAttribute("opacity", glintA.toFixed(3));
        blush.setAttribute("cx", (wx + side * 3).toFixed(2));
        blush.setAttribute("cy", (wy + h / 2 + 6).toFixed(2));
        blush.setAttribute("opacity", (accent.blush.x * 0.6 * (visible ? 1 : 0)).toFixed(3));
      }

      // ---- accents, each in its own place and colour
      const topY = pivotY + (CY - R - pivotY) * sy + oy;
      const a = accent;
      flash.setAttribute("opacity", (a.flash.x * (0.35 + 0.65 * Math.max(0, Math.sin(phase.pulse)))).toFixed(3));
      const sweatCycle = (clock * 0.55) % 1;
      sweat.setAttribute("transform", `translate(${(CX + R * 0.78 * sx + ox).toFixed(2)},${(CY - R * 0.35 + sweatCycle * 10 + oy).toFixed(2)})`);
      sweat.setAttribute("opacity", (a.sweat.x * (1 - sweatCycle * 0.7)).toFixed(3));
      const pop = (s) => 0.4 + 0.6 * s;
      bang.setAttribute("transform", `translate(${(CX + R * 0.72 + ox).toFixed(2)},${(topY - 6).toFixed(2)}) scale(${pop(a.bang.x).toFixed(3)})`);
      bang.setAttribute("opacity", a.bang.x.toFixed(3));
      const qb = Math.sin(clock * 3) * 2;
      question.setAttribute("transform", `translate(${(CX + R * 0.75 + ox).toFixed(2)},${(topY - 5 + qb).toFixed(2)}) rotate(${(12 + qb * 3).toFixed(1)}) scale(${pop(a.question.x).toFixed(3)})`);
      question.setAttribute("opacity", a.question.x.toFixed(3));
      zzz.forEach((z, i) => {
        const k = (clock * 0.35 + i / 3) % 1;
        z.setAttribute("transform", `translate(${(CX + R * 0.55 + k * 16 + ox).toFixed(2)},${(topY + 4 - k * 22).toFixed(2)}) scale(${(0.7 + k * 0.7).toFixed(3)})`);
        z.setAttribute("opacity", (a.zzz.x * Math.sin(k * Math.PI)).toFixed(3));
      });
      dots.forEach((dt_, i) => {
        const k = (Math.sin(clock * 4 - i * 0.9) + 1) / 2;
        dt_.setAttribute("cx", (CX + R * 0.35 + i * 8 + ox).toFixed(2));
        dt_.setAttribute("cy", (topY - 6 - i * 3 + oy * 0).toFixed(2));
        dt_.setAttribute("r", (2.2 + k * 1.3).toFixed(2));
        dt_.setAttribute("opacity", (a.dots.x * (0.35 + 0.65 * k)).toFixed(3));
      });
      sparkles.forEach((s, i) => {
        const ang = -Math.PI / 2 + (i - 1) * 1.1 + Math.sin(clock * 1.3 + i) * 0.12;
        const tw = (Math.sin(clock * 5 + i * 2.1) + 1) / 2;
        const sx_ = CX + Math.cos(ang) * R * 1.32 + ox;
        const sy_ = CY + Math.sin(ang) * R * 1.32 + oy;
        s.setAttribute("transform", `translate(${sx_.toFixed(2)},${sy_.toFixed(2)}) scale(${(0.5 + tw * 0.8).toFixed(3)}) rotate(${(clock * 60 + i * 30).toFixed(1)})`);
        s.setAttribute("opacity", (a.sparkle.x * (0.3 + 0.7 * tw)).toFixed(3));
      });
    },

    /** Moves to another state; the body travels there, nothing cuts. */
    setState(next) {
      if (!EXPRESSIONS[next] || next === state) return face;
      state = next;
      applyExpression(false);
      dirty = true;
      wake();
      return face;
    },
    get state() {
      return state;
    },
    /** A one-shot on top of whatever the state is doing. */
    react(name) {
      if (REACT[name]) REACT[name]();
      wake();
      return face;
    },
    /** The body's colour — the owner's pick; states never change it. */
    setColor(color) {
      baseRGB = toRGB(color || DEFAULT_COLOR);
      dirty = true;
      wake();
      return face;
    },
    /** Morphs to another silhouette. */
    setShape(next) {
      if (!SHAPE_FN[next] || next === shape) return face;
      fromShape = shape;
      shape = next;
      shapeT = 1; // (animated below when motion is allowed)
      if (motionAllowed()) shapeT = 0;
      dirty = true;
      wake();
      return face;
    },
    /** Eyes track the pointer (true) or keep to the state's own gaze. */
    follow(on) {
      if (on && !followPointer) window.addEventListener("pointermove", onPointer, { passive: true });
      if (!on && followPointer) window.removeEventListener("pointermove", onPointer);
      followPointer = !!on;
      return face;
    },
    destroy() {
      live.delete(face);
      if (observer) observer.unobserve(root);
      if (resizeObs) resizeObs.disconnect();
      window.removeEventListener("pointermove", onPointer);
      root.remove();
    },
  };
  root.__face = face;
  live.add(face);
  watch(face);
  face._tick(0.016, performance.now() / 1000);
  wake();
  return face;
}
