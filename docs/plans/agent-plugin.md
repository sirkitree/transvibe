# Plan: the agent plugin — answer your coding agent out loud

Status: **steps one and two built**, 2026-09-13. The plugin loads, the hook runs, the payloads below are recorded from a real session rather than read off a documentation page, and `src/shared/agent-request.js` turns one into what to say and what to answer with. Nothing is wired to a microphone yet; steps 3–7 are ahead.

## What step one found

- **`Stop` carries `last_assistant_message` and `stop_hook_active`**, as the plan assumed. It also carries `permission_mode`, `effort.level`, `background_tasks` and `session_crons`, none of which we need yet.
- **`SessionStart` says `source`, not `startup_reason`.** The hooks reference documents the latter; this build sends `{"source": "startup"}`. Recorded rather than trusted, which is the reason step one existed.
- **`claude plugin marketplace add .` is rejected** — "Invalid marketplace source format" — while `./` is accepted. A local marketplace needs the slash.
- **A plugin's `source` may be a subdirectory.** `"./plugin"` from a root `.claude-plugin/marketplace.json` installs correctly, so the plugin and the app stay in one repo.
- **`claude --plugin-dir plugin` loads the hooks without touching `~/.claude/settings.json`**, which is how to work on this without arming it for every session.
- **`Notification` carries a written `message` alongside `notification_type`** — "Claude is waiting for your input" for `idle_prompt`. That is a sentence someone wrote to be read by a person, which means the speakable form of a notification is a field rather than something we compose.
- **`SessionStart` also carries `model`**, so a session can say which model it is as well as where it is.
- **`PermissionRequest` only fires in the default permission mode**, not in `auto`. It carries `tool_name`, `tool_input` and `permission_suggestions` — but **no `permission_category` and no `tool_use_id`**, both of which the reference lists. Do not depend on either.
- **`permission_suggestions` is what "always allow" is made of**: `[{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]` for a file write. Offering that out loud is a real option later, and it is the session's own suggestion rather than something we would be inventing.
- **`tool_input` is not speakable.** For a `Write` it holds the entire file content. What gets said is the shape of the request — "Claude wants to write hooktest.txt" — never the argument.
- **A permission prompt fires twice.** `PermissionRequest` first, then a `Notification` with `notification_type: "permission_prompt"` about six seconds later, both carrying the same `prompt_id`. Handling both would ask the room the same question twice. `PermissionRequest` is the actionable one — it is the event that can answer — so a `permission_prompt` notification for a `prompt_id` already in hand is dropped. `prompt_id` is the join, and it is on every event that has one.

The recordings are in `test/fixtures/hooks/`, and `test/agent-hook.test.js` runs every one of them through the hook, so a payload captured later is covered by being added rather than by somebody remembering to write a test for it. Two were kept for what they will exercise later rather than for their shape: one long enough that the spoken-length rules will have to cut it, and one ending in "Want it at `…` instead?" — an agent stopped, waiting on an answer nobody is at the terminal to give, which is the feature in a sentence.

