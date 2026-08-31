# Settings

The gear on the strip, or **Settings…** in the menu bar (⌘,). Tabs down the left, one section at a time; every change saves and takes hold as you make it, which is the point — the speech threshold and the fade delay are settings you tune by watching what they do, not by editing a file and relaunching.

Two exceptions say so on the row: the speech model and the language are baked into a running whisper server and take effect on restart.

Two settings are not in the panel. `vocabulary` and `corrections` have the glossary panel, which is a better editor for them than a text field; the panel links there. One setting in the panel is not in the file: **Launch at login** is macOS's, kept in its Login Items list.

Behind it is `~/Library/Application Support/transvibe/settings.json`, written on change and merged over the defaults, so deleting the file resets everything. Editing it by hand still works; the panel reads it fresh each time it opens.

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
