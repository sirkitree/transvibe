# The assist model

A second local model, off by default, that tidies dictated text and rescues unrecognised commands.


A second, local model — Gemma 4 E2B through [Ollama](https://ollama.com) — does the three things whisper and a rule parser each do badly. The first two are off by default:

```sh
ollama pull gemma4:e2b     # ~7.2 GB, one time
```
```json
{ "cleanup": true, "commandFallback": true }
```

Still no cloud: Ollama serves on `127.0.0.1`, and the audio never reaches it at all — only text does. If Ollama is not running or the model was never pulled, the strip says so once and everything carries on exactly as before.

**`cleanup`** rewrites a settled utterance with the filler words and false starts taken out. "Um, so I was thinking we should uh ship the thing on Friday" becomes "So I was thinking we should ship the thing on Friday". It runs after whisper's text is already on screen, so it costs nothing you wait for; the tidier version swaps in a few hundred milliseconds later, or never.

**`commandFallback`** hands an unrecognised command to the model instead of giving up on it. Say "nope, take that back" or "stick that on the clipboard for me" with right ⌥ held — phrasings no rule covers — and they work.

**Spoken replies** use it too, if it happens to be running, and are the one job that does not need it: after a command runs, the model shortens the confirmation into something worth hearing ("deleted the last 3 words" → "three words gone"). It is given the outcome, not the utterance, so it cannot announce something that did not happen, and it is on a 1.2-second leash — the microphone is deaf while the app talks, so a slow answer costs you the start of your next sentence. Past that, the app says its own wording instead. Turning spoken replies on does not go looking for Ollama, and never warns that it is missing.

Measured on an M-series Mac, warm: cleanup 170–350ms, command fallback 180–510ms, both after the fact.

Cleanup can make a subtle word change that the guards below do not catch, so read the result before sending it somewhere that matters.

## How it is kept on a leash

Every `cleanup` reply is guarded before it can touch the transcript, because the failure that matters is not a bad rewrite but a *plausible* one — a summary, or an answer to a question the user happened to dictate. A reply that is under half or over 1.5× the original's length, that opens like a chatbot ("Here's the…"), or that comes back empty is discarded and the original stands. `acceptCleanup` in `src/shared/assist.js` is that rule, unit-tested, and it always returns something safe to show.

Those guards do not catch a subtle word change. Cleanup has turned "I still need to double check" into "I still need *you* to double-check" — a plausible sentence, the right length, and not what was said. Read the result before sending it somewhere that matters.

A spoken reply is on a looser rein, because a wrong four words out of the speakers is not the user's own text overwritten: `acceptSpoken` throws away anything over six words, anything that opens like a chatbot, and anything with markup in it, and falls back to the line the applier wrote — which is always sayable.

Two guards came from watching it get this wrong. Asked to shorten "not a command", the model returned **"Confirmed that is it."** — fluent, four words, and a confirmation of something that never happened. So a reply now has to share a content word with the line it was given, and a line of four words or fewer is not sent at all: "copied", "undone", "no change" are already spoken replies, and the only thing a rewrite can do to them is change what they mean. Answers about settings are never sent either — they carry a value, and "the speaking rate is the voice's own" came back as "voice is speaking".

For `commandFallback`, the model does not invent a command — it picks one of the 66 example phrases the parser already understands, and that phrase goes straight back through `parseCommand`. Two things fall out of that: a wrong answer can only ever produce a command the app actually implements, and everything the rules know about targets and counts ("the last three words") keeps working without a second, weaker copy of it.

It is safe to ask at all only because command mode is armed deliberately. The model is never shown ordinary dictation, so it never gets the chance to mistake any for a command — which it will: asked cold, "I need to copy that file to the server" comes back as `copy`. That is the exact false positive the rules exist to prevent, and it is why they stay in front.

Thinking is on by default in Ollama and cost ~1.1s per call for a task that needs none; both calls set `reasoning_effort: "none"`.

**What was tried and rejected.** Gemma 4 takes audio natively, so it could replace whisper outright. On the same clips it was slower and less accurate — "Vinchi" for "Vinci", words dropped off the end of a long sentence, and it ignored an instruction to clean up while transcribing. Whisper keeps the audio. Google's other new model, Gemini 3.5 Transcribe, does all of this better and in one pass, but it is a cloud API with no open weights, which would cost this app the only property it really has.
