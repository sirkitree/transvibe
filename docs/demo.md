# The demo video

The video that sits at the top of the README. Its whole job is to answer *what is this and how does it work* for someone who arrived from a link, has never heard of the project, and will give it about a minute.

Target: **75–90 seconds**, no voiceover.

## Two things that shape the whole script

**It will be watched with the sound off.** A video embedded in a README is watched muted, in a browser tab, next to nine other tabs. Nothing can depend on hearing you.

That sounds fatal for a dictation app, and it is the opposite: the app puts what you said on screen as you say it. **The product is its own subtitle track.** The viewer watches words appear, which is exactly the thing being demonstrated. All the script has to add is a short caption card per beat saying what to notice.

**The viewer has no context.** No Slack, no colleagues, no in-jokes, nothing from your setup. Every word on screen has to make sense to a stranger. That rules out internal names — which is why the glossary beat uses `whisper.cpp`, a word the viewer read in the README two lines above the video.

## What they should be able to say afterwards

Three things, in this order. If a beat does not serve one of them, cut it.

1. It turns what I say into text, on screen, as I talk.
2. It has no window and it gets out of the way — this is not another floating box to manage.
3. It runs on the machine. Nothing I say goes anywhere.

Everything else — the glossary, voice editing, the assist model — is evidence that someone thought about the details, not the point.

## Before you record

- A clean desktop. One editor or browser window, no dock full of badges, no notifications. Do Not Disturb on.
- Record at 1280×800 or 1440×900, not a 6K display scaled down — the strip's text has to be legible in a README's column width.
- Whatever you record into needs a text field you can leave focused, for the paste at the end.
- **Rehearse the glossary word.** `whisper.cpp` comes out as "Whisper CPP" reliably here, but it depends on your voice and your model. Say it a few times first and confirm it actually fails for you; if it does not, pick another word that does — a colleague's name usually works — and change the caption to match.
- Clear the glossary of anything private before recording. It is on screen in beat 5.
- Decide whether the assist model is on. Beat 4 needs `cleanup: true`; if you leave it off, cut that beat and the video is 70 seconds instead of 85.
- Sit quietly for ten seconds before you start, so the strip has faded and the screen looks untouched.

## The script

Times are cumulative. Captions are short on purpose — they are read at a glance, over the top of the action.

| in | for | on screen | caption |
|---|---|---|---|
| 0:00 | 6s | A quiet desktop. One thin line across the very top. | **transvibe** — local voice-to-text for macOS |
| 0:06 | 8s | Pointer moves up over the strip and clicks a tab or a link *behind* it. It works. | It has no window. Clicks pass straight through. |
| 0:14 | 6s | Pointer rests on the strip: it goes solid, buttons appear. Pointer leaves: it is a ghost again. | Rest the pointer on it and it wakes. |
| 0:20 | 12s | You speak. Blue text appears while you are still talking, then settles. | Text appears while you are still talking. |
| 0:32 | 6s | The line rewrites itself, fillers gone. *(Optional — needs the assist model.)* | Optional: a second local model takes the fillers out. |
| 0:38 | 12s | "Whisper CPP" appears. Click the word, type `whisper.cpp`, hit fix. It changes everywhere. | Click a word to fix it. It remembers for next time. |
| 0:50 | 10s | Hold right ⌥ — the strip turns amber. Speak. The last sentence disappears. | Hold right ⌥ to edit by voice. |
| 1:00 | 8s | ⌃⌥↩. The text lands in the editor you left focused. | ⌃⌥↩ pastes it where you were typing. |
| 1:08 | 8s | Stop. The text fades. Back to one thin line. | Then it gets out of the way. |
| 1:16 | 4s | Hold on the empty screen. | Nothing you say leaves your machine. |

### The lines to say

Verified against `small.en`. Say them at a normal pace with natural pauses; do not perform them.

**0:20** — one sentence, then stop talking so the final replaces the interim:

> Everything transvibe hears stays on the laptop.

**0:32**, if the assist model is on, replace the above with a line that has something to take out:

> Um so transvibe runs uh runs entirely on this machine.

**0:38** — the glossary beat:

> It is all in the whisper.cpp bindings.

Comes out as *"It is all in the Whisper CPP bindings."* Click **Whisper**, type `whisper.cpp`, fix. Both words collapse into the right one, and the rule is saved — reopen the glossary to show it landed, if the timing allows.

**0:50** — hold right ⌥, and use a phrasing no rule covers, so the assist model is doing the work:

> actually chuck that last bit

If the assist model is off, say **"scratch that"** instead, which the rules handle on their own.

## After recording

Trim to the first frame of the desktop and the last frame of the empty strip — no title card, no fade in. A README video that opens on a logo has spent its first two seconds badly.

Keep it under 10 MB if you can. GitHub renders an uploaded `.mp4` as a player: drag the file into any issue or PR comment box, GitHub uploads it and gives you back a URL, and that URL goes into the README. Paste it into the slot near the top:

```html
<!-- demo video: https://github.com/user-attachments/assets/... -->
```

A GIF is the fallback if the video will not play inline, but it will be several times the size for the same length and the text will be softer. Prefer the video.

## Do not record this

**Spoken self-corrections.** "Ship it Friday, no wait, Thursday" *sometimes* comes back corrected and sometimes keeps both halves. It is a great party trick when it lands and a dead demo when it does not.

**A long monologue.** The transcript caps at four lines and older text scrolls away. One sentence per beat.

**A noisy room.** A short glossary makes every cough a candidate for one of its terms. The echo filter drops utterances that are only glossary words, but background chatter still produces stray text on screen.

**Anything you would mind a stranger reading.** The glossary panel is on screen in beat 5, the transcript throughout, and whatever you paste into lands in beat 8.

## One thing to know before you trust it

Cleanup has turned "I still need to double check" into "I still need *you* to double-check" — a plausible sentence, the right length, and not what was said. The guards catch a summary, a refusal or a chatbot preamble, but not a single-word meaning change. Read what it produced before you send it anywhere that matters, and do not put a demo transcript straight into a real message.
