# transvibe

Local voice-to-text for macOS. A click-through strip across the top of the screen that listens continuously, transcribes on-device with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and draws a colorful "electric" audio visualizer hanging off the top edge.

- **No window.** Clicks land in whatever is behind it until you park the pointer on it
- Text appears **while you are still talking**, not after you stop
- The transcript fades a few seconds after you stop; esc clears it now
- Hold right ⌥ to speak an editing command instead of dictating
- ⌃⌥↩ pastes the transcript straight into whatever app is in front
- Optionally, a second local model tidies the fillers out and makes command mode understand phrasings the rules never learned
- Lives in the menu bar

**No cloud service.** Audio never leaves the machine — there is no network call anywhere in the transcription path. The only outbound request the app can ever make is a one-time model download from Hugging Face, and only if it cannot find a Whisper model already on disk. The optional assist model runs locally too, through Ollama on `127.0.0.1`, and is only ever sent text.

## Requirements

- macOS on Apple Silicon (Metal acceleration)
- Node 20+
- `brew install whisper-cpp`
- Swift (from the Xcode command line tools) to build the key-tap helper

Optional, for [the assist model](#the-assist-model): [Ollama](https://ollama.com) and `ollama pull gemma4:e2b` (~7.2 GB). Everything works without it.

## Run

```sh
npm install
npm start          # or: npm run dev  (opens a CDP port on 9333)
```

On first launch it asks for microphone access, then looks for a Whisper model in this order:

1. `~/Library/Application Support/transvibe/models/*.bin`
2. A model another local Whisper app already downloaded — superwhisper, MacWhisper, or `~/.cache/whisper.cpp`. These are **read only**; transvibe never writes into another app's directory.
3. Failing both, it downloads `ggml-base.en.bin` (~148 MB) into its own models directory.

Three macOS permissions are involved, each degrading on its own rather than taking the app down with it:

| grant | needed for | without it |
|---|---|---|
| Microphone | everything | the app says so in the status line |
| Input Monitoring | right-⌥ hold (`bin/rightopt`) | falls back to ⌃⌥C |
| Accessibility | pasting on send (`bin/sendkeys`) | text is still on the clipboard |

# Using it

## The strip

There is no window to move, focus, or close. The app is a transparent band hanging from the top of the screen, above everything including full-screen apps, and **click-through** — every click goes to whatever is behind it.

**Rest the pointer on it and it wakes**: the words become clickable and the buttons appear. Move away and it is a ghost again. Waking takes a deliberate dwell, so sweeping up to the menu bar never steals a click, and only the text, the buttons and the panels count — a click in the empty air between them reaches the app underneath even while the pointer is on the strip.

**The text fades.** Six seconds after the last thing you said, the transcript fades out. It is still there to send with ⌃⌥↩, but it is now stale: the next thing you say starts a fresh transcript rather than appending to something you can no longer see. Speaking, or reaching for the strip, brings it back. `esc` clears it outright.

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

Anything the rules cannot place is shown as `not a command: "…"` rather than guessed at, so nothing you said is silently swallowed. With [`commandFallback`](#the-assist-model) on, that miss goes to the local assist model first, which makes phrasings like "nope, take that back" or "stick that on the clipboard for me" work without adding a rule for each one.

The **?** button opens an in-app help panel with the full list (`esc` or `?` toggles it too).

## The glossary

Names, jargon and product words are what a small Whisper model gets wrong most consistently — it has never seen them, so it reaches for the nearest thing it has. Two lists attack that from opposite ends: **terms** are fed to the recogniser as it listens, so the spelling wins while you are still talking; **fixes** rewrite what it got wrong anyway.

**Click a word in the transcript** to say what it should have been. The rewrite always happens; what you keep is the opt-out. *Remember the fix* saves it as a rule, and *listen for it too* adds the corrected spelling to the terms — untick both and the word is simply fixed here and now, which is what a one-off mishearing deserves. Both checkboxes hold their setting for the rest of the session, so a run of throwaway fixes is one click, not one per word.

Esc, the *esc* button, or a click anywhere outside dismisses it without changing anything. Dragging still selects text; only a click that leaves no selection opens the fixer. The "heard" side stays editable, which is how a two-word phrase gets a rule.

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

Keep the terms to words that actually get mangled — a long list of ordinary English is worse than a short one. [Why, and what a fix actually matches](#the-glossary-under-the-hood).

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

transvibe lives in the macOS menu bar as a waveform icon. Left-click toggles the strip; right-click opens a menu with show/hide, a listening checkbox, copy and clear, and Quit.

Hiding parks the app in the menu bar with the model still resident, so bringing it back is instant rather than a fresh model load. It comes back without stealing focus from what you were typing in. Only Quit (or `⌘Q`) actually tears down the engine.

## The assist model

A second, local model — Gemma 4 E2B through [Ollama](https://ollama.com) — does the two things whisper and a rule parser each do badly. Both features are off by default:

```sh
ollama pull gemma4:e2b     # ~7.2 GB, one time
```
```json
{ "cleanup": true, "commandFallback": true }
```

Still no cloud: Ollama serves on `127.0.0.1`, and the audio never reaches it at all — only text does. If Ollama is not running or the model was never pulled, the strip says so once and everything carries on exactly as before.

**`cleanup`** rewrites a settled utterance with the filler words and false starts taken out. "Um, so I was thinking we should uh ship the thing on Friday" becomes "So I was thinking we should ship the thing on Friday". It runs after whisper's text is already on screen, so it costs nothing you wait for; the tidier version swaps in a few hundred milliseconds later, or never.

**`commandFallback`** hands an unrecognised command to the model instead of giving up on it. Say "nope, take that back" or "stick that on the clipboard for me" with right ⌥ held — phrasings no rule covers — and they work.

Measured on an M-series Mac, warm: cleanup 170–350ms, command fallback 180–510ms, both after the fact.

Read [how each one is kept on a leash](#the-assist-model-under-the-hood) before trusting cleanup with anything that matters — it can make a subtle word change that the guards do not catch.

## Settings

`~/Library/Application Support/transvibe/settings.json`, written on change and merged over the defaults, so deleting the file resets everything.

| key | default | |
|---|---|---|
| `threshold` | `0.02` | RMS level that counts as speech |
| `hangoverMs` | `550` | silence before an utterance is considered finished |
| `interimMs` | `500` | how often the open utterance is re-transcribed |
| `commandTimeoutMs` | `6000` | command mode disarms itself after this |
| `sendTarget` | `null` | app to focus before pasting; null = whatever is in front |
| `sendPressesEnter` | `false` | also hit Return after pasting |
| `clearAfterSend` | `true` | empty the transcript once delivered |
| `stripHeight` | `180` | minimum height of the strip; it grows to fit |
| `panelHeight` | `560` | height while the help or glossary panel is open |
| `wakeDelayMs` | `320` | pointer dwell before the strip stops being click-through |
| `idleFadeMs` | `6000` | silence before the transcript fades |
| `alwaysOnTop` | `true` | keep above other windows |
| `autoCopy` | `false` | copy every finished utterance automatically |
| `modelPath` | `null` | pin a specific ggml model |
| `language` | `'en'` | recognition language |
| `vocabulary` | `[]` | terms to bias recognition toward |
| `corrections` | `{}` | wrong → right rewrites applied to finished text |
| `dropGlossaryEcho` | `true` | discard an utterance that is only glossary words |
| `cleanup` | `false` | tidy fillers out of settled text with the assist model |
| `commandFallback` | `false` | ask the assist model about unrecognised commands |
| `assistModel` | `'gemma4:e2b'` | Ollama model for both of the above |
| `assistUrl` | `'http://127.0.0.1:11434'` | where Ollama is listening |
| `vizLinesPerFamily` | `18` | polylines per hue family (×3) |
| `vizPoints` | `220` | samples per polyline |
| `vizFps` | `30` | frame rate while speech is detected |
| `vizQuietFps` | `8` | frame rate in a silent room |

# How it works

```
renderer  getUserMedia → AudioContext(16 kHz)
            ├─ AnalyserNode(fftSize 2048) → visualizer.js       60 fps
            └─ AudioWorklet → 20 ms frames → vad.js  ─┐
                                                      │ every 500 ms while open,
                                 30 s ring buffer ────┤ and again on speech-end
                                                      ↓
main      wav.js (16-bit mono WAV) → whisper.js FIFO queue → whisper-server
                                                    └→ text → IPC → renderer
                                                                      │
                             transcribe mode ─────────────────────────┤
                               → append to the transcript             │
                               → assist.cleanup (optional) ──┐        │
                                   swaps the tidied text in ─┘        │
                             command mode (right ⌥ held) ─────────────┘
                               → commands.js → edit the transcript
                               → on a miss: assist.command (optional)
                                   → picks a known phrase → commands.js

send      ⌃⌥↩ → clipboard → hide if focused → bin/sendkeys posts ⌘V
keys      bin/rightopt (CGEventTap) → "down"/"up" → arm command mode
assist    text only, never audio → Ollama on 127.0.0.1
```

One microphone stream feeds both consumers, so there is no second capture process and the visualizer is always in sync with what is being recognised.

`whisper-server` is spawned once on a free loopback port and keeps the model resident. That turns the ~160 ms per-utterance model load into a one-time cost: measured round-trip from renderer to transcript is **~105 ms** for a 3-second utterance with `small.en`. If `whisper-server` is missing, the engine falls back to spawning `whisper-cli` per utterance behind the same interface.

The VAD opens a segment after 3 consecutive frames above threshold and closes it after 550 ms of silence, reporting the *true* onset frame so the ring-buffer slice never clips the first syllable. Segments under 400 ms are discarded, and one running past 15 s is force-flushed and immediately reopened.

## Interim results

Waiting for the hangover to expire means text only appears once you stop talking. So while an utterance is still open, the audio so far is re-transcribed every 500 ms and shown highlighted in blue. When the utterance closes, the final replaces it.

Measured on `small.en`, an utterance building up:

| audio so far | interim latency | text |
|---|---|---|
| 0.7 s | 111 ms | "testing one" |
| 1.4 s | 81 ms | "Testing 123." |
| 2.1 s | 87 ms | "Testing 123 transcribe" |
| 2.8 s | 101 ms | "Testing 123 transcribe this locally." |
| final | 104 ms | "Testing 123 transcribe this locally." |

Two rules keep the interims from getting in the final's way. Only one is ever in flight — a slow model throttles them rather than queueing them ahead of the final — and each carries a sequence number, so an interim that lands after a newer one (or after the utterance has closed) is discarded rather than shown. Interims also decode greedily (`beam_size 1`, `best_of 1`, no context carry-over) since they are thrown away as soon as the next one lands, and they never touch the clipboard.

Small Whisper models emit stock phrases on near-silence ("Thank you.", "[BLANK_AUDIO]", "you"). `whisper-parse.js` filters these as whole-string matches only, so a real sentence containing "you" survives untouched.

## The overlay

The window is frameless and transparent, sized to the work area's full width, `alwaysOnTop` at the `screen-saver` level so it survives full-screen apps, and created with `setIgnoreMouseEvents(true, { forward: true })`.

**Waking is polled from the cursor position**, not driven by mouse events, because a click-through window is only told about movement *over* it: it can see the pointer arrive but never see it leave. The renderer separately reports whether the pointer is over something clickable, which is what keeps the empty air between the controls transparent to the mouse. `src/main/overlay.js` holds the geometry and the dwell rule as pure functions.

**The strip is as tall as its contents.** The renderer measures its own laid-out content after every render and the window follows, so the buttons are always fully on screen wherever the text happens to wrap. Only the stage is measured, never an open panel — a panel is sized in percentages of the window, so feeding its height back in would grow the strip without limit. Opening a panel asks for at least `panelHeight` and pins the strip awake.

**Fading** is a small state machine in `src/renderer/presence.js`, pure and clock-injected. Anything that counts as interest resets the clock: speech, an interim update, the pointer arriving, a panel being open.

Panels are near-opaque rather than glass. `backdrop-filter` is dead weight on a transparent window with no vibrancy material — there is no backdrop for it to sample — so a translucent panel is really just showing whatever is behind it straight through the text, and a panel is something you opened in order to read.

## Command parsing

Recognition is **rule-based, not a model**. For this vocabulary a parser is instant, deterministic, and unit-testable, where a local LLM would add a second or two of latency and nondeterminism to every command.

The design guards hard against false positives — ordinary dictation like "I need to copy that file" must not fire a command, because a wrong match silently eats what you said. Over 60 of the cases in `commands.test.js` are ordinary sentences asserted to parse as *nothing*.

The help panel's command reference is generated at runtime from `COMMANDS`, the same array the parser is driven by, so the documentation cannot drift from what actually works. Adding a command to the parser adds it to the help for free.

Hold-to-talk needs a native helper. Electron's `globalShortcut` fires only on key-down, never key-up, and it cannot bind a bare modifier or tell left ⌥ from right ⌥ — so `src/native/rightopt.swift` runs a listen-only `CGEventTap` that watches `flagsChanged` for keycode 61 and prints `down`/`up`. It is built by `npm run build:native` (which `npm start` runs for you) and spawned as a child process. Without Input Monitoring permission `tapCreate` returns nil, the helper exits non-zero, and the app says so and falls back to ⌃⌥C.

## The glossary, under the hood

`vocabulary` becomes whisper.cpp's initial prompt (`prompt` on the server, `--prompt` on the CLI). The decoder conditions on it, so those spellings become much cheaper token sequences and often win *during* recognition — which means interim text is right too, not just the settled utterance. Whisper truncates its prompt at 224 tokens, so the list is capped at 800 characters and extra terms are dropped from the end.

**Prompt echo** is the reason to keep that list short. The prompt is prepended as prior context, and over silence or room noise Whisper will happily just repeat it back — the shorter the glossary, the more often it does. A one-term glossary turns every cough into that term. So an utterance made of *nothing but* glossary words is dropped, exactly like the model's other stock hallucinations. Said inside a real sentence the term still comes through, which is what it was added for. The cost is that dictating a single glossary term on its own does nothing; set `dropGlossaryEcho: false` if you need that.

`corrections` is the backstop for the passes where the nudge lost. Each key is matched whole-word and case-insensitively, and a space in the key matches any run of whitespace or punctuation — so `"trans vibe"` also catches `Trans-Vibe` and `trans vibe.`. Replacements are inserted verbatim, longest key first, and never fire inside a longer word (`undruppled` stays put).

## The assist model, under the hood

Every `cleanup` reply is guarded before it can touch the transcript, because the failure that matters is not a bad rewrite but a *plausible* one — a summary, or an answer to a question the user happened to dictate. A reply that is under half or over 1.5× the original's length, that opens like a chatbot ("Here's the…"), or that comes back empty is discarded and the original stands. `acceptCleanup` in `src/shared/assist.js` is that rule, unit-tested, and it always returns something safe to show.

Those guards do not catch a subtle word change. Cleanup has turned "I still need to double check" into "I still need *you* to double-check" — a plausible sentence, the right length, and not what was said. Read the result before sending it somewhere that matters.

For `commandFallback`, the model does not invent a command — it picks one of the 66 example phrases the parser already understands, and that phrase goes straight back through `parseCommand`. Two things fall out of that: a wrong answer can only ever produce a command the app actually implements, and everything the rules know about targets and counts ("the last three words") keeps working without a second, weaker copy of it.

It is safe to ask at all only because command mode is armed deliberately. The model is never shown ordinary dictation, so it never gets the chance to mistake any for a command — which it will: asked cold, "I need to copy that file to the server" comes back as `copy`. That is the exact false positive the rules exist to prevent, and it is why they stay in front.

Thinking is on by default in Ollama and cost ~1.1s per call for a task that needs none; both calls set `reasoning_effort: "none"`.

**What was tried and rejected.** Gemma 4 takes audio natively, so it could replace whisper outright. On the same clips it was slower and less accurate — "Vinchi" for "Vinci", words dropped off the end of a long sentence, and it ignored an instruction to clean up while transcribing. Whisper keeps the audio. Google's other new model, Gemini 3.5 Transcribe, does all of this better and in one pass, but it is a cloud API with no open weights, which would cost this app the only property it really has.

## The visualizer

Ported from a radial visualizer to a horizontal band: three hue families at 0/0.33/0.66 offsets over a slowly drifting base hue, 18 polylines each, every point displaced by its FFT bin, and a per-line random-walk twist — that jitter is what makes it read as "electric" rather than as a clean sine. Additive blending gives the bloom where lines cross, and a thin white line rides on top as the hot core. When silent the band collapses to a nearly straight horizontal line with a slow breathing pulse.

The glow comes from drawing the band to an offscreen canvas and blitting it twice, blurred then crisp, so it costs one blur per frame rather than one per stroke. That, and dropping to 8fps in a quiet room, is why the whole app idles around 12% CPU — [the measurements are in `docs/performance.md`](docs/performance.md).

## Project layout

```
src/main/       index.js      window, tray, shortcuts, IPC, send
                whisper.js    engine lifecycle + serialised inference queue
                whisper-parse.js  output parsing, artifact filter, queue
                wav.js        Float32 → 16-bit PCM WAV
                models.js     locate or download a ggml model
                overlay.js    strip geometry + hover-wake rule (pure)
                config.js     settings persistence
                assist.js     optional local LLM pass (Ollama)
src/shared/     glossary.js   vocabulary prompt + corrections (pure)
                assist.js     assist prompts + reply guards (pure)
src/renderer/   app.js        transcript UI, command dispatch, help panel
                audio.js      mic graph, ring buffer, segment slicing
                vad.js        voice-activity state machine (pure)
                presence.js   when the transcript fades (pure)
                commands.js   voice-command parser + applier (pure)
                glossary-edit.js  glossary panel edit rules (pure)
                band.js       visualizer math (pure)
                visualizer.js canvas rendering
                pcm-worklet.js
src/native/     rightopt.swift   right-⌥ hold detection via CGEventTap
                sendkeys.swift   posts ⌘V to the frontmost app
```

The pure modules — `vad`, `commands`, `band`, `wav`, `overlay`, `presence`, `glossary`, `glossary-edit`, `assist`, `whisper-parse` — take no DOM, Electron, filesystem or network dependency, which is what makes the awkward parts (segment boundaries, command false positives, model replies) testable under plain Node rather than only discoverable by hand.

# Tests

```sh
npm test          # 351
npm run test:unit # pure modules only, no whisper binary needed
```

| file | | covers |
|---|---:|---|
| `commands.test.js` | 167 | command parsing, false positives, transcript edits |
| `wav.test.js` | 26 | header byte-exactness, clamping, overflow guards |
| `glossary-edit.test.js` | 23 | glossary panel edits, word splitting |
| `whisper-parse.test.js` | 21 | output parsing, artifact filter, FIFO queue |
| `glossary.test.js` | 18 | prompt budget, whole-word corrections, echo filter |
| `assist.test.js` | 18 | assist prompts, and the guards on its replies |
| `vad.test.js` | 16 | segment boundaries, hangover, force-flush, bad options |
| `overlay.test.js` | 16 | strip geometry, hover-wake dwell |
| `band.test.js` | 15 | visualizer math stays finite and in-bounds |
| `presence.test.js` | 11 | when the transcript fades, and what un-fades it |
| `engine.integration.test.js` | 4 | the real engine, end to end |

The bulk sits in `commands.test.js` because a command parser's worst failure is silent: a false positive eats dictation the user meant to keep. Over 60 of the cases there are ordinary sentences — "I need to copy that file", "let's undo the last commit", "send that email to Bob" — asserted to parse as *nothing*.

`engine.integration.test.js` is real end-to-end coverage with no cloud and no microphone: macOS `say` synthesises a known phrase, `ffmpeg` conforms it to 16 kHz mono, and the engine has to read it back. It also covers an interim pass over a partial utterance, and asserts that a second of pure silence returns empty text rather than a hallucinated phrase. It self-skips if `say`, `ffmpeg`, whisper.cpp, or a model is unavailable.

## Manual checklist

Things the automated tests cannot cover:

- [ ] Clicking through the empty parts of the strip reaches the app underneath
- [ ] Resting the pointer on the text wakes the strip; leaving puts it back
- [ ] Sweeping up to the menu bar does not wake it
- [ ] The strip floats over a full-screen app
- [ ] Transcript fades ~6s after you stop talking, and esc clears it now
- [ ] After a fade, the next thing you say starts a fresh transcript
- [ ] ⌃⌥↩ still sends a faded transcript
- [ ] Microphone permission prompt appears on first launch
- [ ] Visualizer sits flat and still when the room is quiet
- [ ] Visualizer reacts immediately and colorfully to speech
- [ ] Text appears while you are still talking, highlighted in blue
- [ ] Blue interim text is replaced by the final when you stop
- [ ] Transcript appends within ~1s of finishing a sentence
- [ ] Holding right ⌥ turns the strip amber and shows the Command banner
- [ ] Left ⌥ does nothing (only the right key arms command mode)
- [ ] ⌃⌥C turns the strip amber and shows the Command banner
- [ ] A spoken command edits the transcript and returns to transcribe mode
- [ ] Command mode disarms itself after 6s of silence
- [ ] With `commandFallback` on, "nope, take that back" undoes
- [ ] With it off, the same phrase is reported as not a command
- [ ] With `cleanup` on, "um so I was thinking, no wait" tidies itself a moment later
- [ ] With Ollama stopped, both features fail quietly and dictation is unaffected
- [ ] ? opens the help panel; esc closes it; it scrolls and lists every command
- [ ] Opening a panel grows the strip; closing it shrinks back
- [ ] Buttons appear on wake and every one is clickable across its whole area
- [ ] ⌃⌥↩ from Warp pastes the transcript straight into Warp
- [ ] The ➤ button hides transvibe, restores the previous app, and pastes there
- [ ] `⌃⌥Space` toggles visibility from another app
- [ ] Waveform icon appears in the menu bar and adapts to light/dark
- [ ] × clears the transcript; the tray icon still shows and hides the strip

# Package

```sh
npm run build:native   # compiles bin/rightopt and bin/sendkeys
npm run dist           # -> dist/mac-arm64/transvibe.app
```

`npm start` runs `build:native` for you; packaging does not, so build the helpers first. They are bundled into the app under `bin/`.

Unsigned, and `whisper-cpp` is not bundled — the packaged app still needs `brew install whisper-cpp` on the machine that runs it.

One thing to expect from the packaged build: macOS attributes Input Monitoring and Accessibility to the specific binary asking, so grants that the helpers inherited while running under `npm start` do not carry over. The app will prompt again, and both features degrade as described under **Run** if denied.
