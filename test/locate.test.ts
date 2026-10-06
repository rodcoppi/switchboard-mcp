// Relative paths agents write (owner, 06/10: "nunca funciona essa merda"):
// the video editor named `53/_trabalho/S53-SEM-CAPA.mp4`, relative to a
// Shorts folder on OneDrive, and the board joined it to the agent's own
// folder — "File not found", every time the work was anywhere else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateRelativePath } from "../src/server/api.js";

let dir: string;
let cwd: string;
let elsewhere: string;
let transcript: string;

const line = (o: unknown): string => JSON.stringify(o) + "\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-locate-"));
  cwd = path.join(dir, "home", "video-editor");
  // Under a /tmp root the transcript scan recognises as the start of a path.
  elsewhere = path.join(dir, "OneDrive", "ai panorama", "00 Shorts");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(elsewhere, "53", "_trabalho"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "53", "_trabalho", "S53-SEM-CAPA.mp4"), "video");
  fs.writeFileSync(path.join(elsewhere, "53", "_trabalho", "S53-PREVIA.mp4"), "video");
  transcript = path.join(dir, "t.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("finding a relative path where it really is", () => {
  it("takes the agent's folder first, when it is there", () => {
    fs.mkdirSync(path.join(cwd, "53", "_trabalho"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "53", "_trabalho", "S53-SEM-CAPA.mp4"), "here");
    expect(locateRelativePath("53/_trabalho/S53-SEM-CAPA.mp4", cwd, null, [])).toBe(
      path.join(cwd, "53", "_trabalho", "S53-SEM-CAPA.mp4"),
    );
  });

  it("finds it through the full path the agent wrote for it earlier", () => {
    const full = path.join(elsewhere, "53", "_trabalho", "S53-SEM-CAPA.mp4");
    fs.writeFileSync(transcript, line({ type: "assistant", text: `rendered ${full} ok` }) + line({ type: "assistant", text: "it is in `53/_trabalho/S53-SEM-CAPA.mp4`" }));
    expect(locateRelativePath("53/_trabalho/S53-SEM-CAPA.mp4", cwd, transcript, [])).toBe(full);
  });

  it("finds it through the folder's full path, written for ANOTHER file in it", () => {
    // The real case: only the preview's full path was ever written.
    const preview = path.join(elsewhere, "53", "_trabalho", "S53-PREVIA.mp4");
    fs.writeFileSync(transcript, line({ files: [preview] }) + line({ text: "full file in `53/_trabalho/S53-SEM-CAPA.mp4`" }));
    expect(locateRelativePath("53/_trabalho/S53-SEM-CAPA.mp4", cwd, transcript, [])).toBe(
      path.join(elsewhere, "53", "_trabalho", "S53-SEM-CAPA.mp4"),
    );
  });

  it("tries the folders the board knows when the conversation says nothing", () => {
    expect(locateRelativePath("53/_trabalho/S53-SEM-CAPA.mp4", cwd, null, [elsewhere])).toBe(
      path.join(elsewhere, "53", "_trabalho", "S53-SEM-CAPA.mp4"),
    );
  });

  it("never answers with a file that does not exist", () => {
    const preview = path.join(elsewhere, "53", "_trabalho", "S53-PREVIA.mp4");
    fs.writeFileSync(transcript, line({ files: [preview] }));
    expect(locateRelativePath("53/_trabalho/NOPE.mp4", cwd, transcript, [elsewhere])).toBeNull();
  });

  it("refuses to climb out with ..", () => {
    expect(locateRelativePath("../../etc/passwd", cwd, null, [elsewhere])).toBeNull();
  });
});
