# Architecture

How the pieces fit.

## The pipeline

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
                             command mode (right ⌥ held, ⌃⌥C, ────────┘
                              or wake.js hears an agent's name)
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

## The glossary

`vocabulary` becomes whisper.cpp's initial prompt (`prompt` on the server, `--prompt` on the CLI). The decoder conditions on it, so those spellings become much cheaper token sequences and often win *during* recognition — which means interim text is right too, not just the settled utterance. Whisper truncates its prompt at 224 tokens, so the list is capped at 800 characters and extra terms are dropped from the end.

**Prompt echo** is the reason to keep that list short. The prompt is prepended as prior context, and over silence or room noise Whisper will happily just repeat it back — the shorter the glossary, the more often it does. A one-term glossary turns every cough into that term. So an utterance made of *nothing but* glossary words is dropped, exactly like the model's other stock hallucinations. Said inside a real sentence the term still comes through, which is what it was added for. The cost is that dictating a single glossary term on its own does nothing; set `dropGlossaryEcho: false` if you need that.

`corrections` is the backstop for the passes where the nudge lost. Each key is matched whole-word and case-insensitively, and a space in the key matches any run of whitespace or punctuation — so `"trans vibe"` also catches `Trans-Vibe` and `trans vibe.`. Replacements are inserted verbatim, longest key first, and never fire inside a longer word (`undruppled` stays put).

## The visualizer

Ported from a radial visualizer to a horizontal band: three hue families at 0/0.33/0.66 offsets over a slowly drifting base hue, 18 polylines each, every point displaced by its FFT bin, and a per-line random-walk twist — that jitter is what makes it read as "electric" rather than as a clean sine. Additive blending gives the bloom where lines cross, and a thin white line rides on top as the hot core. When silent the band collapses to a nearly straight horizontal line with a slow breathing pulse.

The glow comes from drawing the band to an offscreen canvas and blitting it twice, blurred then crisp, so it costs one blur per frame rather than one per stroke. That, and dropping to 8fps in a quiet room, is why the whole app idles around 12% CPU — [the measurements are here](performance.md).

## Project layout

```
src/main/       index.js      window, tray, shortcuts, IPC, send
                whisper.js    engine lifecycle + serialised inference queue
                whisper-parse.js  output parsing, artifact filter, queue
                wav.js        Float32 → 16-bit PCM WAV
                models.js     find or download a ggml model
                overlay.js    strip geometry + hover-wake rule (pure)
                config.js     settings persistence
                assist.js     optional local LLM pass (Ollama)
                speech.js     saying a confirmation out loud via `say`
src/shared/     agents.js     who you can talk to, and what a name means (pure)
                conversation.js  prompts and guards for talking to one (pure)
                glossary.js   vocabulary prompt + corrections (pure)
                assist.js     assist prompts + reply guards (pure)
src/renderer/   app.js        transcript UI, command dispatch, help panel
                settings-schema.js  what settings.json holds (pure)
                settings-voice.js   changing a setting by saying so (pure)
                settings-panel.js   the settings panel, built from the schema
                audio.js      mic graph, ring buffer, segment slicing
                vad.js        voice-activity state machine (pure)
                presence.js   when the transcript fades and expires (pure)
                placement.js  where a dragged panel may land (pure)
                commands.js   voice-command parser + applier (pure)
                wake.js       is an utterance addressed to one of them (pure)
                glossary-edit.js  glossary panel edit rules (pure)
                band.js       visualizer math (pure)
                visualizer.js canvas rendering
                saying.js     a synthetic spectrum for the app's own voice (pure)
                saying-viz.js the same ribbon, small, warm, drawn while it talks
                pcm-worklet.js
src/native/     rightopt.swift   right-⌥ hold detection via CGEventTap
                sendkeys.swift   posts ⌘V to the frontmost app
script/         install-launcher.sh  build ~/Applications/Transvibe.app
                make-icon.py         draw build/icon.icns
```

The pure modules — `vad`, `commands`, `band`, `wav`, `overlay`, `presence`, `glossary`, `glossary-edit`, `assist`, `agents`, `conversation`, `placement`, `whisper-parse`, `settings-schema`, `settings-voice`, `saying` — take no DOM, Electron, filesystem or network dependency, which is what makes the awkward parts (segment boundaries, command false positives, model replies) testable under plain Node rather than only discoverable by hand.
