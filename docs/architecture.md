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

The VAD opens a segment after 3 consecutive frames above threshold and closes it after 550 ms of silence, reporting the *true* onset frame; capture includes up to 200 ms before it for quiet word beginnings, bounded by the last utterance or microphone-unmute boundary. Segments under the configurable minimum (250 ms by default) are discarded, and one running past 15 s is force-flushed and immediately reopened.

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

**Ahead of all of it, a speech gate.** whisper.cpp carries a Silero VAD, and `vadArgs` in `whisper.js` puts `--vad -vm <model> -vt <threshold>` on the sidecar when the detector is on disk and the setting is on. Whisper is then handed only the regions that scored as voice, so music does not become text that later has to be recognised as music. The flags are built from the file rather than from the setting: `--vad` with a `-vm` that does not resolve exits the server at startup, so a missing detector means no flags and the pre-gate behaviour intact. An empty result is reported as `dropped: 'no speech'` — but only when the gate is genuinely up, since an empty result with it off is ordinary silence.

The gate carries one workaround. whisper-server 1.9.2 segfaults when the *first* request it ever serves comes back from VAD with no speech in it; every request after that handles the same empty result correctly, so the bug is reachable exactly once — on the request most likely to be music, since the sidecar comes up at launch and is handed whatever the room was doing. `warmUp()` therefore spends half a second of `say` output on becoming ready, making request one a successful decode. It cannot be synthesised: Silero rejects a formant-shaped buzz, which is the same selectivity that makes it work on music. Best-effort, and the sidecar's exit handler clears its own handles so a crash costs one slow utterance rather than the engine. Revisit when whisper.cpp fixes it — nothing had as of 1.9.2, which is the current bottle.

The four rules below still run behind the gate. They are what catches whatever it passes, and the whole defence where the detector could not be downloaded.

Small Whisper models emit stock phrases on near-silence ("Thank you.", "[BLANK_AUDIO]", "you"). `whisper-parse.js` filters these as whole-string matches only, so a real sentence containing "you" survives untouched.

Bigger models fail the other way round: they caption the room correctly and confidently, so `confidenceFloor` never sees "Sad music." and the bracket rule never sees it either, because there are no brackets on it. `isArtifact` therefore also splits an utterance at sentence ends and adjacent brackets and asks of every piece whether it is a tag — bracketed, wrapped in `*` or `♪`, or made entirely of a curated sound vocabulary with at least one word naming a sound. All pieces or none: a single real sentence in the run keeps the whole thing. Separately, `isRepetitionLoop` catches the decoder latching onto a phrase and repeating it, which no vocabulary can recognise because every repeat is ordinary speech — it is judged on fragment counts alone.

## The overlay

The window is frameless and transparent, sized to the work area's full width, `alwaysOnTop` at the `screen-saver` level so it survives full-screen apps, and created with `setIgnoreMouseEvents(true, { forward: true })`.

**Waking is polled from the cursor position**, not driven by mouse events, because a click-through window is only told about movement *over* it: it can see the pointer arrive but never see it leave. The renderer separately reports whether the pointer is over something clickable, which is what keeps the empty air between the controls transparent to the mouse. `src/main/overlay.js` holds the geometry and the dwell rule as pure functions.

**The strip is as tall as its contents.** The renderer measures its own laid-out content after every render and the window follows, so the buttons are always fully on screen wherever the text happens to wrap. Only the stage is measured, never an open panel — a panel is sized in percentages of the window, so feeding its height back in would grow the strip without limit. Opening a panel asks for at least `panelHeight` and pins the strip awake.

**Fading** is a small state machine in `src/renderer/presence.js`, pure and clock-injected. Anything that counts as interest resets the clock: speech, an interim update, the pointer arriving, a panel being open.

**The orb is a second window.** It sits in the lower-left corner of the screen and the strip is a band across the top, so one window cannot be both without covering everything between them. It is created and destroyed as `layout` changes, follows the strip to whatever display it is on, and hides with it.

**It wakes on a circle, not a rectangle.** A round thing in a square window has four corners with nothing drawn in them, and testing the window would have the orb swallowing the pointer in exactly the part of the screen other things live in. `withinCircle` in `overlay.js` is the hit test, inset a little so the region does not reach past the figure.

The wake is split further than the strip's, because there are two different questions. The pointer being on the orb only *reveals* its two controls — the window stays click-through for that, so moving past the orb never costs you a click on what is behind it. It stops being click-through only while the pointer is on one of the buttons, which the renderer reports the same way the strip reports `overTarget`. And there is no dwell either way: a small round thing in a corner is not something you sweep across on the way somewhere, so holding still on it would only feel slow.

It is also deaf. The microphone, the `AnalyserNode` and the VAD stay in the strip's renderer, which is the only thing that knows what the room is doing and whether the app is listening, speaking or armed; what crosses to the orb is about seven numbers a frame on one channel, one way. Deliberately lossy — a dropped message is a dropped frame of animation and nothing else — and paced off the VAD, so a silent room sends eight a second rather than thirty.

Panels are near-opaque rather than glass. `backdrop-filter` is dead weight on a transparent window with no vibrancy material — there is no backdrop for it to sample — so a translucent panel is really just showing whatever is behind it straight through the text, and a panel is something you opened in order to read.

## Command parsing

Recognition is **rule-based, not a model**. For this vocabulary a parser is instant, deterministic, and unit-testable, where a local LLM would add a second or two of latency and nondeterminism to every command.

The design guards hard against false positives — ordinary dictation like "I need to copy that file" must not fire a command, because a wrong match silently eats what you said. Over 60 of the cases in `commands.test.js` are ordinary sentences asserted to parse as *nothing*.

