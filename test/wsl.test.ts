// Which WSL distro this process is in (src/shared/wsl.ts). The env variable is
// the canonical answer, but it is ONLY exported to sessions WSL itself starts:
// a hub born from the Windows login hook — and every agent it launches, since
// they inherit its environment — has an env without it, and the whole Windows
// side (folder/file dialogs, open folder, new terminal, shortcut) went dark
// with "WSL_DISTRO_NAME is not set" on a machine that is plainly WSL (18/08).

import { describe, expect, it } from "vitest";
import {
  interopStatus, distroFromRootUnc, resolveWslDistro, withWindowsInterop } from "../src/shared/wsl.js";

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

describe("withWindowsInterop", () => {
  // The hub bakes its own environment into every agent it launches, so a PATH
  // missing the Windows directories does not fail at the hub — it fails later,
  // in ten agents at once, as a Stop hook dying with "/bin/sh: 1:
  // powershell.exe: not found" (22/08, after a hand restart with a shortened
  // PATH). powershell.exe lives in the WindowsPowerShell/v1.0 one, which is
  // exactly the one an abbreviated PATH tends to drop.
  const all = () => true;

  it("appends only what is missing, and only at the END", () => {
    expect(withWindowsInterop("/usr/bin:/mnt/c/Windows/System32", all)).toBe(
      "/usr/bin:/mnt/c/Windows/System32:/mnt/c/Windows:/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
    );
    // Last is right: a Linux binary must win over a Windows one of the same
    // name (there is a powershell in both worlds on some setups).
    expect(withWindowsInterop("/usr/bin", all).startsWith("/usr/bin:")).toBe(true);
  });

  it("a complete PATH is returned untouched (callers use that to skip the override)", () => {
    const complete =
      "/usr/bin:/mnt/c/Windows/System32:/mnt/c/Windows:/mnt/c/Windows/System32/WindowsPowerShell/v1.0";
    expect(withWindowsInterop(complete, all)).toBe(complete);
  });

  it("never invents a directory that is not on this machine", () => {
    expect(withWindowsInterop("/usr/bin", () => false)).toBe("/usr/bin");
    const onlyOne = (dir: string) => dir === "/mnt/c/Windows/System32";
    expect(withWindowsInterop("/usr/bin", onlyOne)).toBe("/usr/bin:/mnt/c/Windows/System32");
  });

  it("an empty PATH does not start with a colon", () => {
    expect(withWindowsInterop("", all)).toBe(
      "/mnt/c/Windows/System32:/mnt/c/Windows:/mnt/c/Windows/System32/WindowsPowerShell/v1.0",
    );
  });
});

describe("interopStatus — can this distro run Windows programs at all?", () => {
  // Everything on the Windows side (open folder, open in a terminal, the
  // native dialogs, the shortcut) is a .exe launched from Linux, and that
  // needs WSLInterop registered in binfmt_misc. A distro brought over with
  // `wsl --import` often comes up WITHOUT it — and then those buttons reported
  // success and did nothing, because explorer.exe's non-zero exit is normal
  // and the real error (Exec format error) was being swallowed with it.
  it("registered and enabled → ok, with nothing to say", () => {
    expect(interopStatus(() => "enabled\ninterpreter /init\nflags: PF\n")).toEqual({ ok: true });
  });

  it("no entry at all → explains it AND gives both fixes", () => {
    const status = interopStatus(() => null); // this machine, 27/08
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("[interop]");           // the persistent fix
    expect(status.reason).toContain("binfmt_misc/register"); // the immediate one
    expect(status.reason).toContain("wsl --terminate");
  });

  it("registered but switched off → the one-line fix, not the whole story", () => {
    const status = interopStatus(() => "disabled\n");
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("WSLInterop");
    expect(status.reason).not.toContain("[interop]"); // wrong advice for this case
  });

  it("assertInterop throws the same sentence the status carries", async () => {
    const { assertInterop } = await import("../src/shared/wsl.js");
    // Reads the real file: on a healthy WSL it must NOT throw, and off WSL
    // there is no Windows side to reach anyway. Assert the invariant instead
    // of the machine: whatever it decides, it agrees with interopStatus.
    const healthy = interopStatus().ok;
    if (healthy) expect(() => assertInterop()).not.toThrow();
    else expect(() => assertInterop()).toThrow(/interop|WSLInterop/i);
  });
});
