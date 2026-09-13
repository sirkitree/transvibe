# Settings

The gear on the strip, or **Settings…** in the menu bar (⌘,). Tabs down the left, one section at a time; every change saves and takes hold as you make it, which is the point — the speech threshold and the fade delay are settings you tune by watching what they do, not by editing a file and relaunching.

Two exceptions say so on the row: the speech model and the language are baked into a running whisper server and take effect on restart.

Six tabs, grouped by what you are trying to change rather than by which part of the app does it: **Listening** (what it hears and what it throws away), **Agents** (who you talk to and how they answer), **Transcription** (what turns sound into text), **Sending**, **Visuals** (the strip, and which visualizer is running), and **Advanced** (the plumbing). A long tab carries sub-headings rather than becoming a wall of sliders.

`vocabulary` and `corrections` are not in it: they have the glossary panel, which is a better editor for them than a text field, and the Transcription tab links there. `agents` is edited in the Agents tab, but as a list of records — a name, a kind, a voice and a model per row — rather than as fields. One setting in the panel is not in the file: **Launch at login** is macOS's, kept in its Login Items list.

![The settings panel, Listening tab: the tab list down the left, sliders on the right, each with its value and a line saying what it does](images/settings.png)

![The Transcription tab: a dropdown of the whisper models found on this machine, the language, and the glossary-echo toggle](images/settings-transcription.png)

The Visuals tab shows the dials of the visualizer that is actually running, and not the other one's. Which one is running is the first thing on it, under **The visualizer**, with the two frame rates — those pace whichever it is. Under that comes a second heading naming the one you picked, **The ribbon** or **The orb**, and only ever the one. Eight sliders where half of them do nothing you can see is worse than four, because you have to work out which half.

![The Visuals tab with the orb selected: a Which one dropdown reading “Orb in the corner”, the two frame rates, then the orb’s own dials — size, distance from the corner, filaments, filament length, inner ring size, and the two zoom settings](images/settings-visuals.png)

