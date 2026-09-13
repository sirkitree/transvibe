# The assist model

A second local model, off by default, that tidies dictated text, rescues unrecognised commands, and — if you let it — knows when to hand a question to a bigger model.


A second, local model — Gemma 4 E2B through [Ollama](https://ollama.com) — does the three things whisper and a rule parser each do badly. The first two are off by default:

```sh
ollama pull gemma4:e2b     # ~7.2 GB, one time
```
```json
{ "cleanup": true, "commandFallback": true }
```

Which model does the work is set per agent, in Settings › Agents.

Still no cloud, unless you go and ask for one: Ollama serves on `127.0.0.1`, and the audio never reaches it at all — only text does. The single path off this machine is [escalation](#when-the-local-model-does-not-know), which is off until you turn it on and says so out loud when it runs. If Ollama is not running or the model was never pulled, the strip says so once and everything carries on exactly as before.

**`cleanup`** rewrites a settled utterance with the filler words and false starts taken out. "Um, so I was thinking we should uh ship the thing on Friday" becomes "So I was thinking we should ship the thing on Friday". It runs after whisper's text is already on screen, so it costs nothing you wait for; the tidier version swaps in a few hundred milliseconds later, or never.

**`commandFallback`** hands an unrecognised command to the model instead of giving up on it. Say "nope, take that back" or "stick that on the clipboard for me" with right ⌥ held — phrasings no rule covers — and they work.

**Spoken replies** use it too, if it happens to be running, and are the one job that does not need it: after a command runs, the model shortens the confirmation into something worth hearing ("deleted the last 3 words" → "three words gone"). It is given the outcome, not the utterance, so it cannot announce something that did not happen, and it is on a 1.2-second leash — the microphone is deaf while the app talks, so a slow answer costs you the start of your next sentence. Past that, the app says its own wording instead. Turning spoken replies on does not go looking for Ollama, and never warns that it is missing.

**Conversation** is the fourth job and the only one that is the point rather than a tidy-up: an agent set to *talks back* hands its sentence here as a question, and the answer is said out loud. It carries the last few turns, so "how far is that from London" follows "what's the capital of France", and it is asked for one or two plain sentences — nobody can hear a bulleted list, and the microphone is deaf for as long as the answer takes. A long one is cut to its first sentences rather than thrown away. Each agent names its own model, which is worth doing in both directions: asked what a VAD is, `gemma4:e2b` offered "video-assisted delivery" while `llama3` got it right — and `gemma4:e2b` is exactly what you want deciding, in under half a second, whether you just said "delete that". There is no global model setting any more: a model belongs to whoever thinks with it. Dictation is the one thing addressed to nobody, so tidying it uses the model belonging to whoever runs commands.

Measured on an M-series Mac, warm: cleanup 170–350ms, command fallback 180–510ms, both after the fact. A conversational answer runs 300ms–1s depending on the model.

Cleanup can make a subtle word change that the guards below do not catch, so read the result before sending it somewhere that matters.

## When the local model does not know

A 2-billion-parameter model answering out loud in half a second is the right trade for "delete that" and the wrong one for "what changed in the Electron 44 release". It gets things wrong, and — usefully — it often says so first. Escalation takes that admission seriously: when the local model cannot answer, the question goes to a frontier model instead, and the answer comes back spoken with its source named. It is off until you turn it on: `remote` is `false` in a fresh settings file, and even then nothing escalates unless an agent has been given somewhere to escalate to.

It reaches that model by spawning the CLI you already have. `claude -p` and `codex exec`, run as your own logged-in user, so the call bills against the subscription you are already paying for rather than a metered API key — which also means there is no key, anywhere, to store, leak or rotate. Nothing is configured but the agent's provider and, if you want, a model name; the CLIs bring their own auth, from the keychain or the OAuth token they already hold.

**Four things send a question outward, in that order of how much they can be trusted.**

The first is a sentinel we ask for. `ASK_PROMPT` already tells the model to admit uncertainty; it now also says that if it cannot answer from what it knows, it should reply with exactly `PASS` and nothing else. Asking beats guessing, and by some distance: a model that is about to be wrong is the only thing in the system that knows it, and one word costs nothing to check for. It is the same move `buildCommandMessage` makes when it offers the parser "or the word none" — give the model a cheap, unambiguous way to decline and it will usually take it, instead of producing something fluent to fill the silence.

Hedge detection is the backstop for when it does not. "I'm not sure", "I don't have access to", "as of my training data" — but only counted in the first sentence *and* the first dozen words, or anywhere in an answer under twenty-five. The scoping is the whole trick. "The capital is Paris, though I'm not sure about the population" is a good answer with a caveat on the end, and throwing it away to ask a frontier model would be slower, costlier and no more correct; the same words leading the answer mean the model has nothing. Words that only look like hedges are ruled out the same way — "the latest you can arrive", "you pass it as the second argument" — because the price of a false positive is eight to fourteen seconds of silence, and the price of a miss is only the answer you would have got anyway.

Hard failure is the third: `ok: false`, a timeout, Ollama not running. If nothing came back there is nothing to lose by asking elsewhere, and the panel is told which of the two it was, so "the machine needs starting" does not read as "the model had nothing".

The fourth does not wait for the local model at all. A question about the latest release, today's news, who won, what something costs — a model with no clock and no network cannot answer it, and asking anyway spends a second to be told so. `needsFreshFacts` routes those straight to a codex agent with web search on. It is deliberately a narrow rule: "latest" counts only in front of a noun it can name (version, release, price, score, standings), so "what's the latest on that bug" is not a freshness question and takes the ordinary route. The rule misses real cases on purpose. A miss costs one local attempt; a wrong hit costs the whole remote roundtrip.

**And you can just ask.** Mid-conversation, "Mira, ask Claude about this" re-puts the thread's question to the frontier model and says the answer, and it works whether the local one hedged or answered confidently and you simply did not believe it. "check with Codex", "run that past Claude", "get a second opinion from Claude" are the same command. Either way the answer is spoken as "**Claude said**, …" — anything that did not come from this machine says where it came from, every time, whether you asked for it or it escalated on its own.

**The waiting matters more than it sounds.** A remote answer takes seconds, and for all of them the app is silent: nothing is transcribed, nothing is spoken, the strip has nothing to show. Left alone the transcript would fade at six seconds and be forgotten at twenty — under the question you are still waiting on — so a call in flight holds the strip up for as long as it runs. There is a counter and a breathing dot, and past ten seconds it *says* "still waiting on Codex" out loud. That announcement is the part that earns its place: you asked out loud precisely so you could keep looking at the window you were working in, and an indicator on a strip you are not looking at is not an indicator at all.

Measured on an M-series Mac: `claude -p` answers in **2.7s** with the flags it is given here, and **8.4s** without them, because untrimmed it loads `CLAUDE.md`, plugins, MCP servers and hooks before it will answer a sentence. `codex exec` is **8.7s**, or **14.1s** with web search. A local answer, for comparison, is 300ms–1s. So escalation is between three and forty times the wait, which is why it is a fallback and not the default path, and why the first thing to get right was the deciding.

`--bare` looks like exactly the flag for that trimming, and it is a trap: it forces API-key authentication and never reads the OAuth token or the keychain, so it either fails outright or quietly bills an API account. The point of going through the CLI was the subscription; `--bare` is the one flag that throws it away. `--restricted --strict-mcp-config --disable-slash-commands` get the same 2.7s with the login intact.

The other measured finding is why the freshness case goes to codex rather than claude: `claude -p` in this configuration has **no live web access** — zero web searches across the runs we watched. It is a very good model recalling what it read. Codex genuinely searches, and its answers come back full of markdown links, which is why `unformat` reduces a link to its text before anything is spoken.

**The boundaries, which are not negotiable.** The CLI is spawned with an argv *array*, never a shell string — the input is a sentence transcribed from an open microphone, and nothing in a room's worth of speech may ever become a flag or reach a shell. It runs in an empty temp directory, never your repo, so there is no `CLAUDE.md`, no git history and no project context to pick up. No permission bypass is passed, `--dangerously-skip-permissions` least of all; the CLI is answering a question, not doing work. Captured output is capped and the call is on a leash — timeout, then `SIGTERM`, then `SIGKILL` — and "stop" or esc kills it, discarding an answer already sitting on stdout rather than speaking something you cancelled. There is a cap of fifty remote calls a day, and hitting it says so rather than silently doing nothing.

And the two jobs that touch your own words never go anywhere. `cleanup` and `commandFallback` are wired to the local model with no provider argument to pass; there is no setting, no agent field and no code path that could route them outward. "No code path" is a claim about the import graph, so `test/boundary.test.js` walks it: from both halves of the assist model, nothing reachable can start a process. The other way in is a new handler calling `askRemote` directly rather than importing anything, and `REMOTE_JOBS` catches that — every remote call names its job, and a job that is not one of the three the app sends out fails closed rather than spawning. Only a sentence deliberately addressed to a named chat agent, plus that thread's own history, is ever sent off the machine.

## Whether the deciding is any good

Every rule above is a phrase somebody wrote down after watching the app get one wrong, and phrases like that are only as good as the cases behind them — delete `NEWEST` and rewrite it tomorrow and you would lose "what's the latest you can arrive" again, because nobody thinks of it twice. So the cases are the artefact. `test/routing-cases.js` holds them, one line each, with a note saying what the line is for, and `test/escalate.test.js` asserts the whole list rather than a hand-written selection from it. A misroute you notice is a one-line commit, and the phrase lists can then be rewritten as freely as you like.

`npm run routing` replays that corpus and prints what the rules get wrong. It needs no model, no Ollama and nothing billed, because `escalate.js` is pure — the purity was paid for when it was written and this is collecting on it. Cases marked `known` are printed apart from the failures rather than counted as them: a case nobody has a clean fix for is debt worth keeping visible, and a red suite is not a to-do list. There is one at the time of writing — "what was the score of the 1966 world cup final" matches "the score", and fixing it properly needs a date test that does not exist yet.

The corpus says whether the rules classify what somebody already thought of. What they do on a real machine is a different question, and the app counts it: `routingStats` in the settings file keeps a row per reason — how often it fired, and, where there were two answers to hold up against each other, how often the frontier model then said the same thing as the local one anyway. That second number is the one worth having. An escalation that fires and hears the same answer back is eight seconds of a quiet room spent confirming something gemma already had right, and there is no way to see it from the strip, where a good escalation and a needless one both arrive as an answer in a voice. `unsure` is the rule it bites on, because it is the only one that reaches the comparison with a local answer still in hand — `pass`, `failed` and `empty` come with nothing to compare, and `answersAgree` says so rather than guessing.

The errors run in two directions and only one of them is visible. A needless escalation you can count, because both answers exist. A *missed* one — the app saying something false, confidently, in its own voice — leaves no trace at all, since the better answer was never fetched. The one signal for it is already in the app and costs nothing: "Mira, ask Claude about this" is you saying the rule should have fired and did not, and when the answer that comes back differs from the one you had just heard, that is a labelled miss. It is counted as `asked`. It is biased — it only catches the wrong answers you noticed — but it is free, and the alternative is asking a frontier model in the background for answers nobody will hear.

None of it tunes anything by itself, deliberately. The sample is a few dozen questions a week from one person and a threshold fitted to that is fitting noise; more to the point, a phrase list you can read and predict is the reason any of this can be debugged, and a number that drifts on its own would take that away in both directions silently — toward more escalation, which is slow and spends a subscription, or toward less, which is the app saying false things out loud. So the app measures and you tune: it tells you which rule is misfiring, and you edit `escalate.js` and add a line to the corpus.

Nothing you said is in any of this. The counters are integers, which is why they are on; the questions and answers go to `routing.log`, which is off unless you turn it on and which you can delete. The strip throws a transcript away twenty seconds after you stop talking, and a permanent ledger of everything you ever asked out loud would be the one place in this app that did not.

## How it is kept on a leash

Every `cleanup` reply is guarded before it can touch the transcript, because the failure that matters is not a bad rewrite but a *plausible* one — a summary, or an answer to a question the user happened to dictate. A reply that is under half or over 1.5× the original's length, that opens like a chatbot ("Here's the…"), or that comes back empty is discarded and the original stands. `acceptCleanup` in `src/shared/assist.js` is that rule, unit-tested, and it always returns something safe to show.

Those guards do not catch a subtle word change. Cleanup has turned "I still need to double check" into "I still need *you* to double-check" — a plausible sentence, the right length, and not what was said. Read the result before sending it somewhere that matters.

A spoken reply is on a looser rein, because a wrong four words out of the speakers is not the user's own text overwritten: `acceptSpoken` throws away anything over six words, anything that opens like a chatbot, and anything with markup in it, and falls back to the line the applier wrote — which is always sayable.

Two guards came from watching it get this wrong. Asked to shorten "not a command", the model returned **"Confirmed that is it."** — fluent, four words, and a confirmation of something that never happened. So a reply now has to share a content word with the line it was given, and a line of four words or fewer is not sent at all: "copied", "undone", "no change" are already spoken replies, and the only thing a rewrite can do to them is change what they mean. Answers about settings are never sent either — they carry a value, and "the speaking rate is the voice's own" came back as "voice is speaking".

For `commandFallback`, the model does not invent a command — it picks one of the 66 example phrases the parser already understands, and that phrase goes straight back through `parseCommand`. Two things fall out of that: a wrong answer can only ever produce a command the app actually implements, and everything the rules know about targets and counts ("the last three words") keeps working without a second, weaker copy of it.

It is safe to ask at all only because command mode is armed deliberately. The model is never shown ordinary dictation, so it never gets the chance to mistake any for a command — which it will: asked cold, "I need to copy that file to the server" comes back as `copy`. That is the exact false positive the rules exist to prevent, and it is why they stay in front.

Thinking is on by default in Ollama and cost ~1.1s per call for a task that needs none, so every call sets `reasoning_effort: "none"` — except a chat agent that has been set to think first, where the whole point is the reasoning.

That parameter is a request, not a guarantee. Measured on `qwen3:30b-a3b`, asking for no reasoning does not stop the model reasoning; it stops the reasoning being held apart from the answer, and the entire chain of thought arrives in the reply — "Okay, the user is asking about voice activity detection, but they've also given very specific instructions…" — and gets said out loud. It is honoured by `gemma4:e2b`, where it was measured saving 1.1s, and ignored harmlessly by models with no reasoning to skip. If a chat agent starts narrating its own thoughts, turn thinking on for it.

**What was tried and rejected.** Gemma 4 takes audio natively, so it could replace whisper outright. On the same clips it was slower and less accurate — "Vinchi" for "Vinci", words dropped off the end of a long sentence, and it ignored an instruction to clean up while transcribing. Whisper keeps the audio. Google's other new model, Gemini 3.5 Transcribe, does all of this better and in one pass, but it is a cloud API with no open weights, which would cost this app the only property it really has.

### Verification and completed replies

Explicit requests to verify an article or provide a source bypass the local model and use a Codex agent in the configured chain when remote answers and web search are enabled. A follow-up asking for the “actual response” after a verification request follows the same route. An unavailable lookup, a timeout, or a reply without a source URL is reported as unconfirmed; the local model does not fill that gap with a guessed verification. A supplied URL is necessary evidence, not an automatic guarantee of accuracy.

The local prompt states that it has no search tools. A guard also catches claims such as “After searching, I found…” and replaces them with an explicit unconfirmed result. Codex streams must include a completed turn, and commentary messages are excluded from answer selection. A timed-out process cannot supply a successful answer from partial output.

Short acknowledgments such as “Okay, that's great” do not call a model. New questions and cancellation invalidate pending local-to-remote continuations, so an obsolete local result cannot start a remote fallback. Conversation capture uses its own silence window and includes a bounded 200 ms pre-roll to retain quiet word beginnings.

### Conversation review fixes (September 12)

Chat wake phrases preserve question wording, including “can you”. Conversation
history retains agent names and lookup outcomes; CLI prompts label prior speakers
instead of calling every assistant “You”. Calendar-access, recorded-source, lookup
status, and named-agent response questions use recorded app facts before model
routing. A supplied link is described as a sourced result, not independent proof.

Before answering, explicit questions get a 250 ms continuation grace period;
setup statements get 1.4 seconds after final transcription. Speech resuming before
the reply starts invalidates the pending answer and joins the next segment to the
same thought. Escape/clear also cancels a queued thought. This is not full duplex
speech: recognition remains muted during Mira's spoken reply to avoid echo.

The ribbon shows follow-up seconds, pauses the clock during speech, and shows the
wake phrase when the window expires. Source links remain on screen; known
publication names are spoken instead of their domains.

### Follow-up review fixes

Generated and retrieved answers share `response-format.js`: known leading speaker
labels are removed before checking the PASS sentinel, and displayed URLs are
removed or shortened for speech. A labelled refusal is not retained in history.
Attribution stays in structured history and separate local-prompt metadata, rather
than being prepended to assistant answer text. Local and CLI responses both use
the formatter before routing.

Leading replacement phrases such as “actually, forget that lookup” discard the
pending question. Only the new question is routed; ordinary continuations and
corrections still extend the current thought. A replacement with no new question
cancels without dispatching an empty request.

The local prompt explicitly permits recall from user-supplied facts and uses the
latest stated value when a fact changes. Lookup-status replies report completion
briefly; a source link still does not constitute independent proof.
