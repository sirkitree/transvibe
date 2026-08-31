// Emits "down" / "up" on stdout as the right Option key is held and released.
//
// Electron's globalShortcut cannot express this: it fires only on key-down,
// never key-up, and it cannot bind a bare modifier or tell left from right.
// A listen-only CGEventTap can do all three. It requires Input Monitoring
// permission; without it tapCreate returns nil and we exit non-zero so the
// caller can fall back.

import CoreGraphics
import Foundation

let kRightOption: Int64 = 61

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

let callback: CGEventTapCallBack = { proxy, type, event, _ in
    // The system disables a tap that ever blocks; re-arm rather than going deaf.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = tapRef { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    if type == .flagsChanged,
       event.getIntegerValueField(.keyboardEventKeycode) == kRightOption {
        emit(event.flags.contains(.maskAlternate) ? "down" : "up")
    }

    return Unmanaged.passUnretained(event)
}

var tapRef: CFMachPort?

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
) else {
    FileHandle.standardError.write("tap-denied\n".data(using: .utf8)!)
    exit(1)
}

tapRef = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("ready")
CFRunLoopRun()
