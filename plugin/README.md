# transvibe for Claude Code

Your agent says what it needs through transvibe, and you answer out loud instead of going back to the terminal.

**This is the capture-only first version.** It records what Claude Code sends its hooks and does nothing else — it never blocks the session, never speaks, and never answers. Speaking and answering come next; see `docs/plans/agent-plugin.md` in the transvibe repo.

## Install

```bash
claude plugin marketplace add sirkitree/transvibe
claude plugin install transvibe@transvibe
```

From a checkout, `./` rather than the repo name:

```bash
claude plugin marketplace add ./
claude plugin install transvibe@transvibe
```

Restart Claude Code, then `/hooks` to see it registered.

To work on it without installing it for every session:

```bash
claude --plugin-dir plugin
```

## What it writes

One file per hook event, under:

```
~/Library/Application Support/transvibe/agent/capture/
```

Each is the payload Claude Code sent, byte for byte. It stays on this machine — the hook makes no network call of any kind — but it does include the session's working directory, the path to its transcript, and Claude's last message, so it is worth knowing the directory is there and worth emptying when you are done.

## Turning it off

Per project, from inside that project:

```bash
mkdir -p ~/Library/Application\ Support/transvibe/agent/off
printf %s "$PWD" | cksum | cut -d' ' -f1 | xargs -I{} touch ~/Library/Application\ Support/transvibe/agent/off/{}
```

For one session: `TRANSVIBE_AGENT=0 claude`.

Entirely: `claude plugin uninstall transvibe@transvibe`.