Superwhisper shipped plugins for Claude Code, Codex and Grok Build this summer: "your agent runs in a floating window, tells you when it needs you, and you answer out loud instead of switching back to a terminal." Their Claude Code plugin is public — [`superultrainc/superwhisper-claude-code`](https://github.com/superultrainc/superwhisper-claude-code) — so the mechanism could be read rather than guessed at. It is a standard Claude Code plugin whose `hooks/hooks.json` points every interesting event at one binary, `superwhisper.app/Contents/Resources/agent-hook`, which writes a payload into `~/Library/Application Support/superwhisper/agent/inbox/` and blocks until the app hands it back what the user said.

This is worth having, and it is not what transvibe does today. `cli-agent.js` spawns `claude --print` one-shot: transvibe asks, Claude answers, the process dies. This is the other direction — *your own long-running session*, in a terminal you started yourself, reaching out to say it is finished or that it needs a decision, and taking your spoken answer back. transvibe already has everything needed to hold up its end: a voice per agent, a conversation window that pauses while the speakers are busy, a turn buffer that waits for a thought to finish, wake words, and an interrupt. What it does not have is any way in. There is no URL scheme, no socket, and no server anywhere in `src/main/`.

## Scope, and what must not move

What this adds: a running Claude Code session can speak through transvibe and be answered by voice. Three events in v1 — the agent finished, the agent needs input, the agent wants permission.

What does not change, at all:

- **The microphone path.** Capture, VAD, whisper, interim previews, the glossary, the confidence floor. An inbound request is text arriving over a filesystem, and it touches none of it.
- **`cli-agent.js` and the roster's remote agents.** "Hey Mira, ask Claude about this" keeps working exactly as it does. This is a second, unrelated relationship with the same CLI, and the two never meet: nothing here calls `askRemote`, `askLocal`, or `assist`.
- **The `external` agent kind.** `agents.js` reserves it for "a name that hands the sentence to another program entirely" — an *outbound* idea, you say something and it runs somewhere. An inbound session is not that, and overloading the word would make both halves harder to explain. `addressAgent`'s external branch keeps saying "not wired up yet".
- **The strip, the orb, the panels, the window geometry.** No new window. The inbound turn is a conversation bubble like any other, which is the whole reason the conversation machinery was built.

Explicitly out of scope, however tempting: a floating agent window, transcript scraping for richer summaries, answering `AskUserQuestion` with structured choices, Codex and Grok, and a one-click installer that edits `~/.claude/settings.json` for you. Each is a follow-up with its own decisions in it.

## What the hooks actually give us

Read from the current hooks reference, not from the plugin:

| event | blocks? | how we use it |
|---|---|---|
| `Stop` | yes, **exit 2 with the reason on stderr** | Claude finished. Speak `last_assistant_message`; what you say back becomes the next turn. |
| `PermissionRequest` | via `hookSpecificOutput.decision` = `allow` / `deny` / `abstain`; **exit 2 is ignored here** | Speak what it wants to do — the tool, never the argument; yes or no decides it; anything else abstains and the TUI asks as usual. |
| `Notification` | no | Read its `message` out. `notification_type` decides whether it is worth hearing at all, and drops the `permission_prompt` that doubles a `PermissionRequest` we already have. |
| `SessionStart` | no | Register the session: `cwd`, `session_id`, so a request can be given a name. |

Two details matter and are easy to get wrong. `Stop` no longer takes the `{"decision": "block", "reason": …}` JSON that superwhisper's binary still emits — the documented mechanism is **exit code 2 with the text on stderr**, which is what continues the conversation with what you said. And `Stop` carries `stop_hook_active`; when it is true the hook must do nothing at all, or a voice reply that itself ends in a Stop event becomes a loop that never gives the terminal back.

Timeouts are per hook in `hooks.json`, in seconds, defaulting to 600. 600 seconds of a blocked agent is not a feature. We set our own, low, and time out *before* Claude Code does so that we decide what happens rather than inheriting it.

## The hook is a shell script, and that is the design

Superwhisper ships a universal Mach-O binary. We should ship about twenty lines of `sh`, because of one constraint: a Claude Code user is not guaranteed to have node on `PATH`, and a hook that fails to start is a hook that fails in the middle of someone's work.

That is affordable only if the hook never has to parse JSON. So it does not:

1. Read stdin verbatim, write it to `<DIR>/agent/requests/<id>.json` (to `.tmp`, then `mv` — a watcher must never see half a file).
2. Wait for `<DIR>/agent/replies/<id>.ack` to appear, briefly. No ack means transvibe is not running, is switched off, or is not listening: remove the request and exit 0. **The agent is never held up by an app that is not there.**
3. Wait for `<DIR>/agent/replies/<id>.done`, up to the deadline.
4. `cat` `<id>.out` to stdout and `<id>.err` to stderr, then `exit` the integer in `<id>.exit`.

transvibe writes those four files and therefore owns the whole protocol — which exit code, which JSON on stdout, what stderr says. The hook is a courier that cannot misunderstand its own message, the shape of every Claude Code event stays in one place in `src/shared/`, and changing what we do with an event is an app-side change that needs no reinstall.

It reads exactly two things for itself, both about *this terminal* rather than about the app: `TRANSVIBE_AGENT=0`, and a per-project off switch at `<DIR>/agent/off/<hash of cwd>` — the same idea as superwhisper's `/tmp/superwhisper-agent/disabled-<md5>`, kept inside our own directory. Either one means exit 0 immediately. The global on/off stays in `settings.json` and is enforced by simply not acking, so there is one authority for it and it cannot get out of step.

Files, not a socket. A socket is faster and we do not need faster: this fires when a human is being asked a question. Files survive transvibe being restarted mid-question, need no port, leave a directory you can look at when something goes wrong, and can be tested by writing a file.

## The conversation side

An inbound request is a turn in the conversation, spoken by a name.

- **The name comes from `cwd`** — "Claude in transvibe" for a session started here. Synthesized, not persisted, not on the roster; it gets a hue from the same wheel so the ribbon colours itself while it speaks, and the bubble says who it was.
- **It waits its turn.** If `turnBuffer.pending`, `state.asking`, or `state.deaf` is set, the request queues until the app is idle. A question that lands on top of the sentence you are halfway through saying is worse than one that arrives a second later.
- **It opens the conversation window** for `conversationMs`, addressed to the session. The next thing you say — or anything addressed to it by name — is the reply. That window already pauses while the app is speaking, which is exactly the behaviour this needs: a long `last_assistant_message` must not spend the window saying itself.
- **Escape declines.** `cancelEscalation` already means "stop, I am not waiting on this"; here it writes a reply that lets the agent carry on without you.
- **A permission request is a yes or no**, parsed by a small grammar in `src/shared/` — allow, deny, or neither. Neither asks once more and then abstains, and abstain is a real outcome rather than a failure: the terminal asks you the ordinary way, which is where you already were.

Speaking is bounded. `response-format.js` already knows how to cut a paragraph down to what a microphone can afford to sit through and how to say a URL out loud; `last_assistant_message` goes through the same `acceptAnswer`/`speakable` path as everything else, so the strip shows the message and the speakers get the short form.

## Files

New:

- `src/shared/agent-request.js` — pure. Validate a payload, decide whether it is worth speaking, produce what to say, and decide the four reply files for a given answer. Yes/no grammar lives here too. No fs, no Electron: this is where the protocol is, and it is all unit-testable.
- `src/main/agent-inbox.js` — the watcher. `fs.watch` on the requests directory plus a slow interval sweep, because macOS `fs.watch` coalesces and occasionally misses; ack on read; emit; write the reply; clean up. Takes its paths and its clock as arguments so a test can drive it in a temp directory.
- `plugin/hooks/hooks.json`, `plugin/bin/transvibe-hook`, `plugin/.claude-plugin/plugin.json`, `plugin/README.md` — the plugin, shipped from this repo. The hook is referenced as `${CLAUDE_PLUGIN_ROOT}/bin/transvibe-hook`, which is better than superwhisper's hardcoded `/Applications/…` path: it works for a checkout as well as an installed app, and there is no second copy to keep in step.
- `.claude-plugin/marketplace.json` at the repo root, so `claude plugin marketplace add sirkitree/transvibe` finds it, with the plugin's `source` pointing at `./plugin`.
- `docs/plugin.md` — what it does, how to install it, how to turn it off per project, and what leaves the machine (nothing).

Changed:

- `src/main/index.js` — build the inbox against `config.DIR`, forward requests to the renderer, take answers back, stop it on quit. It sits beside `debugRecording`, and like it, a failure switches the feature off rather than the app.
- `src/preload/index.cjs` — `onAgentRequest`, `answerAgentRequest`, `agentSessions`.
- `src/renderer/app.js` — queue, speak, route the reply, decline on Escape. Reuses `conversationWindow`, `turnBuffer`, `landAnswer`'s bubble shape and `whileDeaf`.
- `src/main/config.js` — `agentPlugin` (off by default), `agentReplyMs` (how long a hook may be held).
- `src/renderer/settings-schema.js` — the toggle, the deadline, and a copyable install command. Bumps the reachable-fields count in `test/settings-voice.test.js`.
- `docs/settings.md`, `docs/architecture.md` — a row each, and a paragraph on the one new way into the app.

## Risks

1. **A hung hook is a hung agent.** The mitigations are the ack (fast exit when nobody is home), our own deadline set below Claude Code's, and a default outcome for every event that is "carry on without me". This has to be right first, not last.
2. **Two voice apps on the same events.** Superwhisper's plugin and ours both merge into `~/.claude/settings.json`; both would answer the same `Stop`. Detect `superwhisper@superwhisper` in `enabledPlugins` and say so in the settings panel rather than fighting over the terminal.
3. **Reply text goes straight into an agent session.** It is the user's own speech, which is the same trust as typing — but it must be capped, stripped of control characters, and never assembled from anything but the transcript.
4. **What gets said out loud.** `last_assistant_message` is whatever was on your screen, and a room is not a screen. Bounded by the spoken-length rules, and the whole feature is off by default.
5. **`fs.watch` on macOS misses events.** Hence the sweep. The test should prove the sweep alone is sufficient, with watching treated as the optimisation it is.
6. **Request files are input.** Size-capped, parsed defensively, anything unrecognised ignored and deleted. The directory lives inside the app's own Application Support folder, which is already as trusted as `settings.json`.
7. **The boundary.** Nothing in this path may reach a model or a network. `test/boundary.test.js` exists to make that structural rather than remembered, and it should be extended to cover this before the code that would violate it is written.

## Steps

1. **Verify the plugin shape works** before writing any app code: a plugin with a `hooks.json` pointing at a script that only logs, installed from this repo, firing on `Stop`. This is where `marketplace.json` with a `./plugin` source is proven, and where the real stdin payloads for all four events get captured into `test/fixtures/` for everything that follows.
2. **`src/shared/agent-request.js` + tests.** The protocol, with no I/O in it.
3. **`plugin/bin/transvibe-hook` + tests.** Recorded payloads on stdin, the four reply files on disk, exact exit codes and streams out. Including: no ack, deadline, `TRANSVIBE_AGENT=0`, per-project off, `stop_hook_active`.
4. **`src/main/agent-inbox.js` + tests**, driven in a temp directory.
5. **Wire it up** — index, preload, renderer, settings — with `Stop` only, and use it on this repo for a day.
6. **Add `PermissionRequest` and `Notification`**, then the yes/no grammar.
7. **`docs/plugin.md`**, the settings rows, and the conflict warning.

Each of 2–4 is independently testable and lands on its own; the feature is only visible at 5.

## Tests

- `test/agent-request.test.js` — payload validation and size caps; what each event says out loud; `stop_hook_active` produces nothing; the reply files for allow, deny, abstain, decline and timeout; the yes/no grammar, including the things that are neither ("do it later", "what does it do").
- `test/agent-hook.test.js` — spawn the script with recorded stdin. Asserts exit code, stdout, stderr per event; that no ack exits 0 and removes the request; that the deadline is honoured; that both off switches exit immediately; and that the request file is valid JSON identical to stdin.
- `test/agent-inbox.test.js` — a temp directory: a request is acked, parsed and emitted; a malformed or oversized one is ignored and cleaned up; a reply lands in the right files; a reply to a request that has already timed out is dropped; two interleaved requests do not cross; the interval sweep alone finds a request with watching disabled.
- `test/boundary.test.js` — extended, so the inbox path can never import anything that spawns or fetches, and `REMOTE_JOBS` stays the other half of that guard.
- `test/settings-voice.test.js` — the new fields are reachable by voice.

## Open questions

- **Does `marketplace.json` at the repo root accept a `source` in a subdirectory?** Superwhisper's is `"./"` with the plugin at the root. Step 1 settles it; if not, the plugin moves to the repo root and the layout above changes, nothing else does.
- **Should the reply also be typed into the terminal?** `bin/sendkeys` exists. It would cover agents with no hook system at all, but it is a different and much less reliable mechanism, and it is not needed for Claude Code. Left alone.
- **Codex.** The same four files with different event names, once Claude Code has been used for long enough to know the shape is right.
