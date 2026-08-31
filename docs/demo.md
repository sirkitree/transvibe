# Demo: sending a status update without leaving the app you are in

A two-minute scenario. The arc is *"I never opened a window and I never touched the keyboard"* — every feature shows up in service of that, rather than as a tour.

The premise: you are in Slack, mid-conversation, and you need to send Dave an update about the VINCI deploy.

## Before you start

- Ollama running, `gemma4:e2b` pulled.
- `settings.json` has `"cleanup": true` and `"commandFallback": true`, and `"vocabulary": ["VINCI"]`.
- Slack (or anything with a text field) open and focused, with something clickable near the top of the screen — a channel in the sidebar, a tab.
- Say nothing for ten seconds first, so the strip is faded and the screen looks untouched.

## The beats

**1. The screen is not yours to give up.** Start on the quiet screen. The only thing visible is a thin line across the top. Move the pointer up and *click a Slack channel through the strip* — the click lands in Slack. Say the line out loud: there is no window here to move out of the way.

Then rest the pointer on the strip for a moment. It goes solid, the buttons appear. Move away and it is a ghost again. That contrast in the first fifteen seconds is the whole product.

**2. Talk.** Do not touch anything. Say, with the pauses natural:

> Um so the VINCI deploy is uh is scheduled for Thursday morning.

Two things to point at. The blue text appearing *while you are still talking* — that is the interim pass, not a wait-for-the-end transcription. And a quarter-second after you stop, the line rewrites itself:

> So the VINCI deploy is scheduled for Thursday morning.

The `um` and the `uh is` are gone. That is the second model, also local, tidying text the first one heard correctly.

**3. Keep going**, so it does not look like a one-line trick:

> I still need to double check the migration script before we uh before we ship it.

> And uh can you let Dave know that the window moved.

**4. VINCI is spelled right.** Worth calling out explicitly, because it is the thing every dictation tool gets wrong. A small Whisper model has never seen the word and reaches for the nearest thing it has — "Vinci", "Vinchi", "Vinci's". It is in the glossary, so it is fed to the recogniser as it listens.

If you want the contrast on camera: open the glossary (the book button), delete the VINCI chip, say the line again, and watch it come back wrong. Then click the wrong word in the transcript, type `VINCI`, hit fix — the word is corrected everywhere on screen *and* the rule is saved. Reopen the glossary and it is there.

**5. Fix it by voice.** Hold the right ⌥ key. The strip swings amber. Say:

> actually chuck that last bit

The rules have never heard that phrasing — before this it would have said *not a command*. The local model maps it to a command the app already implements and the last sentence goes. Release; it returns to transcribing on its own.

Make the point that the rules run first and the model only ever sees speech you already declared to be a command. Dictate "I need to copy that file to the server" normally and watch it stay as text — a model asked cold treats that as a copy command, which is exactly why it sits behind the rules and not in front of them.

**6. Land it.** Press ⌃⌥↩. The transcript pastes straight into Slack, in the field you left focused. You never clicked into transvibe, never alt-tabbed.

**7. Walk away.** Stop talking. Six seconds later the text fades out on its own and the screen is back to the thin line. End the recording there — on nothing.

## If someone asks

**"Where does the audio go?"** Nowhere. Whisper runs on the machine, the assist model runs on the machine through Ollama on `127.0.0.1`, and the assist model is only ever sent text — never audio. The one network call the app can make is a one-time model download.

**"How fast?"** Interim text every 500ms while you talk. Inference around 110ms with the model resident. Cleanup adds 170–350ms *after* the text is already on screen, so it is never something you wait for.

**"Why not Gemini 3.5 Transcribe?"** It is better at all of this, in one pass. It is also a cloud API with no open weights, and this app's only real property is that the audio never leaves the machine.

**"Why two models?"** Whisper is better at hearing and worse at judgement; a small LLM is the reverse. Gemma 4 takes audio natively and was tried as a straight replacement — on the same clips it was slower and less accurate. So Whisper keeps the audio and the LLM only ever sees text.

## Do not demo this

**Spoken self-corrections.** "Ship it Friday, no wait, Thursday" *sometimes* comes back as "ship it Thursday" and sometimes keeps both halves. E2B is not reliable at it. It is a great party trick when it lands and a dead demo when it doesn't, so leave it out and keep the filler-word removal, which is stable.

Related, and worth knowing rather than showing: cleanup once turned "I still need to double check" into "I still need *you* to double-check". The guard rails catch a summary, a refusal, or a chatbot preamble, but not a single-word meaning change. Do not put the demo transcript straight into a real message without reading it.

**A long monologue.** The transcript caps at four lines and older text scrolls away. Keep each utterance to a sentence.

**A noisy room.** A one-term glossary makes every cough a candidate for that term. The echo filter drops utterances that are *only* glossary words, but background chatter still produces stray text.