The help panel's command reference is generated at runtime from `COMMANDS`, the same array the parser is driven by, so the documentation cannot drift from what actually works. Adding a command to the parser adds it to the help for free.

Hold-to-talk needs a native helper. Electron's `globalShortcut` fires only on key-down, never key-up, and it cannot bind a bare modifier or tell left ⌥ from right ⌥ — so `src/native/rightopt.swift` runs a listen-only `CGEventTap` that watches `flagsChanged` for keycode 61 and prints `down`/`up`. It is built by `npm run build:native` (which `npm start` runs for you) and spawned as a child process. Without Input Monitoring permission `tapCreate` returns nil, the helper exits non-zero, and the app says so and falls back to ⌃⌥C.

## The glossary

`vocabulary` becomes whisper.cpp's initial prompt (`prompt` on the server, `--prompt` on the CLI). The decoder conditions on it, so those spellings become much cheaper token sequences and often win *during* recognition — which means interim text is right too, not just the settled utterance. Whisper truncates its prompt at 224 tokens, so the list is capped at 800 characters and extra terms are dropped from the end.

A correction's left-hand side may list alternatives, separated by commas: `"Mirror, Myra, Meera": "Mira"` is three spellings of one name. Read literally it would be a phrase nobody ever says — a rule that sits in the file looking like it works and never fires — and writing it that way is what people do unprompted when they edit the settings by hand, so it means what it looks like it means. The panel splits what you type into one rule per spelling; a comma-joined key written by hand is matched the same way, so an existing file needs no migration.

**Prompt echo** is the reason to keep that list short. The prompt is prepended as prior context, and over silence or room noise Whisper will happily just repeat it back — the shorter the glossary, the more often it does. A one-term glossary turns every cough into that term. So an utterance made of *nothing but* glossary words is dropped, exactly like the model's other stock hallucinations. Said inside a real sentence the term still comes through, which is what it was added for. The cost is that dictating a single glossary term on its own does nothing; set `dropGlossaryEcho: false` if you need that.

The one exemption is an agent's wake name. Putting "Hey Mira" in the glossary so the name is spelled right is the obvious thing to do, and it would otherwise make the bare wake phrase unsayable — an utterance that is nothing but a term. Worse, it would break only once the model got good enough to transcribe the name exactly. So the roster's names are passed to the recogniser alongside the glossary, and an utterance that is exactly one of them is an address, not an echo.

`corrections` is the backstop for the passes where the nudge lost. Each key is matched whole-word and case-insensitively, and a space in the key matches any run of whitespace or punctuation — so `"trans vibe"` also catches `Trans-Vibe` and `trans vibe.`. Replacements are inserted verbatim, longest key first, and never fire inside a longer word (`undruppled` stays put).

## The visualizer

Ported from a radial visualizer to a horizontal band: three hue families at 0/0.33/0.66 offsets over a slowly drifting base hue, 18 polylines each, every point displaced by its FFT bin, and a per-line random-walk twist — that jitter is what makes it read as "electric" rather than as a clean sine. Additive blending gives the bloom where lines cross, and a thin white line rides on top as the hot core. When silent the band collapses to a nearly straight horizontal line with a slow breathing pulse.

The glow comes from drawing the band to an offscreen canvas and blitting it twice, blurred then crisp, so it costs one blur per frame rather than one per stroke. That, and dropping to 8fps in a quiet room, is why the whole app idles around 12% CPU — [the measurements are here](performance.md).

## Project layout

```
src/main/       index.js      windows, tray, shortcuts, IPC, send
                whisper.js    engine lifecycle + serialised inference queue
                whisper-parse.js  output parsing, artifact filter, queue
                wav.js        Float32 → 16-bit PCM WAV
                models.js     find or download a ggml model
                spaces.js     the markers, and the apps that are running
                overlay.js    strip and orb geometry + hover-wake rule (pure)
                config.js     settings persistence
                assist.js     optional local LLM pass (Ollama)
                cli-agent.js  spawning `claude` or `codex`, and surviving it
                speech.js     saying a confirmation out loud via `say`
src/shared/     agents.js     who you can talk to, and what a name means (pure)
                spaces.js     which Space or app a spoken name meant (pure)
                conversation.js  prompts and guards for talking to one (pure)
                glossary.js   vocabulary prompt + corrections (pure)
                assist.js     assist prompts + reply guards (pure)
                escalate.js   when a local answer is not good enough (pure)
                cli.js        argv for a frontier CLI, and reading it back (pure)
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
                band.js       the ribbon's math (pure)
                visualizer.js the ribbon, on a canvas
                orb.js        the orb's math: ring, walk, mirror, zoom (pure)
                orb-viz.js    the orb, on a canvas — both its rings
                orb-window.js the orb window's whole renderer
                waiting.js    when a slow answer is worth saying something about (pure)
                saying.js     a synthetic spectrum for the app's own voice (pure)
                saying-viz.js the same ribbon, small, warm, drawn while it talks
                pcm-worklet.js
src/native/     rightopt.swift   right-⌥ hold detection via CGEventTap
                sendkeys.swift   posts ⌘V to the frontmost app
script/         install-launcher.sh  build ~/Applications/Transvibe.app
                make-icon.py         draw build/icon.icns
```

The pure modules — `vad`, `commands`, `band`, `wav`, `overlay`, `presence`, `glossary`, `glossary-edit`, `assist`, `agents`, `conversation`, `placement`, `whisper-parse`, `settings-schema`, `settings-voice`, `saying` — take no DOM, Electron, filesystem or network dependency, which is what makes the awkward parts (segment boundaries, command false positives, model replies) testable under plain Node rather than only discoverable by hand.