Most of it is reachable by voice too — "hey Claude, turn off spoken replies", "set the fade to ten seconds", "what's the threshold". Everything in the table below is, except `agents`, `language`, `sendTarget`, `spacesDir`, `modelPath` and `assistUrl`: those are free text or paths, and a misheard wake phrase would take the voice commands with it. [Using transvibe](using.md#settings-by-voice) has the grammar.

Behind it is `~/Library/Application Support/transvibe/settings.json`, written on change and merged over the defaults, so deleting the file resets everything. Editing it by hand still works; the panel reads it fresh each time it opens.

| key | default | |
|---|---|---|
| `threshold` | `0.02` | RMS level that counts as speech |
| `minSegmentMs` | `250` | shortest speech retained; lower helps quick wake phrases |
| `conversationHangoverMs` | `950` | silence before a chat turn ends; normal dictation keeps its own silence setting |
| `wakeConfidenceFloor` | `-0.85` | lower confidence allowed only for short exact multiword addresses after speech detection |
| `hangoverMs` | `550` | silence before an utterance is considered finished |
| `interimMs` | `500` | how often the open utterance is re-transcribed |
| `commandTimeoutMs` | `6000` | command mode disarms itself after this |
| `conversationMs` | `25000` | how long an agent keeps listening without its name after speech and the echo delay finish (or after the text appears when speech is off); `0` off |
| `agents` | one commands agent | who you can talk to: a name, what it does, the voice it says it in and the model it thinks with. Edited in the Agents tab |
| `wakeWordFuzzy` | `true` | forgive near-misses in the wake phrase ("hey cloud") |
| `speakReplies` | `true` | say what a command just did, out loud |
| `speakVoice` | `null` | macOS voice name for agents that have none of their own; null = the system voice |
| `speakRate` | `0` | words per minute; `0` = the voice's own pace |
| `sendTarget` | `null` | app to focus before pasting; null = whatever is in front |
| `spacesDir` | `null` | folder of `<Name> Space.app` markers; names them for "switch to …" |
| `modelStats` | `{}` | written by the app: how long each model took to answer last |
| `sendPressesEnter` | `false` | also hit Return after pasting |
| `clearAfterSend` | `true` | empty the transcript once delivered |
| `panelPosition` | `null` | where a panel was last dragged to; `null` is centred. Set by moving one, not by typing |
| `stripHeight` | `180` | minimum height of the strip; it grows to fit |
| `panelHeight` | `560` | height while the help or glossary panel is open |
| `wakeDelayMs` | `320` | pointer dwell before the strip stops being click-through |
| `idleFadeMs` | `6000` | silence before the transcript fades |
| `idleClearMs` | `20000` | silence before it is forgotten entirely; `0` never |
| `alwaysOnTop` | `true` | keep above other windows |
| `autoCopy` | `false` | copy every finished utterance automatically |
| `modelPath` | `null` | pin a specific ggml model |
| `language` | `'en'` | recognition language |
| `vocabulary` | `[]` | terms to bias recognition toward |
| `corrections` | `{}` | wrong → right rewrites applied to finished text |
| `vad` | `true` | ignore anything a speech detector says was not speech, before the recogniser sees it |
| `vadThreshold` | `0.5` | how sure that detector has to be; higher ignores more of the room |
| `confidenceFloor` | `-0.5` | ignore an utterance the recogniser was less sure of than this; `0` off |
| `dropGlossaryEcho` | `true` | discard an utterance that is only glossary words |
| `cleanup` | `false` | tidy fillers out of settled text with the assist model |
| `commandFallback` | `false` | ask the assist model about unrecognised commands |
| `assistUrl` | `'http://127.0.0.1:11434'` | where Ollama is listening |
| `vizLinesPerFamily` | `18` | polylines per hue family (×3) |
| `vizPoints` | `220` | samples per polyline |
| `vizFps` | `30` | frame rate while speech is detected |
| `vizQuietFps` | `8` | frame rate in a silent room |
| `layout` | `'strip'` | which visualizer runs: `'strip'` for the ribbon, `'orb'` for the round one |
| `orbSize` | `300` | the orb window's side, in points; shrinks to fit a small display |
| `orbMargin` | `24` | its inset from the corner of the work area |
| `orbSeeds` | `120` | filaments; each is drawn twice, so this is half the stroke count |
| `orbSteps` | `14` | the longest filament's length, in steps away from the ring |
| `orbSayScale` | `0.4` | the inner ring — the app's own voice — as a fraction of the orb |
| `orbZoomGain` | `0.5` | how far a loud room opens the figure; `0` holds it still |
| `orbZoomDecay` | `0.05` | how fast it closes again once the room is quiet |
| `remote` | `false` | let an agent hand a question its local model cannot answer to a frontier CLI |
| `remoteAnnounce` | `true` | say "Claude said, …" so a remote answer is never passed off as local |
| `remoteTimeoutMs` | `30000` | how long a CLI may take before it is given up on |
| `remoteWebSearch` | `false` | let codex search the web; roughly doubles the wait |
| `remoteCallsToday` | `{}` | written by the app: how many questions went out, per day |
| `debugRecording` | `false` | save local microphone audio and conversation diagnostics; see [recording and review](recording.md) |
| `debugRouting` | `false` | append a line per question to `routing.log`, questions and answers included |

Agents can have comma-separated **Wake aliases**, such as “Hey Mera” for “Hey Mira”. Aliases match full phrases at the start of an utterance without rewriting dictation. An exact primary name wins over an alias; aliases shared by agents are ambiguous and do not route.

Voice isolation can be requested in Listening settings and requires a restart.
The app checks microphone capabilities, requests isolation, and records its
actual state in capture-info during debug recording. Advertised support is not
proof of activation: a rejected constraint or `active: false` means ordinary
capture continues. On the built-in MacBook microphone tested September 12, the
runtime advertised support but rejected activation with “Cannot satisfy
constraints,” both at startup and through applyConstraints.
