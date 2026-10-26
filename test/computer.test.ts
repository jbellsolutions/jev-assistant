import { describe, expect, it } from "vitest";
import { FILE_ROOTS, MacComputer, appDisplayName, describeExecFailure } from "../server/computer.js";

function fake(mdfind: string, fail?: string, front: string[] = ["Slack"]) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const times: Record<string, number> = { "/Users/j/Documents/Resume 2026.pdf": 300, "/Users/j/Downloads/resume-old.docx": 100, "/Users/j/Desktop/Resume.pages": 200 };
  let polls = 0;
  const computer = new MacComputer(
    async (cmd, args) => {
      calls.push({ cmd, args });
      if (fail && `${cmd} ${args.join(" ")}`.includes(fail)) throw new Error(`Unable to find application named '${args.at(-1)}'`);
      return cmd === "mdfind" ? mdfind : "";
    },
    "/Users/j",
    async (p) => times[p] ?? 0,
    async () => front[Math.min(polls++, front.length - 1)] ?? "",
    async () => {},
  );
  return { computer, calls, frontPolls: () => polls };
}

describe("MacComputer", () => {
  it("opens apps by their display name and waits until the app is actually frontmost", async () => {
    // it takes a couple of polls for the launch to reach the foreground
    const late = fake("", undefined, ["Finder", "Finder", "Slack"]);
    expect(await late.computer.openApp("slack")).toBe("Opened Slack");
    expect(late.calls[0]).toEqual({ cmd: "open", args: ["-a", "Slack"] });
    expect(late.frontPolls()).toBe(3); // stopped as soon as Slack came to front
    expect(appDisplayName("slack")).toBe("Slack");
    const vs = fake("", undefined, ["Code"]); // lsappinfo reports "Code" for VS Code
    expect(await vs.computer.openApp("vs code")).toBe("Opened Visual Studio Code");
    await expect(fake("", "Nope").computer.openApp("nope")).rejects.toThrow("Nope"); // launcher errors surface as results, never crashes
  });

  it("finds files by name under the user's own folders, newest first, ignoring caches and code", async () => {
    const { computer, calls } = fake(
      ["/Users/j/Downloads/resume-old.docx", "/Users/j/Library/Caches/resume.tmp", "/Users/j/Documents/Resume 2026.pdf", "/Users/j/Desktop/app/node_modules/resume/index.js", "/Users/j/Desktop/Resume.pages", ""].join("\n"),
    );
    const found = await computer.findFiles("resume");
    expect(found).toEqual(["/Users/j/Documents/Resume 2026.pdf", "/Users/j/Desktop/Resume.pages", "/Users/j/Downloads/resume-old.docx"]);
    const args = calls[0]!.args;
    expect(calls[0]!.cmd).toBe("mdfind");
    expect(args.slice(0, 2)).toEqual(["-name", "resume"]);
    for (const root of FILE_ROOTS) expect(args).toContain(`/Users/j/${root}`);
    expect(await computer.findFiles("  ")).toEqual([]);
  });

  it("opens a path with `open` and names the file", async () => {
    const { computer, calls } = fake("");
    expect(await computer.openPath("/Users/j/Documents/Resume 2026.pdf")).toBe("Opened Resume 2026.pdf");
    expect(calls[0]).toEqual({ cmd: "open", args: ["/Users/j/Documents/Resume 2026.pdf"] });
  });
});

