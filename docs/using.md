# Using transvibe

The day-to-day reference. [Run instructions are in the README](../README.md).

## The strip

There is no window to move, focus, or close. The app is a transparent band hanging from the top of the screen, above everything including full-screen apps, and **click-through** — every click goes to whatever is behind it.

![The strip: transcript, the row of buttons beneath it, and the status line under those](images/strip.png)

The ribbon along the top edge is the audio itself — three families of lines over a slowly drifting hue, additively blended so they bloom where they cross. It is flat and dim in a silent room and travels with whatever it hears, which is the fastest way to tell that the microphone is working without saying anything to find out.

![The visualizer at full travel, mid-sentence, with an interim transcript under it](images/visualizer.png)

**Rest the pointer on it and it wakes**: the words become clickable and the buttons appear. Move away and it is a ghost again. Waking takes a deliberate dwell, so sweeping up to the menu bar never steals a click, and only the text, the buttons and the panels count — a click in the empty air between them reaches the app underneath even while the pointer is on the strip.

**The text fades.** Six seconds after the last thing you said, the transcript fades out. It is still there to send with ⌃⌥↩, but it is now stale: the next thing you say starts a fresh transcript rather than appending to something you can no longer see. Speaking, or reaching for the strip, brings it back. `esc` clears it outright.

**And then it is forgotten.** Twenty seconds after it fades, a transcript nobody has come back to is thrown away — the text, and the undo history with it. The mic hears the whole room, and music, a podcast, or someone stopping by to ask you something all get transcribed the same as dictation; none of it should still be sitting on the strip an hour later waiting for a ⌃⌥↩ meant for something else. Speaking again, or resting the pointer on the strip, restarts the clock. Settings › The strip sets the delay, or drags it all the way left to keep the text until you clear it yourself.

The strip grows to fit what it is showing, and the transcript itself caps at four lines — older text scrolls off the top.

## Controls

The controls only exist while the strip is awake. They sit in a row directly under the transcript, not off in a corner: hovering the text is what woke the strip, so the pointer is already there.

| | |
|---|---|
| Close (×) | Clear the transcript and get out of the way |
| Copy | Copy the full transcript |
| Clear | Empty the transcript |
| ➤ | Send the transcript to the frontmost app |
| Click a word | Correct it, optionally saving the fix to the glossary |
| Book | Glossary — terms to recognise, and fixes for the ones it misses |
| Gear | [Settings](settings.md) — everything else, applied as you change it |
| ? | In-app help — keys, buttons, and the full command list |
| hovering any button | Describes it on the status line under the row |
| Pause | Stop feeding segments to the recogniser |
| `esc` | Closes the fixer, then a panel, then clears the transcript |
| `⌃⌥Space` | Show/hide the strip from anywhere |
| Hold right `⌥` | Speak one command instead of dictating |
| `⌃⌥C` | Same, without holding a key |
| `⌃⌥↩` | Send the transcript to the app in front |

## Command mode

By default everything you say is transcribed. **Hold the right ⌥ key** and the strip swings amber — speak one editing command, release, and it drops straight back to transcribing. (**⌃⌥C** does the same thing without the hold, for when the key is awkward.) If you say nothing it disarms itself after 6 seconds.

    "capitalize that"              "delete the last three words"
    "uppercase that"               "delete that" / "scratch that"
    "lowercase that"               "undo that" / "never mind"
    "new paragraph"                "replace whisper with Whisper"
    "question mark"                "copy that" / "clear everything"
    "send that" / "ship it"

Releasing the key does not end command mode on its own: the utterance is usually still open when your thumb comes up, and the recogniser needs its silence window to close it. Release just starts the idle timeout — the command is consumed when the utterance actually finishes.

Anything the rules cannot place is shown as `not a command: "…"` rather than guessed at, so nothing you said is silently swallowed. With [`commandFallback`](assist.md) on, that miss goes to the local assist model first, which makes phrasings like "nope, take that back" or "stick that on the clipboard for me" work without adding a rule for each one.

### The wake phrase

There is a third way in, with no key at all: **open the sentence with "hey Claude"** and the rest of it is the command.

    "hey Claude, delete the last three words"
    "hey Claude, replace whisper with Whisper"
    "hey Claude could you uppercase that"

This is the one that works while a transcript is already sitting on the strip, and while your hands are somewhere else. The strip swings amber as soon as the phrase is recognised in the open utterance — before you have finished the sentence — and shows the command without its keyword, which is exactly what the parser is about to be handed.

