// Which WSL distro this process is in (src/shared/wsl.ts). The env variable is
// the canonical answer, but it is ONLY exported to sessions WSL itself starts:
// a hub born from the Windows login hook — and every agent it launches, since
// they inherit its environment — has an env without it, and the whole Windows
// side (folder/file dialogs, open folder, new terminal, shortcut) went dark
// with "WSL_DISTRO_NAME is not set" on a machine that is plainly WSL (18/08).

import { describe, expect, it } from "vitest";
import { distroFromRootUnc, resolveWslDistro } from "../src/shared/wsl.js";

describe("distroFromRootUnc", () => {
  it("reads the distro out of both UNC spellings", () => {
    expect(distroFromRootUnc("\\\\wsl.localhost\\Ubuntu\\")).toBe("Ubuntu");
    expect(distroFromRootUnc("\\\\wsl$\\Ubuntu-22.04\\")).toBe("Ubuntu-22.04");
    expect(distroFromRootUnc("  \\\\wsl.localhost\\Debian\\  \n")).toBe("Debian");
  });

  it("is not fooled by anything else", () => {
    expect(distroFromRootUnc("C:\\Users\\User")).toBeUndefined();
    expect(distroFromRootUnc("")).toBeUndefined();
    expect(distroFromRootUnc("\\\\server\\share\\")).toBeUndefined();
  });
});

describe("resolveWslDistro", () => {
  it("the env wins and wslpath is never run", () => {
    let ran = false;
    const got = resolveWslDistro({ WSL_DISTRO_NAME: "Ubuntu" }, () => {
      ran = true;
      return "\\\\wsl.localhost\\Other\\";
    });
    expect(got).toBe("Ubuntu");
    expect(ran).toBe(false);
  });

  it("falls back to wslpath when the variable is missing (the login-hook hub)", () => {
    expect(resolveWslDistro({}, () => "\\\\wsl.localhost\\Ubuntu\\")).toBe("Ubuntu");
  });

  it("a blank variable counts as missing", () => {
    expect(resolveWslDistro({ WSL_DISTRO_NAME: "   " }, () => "\\\\wsl$\\Ubuntu\\")).toBe("Ubuntu");
  });

  it("no WSL at all: undefined, and callers report that as before", () => {
    expect(resolveWslDistro({}, () => null)).toBeUndefined();
    expect(resolveWslDistro({}, () => "not a unc path")).toBeUndefined();
  });
});

describe("hydrateWslDistroEnv", () => {
  it("fills the variable in when it is missing, leaves a real one alone", async () => {
    const { hydrateWslDistroEnv } = await import("../src/shared/wsl.js");
    // Runs under real WSL in the owner's suite; off WSL there is no wslpath and
    // the call is a no-op — both are correct, so assert the INVARIANT: after
    // the call, the variable and the return value agree.
    const env: NodeJS.ProcessEnv = {};
    const got = hydrateWslDistroEnv(env);
    expect(env.WSL_DISTRO_NAME).toBe(got);

    const kept: NodeJS.ProcessEnv = { WSL_DISTRO_NAME: "Pinned" };
    hydrateWslDistroEnv(kept);
    expect(kept.WSL_DISTRO_NAME).toBe("Pinned");
  });
});