describe("MacComputer.control", () => {
  /** Records exact argv, and models which apps are actually running.
   *
   *  `running` matters: a guarded script that skips everything produces empty stdout, which is how
   *  `control()` tells "I paused Spotify" from "there was no Spotify to pause". Defaulting this to
   *  none would make every test assert the not-running path by accident. */
  function ctl(running: string[] = ["Spotify", "Music"]) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const computer = new MacComputer(
      async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd !== "osascript") return "";
        // stand in for osascript: the first guarded block whose app is running "returns" its name
        const script = args[1] ?? "";
        for (const m of script.matchAll(/if application "([^"]+)" is running/g)) if (running.includes(m[1]!)) return `${m[1]}\n`;
        return /^\s*(?:set volume|tell application "System Events")/.test(script) ? "" : "";
      },
      "/Users/j",
      async () => 0,
      async () => "Slack",
      async () => {},
    );
    return { computer, calls, scripts: () => calls.filter((c) => c.cmd === "osascript").map((c) => c.args[1]!) };
  }

  it("SAYS when there was nothing to act on, instead of claiming it worked", async () => {
    // The silent-success bug this codebase keeps rediscovering: with Spotify closed the guard
    // skipped everything and the panel still said "Spotify's a little quieter."
    const { computer } = ctl([]);
    await expect(computer.control({ target: "volume", action: "down", scope: "spotify" })).rejects.toThrow(/Spotify isn't open/);
    await expect(computer.control({ target: "media", action: "pause" })).rejects.toThrow(/Nothing's playing/);
    await expect(computer.control({ target: "media", action: "next", scope: "music" })).rejects.toThrow(/Music isn't open/);
  });

  it("acts on the player that is PLAYING, not on every open one", async () => {
    // "next track" with both apps open must not skip a track in both.
    const { computer, scripts } = ctl(["Spotify", "Music"]);
    await computer.control({ target: "media", action: "next" });
    const all = scripts();
    // the player-state pass runs before any merely-open pass
    expect(all[0]).toContain("player state is playing");
    expect(all[0]!.indexOf("player state")).toBeGreaterThanOrEqual(0);
    // and only ONE player was acted on
    const acted = all.filter((s) => s.includes("next track"));
    expect(acted).toHaveLength(1);
  });

  it("asks each player separately, so an app that is not installed cannot break the others", async () => {
    // Found live on 2026-09-25: `player state` and the constant `playing` are resolved from the app's
    // dictionary at COMPILE time, so naming a player that is not installed is a syntax error (-2741)
    // that kills the whole script. Spotify is absent from this Mac, and "pause the music" therefore
    // failed outright with Music sitting right there. A `try` cannot help — compilation happens first.
    const calls: string[] = [];
    const computer = new MacComputer(
      async (cmd, args) => {
        const script = args[1] ?? "";
        calls.push(script);
        if (script.includes("Spotify")) throw new Error('48:53: syntax error: Expected "," but found identifier. (-2741)');
        if (script.includes("player state")) return ""; // Music is open but paused
        return script.includes("Music") ? "Music\n" : "";
      },
      "/Users/j",
      async () => 0,
      async () => "Slack",
      async () => {},
    );
    await expect(computer.control({ target: "media", action: "pause" })).resolves.toMatch(/paused|pause/i);
    // Spotify was asked and failed; Music still got its turn
    expect(calls.some((c) => c.includes("Spotify"))).toBe(true);
    expect(calls.some((c) => c.includes('tell application "Music" to pause'))).toBe(true);
  });

  it("reports a permission wall as a permission wall, not as silence", async () => {
    // "Nothing's playing" when macOS is actually withholding Automation access sends the user looking
    // in entirely the wrong place.
    const computer = new MacComputer(
      async () => {
        throw new Error("macOS is blocking Jev from controlling other apps. Allow it under System Settings → Privacy & Security → Automation, then say it again.");
      },
      "/Users/j",
      async () => 0,
      async () => "Slack",
      async () => {},
    );
    await expect(computer.control({ target: "media", action: "pause" })).rejects.toThrow(/Privacy & Security → Automation/);
  });

  it("never launches an app it was asked to control", async () => {
    // `tell application "Spotify" to pause` LAUNCHES Spotify when it is closed — so "pause" on a
    // quiet Mac would start the very thing it was told to stop. `is running` is the one test that
    // does not itself launch it.
    const { computer, scripts } = ctl();
    await computer.control({ target: "media", action: "pause" });
    await computer.control({ target: "volume", action: "down", scope: "spotify" });
    await computer.control({ target: "media", action: "next" });
    for (const script of scripts()) {
      // The invariant: no `tell application "<player>"` may appear without a running-guard for it.
      // Asserting line-by-line shapes instead would just re-state the current formatting.
      const tells = [...script.matchAll(/tell application "(Spotify|Music)"/g)].map((m) => m[1]!);
      const guards = [...script.matchAll(/application "(Spotify|Music)" is running/g)].map((m) => m[1]!);
      for (const app of new Set(tells)) {
        expect(guards, script).toContain(app);
        expect(script.indexOf(`application "${app}" is running`), script).toBeLessThan(script.indexOf(`tell application "${app}"`));
      }
    }
  });

  it("considers every player when the user named none", async () => {
    const { computer, scripts } = ctl([]); // nothing running: every candidate gets asked
    await expect(computer.control({ target: "media", action: "next" })).rejects.toThrow(/Nothing's playing/);
    const all = scripts().join("\n");
    expect(all).toContain('application "Spotify" is running');
    expect(all).toContain('application "Music" is running');
    expect(all).toContain("next track");
  });

  it("acts on only the app the user named", async () => {
    const { computer, scripts } = ctl();
    await computer.control({ target: "media", action: "play", scope: "music" });
    const all = scripts().join("\n");
    expect(all).not.toContain("Spotify"); // the other player is never even asked
    expect(all).toContain('tell application "Music"');
    expect(all).toMatch(/\bplay\b/);
  });

  it("changes the system volume without a second round trip", async () => {
    // read-then-write in one osascript: two processes could interleave with the user's own volume
    // key, and would cost an extra spawn for nothing.
    const { computer, scripts } = ctl();
    await computer.control({ target: "volume", action: "down" });
    // The exact string, because it is AppleScript source that this suite cannot execute. An
    // earlier version of this line asserted `(... max 0 min 100)` — which this test accepted and
    // real osascript rejected with -2741 on every single call. `set volume output volume` clamps
    // on its own, verified against a real Mac.
    expect(scripts()[0]).toBe("set volume output volume ((output volume of (get volume settings)) - 20)");
  });

  it("unmutes when told to turn it up, because a louder muted Mac should make noise", async () => {
    const { computer, scripts } = ctl();
    await computer.control({ target: "volume", action: "up" });
    expect(scripts()).toEqual(["set volume output volume ((output volume of (get volume settings)) + 20)", "set volume output muted false"]);
  });

  it("mutes, unmutes and sets a named level exactly", async () => {
    const { computer, scripts } = ctl();
    await computer.control({ target: "volume", action: "mute" });
    await computer.control({ target: "volume", action: "unmute" });
    await computer.control({ target: "volume", action: "set", level: "silent" });
    await computer.control({ target: "volume", action: "set", level: "max" });
    expect(scripts()).toEqual(["set volume output muted true", "set volume output muted false", "set volume output volume 0", "set volume output volume 100"]);
  });

  it("switches appearance through System Events", async () => {
    const { computer, scripts } = ctl();
    await computer.control({ target: "display", action: "dark_on" });
    await computer.control({ target: "display", action: "toggle" });
    expect(scripts()[0]).toBe('tell application "System Events" to tell appearance preferences to set dark mode to true');
    expect(scripts()[1]).toBe('tell application "System Events" to tell appearance preferences to set dark mode to not dark mode');
  });

  it("locks with the shortcut macOS actually still has, and sleeps with pmset", async () => {
    const { computer, calls } = ctl();
    await computer.control({ target: "system", action: "lock" });
    await computer.control({ target: "system", action: "sleep" });
    // ⌃⌘Q is macOS's own Lock Screen shortcut and locks immediately. The obvious-looking
    // `CGSession -suspend` is DEAD: its User.menu bundle no longer exists (checked on macOS 15.6),
    // so the earlier version of this test asserted argv for a binary that could never have run.
    expect(calls[0]).toEqual({ cmd: "osascript", args: ["-e", 'tell application "System Events" to keystroke "q" using {control down, command down}'] });
    expect(calls[1]).toEqual({ cmd: "pmset", args: ["sleepnow"] });
  });

  it("reports what it did in words a person would use", async () => {
    const { computer } = ctl();
    expect(await computer.control({ target: "volume", action: "down", scope: "spotify" })).toBe("Turn Spotify down");
    expect(await computer.control({ target: "system", action: "lock" })).toBe("Lock the screen");
  });
});

describe("what a blocked Mac command says", () => {
  // Both of these arrive on the FIRST run of a newly built app — an Apple Events grant is per-binary,
  // so every rebuild is a new binary and a new prompt. Neither produced a usable message before.
  it("explains the permission dialog rather than reporting a signal", () => {
    // osascript blocks while macOS asks, a human takes longer than the timeout to answer, and the
    // process is killed with an empty stderr. "Command failed ... SIGTERM" tells the user nothing.
    const said = describeExecFailure({ message: "Command failed: osascript -e ...", killed: true, signal: "SIGTERM" }, "");
    expect(said).toMatch(/allow Jev/i);
    expect(said).toMatch(/Automation/);
    expect(said).toMatch(/say it again/);
    expect(said).not.toMatch(/SIGTERM/);
  });

  it("names the exact setting when the grant was refused", () => {
    const denied = describeExecFailure({ message: "Command failed" }, "execution error: Not authorized to send Apple events to Spotify. (-1743)");
    expect(denied).toMatch(/Privacy & Security → Automation/);
    const ax = describeExecFailure({ message: "Command failed" }, "osascript is not allowed assistive access. (-25211)");
    expect(ax).toMatch(/Privacy & Security → Accessibility/);
  });

  it("still passes an ordinary failure through, and keeps the friendly app-not-found line", () => {
    expect(describeExecFailure({ message: "x" }, "Unable to find application named 'Sloack'")).toBe("I couldn't find an app called Sloack");
    expect(describeExecFailure({ message: "something else broke" }, "")).toBe("something else broke");
  });
});
