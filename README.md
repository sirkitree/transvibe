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

## Run

```sh
npm install
npm start          # or: npm run dev  (opens a CDP port on 9333)
```

On first launch it asks for microphone access, then finds a Whisper model: its own `~/Library/Application Support/transvibe/models/`, else one another local Whisper app already downloaded (superwhisper, MacWhisper, `~/.cache/whisper.cpp` — read only), else it downloads `ggml-base.en.bin` (~148 MB).

Three macOS permissions are involved, each degrading on its own rather than taking the app down with it:

| grant | needed for | without it |
|---|---|---|
| Microphone | everything | the app says so in the status line |
| Input Monitoring | right-⌥ hold | falls back to ⌃⌥C |
| Accessibility | pasting on send | text is still on the clipboard |

## The short version

Talk, and the text appears as you speak. The strip ignores your mouse until you rest the pointer on it; then the words become clickable and a row of buttons appears under them. Six seconds after you stop talking the text fades away on its own.

| | |
|---|---|
| `⌃⌥↩` | Paste the transcript into the app in front |
| `⌃⌥Space` | Show or hide the strip |
| `⌃⌥C` | Speak one editing command instead of dictating |
| Hold right `⌥` | The same, held rather than toggled |
| `esc` | Get the transcript out of the way |
| Click a word | Fix what it heard, and teach it the right spelling |

The **?** button opens the same reference in the app, generated from the parser itself.

## Docs

| | |
|---|---|
| [Using transvibe](docs/using.md) | The strip, every control, command mode, the glossary, sending text |
| [The assist model](docs/assist.md) | Optional local LLM: filler-word cleanup, smarter command mode |
| [Settings](docs/settings.md) | Every key in `settings.json` |
| [Architecture](docs/architecture.md) | The pipeline, interim results, the overlay, project layout |
| [Testing](docs/testing.md) | What the 351 tests cover, and the manual checklist |
| [Performance](docs/performance.md) | Where the visualizer's cost went |
| [Demo](docs/demo.md) | A two-minute scenario for showing it to someone |

## Develop

```sh
npm test               # 351
npm run test:unit      # pure modules only, no whisper binary needed
npm run dev            # CDP on 9333
npm run dist           # -> dist/mac-arm64/transvibe.app
```

Most of the interesting logic lives in modules that take no DOM, Electron, filesystem or network dependency — the VAD's segment boundaries, the command parser's false positives, the guards on the assist model's replies — which is what makes them testable under plain Node rather than only discoverable by hand.

Packaging does not run `build:native`, so build the helpers first. The app is unsigned and does not bundle `whisper-cpp`.
