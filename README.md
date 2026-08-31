# transvibe

Local voice-to-text for macOS. A translucent always-on-top HUD that listens
continuously, transcribes on-device with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
and draws a colorful "electric" audio visualizer along the bottom edge.

- Text appears **while you are still talking**, not after you stop
- Hold right ⌥ to speak an editing command instead of dictating
- ⌃⌥↩ pastes the transcript straight into whatever app is in front
- Lives in the menu bar; the window fades out of the way when unfocused

**No cloud service.** Audio never leaves the machine — there is no network call
anywhere in the transcription path. The only outbound request the app can ever
make is a one-time model download from Hugging Face, and only if it cannot find
a Whisper model already on disk.

## Requirements

- macOS on Apple Silicon (Metal acceleration)
- Node 20+
- `brew install whisper-cpp`
- Swift (from the Xcode command line tools) to build the key-tap helper

## Run

```sh
npm install
npm start          # or: npm run dev  (opens a CDP port on 9333)
```

On first launch it asks for microphone access, then looks for a Whisper model in
this order:

1. `~/Library/Application Support/transvibe/models/*.bin`
2. A model another local Whisper app already downloaded — superwhisper,
   MacWhisper, or `~/.cache/whisper.cpp`. These are **read only**; transvibe
   never writes into another app's directory.
3. Failing both, it downloads `ggml-base.en.bin` (~148 MB) into its own
   models directory.

## How it works

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
                             command mode (right ⌥ held) ─────────────┘
                               → commands.js → edit the transcript

send      ⌃⌥↩ → clipboard → hide if focused → bin/sendkeys posts ⌘V
keys      bin/rightopt (CGEventTap) → "down"/"up" → arm command mode
```

One microphone stream feeds both consumers, so there is no second capture
process and the visualizer is always in sync with what is being recognised.

`whisper-server` is spawned once on a free loopback port and keeps the model
resident. That turns the ~160 ms per-utterance model load into a one-time cost:
measured round-trip from renderer to transcript is **~105 ms** for a 3-second
utterance with `small.en`. If `whisper-server` is missing, the engine falls back
to spawning `whisper-cli` per utterance behind the same interface.

The VAD opens a segment after 3 consecutive frames above threshold and closes it
after 550 ms of silence, reporting the *true* onset frame so the ring-buffer
slice never clips the first syllable. Segments under 400 ms are discarded, and
one running past 15 s is force-flushed and immediately reopened.

### Interim results

Waiting for the hangover to expire means text only appears once you stop
talking. So while an utterance is still open, the audio so far is re-transcribed
every 500 ms and shown highlighted in blue — the same treatment the reference
design gives in-flight text. When the utterance closes, the final replaces it.

Measured on `small.en`, an utterance building up:

| audio so far | interim latency | text |
|---|---|---|
| 0.7 s | 111 ms | "testing one" |
| 1.4 s | 81 ms | "Testing 123." |
| 2.1 s | 87 ms | "Testing 123 transcribe" |
| 2.8 s | 101 ms | "Testing 123 transcribe this locally." |
| final | 104 ms | "Testing 123 transcribe this locally." |

Two rules keep the interims from getting in the final's way. Only one is ever in
flight — a slow model throttles them rather than queueing them ahead of the
final — and each carries a sequence number, so an interim that lands after a
newer one (or after the utterance has closed) is discarded rather than shown.
Interims also decode greedily (`beam_size 1`, `best_of 1`, no context carry-over)
since they are thrown away as soon as the next one lands, and they never touch
the clipboard.

Small Whisper models emit stock phrases on near-silence ("Thank you.",
"[BLANK_AUDIO]", "you"). `whisper-parse.js` filters these as whole-string
matches only, so a real sentence containing "you" survives untouched.

### Cost

Measured on an M-series Mac, quiet room, idle:

| | before | after |
|---|---|---|
| GPU process | 49% | 4.2% |
| renderer | 5.8% | 6.3% |
| whisper-server | 0.4% | 1.2% |
| **total** | **~55%** | **~12%** |

Almost all of it was one line of code. `shadowBlur` rasterises a blur *per
stroke*, and the band draws 55 strokes a frame — disabling it alone took the
GPU process from 49% to 12%. The glow now comes from drawing the band to an
offscreen canvas and blitting it twice, blurred then crisp, so it costs one
blur per frame instead of 55.

The rest came from frame pacing. 30fps is indistinguishable from 60 for a
flowing ribbon, and a silent room drops to 8. That idle path originally never
engaged: it tested `model.level`, which `levelGain` multiplies well past any
threshold, so a quiet room still painted at 26fps. It now keys off the VAD's
own state, which is the thing that actually knows whether anyone is talking.

Worth recording what did *not* help, since it is where the intuition goes
first: cutting the line budget from 54 to 36 and points from 220 to 160 changed
nothing measurable (13.5% either way). Once the blur was gone the cost was
compositing a transparent window, not drawing into it — so the line budget
stayed generous. Below ~10% the differences stop being resolvable by process
sampling at all; `backdrop-filter` measured *higher* switched off than on,
which is only noise.

Tunable in settings: `vizLinesPerFamily`, `vizPoints`, `vizFps`, `vizQuietFps`.

### The visualizer

Ported from a radial visualizer to a horizontal band: three hue families at
0/0.33/0.66 offsets over a slowly drifting base hue, 18 polylines each, every
point displaced by its FFT bin, and a per-line random-walk twist — that jitter
is what makes it read as "electric" rather than as a clean sine. Additive
blending plus `shadowBlur` gives the bloom where lines cross, and a thin white
line rides on top as the hot core. When silent the band collapses to a nearly
straight horizontal line with a slow breathing pulse, and rendering drops to
~30 fps, since a transparent window is expensive to composite.

## Project layout

```
src/main/       index.js      window, tray, shortcuts, IPC, send
                whisper.js    engine lifecycle + serialised inference queue
                whisper-parse.js  output parsing, artifact filter, queue
                wav.js        Float32 → 16-bit PCM WAV
                models.js     locate or download a ggml model
                bounds.js     window-geometry rules (pure)
                config.js     settings persistence
