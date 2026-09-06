# Tests

```sh
npm test          # 843
npm run test:unit # pure modules only, no whisper binary needed
```

| file | | covers |
|---|---:|---|
| `commands.test.js` | 224 | command parsing, false positives, transcript edits |
| `agents.test.js` | 50 | the roster: names, kinds, providers, and who escalates to whom |
| `orb.test.js` | 39 | the seed ring, the walk, the mirror, and the zoom envelope |
| `assist.test.js` | 36 | assist prompts, and the guards on its replies |
| `wake.test.js` | 35 | the wake phrase: what starts a command, and what is just speech |
| `settings-voice.test.js` | 34 | changing a setting by voice, and which ones can be |
| `spaces.test.js` | 30 | desktop Space markers, matching, and switch targets |
| `escalate.test.js` | 28 | when a local answer is not good enough, and who is asked next |
| `whisper-parse.test.js` | 28 | output parsing, artifact filter, FIFO queue |
| `modules.test.js` | 27 | every module imports, and exports what it claims |
| `overlay.test.js` | 26 | strip and orb geometry, hover-wake dwell, the sleep grace |
| `wav.test.js` | 26 | header byte-exactness, clamping, overflow guards |
| `cli-agent.test.js` | 24 | spawning a frontier CLI against a fake process: timeouts, cancel, exit codes |
| `glossary-edit.test.js` | 23 | glossary panel edits, word splitting |
| `waiting.test.js` | 22 | the wait indicator's timing, and the once-only spoken nudge |
| `cli.test.js` | 21 | the argv handed to `claude` and `codex`, and reading what they print |
| `glossary.test.js` | 21 | prompt budget, whole-word corrections, echo filter |
| `settings-schema.test.js` | 21 | the panel's schema against `config.js`, both directions |
| `vad.test.js` | 21 | segment boundaries, hangover, force-flush, bad options |
| `presence.test.js` | 19 | when the transcript fades, when it is forgotten, and what un-fades it |
| `conversation.test.js` | 18 | the ask prompt, and what counts as an answer worth speaking |
| `band.test.js` | 15 | the ribbon's math stays finite and in-bounds |
| `placement.test.js` | 12 | where the strip is allowed to sit on a screen |
| `saying.test.js` | 12 | the speaking indicator's arithmetic |
| `models.test.js` | 11 | model discovery against a real directory tree |
| `assist-models.test.js` | 8 | listing what Ollama has, and what an absent Ollama reads as |
| `speech.test.js` | 8 | voice list parsing, and the `say` argv |
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
- [ ] Transcript disappears ~20s after that; hovering the strip in the meantime keeps it
- [ ] After a fade, the next thing you say starts a fresh transcript
- [ ] ⌃⌥↩ still sends a faded transcript
- [ ] Microphone permission prompt appears on first launch
- [ ] Visualizer sits flat and still when the room is quiet
- [ ] Visualizer reacts immediately and colorfully to speech
- [ ] Switching the visualizer to the orb puts a round one in the lower-left corner and empties the ribbon's band, without moving the transcript or the buttons
- [ ] The orb is click-through everywhere, corners included — clicking it reaches whatever is behind
- [ ] The orb breathes outward when you speak and settles when the room goes quiet
- [ ] Holding right ⌥ washes the orb amber, the way it turns the strip amber
- [ ] A spoken answer draws a smaller ring turning the other way inside the orb, and it goes when the sentence ends
- [ ] ⌃⌥Space hides the orb along with the strip, and brings both back
- [ ] The orb sits above the Dock, and moves with the strip to another display
- [ ] Switching back to the ribbon removes the orb's window and puts both strip canvases back
- [ ] Text appears while you are still talking, highlighted in blue
- [ ] Blue interim text is replaced by the final when you stop
- [ ] Transcript appends within ~1s of finishing a sentence
- [ ] Holding right ⌥ turns the strip amber and shows the Command banner
- [ ] Left ⌥ does nothing (only the right key arms command mode)
- [ ] ⌃⌥C turns the strip amber and shows the Command banner
- [ ] A spoken command edits the transcript and returns to transcribe mode
- [ ] Command mode disarms itself after 6s of silence
- [ ] "hey Claude, delete that" edits the transcript with no key touched
- [ ] The strip turns amber part-way through saying it, and hides the keyword
- [ ] "hey Claude" alone arms command mode for the next thing you say
- [ ] "I told him hey Claude was down" is transcribed, not obeyed
- [ ] "hey Claude, blah blah" puts the words in the transcript rather than dropping them
- [ ] Clearing the wake phrase in Settings turns the whole thing off
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

Escalation, which is almost entirely beyond the unit suite — the pure modules decide *whether* to escalate, but nothing under Node ever spawns a CLI, draws the wait, or speaks the attribution:

- [ ] With `remote` off, "ask Claude about that" is transcribed, not obeyed
- [ ] Turning `remote` on with no `claude` or `codex` installed says so once, at startup
- [ ] A question the local model admits defeat on comes back in a frontier model's words, prefixed "Claude said, …"
- [ ] The bubble wears the answering agent's name and colour, and the spoken line names it once, not twice
- [ ] The strip does not fade during a 14s codex call, and the transcript is still there when the answer lands
- [ ] The pending bubble counts seconds up rather than sitting on a static '…'
- [ ] Past ~10s a spoken nudge says it is still waiting — once, not once a frame
- [ ] "stop" and esc kill the subprocess: `pgrep -f 'claude -p'` is empty within a second, and nothing is spoken afterwards
- [ ] Quitting the app mid-call leaves no orphaned `claude` or `codex` process
- [ ] With `remoteAnnounce` off the escalation still happens and is still on screen, just not narrated
- [ ] With `remoteWebSearch` on, "what came out this week" answers with something the local model could not know
- [ ] Turning `remote` off mid-conversation stops the next question leaving the machine
- [ ] Dictation, cleanup and command guessing are unaffected by any of the above — nothing of them appears in a CLI's transcript

`models.test.js` builds a temporary Application Support tree rather than mocking `fs`, because the failures worth catching are all about what a real directory holds: a CoreML bundle whose `weight.bin` files are each larger than a small ggml model, and an OpenVINO encoder sitting beside its model under nearly its name. Both would list as models, and neither would load.

`settings-schema.test.js` is the one that stops the settings panel drifting from the file behind it. It asserts in both directions — every key in `DEFAULTS` has a row, every row names a key that exists — so adding a setting to `config.js` and forgetting the panel is a failing test rather than a setting nobody can reach.

## Screenshots

The images in `docs/images/` are taken by `script/make-screenshots.mjs`, driving a running app over its CDP port:

```sh
npm run dev &
node script/make-screenshots.mjs
```

The ribbon gets its own recorder, because a still of a moving band is a squiggle:

```sh
node script/make-visualizer-media.mjs     # -> visualizer.png and visualizer.gif
```

That one is not staged at all beyond the backdrop. macOS `say` reads a line out loud, the microphone picks it up like any other sound in the room, and the frames are whatever the app drew in response — the transcript in them is that sentence, actually transcribed. It needs `ffmpeg` for the GIF and writes the PNG either way, choosing the busiest frame for it rather than the first, since a frame caught between words is the flat line this is trying not to show.

Retake them after anything that changes what the strip or a panel looks like. Two things in there are staged rather than captured as found, and both on purpose: a plain dark backdrop stands in for whatever would really be behind a click-through window, and the glossary panel is rendered from a demo glossary held in memory, because the real one is full of the client names and jargon its owner has had to teach it. Nothing is written to `settings.json`, and the app is put back the way it was found.
