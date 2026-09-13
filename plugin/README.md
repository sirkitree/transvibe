# transvibe for Claude Code

Your agent says what it needs through transvibe, and you answer out loud instead of going back to the terminal.

**Not finished yet.** The hook is built and tested; the app side that speaks and listens is not. Until then this does nothing at all — with transvibe not watching, the hook exits immediately and the session never notices it ran. See `docs/plans/agent-plugin.md` in the transvibe repo.

## Install

```bash
claude plugin marketplace add sirkitree/transvibe
claude plugin install transvibe@transvibe
```

From a checkout, `./` rather than the repo name — a local marketplace needs the slash:

```bash
claude plugin marketplace add ./
claude plugin install transvibe@transvibe
```

Restart Claude Code, then `/hooks` to see it registered.

To work on it without installing it for every session:

```bash
claude --plugin-dir plugin
```

## What it does

On four events — the agent finishing, a notification, a permission request, and a session starting — it writes what Claude Code sent to a file transvibe watches, waits for an answer, and prints back whatever transvibe decided. It parses nothing itself: what an event means, what it sounds like and what answers it all live in the app, in `src/shared/agent-request.js`.

Everything stays on this machine. The hook makes no network call of any kind.

**It will not hold up your session.** With transvibe not running it exits at once. With transvibe running but not answering — paused, switched off, or busy — it waits a second and a half for an acknowledgement and then gets out of the way. Every path that is not an answer exits 0, because on the `Stop` event a non-zero exit is not an error, it is an instruction to keep going.

## Turning it off

Per project, from inside that project:

```bash
mkdir -p ~/Library/Application\ Support/transvibe/agent/off
printf %s "$PWD" | cksum | cut -d' ' -f1 | xargs -I{} touch ~/Library/Application\ Support/transvibe/agent/off/{}
```

For one session: `TRANSVIBE_AGENT=0 claude`.

Entirely: `claude plugin uninstall transvibe@transvibe`.

## Keeping a copy

`TRANSVIBE_CAPTURE=1` keeps what arrived, under `~/Library/Application Support/transvibe/agent/capture/`. Off by default: a payload holds the session's last message and its working directory, and a directory quietly filling with those is not a default.
