# Tests

```sh
npm test          # 382
npm run test:unit # pure modules only, no whisper binary needed
```

| file | | covers |
|---|---:|---|
| `commands.test.js` | 167 | command parsing, false positives, transcript edits |
| `wav.test.js` | 26 | header byte-exactness, clamping, overflow guards |
| `glossary-edit.test.js` | 23 | glossary panel edits, word splitting |
| `whisper-parse.test.js` | 21 | output parsing, artifact filter, FIFO queue |
| `glossary.test.js` | 21 | prompt budget, whole-word corrections, echo filter |
| `assist.test.js` | 18 | assist prompts, and the guards on its replies |
| `overlay.test.js` | 17 | strip geometry, hover-wake dwell, the sleep grace |
| `vad.test.js` | 16 | segment boundaries, hangover, force-flush, bad options |
| `band.test.js` | 15 | visualizer math stays finite and in-bounds |
| `settings-schema.test.js` | 13 | the panel's schema against `config.js`, both directions |
| `modules.test.js` | 13 | every module imports, and exports what it claims |
| `presence.test.js` | 11 | when the transcript fades, and what un-fades it |
| `models.test.js` | 11 | model discovery against a real directory tree |
| `assist-models.test.js` | 6 | listing what Ollama has, and what an absent Ollama reads as |
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

`models.test.js` builds a temporary Application Support tree rather than mocking `fs`, because the failures worth catching are all about what a real directory holds: a CoreML bundle whose `weight.bin` files are each larger than a small ggml model, and an OpenVINO encoder sitting beside its model under nearly its name. Both would list as models, and neither would load.

`settings-schema.test.js` is the one that stops the settings panel drifting from the file behind it. It asserts in both directions — every key in `DEFAULTS` has a row, every row names a key that exists — so adding a setting to `config.js` and forgetting the panel is a failing test rather than a setting nobody can reach.
