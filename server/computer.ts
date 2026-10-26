/** The Mac lane's launcher: applications with `open -a` (which also brings a running app to
 *  the front), files by name through Spotlight (`mdfind`), opened with `open`. Acting inside
 *  an app is the Mac executor's job. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { type Control, LEVEL_PERCENT, type Player, SCRIPTABLE_PLAYERS, describeControl } from "../core/controls.js";
import type { Computer } from "../core/session.js";

type Run = (cmd: string, args: string[]) => Promise<string>;

/** Folders whose contents are never "my resume": caches, code dependencies, app bundles. */
const NOISE = /\/(?:Library|node_modules|\.[^/]+|\.git|dist|build|target|venv|__pycache__)\//;
/** Where people keep the files they ask for by name. */
export const FILE_ROOTS = ["Documents", "Desktop", "Downloads", "Movies", "Music", "Pictures", "iCloud Drive"];

const DISPLAY_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  "vs code": "Visual Studio Code",
  "system preferences": "System Settings",
  iterm: "iTerm",
  word: "Microsoft Word",
  excel: "Microsoft Excel",
  powerpoint: "Microsoft PowerPoint",
  outlook: "Microsoft Outlook",
  teams: "Microsoft Teams",
};

/** "vs code" -> "Visual Studio Code"; otherwise Title Case, which is what most bundles are called. */
export function appDisplayName(app: string): string {
  const key = app.trim().toLowerCase();
  return DISPLAY_NAMES[key] ?? key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Raised when a control was understood but there was nothing to act on — a player that is not
 *  open, so nothing happened. Distinct from a failure: Jev heard correctly, it just found an empty
 *  room. The session reports it as a warning in the user's own terms. */
export class NotRunning extends Error {
  // core/controls.ts's isNotRunning() matches on this, because core cannot import from server/.
  override readonly name = "NotRunning";
}

/** How much one "louder"/"quieter" moves the volume. hey-jev uses 20; a spoken correction is one
 *  more word, so a step you can actually hear beats a step you have to repeat. */
export const VOLUME_STEP = 20;

/** AppleScript display names for the players Jev can talk to. */
const PLAYER_APP: Record<Player, string> = { spotify: "Spotify", music: "Music" };

/** Wrap a script so it does nothing at all when the app is not already running, and so that it
 *  SAYS whether it ran.
 *
 *  Two separate bugs live here. Without the guard, `tell application "Spotify" to pause` LAUNCHES
 *  Spotify — so "pause" on a quiet Mac would start the very thing it was asked to stop;
 *  `application "X" is running` is the one test that does not itself launch it. And without the
 *  marker, a guard that skipped everything still returned "Paused." to the panel — the
 *  silent-success failure this codebase keeps rediscovering, where doing nothing and doing the job
 *  are indistinguishable to the person who asked. */
function ifRunning(app: string, script: string): string {
  return `if application "${app}" is running then\n${script}\nreturn "${app}"\nend if`;
}

export class MacComputer implements Computer {
  constructor(
    private readonly run: Run = exec,
    private readonly home = homedir(),
    private readonly mtime: (path: string) => Promise<number> = (p) => stat(p).then((s) => s.mtimeMs),
    /** The frontmost app's name (default: `lsappinfo`); used to wait until a launch has focus. */
    private readonly frontName: () => Promise<string> = frontApp,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Volume, playback, appearance and power — the twenty-odd things people say out loud to a Mac.
   *
   *  Everything goes through the same injected `run` seam as openApp, so each one is asserted
   *  against exact argv in test/computer.test.ts rather than being tried on a real machine.
   *
   *  Permissions worth knowing before this is debugged: anything that talks to "System Events"
   *  (dark mode) needs Apple Events, which macOS attributes to Jev.app and prompts for once —
   *  hence NSAppleEventsUsageDescription in package.json. Without that key the call is refused
   *  outright with error -1743 and NO prompt, which looks like a broken feature rather than a
   *  missing grant. Grants given in dev do not carry to the packaged app. */
  async control(c: Control): Promise<string> {
    const osa = (script: string) => this.run("osascript", ["-e", script]);
    const done = describeControl(c);

    switch (c.target) {
      case "volume": {
        if (c.scope) {
          const app = PLAYER_APP[c.scope];
          const level = c.action === "set" ? LEVEL_PERCENT[c.level ?? "half"] : null;
          const target =
            level !== null
              ? String(level)
              : c.action === "mute"
                ? "0"
                : c.action === "unmute"
                  ? String(LEVEL_PERCENT.half)
                  : `(sound volume of application "${app}" ${c.action === "up" ? "+" : "-"} ${VOLUME_STEP})`;
          const ran = await osa(ifRunning(app, `tell application "${app}" to set sound volume to ${target}`));
          if (!ran.trim()) throw new NotRunning(`${app} isn't open`);
          return done;
        }
        if (c.action === "mute") await osa("set volume output muted true");
        else if (c.action === "unmute") await osa("set volume output muted false");
        else if (c.action === "set") await osa(`set volume output volume ${LEVEL_PERCENT[c.level ?? "half"]}`);
        else {
          // Read-then-write in ONE osascript: two round trips could interleave with the user's own
          // volume key, and would cost a second process for no reason.
          const delta = c.action === "up" ? `+ ${VOLUME_STEP}` : `- ${VOLUME_STEP}`;
          // No clamping: `set volume output volume` clamps by itself (verified live — -30 lands on
          // 0, 150 on 100). The first draft wrote `(... max 0 min 100)`, which is not AppleScript
          // syntax at all and failed with -2741 every time, while the unit test asserting the
          // exact string passed happily. A shell-out's argv is only half the contract.
          await osa(`set volume output volume ((output volume of (get volume settings)) ${delta})`);
          // unmuting is implied by turning it up: a muted Mac that gets louder should make noise
          if (c.action === "up") await osa("set volume output muted false");
        }
        return done;
      }

      case "media": {
        const verb = { play: "play", pause: "pause", next: "next track", previous: "previous track" }[c.action];
        // Named an app: only that one. Named none: whichever player is already running, preferring
        // one that is actually playing. Nothing running means nothing to control — say so rather
        // than launching a music app nobody asked for.
        // Named an app: only that one. Named none: the player that is actually PLAYING, else the
        // first one that is merely open. Acting on every running player at once would skip a track
        // in Music as well as Spotify, which is not what "next track" means.
        const players = c.scope ? [c.scope] : [...SCRIPTABLE_PLAYERS];
        const act = (p: Player) => `tell application "${PLAYER_APP[p]}" to ${verb}`;

        // One osascript PER PLAYER, and this is not a style choice.
        //
        // `player state` and the constant `playing` come from the app's own dictionary, and
        // AppleScript resolves those at COMPILE time — so naming a player that is not installed is a
        // syntax error (-2741) that kills the whole script, including the players that ARE installed.
        // Spotify is absent from this Mac, which made "pause the music" fail outright even though
        // Music was right there. A `try` block does not help: compilation happens first. Splitting the
        // script means a missing app fails only its own attempt, which is exactly the skip we want.
        //
        // (`tell application "X" to pause` alone compiles without the app, because the verb needs no
        // enumerated constant — which is why the fallback pass below can stay as one script.)
        let blocked: unknown = null;
        const tryEach = async (script: (p: Player) => string): Promise<boolean> => {
          for (const p of players) {
            try {
              if ((await osa(script(p))).trim()) return true;
            } catch (err) {
              blocked = err; // an uninstalled app, or a permission Jev has not been granted
            }
          }
          return false;
        };

        // First the player actually PLAYING: acting on every running player at once would skip a
        // track in Music as well as Spotify, which is not what "next track" means.
        const playing = (p: Player) => `if application "${PLAYER_APP[p]}" is running then\ntell application "${PLAYER_APP[p]}"\nif player state is playing then\n${verb}\nreturn "${PLAYER_APP[p]}"\nend if\nend tell\nend if`;
        if (await tryEach(playing)) return done;
        // Then whichever is merely open.
        if (await tryEach((p) => ifRunning(PLAYER_APP[p], act(p)))) return done;

        // Nothing answered. If something was refusing us rather than absent, say THAT — reporting
        // "Nothing's playing" when macOS is withholding permission sends the user looking in the
        // wrong place entirely.
        if (blocked && /allow jev|privacy & security/i.test(String((blocked as Error)?.message ?? ""))) throw blocked;
        throw new NotRunning(c.scope ? `${PLAYER_APP[c.scope]} isn't open` : "Nothing's playing");
      }

      case "display": {
        const value = { dark_on: "true", dark_off: "false", toggle: "not dark mode" }[c.action];
        await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${value}`);
        return done;
      }

      // Timers are the session's, not the Mac's: firing one means SPEAKING, which this lane knows
      // nothing about. Reaching here at all is a wiring mistake, so it says so rather than no-oping.
      case "timer":
        throw new Error("timers are handled by the session, not the Mac lane");

      case "system": {
        if (c.action === "sleep") await this.run("pmset", ["sleepnow"]);
        // ⌃⌘Q is macOS's own Lock Screen shortcut, and it locks IMMEDIATELY regardless of the
        // screen-lock grace period (on this Mac that grace period is 3600s, so the screensaver and
        // display-sleep routes would not ask for a password at all — they would only look locked).
        //
        // The obvious-looking alternative, `CGSession -suspend`, is dead: the User.menu bundle it
        // lives in was removed, and on macOS 15.6 that path does not exist. A unit test asserting
        // its argv passed happily while the real command could never have run — the same trap as
        // the invented `max 0 min 100` AppleScript.
        //
        // Cost of this route: it needs the Accessibility grant, which is separate from Apple
        // Events and prompts on first use.
        else await osa('tell application "System Events" to keystroke "q" using {control down, command down}');
        return done;
      }
    }
  }

  /** Launch or focus an app, then wait until it is actually the frontmost app (up to ~1.6 s) so
   *  the next step of a spoken sequence — "open slack and click general" — snapshots Slack, not
   *  whatever was in front when the launch was still starting up. */
  async openApp(app: string): Promise<string> {
    const name = appDisplayName(app);
    await this.run("open", ["-a", name]);
    const want = name.toLowerCase();
    for (let i = 0; i < 8; i++) {
      const front = (await this.frontName().catch(() => "")).toLowerCase();
      if (front && (front === want || front.includes(want) || want.includes(front))) break;
      await this.sleep(200);
    }
    return `Opened ${name}`;
  }

  /** Spotlight by file name under the user's own folders, newest first. `mdfind -name` matches
   *  the display name case-insensitively as a substring, so "resume" finds "Resume 2026.pdf". */
  async findFiles(query: string): Promise<string[]> {
    const q = query.trim();
    if (!q) return [];
    const args = ["-name", q];
    for (const root of FILE_ROOTS) args.push("-onlyin", `${this.home}/${root}`);
    let out: string;
    try {
      out = await this.run("mdfind", args);
    } catch {
      out = "";
    }
    const paths = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l));
    const dated = await Promise.all(paths.map(async (p) => ({ p, t: await this.mtime(p).catch(() => 0) })));
    return dated.sort((a, b) => b.t - a.t).map((d) => d.p);
  }

  async openPath(path: string): Promise<string> {
    await this.run("open", [path]);
    const name = path.split("/").pop() ?? path;
    return `Opened ${name}`;
  }
}

/** The frontmost application's display name, via `lsappinfo` (fast, no TCC prompt). */
function frontApp(): Promise<string> {
  return new Promise((resolve) =>
    execFile("/bin/sh", ["-c", 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 3000 }, (_e, out) => {
      const m = /"LSDisplayName"\s*=\s*"(.*)"/.exec(String(out));
      resolve(m ? m[1]! : "");
    }),
  );
}

/** How long to wait on a shelled-out command. Long enough for AppleScript, short enough that the
 *  panel does not appear to hang — but NOT long enough for a human to find and answer a macOS consent
 *  dialog, which is why `describeExecFailure` exists. */
export const EXEC_TIMEOUT_MS = 10_000;

/** Turn a failed shell-out into something the user can act on.
 *
 *  Two of these are certainties rather than edge cases, and both arrive on the FIRST run of a newly
 *  built app, because an Apple Events grant is per-binary and a rebuilt bundle is a new binary:
 *
 *  - The consent dialog ("Jev wants to control Spotify") blocks osascript until it is answered, and a
 *    human needs longer than the timeout to find it and click. The command is killed with an empty
 *    stderr and a message about a signal, which tells him nothing at all.
 *  - A denial comes back as AppleScript error -1743, whose own wording does not mention where the
 *    switch is.
 *
 *  Exported and pure so the mapping is testable without provoking a real TCC prompt. */
export function describeExecFailure(err: { message?: string; killed?: boolean; signal?: string | null; code?: number | string | null }, stderr: string): string {
  const text = String(stderr || err.message || "").trim();
  if (err.killed || err.signal === "SIGTERM") {
    return "That took too long — macOS was probably asking you to allow Jev to control the app. Answer that dialog (or allow Jev under System Settings → Privacy & Security → Automation), then say it again.";
  }
  if (/-1743|not authorized to send apple events/i.test(text)) {
    return "macOS is blocking Jev from controlling other apps. Allow it under System Settings → Privacy & Security → Automation, then say it again.";
  }
  if (/-25211|assistive access|accessibility/i.test(text)) {
    return "macOS is blocking Jev from using the keyboard and mouse. Allow it under System Settings → Privacy & Security → Accessibility, then say it again.";
  }
  return text.replace(/^Unable to find application named '(.*)'$/, "I couldn't find an app called $1");
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(describeExecFailure(err, String(stderr ?? ""))));
      else resolve(String(stdout ?? ""));
    });
  });
}

export function selectComputer(env: NodeJS.ProcessEnv = process.env, platform = process.platform): MacComputer | null {
  if (platform !== "darwin" || env.JEV_COMPUTER === "off") return null;
  return new MacComputer();
}
