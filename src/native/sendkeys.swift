// Posts ⌘V to whatever app is frontmost, so a transcript can be delivered
// straight into another window instead of being copied and pasted by hand.
//
// Requires Accessibility permission (posting events), which is a different
// grant from the Input Monitoring that rightopt needs. Exits non-zero if the
// event source cannot be created so the caller can fall back to the clipboard.

import CoreGraphics
import Foundation

let kVK_ANSI_V: CGKeyCode = 9
let kVK_Return: CGKeyCode = 36

let pressEnter = CommandLine.arguments.contains("--enter")

guard let src = CGEventSource(stateID: .combinedSessionState) else {
    FileHandle.standardError.write("no-event-source\n".data(using: .utf8)!)
    exit(1)
}

func tap(_ key: CGKeyCode, flags: CGEventFlags = []) {
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false)
    else { return }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(15_000)
    up.post(tap: .cghidEventTap)
}

tap(kVK_ANSI_V, flags: .maskCommand)

if pressEnter {
    usleep(60_000)
    tap(kVK_Return)
}
