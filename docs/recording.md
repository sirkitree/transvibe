# Recording and reviewing Mira sessions

In **Settings → Advanced**, turn on **Record audio and conversations for debugging**. The strip shows **Recording locally — stop**, and the menu-bar icon shows **REC** even when the strip is hidden. Click the strip's stop button or turn the setting off to finish. Pause listening to pause microphone recording. The setting remains enabled across restarts; each restart creates a new session.

Sessions live in `~/Library/Application Support/transvibe/recordings/<timestamp-id>/`:

- `microphone.wav`: 16 kHz mono microphone audio, including sounds rejected by the speech gate and audio during Mira's replies. This is the browser-processed microphone signal (echo cancellation, noise suppression, automatic gain), not raw hardware or separately captured system audio. Paused intervals are omitted; `audio-span` events map file positions to wall-clock times.
- `utterance-<id>.wav`: the exact audio submitted for each final recognition pass.
- `events.jsonl`: timestamped interim/final recognition, raw text, corrected/filtered text, confidence, rejection reasons, voice-activity boundaries, wake/follow-up decisions, displayed transcript/history, question context, answers, available routing details, and spoken text/playback/microphone-gate timing. `debugId` connects recognition and routing. Events continue after bubbles fade.
- `settings.json`: settings at the start, with subsequent changes in the event log.

Audio uses about 115 MB/hour, plus utterance copies and logs. Files stay on this Mac; the recorder and review report do not upload them. Existing agent routing still behaves according to your agent settings. There is no automatic deletion. An abrupt crash can lose the last buffered second; normal stop, pause, and quit flush it. Disk errors stop recording and show an error without stopping transcription.

From the repository:

```sh
node script/review-session.mjs latest
node script/review-session.mjs /path/to/session
node script/review-session.mjs latest --follow
```

This generates `review.html` with audio players, raw/final transcripts, conversation turns, and event details, plus a `notes.md` template. Open the HTML file locally. `--follow` refreshes the report and prints new transcript routing and conversation turns until Ctrl-C; it watches that session, not later sessions. Interim results remain available in the full log.

To review with Codex, say “review the latest Mira recording” or provide the session path and the approximate time of the problem. Recording persists without an active Codex turn; interpretation and recommendations happen when you ask for a review.

For transcription review, listen first and write what was actually said. Compare it with raw recognition, post-correction text, then the routing decision. Distinguish audio capture/gating, recognition, correction, and routing failures. Do not treat the model's own transcript as ground truth.

For reply review, use the question and prior history actually supplied, identify the intended task, and compare Mira's reply with that task. Separate factual errors, lost context, wrong routing, and response style. Record what a better answer should do and why; turn confirmed failures into regression examples before changing prompts, models, or code. Spoken text/timing is recorded, but a separate clean recording of Mira's synthesized voice is not.

Final transcription now retries suspicious speaker labels or moderately uncertain
recognition once, using recent user conversation context instead of the glossary prompt, with up to one extra second of
available leading audio. Audio does not cross the previous segment or the app's
speech-mute boundary. Retries never change interim text, and retain the original
unless the alternative meets the confidence/shape checks. The transcription result
records both candidates, their confidence, context, retry audio, and whether the retry was accepted.

When interim recognition repeatedly reports no speech or rejected text, preview
requests back off from the configured interval to at most one every two seconds.
Those probes contain only the latest two seconds of the open segment, instead of
rechecking its entire growing buffer. Recognized speech restores the configured
preview interval. Final utterances retain their full audio and original gates;
this optimization does not classify music or identify a particular speaker.
