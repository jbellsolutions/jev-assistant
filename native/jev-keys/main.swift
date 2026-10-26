// jev-keys: tells Jev when the talk keys (default Fn+Control) go down and come back up, so the user can
// hold them and talk with no mouse. A LISTEN-ONLY event tap on modifier changes: it never sees, keeps
// or prints which ordinary key was pressed — only whether the combo is held.
//
// stdout, one word per line:
//   ready                    the tap is live
//   down / up                the combo was pressed / released
//   cancel                   another key was pressed while the combo was held (Fn+Control+→ and the
//                            like are shortcuts, not "I want to talk")
//   error: input-monitoring  macOS has not granted Input Monitoring yet (the prompt has been shown)
//
// usage: jev-keys [fn+control]
import CoreGraphics
import Foundation

// Same as jev-speech: macOS would attribute the permission to whoever spawned us (the Electron app,
// whose signature changes on every build). Re-exec with the parent's responsibility disclaimed, so
// Input Monitoring is granted to this binary once and survives app rebuilds.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
watchdog.schedule(deadline: .now() + 1, repeating: 1)
watchdog.setEventHandler { if getppid() == 1 { kill(0, SIGTERM); exit(0) } }
watchdog.resume()

if ProcessInfo.processInfo.environment["JEV_KEYS_DISCLAIMED"] == nil {
    var attrs: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attrs)
    _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
    var env = ProcessInfo.processInfo.environment
    env["JEV_KEYS_DISCLAIMED"] = "1"
    let cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    let cArgs: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, CommandLine.arguments[0], nil, &attrs, cArgs, cEnv)
    posix_spawnattr_destroy(&attrs)
    if rc != 0 {
        FileHandle.standardError.write("jev-keys: posix_spawn failed (\(rc))\n".data(using: .utf8)!)
        exit(1)
    }
    signal(SIGTERM) { _ in kill(0, SIGTERM); exit(143) }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}

func say(_ line: String) {
    FileHandle.standardOutput.write("\(line)\n".data(using: .utf8)!)
}

let names: [String: CGEventFlags] = [
    "fn": .maskSecondaryFn, "globe": .maskSecondaryFn,
    "control": .maskControl, "ctrl": .maskControl,
    "option": .maskAlternate, "alt": .maskAlternate,
    "command": .maskCommand, "cmd": .maskCommand,
    "shift": .maskShift,
]
let spec = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fn+control"
var combo: CGEventFlags = []
for part in spec.lowercased().split(separator: "+") {
    guard let flag = names[String(part)] else {
        say("error: unknown key \(part)")
        exit(2)
    }
    combo.insert(flag)
}
let watched: CGEventFlags = [.maskSecondaryFn, .maskControl, .maskAlternate, .maskCommand, .maskShift]

if !CGPreflightListenEventAccess() {
    _ = CGRequestListenEventAccess() // shows the system prompt once; a grant takes effect on the next launch
    say("error: input-monitoring")
    exit(3)
}

var held = false
var tap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if type == .keyDown {
        if held { say("cancel"); held = false }
        return Unmanaged.passUnretained(event)
    }
    // exactly the combo: Fn+Control+Shift is some other shortcut, not "talk"
    let now = event.flags.intersection(watched) == combo
    if now != held {
        held = now
        say(now ? "down" : "up")
    }
    return Unmanaged.passUnretained(event)
}

let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: CGEventMask(mask), callback: callback, userInfo: nil) else {
    say("error: input-monitoring")
    exit(3)
}
tap = created
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: created, enable: true)
setvbuf(stdout, nil, _IOLBF, 0)
say("ready")
CFRunLoopRun()