Said on its own, "hey Claude" just arms command mode for the next thing you say, the same as ⌃⌥C.

The phrase has to come first. A keyword recognised anywhere would turn "I told him hey Claude was down" into a command; recognised only at the front, after fillers like "um" and "so", it stays out of ordinary speech. Near misses are forgiven, because a small model hears an unusual name loosely — "hey cloud" and "hey claud" both count. Change the phrase, or turn either behaviour off, under Settings › Command mode.

Because the app decided this was a command rather than you, an utterance that reaches the parser and means nothing to it is **put back into the transcript** rather than dropped: `not a command — kept "…"`. The key path does not do that — there you meant a command, so being told is better than a stray sentence appearing.

The **?** button opens an in-app help panel with the full list (`esc` or `?` toggles it too). It is generated from the parser, so it cannot describe a command the parser does not have.

![The help panel: sections for the strip, the keys, the transcript and the buttons, then the full command list](images/help.png)

## The glossary

Names, jargon and product words are what a small Whisper model gets wrong most consistently — it has never seen them, so it reaches for the nearest thing it has. Two lists attack that from opposite ends: **terms** are fed to the recogniser as it listens, so the spelling wins while you are still talking; **fixes** rewrite what it got wrong anyway.

**Click a word in the transcript** to say what it should have been. The rewrite always happens; what you keep is the opt-out. *Remember the fix* saves it as a rule, and *listen for it too* adds the corrected spelling to the terms — untick both and the word is simply fixed here and now, which is what a one-off mishearing deserves. Both checkboxes hold their setting for the rest of the session, so a run of throwaway fixes is one click, not one per word.

![The word fixer, anchored under the word it was opened on](images/fixer.png)

Esc, the *esc* button, or a click anywhere outside dismisses it without changing anything. Dragging still selects text; only a click that leaves no selection opens the fixer. The "heard" side stays editable, which is how a two-word phrase gets a rule.

![The glossary panel: terms to listen for as removable chips, and the wrong-to-right fixes below them](images/glossary.png)

The book button opens the glossary panel: terms on top, fixes below, added and removed in place. Every edit is written to the settings file and swapped into the running recogniser immediately — the model stays loaded, and the change takes effect on the next thing you say.

The same data lives in the settings file, if you would rather paste a list in:

```json
{
  "vocabulary": ["Drupal", "Lullabot", "Tugboat", "transvibe", "Claude Code"],
  "corrections": {
    "trans vibe": "transvibe",
    "drupple": "Drupal",
    "lolabot": "Lullabot"
  }
}
```

Keep the terms to words that actually get mangled — a long list of ordinary English is worse than a short one. [Why, and what a fix actually matches](architecture.md#the-glossary).

## Sending the transcript

Dictating into a HUD is only useful if the text can get where you actually want it. **⌃⌥↩** (or the ➤ button, or saying *"send that"*) pastes the transcript into whatever app is in front — no copy, switch, paste.

It pastes rather than typing the text out keystroke by keystroke: pasting is instant and cannot mangle characters the target app treats specially.

The subtle part is focus. If transvibe has focus, ⌘V would land in its own window, so it hides first — which returns macOS focus to whatever app you were in before. Triggered by the global shortcut it never had focus at all, and the target is already frontmost. Set `sendTarget` in settings to an app name (e.g. `"Warp"`) to always focus that app first regardless.

| setting | default | |
|---|---|---|
| `sendTarget` | `null` | app to focus before pasting; null means whatever is in front |
| `sendPressesEnter` | `false` | also hit Return after pasting |
| `clearAfterSend` | `true` | empty the transcript once it has been delivered |

This needs **Accessibility** permission to post the keystroke — a different grant from the Input Monitoring that the right-⌥ tap uses. Without it the text is still on the clipboard and the status line says so, so the fallback is the old copy-and-paste rather than nothing.

## Menu bar

transvibe lives in the macOS menu bar as a waveform icon. Left-click toggles the strip; right-click opens a menu with show/hide, a listening checkbox, copy and clear, the three panels (Settings ⌘,, Glossary, Keys & commands), Launch at login, Reveal model folder, and Quit.

The three panel entries show the strip on the way, since a panel opened onto a hidden window is nothing to look at.

Hiding parks the app in the menu bar with the model still resident, so bringing it back is instant rather than a fresh model load. It comes back without stealing focus from what you were typing in. Only Quit (or `⌘Q`) actually tears down the engine.
