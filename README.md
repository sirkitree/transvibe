# transvibe

Local voice-to-text for macOS. A click-through strip across the top of the
screen that listens continuously, transcribes on-device with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), and draws a colorful
"electric" audio visualizer hanging off the top edge.

- **No window.** Clicks land in whatever is behind it until you park the pointer on it
- Text appears **while you are still talking**, not after you stop
- The transcript fades a few seconds after you stop; esc clears it now
- Hold right ⌥ to speak an editing command instead of dictating
- ⌃⌥↩ pastes the transcript straight into whatever app is in front
- Optionally, a second local model tidies the fillers out and makes command
  mode understand phrasings the rules never learned
- Lives in the menu bar

**No cloud service.** Audio never leaves the machine — there is no network call
anywhere in the transcription path. The only outbound request the app can ever
make is a one-time model download from Hugging Face, and only if it cannot find
a Whisper model already on disk. The optional assist model runs locally too,
through Ollama on `127.0.0.1`, and is only ever sent text.

## Requirements

- macOS on Apple Silicon (Metal acceleration)
- Node 20+
- `brew install whisper-cpp`
- Swift (from the Xcode command line tools) to build the key-tap helper

Optional, for [the assist model](#the-assist-model-optional): [Ollama](https://ollama.com)
and `ollama pull gemma4:e2b` (~7.2 GB). Everything works without it.

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

### Turning on the assist model

Off by default, and the app never mentions it unless you ask for it. If you
want the filler-word cleanup and the smarter command mode:

```sh
ollama pull gemma4:e2b     # ~7.2 GB, one time
```

then in `~/Library/Application Support/transvibe/settings.json`:

```json
{ "cleanup": true, "commandFallback": true }
```

Restart, and say something with a false start in it — "um so I was thinking
maybe we could ship this on Friday, no wait, Thursday". Whisper's text appears
as you speak; a tidied version swaps in about a quarter of a second after you
stop. Then hold right ⌥ and try a phrasing the rules do not know, like "nope,
take that back" or "stick that on the clipboard for me".

If Ollama is not running or the model was never pulled, the strip says so once
and everything carries on exactly as before. [How it works, and what it
deliberately does not do](#the-assist-model-optional).

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

The pure modules — `vad`, `commands`, `band`, `wav`, `overlay`, `presence`,
`glossary`, `glossary-edit`, `assist`, `whisper-parse` — take no DOM, Electron, filesystem or network dependency, which
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

The controls only exist while the strip is awake — asleep it is a ribbon and
some text, and there would be nothing to click anyway. They sit in a row
directly under the transcript, not off in a corner: hovering the text is what
woke the strip, so the pointer is already there. The row holds its space
whether visible or not, so waking never shifts the layout out from under the
pointer.

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

Anything the rules cannot place is shown as `not a command: "…"` rather than
guessed at, so nothing you said is silently swallowed. With
[`commandFallback`](#the-assist-model-optional) on, that miss goes to the local
assist model first, which makes phrasings like "nope, take that back" or "stick
that on the clipboard for me" work without adding a rule for each one.

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
strip; right-click opens a menu with show/hide, a listening checkbox, copy and
clear, and Quit.

Hiding parks the app in the menu bar with the model still resident, so bringing
it back is instant rather than a fresh model load. It comes back with
`showInactive`, never stealing focus from what you were typing in. Only Quit
(or `⌘Q`) actually tears down the engine.

### Getting out of the way

There is no window. The app is a frameless, transparent strip hanging from the
top of the work area — 180pt tall, or taller when there is more to show, `alwaysOnTop` at the `screen-saver`
level so it survives full-screen apps, and **click-through**: every click goes
to whatever is behind it.

Three things make that liveable.

**Hover to wake.** Rest the pointer on the strip and it turns solid — words
become clickable, the buttons appear. Move away and it is a ghost again.
Waking takes a deliberate dwell (`wakeDelayMs`, 320ms) so sweeping up to the
menu bar never steals a click; sleeping is immediate, because a strip that
stays solid after you have gone is the whole problem this layout exists to
solve.

**Only over something clickable.** Being on the strip is not enough — most of
it is empty air. The renderer watches the forwarded mouse-move events and tells
the main process whether the pointer is over the text, a control or a panel; a
click in the gaps reaches the app underneath even though the pointer is
technically on the overlay.

The wake decision is polled from the cursor position rather than driven by
mouse events, because a click-through window is only told about movement *over*
it: it can see the pointer arrive but never see it leave. `src/main/overlay.js`
holds the geometry and the dwell rule as pure functions.

**The text fades.** `idleFadeMs` (6s) after the last thing you said, the
transcript fades out. It stays in memory — ⌃⌥↩ still sends it — but it is now
*stale*, so the next utterance starts a fresh transcript rather than appending
to something you can no longer see. Anything that counts as interest resets the
clock: speech, an interim update, the pointer arriving, a panel being open. Esc
clears it outright. `src/renderer/presence.js` is that state machine, pure and
clock-injected.

**The strip is as tall as its contents.** The renderer measures its own laid-out
content after every render and the window follows. A fixed height clipped the
last line of a three-line utterance and cut the button row underneath it in
half; measuring means the buttons are always fully on screen, wherever the text
happens to wrap. The transcript itself caps at four lines and the oldest
scrolls off under the mask. Only the stage is measured, never an open panel —
a panel is sized in percentages of the window, so feeding its height back in
would grow the strip without limit.

Opening the help or glossary panel asks the main process for at least
`panelHeight` (560pt) and pins it awake; closing shrinks it back. Panels are
near-opaque rather than glass: `backdrop-filter` is dead weight on a
transparent window with no vibrancy material — there is no backdrop for it to
sample — so a translucent panel was really just showing whatever bright thing
was behind it straight through the text. A panel is something you opened in
order to read it.

### The assist model (optional)

A second, local model — Gemma 4 E2B through [Ollama](https://ollama.com) —
does the two things whisper and a rule parser each do badly. Both features are
off by default and the app is unchanged without them: if Ollama is not running
or the model was never pulled, the availability check fails once and every
later call short-circuits.

```sh
ollama pull gemma4:e2b     # ~7.2 GB
```
```json
{ "cleanup": true, "commandFallback": true }
```

Still no cloud. Ollama serves on `127.0.0.1` and the audio never reaches it at
all — only text does.

**`cleanup`** rewrites a settled utterance with the filler words and false
starts taken out. "Um, so I was thinking we should uh ship the thing on Friday"
becomes "So I was thinking we should ship the thing on Friday". It runs after
whisper's text is already on screen, so it costs nothing you wait for; the
tidier version swaps in a few hundred milliseconds later, or never.

Every reply is guarded before it can touch the transcript, because the failure
that matters is not a bad rewrite but a *plausible* one — a summary, or an
answer to a question the user happened to dictate. A reply that is under half
or over 1.5× the original's length, that opens like a chatbot ("Here's the…"),
or that comes back empty is discarded and the original stands. `acceptCleanup`
in `src/shared/assist.js` is that rule, unit-tested, and it always returns
something safe to show.

**`commandFallback`** fills the seam the rules leave open. An utterance spoken
in command mode that `parseCommand` cannot place used to be logged and shown as
"not a command"; now the model is asked what it meant. It does not invent a
command — it picks one of the 66 example phrases the parser already
understands, and that phrase goes straight back through `parseCommand`. Two
things fall out of that: a wrong answer can only ever produce a command the app
actually implements, and everything the rules know about targets and counts
("the last three words") keeps working without a second, weaker copy of it.

It is safe to ask here precisely because command mode is armed deliberately.
The model is never shown ordinary dictation, so it never gets the chance to
mistake any for a command — which it will: asked cold, "I need to copy that
file to the server" comes back as `copy`. That is the exact false positive
`commands.test.js` has 60-odd cases guarding against, and it is why the rules
stay in front.

Measured on an M-series Mac, warm, with thinking disabled (`reasoning_effort:
"none"` — leaving it on cost ~1.1s per call for a task that needs none):

| | |
|---|---:|
| cleanup, one sentence | 170–350ms |
| command fallback | 180–510ms |

**What was tried and rejected:** Gemma 4 takes audio natively, so it could
replace whisper outright. On the same clips it was slower and less accurate —
"Vinchi" for "Vinci", words dropped off the end of a long sentence, and it
ignored an instruction to clean up while transcribing. Whisper keeps the audio.
Google's other new model, Gemini 3.5 Transcribe, does all of this better and in
one pass, but it is a cloud API with no open weights, which would cost this app
the only property it really has.

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
| `stripHeight` | `180` | minimum height of the strip; it grows to fit |
| `panelHeight` | `560` | height while the help or glossary panel is open |
| `wakeDelayMs` | `320` | pointer dwell before the strip stops being click-through |
| `idleFadeMs` | `6000` | silence before the transcript fades |
| `alwaysOnTop` | `true` | keep above other windows |
| `autoCopy` | `false` | copy every finished utterance automatically |
| `modelPath` | `null` | pin a specific ggml model |
| `language` | `'en'` | recognition language |
| `vocabulary` | `[]` | terms to bias recognition toward (see Glossary) |
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

### Glossary

**Click a word in the transcript** to say what it should have been. The
rewrite always happens; what you keep is the opt-out. *Remember the fix* saves
it as a rule, and *listen for it too* adds the corrected spelling to the terms
— untick both and the word is simply fixed here and now, which is what a
one-off mishearing deserves. Both checkboxes hold their setting for the rest of
the session, so a run of throwaway fixes is one click, not one per word.

Esc, the *esc* button, or a click anywhere outside dismisses it without
changing anything. Dragging still selects text; only a click that leaves no
selection opens the fixer. The "heard" side stays editable, which is how a
two-word phrase gets a rule.

The book button opens the glossary panel: terms on top, fixes
below, added and removed in place. Every edit is written to the settings file
and swapped into the running recogniser immediately — the model stays loaded,
and the change takes effect on the next thing you say. The file below is the
same data, if you would rather paste a list in.

Names, jargon and product words are what a small Whisper model gets wrong most
consistently — it has never seen them, so it reaches for the nearest thing it
has. Two settings attack that from opposite ends.

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

`vocabulary` becomes whisper.cpp's initial prompt (`prompt` on the server,
`--prompt` on the CLI). The decoder conditions on it, so those spellings become
much cheaper token sequences and often win *during* recognition — which means
interim text is right too, not just the settled utterance. It is a nudge, and
Whisper truncates its prompt at 224 tokens, so the list is capped at 800
characters and extra terms are dropped from the end. Keep it to words that
actually get mangled; a long list of ordinary English wastes the budget and
tempts the model into reciting the prompt back.

**Prompt echo.** The initial prompt is prepended as prior context, and over
silence or room noise Whisper will happily just repeat it back — the shorter
the glossary, the more often it does. A one-term glossary turns every cough
into that term. So an utterance made of *nothing but* glossary words is
dropped, exactly like the model's other stock hallucinations (`Thank you.`,
`[BLANK_AUDIO]`). Said inside a real sentence the term still comes through,
which is what it was added for. The cost is that dictating a single glossary
term on its own does nothing; set `dropGlossaryEcho: false` if you need that.

`corrections` is the backstop for the passes where the nudge lost. Each key is
matched whole-word and case-insensitively, and a space in the key matches any
run of whitespace or punctuation — so `"trans vibe"` also catches `Trans-Vibe`
and `trans vibe.`. Replacements are inserted verbatim, longest key first, and
never fire inside a longer word (`undruppled` stays put).

Edits take effect on the next utterance; the model stays loaded.

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
| `overlay.test.js` | 16 | strip geometry, hover-wake dwell |
| `assist.test.js` | 18 | assist prompts, and the guards on its replies |
| `presence.test.js` | 11 | when the transcript fades, and what un-fades it |
| `glossary.test.js` | 18 | prompt budget, whole-word corrections |
| `glossary-edit.test.js` | 23 | glossary panel edits, word splitting |
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
- [ ] With `commandFallback` on, "nope, take that back" undoes
- [ ] With it off, the same phrase is reported as not a command
- [ ] With `cleanup` on, "um so I was thinking, no wait" tidies itself a moment later
- [ ] With Ollama stopped, both features fail quietly and dictation is unaffected
- [ ] Command mode disarms itself after 6s of silence
- [ ] ? opens the help panel; esc closes it; it scrolls and lists every command
- [ ] ⌃⌥↩ from Warp pastes the transcript straight into Warp
- [ ] The ➤ button hides transvibe, restores the previous app, and pastes there
- [ ] Opening a panel grows the strip; closing it shrinks back
- [ ] `⌃⌥Space` toggles visibility from another app
- [ ] Waveform icon appears in the menu bar and adapts to light/dark
- [ ] × clears the transcript; the tray icon still shows and hides the strip
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
