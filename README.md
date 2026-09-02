# transvibe

Local voice-to-text for macOS. A click-through strip across the top of the screen that listens continuously, transcribes on-device with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and draws a colorful "electric" audio visualizer hanging off the top edge.

- **No window.** Clicks land in whatever is behind it until you park the pointer on it
- Text appears **while you are still talking**, not after you stop
- The transcript fades a few seconds after you stop, and is forgotten entirely twenty seconds later; esc clears it now
- Hold right ⌥ — or just say "hey Claude" — to speak an editing command instead of dictating
- Ignores music and background noise rather than transcribing it, while the visualizer still reacts to it
- Commands chain: "open settings and change the voice to Karen"
- Settings change by voice too — "turn off spoken replies", "set the fade to ten seconds", "what's the threshold"
- It **says what it did** after a command — you are looking at the app you are dictating into, not at the strip
- ⌃⌥↩ pastes the transcript straight into whatever app is in front
- Optionally, a second local model tidies the fillers out and makes command mode understand phrasings the rules never learned
- Every setting is a panel on the strip, applied as you change it
- Lives in the menu bar

![The strip reacting to a spoken sentence: the ribbon flat and dim in silence, alive as the words come, and settling again as the finished transcript appears](docs/images/visualizer.gif)

<!-- demo video goes here: drag the .mp4 into a GitHub comment box, paste the
     user-attachments URL on the next line. Script: docs/demo.md -->

**No cloud service.** Audio never leaves the machine — there is no network call anywhere in the transcription path. The only outbound request the app can ever make is a one-time model download from Hugging Face, and only if it cannot find a Whisper model already on disk. The optional assist model runs locally too, through Ollama on `127.0.0.1`, and is only ever sent text.

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

## Install it as an app

`npm start` needs a terminal to stay open, and the checkout to be findable. This puts transvibe in `~/Applications` with an icon, launchable from Spotlight or the Dock:

```sh
./script/install-launcher.sh
```

The bundle it builds runs **this working tree** — Electron's own `.app`, copied and renamed, with `Resources/app` symlinked back to the repo — so an ordinary source edit needs a relaunch and not a rebuild. Re-run the script after `npm install` pulls a new Electron; moving the checkout breaks the symlink.

`npm run dist` builds a self-contained `.app` instead, and is **not** currently usable: `electron-builder` seals `bin/` inside the asar, where the app cannot spawn the two Swift helpers, so the right-⌥ hotkey and pasting on send both fail. Packaging also does not run `build:native`. The app is unsigned either way and does not bundle `whisper-cpp`.

On first launch it asks for microphone access, then finds a Whisper model. It looks for `ggml-*.bin` in its own `~/Library/Application Support/transvibe/models/` and then, read only, a few folders deep through `~/Library/Application Support`, `~/Library/Caches` and `~/.cache` — which is where superwhisper, MacWhisper, Highlight and whisper.cpp keep theirs. Failing all of that it downloads `ggml-base.en.bin` (~148 MB). The Transcription tab lists everything it found, with the size and whose folder it came from.

Only whisper.cpp's ggml format is listed, because that is all the engine can load — MacWhisper and its kin also keep WhisperKit CoreML models, often the larger ones, and those need a different runtime.

Three macOS permissions are involved, each degrading on its own rather than taking the app down with it:

| grant | needed for | without it |
|---|---|---|
| Microphone | everything | the app says so in the status line |
| Input Monitoring | right-⌥ hold | falls back to ⌃⌥C |
| Accessibility | pasting on send | text is still on the clipboard |

## The short version

![The strip: the transcript with the in-flight words highlighted, the row of buttons under it, and the status line below those](docs/images/strip.png)

Talk, and the text appears as you speak. The strip ignores your mouse until you rest the pointer on it; then the words become clickable and a row of buttons appears under them. Six seconds after you stop talking the text fades away on its own, and twenty seconds after that it is thrown away — the room walking past the mic never becomes something you can paste.

| | |
|---|---|
| `⌃⌥↩` | Paste the transcript into the app in front |
| `⌃⌥Space` | Show or hide the strip |
| `⌃⌥C` | Speak one editing command instead of dictating |
| Hold right `⌥` | The same, held rather than toggled |
| `esc` | Get the transcript out of the way |
| Click a word | Fix what it heard, and teach it the right spelling |

The **?** button opens the same reference in the app, generated from the parser itself.

Click a word it got wrong and say what it should have been. Ticking *remember the fix* teaches it, so the correction and the spelling both stick:

![The word fixer open under a mis-heard word, with the heard word on the left, an empty field for the right one, and two checkboxes: remember the fix, listen for it too](docs/images/fixer.png)

Hold right ⌥ and the palette goes amber — the next thing you say is a command, not dictation. Saying "hey Claude, delete that" does the same thing with no key at all, and the strip goes amber while you are still speaking:

![The strip in command mode: an amber COMMAND badge, and the spoken command highlighted in amber rather than blue](docs/images/command-mode.png)

Settings are a panel on the strip, tabbed down the left, saved and applied as you change them:

![The settings panel, Listening tab: sliders for the speech threshold, the silence before an utterance ends, and the interim update interval](docs/images/settings.png)

## Docs

| | |
|---|---|
| [Using transvibe](docs/using.md) | The strip, every control, command mode, the glossary, sending text |
| [The assist model](docs/assist.md) | Optional local LLM: filler-word cleanup, smarter command mode |
| [Settings](docs/settings.md) | The settings panel, and every key behind it |
| [Architecture](docs/architecture.md) | The pipeline, interim results, the overlay, project layout |
| [Testing](docs/testing.md) | What the 417 tests cover, and the manual checklist |
| [Performance](docs/performance.md) | Where the visualizer's cost went |
| [Demo video](docs/demo.md) | The script for the video at the top of this page |

## Develop

```sh
npm test                      # 417
npm run test:unit             # pure modules only, no whisper binary needed
npm run dev                   # CDP on 9333
./script/install-launcher.sh  # -> ~/Applications/Transvibe.app, running this tree
```

Most of the interesting logic lives in modules that take no DOM, Electron, filesystem or network dependency — the VAD's segment boundaries, the command parser's false positives, the guards on the assist model's replies — which is what makes them testable under plain Node rather than only discoverable by hand.

The settings panel is generated from `src/renderer/settings-schema.js`, and a test holds that schema and `config.js` to each other in both directions: a setting added to one without the other fails rather than becoming quietly unreachable.

`script/make-icon.py` draws `build/icon.icns` — the visualizer's bars on the strip's scrim — rather than the repo carrying a designed one.