src/renderer/   app.js        transcript UI, command dispatch, help panel
                audio.js      mic graph, ring buffer, segment slicing
                vad.js        voice-activity state machine (pure)
                commands.js   voice-command parser + applier (pure)
                band.js       visualizer math (pure)
                visualizer.js canvas rendering
                pcm-worklet.js
src/native/     rightopt.swift   right-⌥ hold detection via CGEventTap
                sendkeys.swift   posts ⌘V to the frontmost app
```

The pure modules — `vad`, `commands`, `band`, `wav`, `bounds`,
`whisper-parse` — take no DOM, Electron, filesystem or network dependency, which
is what makes the awkward parts (segment boundaries, command false positives,
off-screen windows) testable under plain Node rather than only discoverable by
hand.

## Permissions

Three separate macOS grants, each degrading on its own rather than taking the
app down with it:

| grant | needed for | without it |
|---|---|---|
| Microphone | everything | the app says so in the status line |
| Input Monitoring | right-⌥ hold (`bin/rightopt`) | falls back to ⌃⌥C |
| Accessibility | pasting on send (`bin/sendkeys`) | text is still on the clipboard |

## Controls

The controls stay hidden until the pointer is over the window. They sit in a
column at the top right, and the transcript reserves a gutter beside them at
every scroll position — a float spacer would only hold the first few lines
clear, and text scrolled past it would slide under the buttons again. The bar
also carries a higher `z-index` than the transcript, which comes later in the
DOM and would otherwise swallow clicks over the overlap.

| | |
|---|---|
| Close (×) | Hide the window to the menu bar — does **not** quit |
| Copy | Copy the full transcript |
| Clear | Empty the transcript |
| Pin | Toggle always-on-top |
| ➤ | Send the transcript to the frontmost app |
| ? | In-app help — keys, buttons, and the full command list |
| Pause | Stop feeding segments to the recogniser |
| `⌃⌥Space` | Show/hide the window from anywhere |
| Hold right `⌥` | Speak one command instead of dictating |
| `⌃⌥C` | Same, without holding a key |
| `⌃⌥↩` | Send the transcript to the app in front |

## Command mode

By default everything you say is transcribed. **Hold the right ⌥ key** and the
window swings amber — speak one editing command, release, and it drops straight
back to transcribing. (**⌃⌥C** does the same thing without the hold, for when
the key is awkward.) If you say nothing it disarms itself after 6 seconds.

Releasing the key does not end command mode on its own: the utterance is
usually still open when your thumb comes up, and the VAD needs its silence
window to close it. Release just starts the idle timeout — the command is
consumed when the utterance actually finishes.

    "capitalize that"              "delete the last three words"
    "uppercase that"               "delete that" / "scratch that"
    "lowercase that"               "undo that" / "never mind"
    "new paragraph"                "replace whisper with Whisper"
    "question mark"                "copy that" / "clear everything"
    "send that" / "ship it"

Hold-to-talk needs a native helper. Electron's `globalShortcut` fires only on
key-down, never key-up, and it cannot bind a bare modifier or tell left ⌥ from
right ⌥ — so `src/native/rightopt.swift` runs a listen-only `CGEventTap` that
watches `flagsChanged` for keycode 61 and prints `down`/`up`. It is built by
`npm run build:native` (which `npm start` runs for you) and spawned as a child
process.

It needs **Input Monitoring** permission. Without it `tapCreate` returns nil,
the helper exits non-zero, and the app says so and falls back to ⌃⌥C — nothing
else breaks.

Recognition is **rule-based, not a model**. For this vocabulary a parser is
instant, deterministic, and unit-testable, where a local LLM would add a second
or two of latency and nondeterminism to every command. The design guards hard
against false positives — ordinary dictation like "I need to copy that file"
must not fire a command, because a wrong match silently eats what you said.
Anything the rules cannot place is logged to the console and shown as
`not a command: "…"` rather than guessed at; that log is the seam a local model
fallback drops into once there is evidence about which phrasings actually get
missed.

The **?** button opens an in-app help panel (`esc` or `?` toggles it too). Its
command reference is generated at runtime from `COMMANDS` — the same array the
parser is driven by — so the documentation cannot drift from what actually
works. Adding a command to the parser adds it to the help for free.

## Sending the transcript

Dictating into a HUD is only useful if the text can get where you actually want
it. **⌃⌥↩** (or the ➤ button, or saying *"send that"*) pastes the transcript
into whatever app is in front — no copy, switch, paste.

It pastes rather than typing the text out keystroke by keystroke: pasting is
instant and cannot mangle characters the target app treats specially.

The subtle part is focus. If transvibe has focus, ⌘V would land in its own
window, so it hides first — which returns macOS focus to whatever app you were
in before. Triggered by the global shortcut it never had focus at all, and the
target is already frontmost. Set `sendTarget` in settings to an app name (e.g.
`"Warp"`) to always focus that app first regardless.

| setting | default | |
|---|---|---|
| `sendTarget` | `null` | app to focus before pasting; null means whatever is in front |
| `sendPressesEnter` | `false` | also hit Return after pasting |
| `clearAfterSend` | `true` | empty the transcript once it has been delivered |

This needs **Accessibility** permission to post the keystroke — a different
grant from the Input Monitoring that the right-⌥ tap uses. Without it the text
is still on the clipboard and the status line says so, so the fallback is the
old copy-and-paste rather than nothing.

### Menu bar

transvibe lives in the macOS menu bar as a waveform icon. Left-click toggles the
window; right-click opens a menu with show/hide, a listening checkbox, copy and
clear, and Quit.

The window never really closes — closing it parks the app in the menu bar with
the model still resident, so bringing it back is instant rather than a fresh
model load. Only Quit (or `⌘Q`) actually tears down the engine.

### Focus fade

Unfocused, the window gets out of the way so you can read what is behind it.
Each layer fades independently rather than the panel fading as a whole — an
`opacity` on the shell would cap its children, and the band is the part still
worth glancing at from the background:

| layer | focused | unfocused |
|---|---|---|
| vibrancy material | `blur(28px)` | off |
| window shadow | on | off |
| visualizer | 1.0 | 0.56 |
| transcript / footer | 1.0 | 0.22 |
| buttons | hover only | hover only |
| dotted trim | 0.55 | 0.12 |

The vibrancy material has to go with the fade: it frosts whatever is behind the
window, which is exactly what you are trying to see. The window shadow goes too,
since a CSS opacity fade cannot reach it.

Tune the depth with `idleOpacity` in settings (default `0.22`); the visualizer
always rides `0.34` above it.

The window remembers its size and position and restores them on next launch,
debounced so a drag writes once rather than on every frame.

A saved rectangle is only reused if it still lands on a screen that exists, and
with enough overlap to actually grab (120×80pt). Unplug the external display the
window was parked on and it comes back centred at its old *size* rather than
stranded off-canvas where it cannot be reached or seen. `src/main/bounds.js`
holds that rule as a pure function so the recovery paths are unit-tested rather
than discovered the hard way.

### Settings

`~/Library/Application Support/transvibe/settings.json`, written on change and
merged over the defaults, so deleting the file resets everything.

| key | default | |
|---|---|---|
| `threshold` | `0.02` | RMS level that counts as speech |
| `hangoverMs` | `550` | silence before an utterance is considered finished |
| `interimMs` | `500` | how often the open utterance is re-transcribed |
| `commandTimeoutMs` | `6000` | command mode disarms itself after this |
| `sendTarget` | `null` | app to focus before pasting; null = whatever is in front |
| `sendPressesEnter` | `false` | also hit Return after pasting |
| `clearAfterSend` | `true` | empty the transcript once delivered |
| `idleOpacity` | `0.22` | how far the window fades when unfocused |
| `alwaysOnTop` | `true` | keep above other windows |
| `autoCopy` | `false` | copy every finished utterance automatically |
| `modelPath` | `null` | pin a specific ggml model |
| `language` | `'en'` | recognition language |
| `bounds` | `null` | last window rectangle |
| `vizLinesPerFamily` | `18` | polylines per hue family (×3) |
| `vizPoints` | `220` | samples per polyline |
| `vizFps` | `30` | frame rate while speech is detected |
| `vizQuietFps` | `8` | frame rate in a silent room |

## Tests

```sh
npm test          # 260 tests
npm run test:unit # 256 — pure modules only, no whisper binary needed
```

| file | | covers |
|---|---:|---|
| `commands.test.js` | 167 | command parsing, false positives, transcript edits |
| `wav.test.js` | 26 | header byte-exactness, clamping, overflow guards |
| `vad.test.js` | 16 | segment boundaries, hangover, force-flush, bad options |
| `band.test.js` | 15 | visualizer math stays finite and in-bounds |
| `bounds.test.js` | 11 | window restore, off-screen recovery |
| `whisper-parse.test.js` | 21 | output parsing, artifact filter, FIFO queue |
| `engine.integration.test.js` | 4 | the real engine, end to end |

The bulk sits in `commands.test.js` because a command parser's worst failure is
silent: a false positive eats dictation the user meant to keep. Over 60 of the
cases there are ordinary sentences — "I need to copy that file", "let's undo the
last commit", "send that email to Bob" — asserted to parse as *nothing*.

`engine.integration.test.js` is real end-to-end coverage with no cloud and no
microphone: macOS `say` synthesises a known phrase, `ffmpeg` conforms it to
16 kHz mono, and the engine has to read it back. It also covers an interim pass
over a partial utterance, and asserts that a second of pure silence returns
empty text rather than a hallucinated phrase. It self-skips if `say`, `ffmpeg`,
whisper.cpp, or a model is unavailable.

### Manual checklist

Things the automated tests cannot cover:

- [ ] Window is translucent and blurs the desktop behind it
- [ ] Specular rim reads as glass, not as a flat border
- [ ] Microphone permission prompt appears on first launch
- [ ] Visualizer sits flat and still when the room is quiet
- [ ] Visualizer reacts immediately and colorfully to speech
- [ ] Text appears while you are still talking, highlighted in blue
- [ ] Blue interim text is replaced by the final when you stop
- [ ] Transcript appends within ~1s of finishing a sentence
- [ ] Holding right ⌥ turns the window amber and shows the Command banner
- [ ] Left ⌥ does nothing (only the right key arms command mode)
- [ ] ⌃⌥C turns the window amber and shows the Command banner
- [ ] A spoken command edits the transcript and returns to transcribe mode
- [ ] Command mode disarms itself after 6s of silence
- [ ] ? opens the help panel; esc closes it; it scrolls and lists every command
- [ ] ⌃⌥↩ from Warp pastes the transcript straight into Warp
- [ ] The ➤ button hides transvibe, restores the previous app, and pastes there
- [ ] Window drags from anywhere but the buttons and transcript
- [ ] Moving or resizing the window and relaunching restores it in place
- [ ] Pin actually keeps it above full-screen apps
- [ ] `⌃⌥Space` toggles visibility from another app
- [ ] Waveform icon appears in the menu bar and adapts to light/dark
- [ ] × hides the window without quitting; the tray icon brings it back
- [ ] Clicking away fades the window and un-frosts the background behind it
- [ ] Clicking back restores it smoothly
- [ ] Buttons fade in on hover and away again when the pointer leaves
- [ ] With a long transcript scrolled to the bottom, text never runs under the
      buttons and every button is clickable across its whole area

## Package

```sh
npm run build:native   # compiles bin/rightopt and bin/sendkeys
npm run dist           # -> dist/mac-arm64/transvibe.app
```

`npm start` runs `build:native` for you; packaging does not, so build the
helpers first. They are bundled into the app under `bin/`.

Unsigned, and `whisper-cpp` is not bundled — the packaged app still needs
`brew install whisper-cpp` on the machine that runs it.

One thing to expect from the packaged build: macOS attributes Input Monitoring
and Accessibility to the specific binary asking, so grants that the helpers
inherited while running under `npm start` do not carry over. The app will prompt
again, and both features degrade as described under **Permissions** if denied.
