# Plan: the orb — a round visualizer in the lower-left corner

Status: **built**, 2026-09-06. Kept as the record of why it is shaped the way it is; where the code diverged from the plan, that is noted below.

## Where it came out differently

- **No `orb-saying.js`.** The inner orb is a second layer inside `orb-viz.js`, against the same `orb.js`, drawn to the same canvas. It shares the one blur blit that way, and the two rings composite as one object instead of as two stacked ones. A separate module would have been a second canvas and a second blur.
- **The zoom is far smaller than the reference's.** `orbZoomGain` defaults to 0.5, not 3. The reference had a whole screen to grow into; this has a 300pt square, and a mandala clipped against the edge of its own window reads as broken rather than as loud.
- **`orbSaySeeds` / `orbSaySteps` were not needed.** The inner ring derives both from the outer's. `orbSayScale` is the one dial it has.
- **The spoken form is "change the visualizer to the orb", not "switch to the orb".** "Switch to X" already means a desktop Space, and a second meaning for it would be a coin toss on every "switch to". It goes through the settings schema instead, which needed one new thing: `resolveChoice`, for a select whose options the schema already knows rather than the machine.
- **It is not cheaper than the ribbon.** The plan guessed it might be, since a small square composites fewer pixels than a full-width strip. Measured, it is about two and a half times the cost when active and indistinguishable when idle. The numbers are in `docs/performance.md`.
- **The noise scale turned out to be the whole look.** Not something the plan anticipated: below about 10, neighbouring seeds get near-identical turn fields and the ring combs into solid sheets; past about 30 they stop agreeing at all and it tangles. 22 is where they read as filaments.

Reference: <https://jeradbitner.com/websim-projects/dynamic-p5-js-visualization-with-enhanced-sound-reactive-zoom.html> — a p5.js sketch of Jerad's. Source read and summarised below, because the page is a websim export and may not stay up.

## Scope, and what must not move

The strip stays exactly where it is and keeps doing exactly what it does. The transcript, the conversation bubbles, the button bar, the hint line, the four panels, the hover-to-wake behaviour, the window geometry, `stripHeight`, the idle fade — none of it changes. **This feature is only the visual.**

What changes: the electric ribbon along the top of the strip is replaced by a round visualizer in the lower-left corner of the screen. That is a different place on the screen from the strip, so it is a second window.

Explicitly out of scope, however tempting once the ribbon is gone: shrinking the strip, moving the transcript up into the space the ribbon used, or re-centring anything. `centerRatio`, `stripHeight` and the stage layout stay as they are.

## What the reference actually draws

Not concentric rings, which is what the title suggests and what a summary would guess.

- **A rotating seed ring.** `rInit` sweeps 0 → π in `ptnCnt` (500) steps. Each seed sits on a circle of radius 0.25 around the unit-space centre (0.5, 0.5), rotated by `frmRatio = (frameCount * rotationSpeed) % 144 / 144`.
- **A short walk from each seed.** `plotMax = 10 + floor(20 * sin(π * (rRatio + frmRatio) % π))` steps, so filament length varies around the ring and travels around it as it turns. Each step turns by `sin(xPrev + yPrev + frameCount * 0.01 * rotationSpeed) + sin(dist(xBase, yBase, xInit, yInit)) + noise(xPrev * noiseScale, yPrev * noiseScale, frameCount * 0.005 * rotationSpeed) * 4`, multiplied by `plotMult` (1.5–3.5), and steps `plotDiv` (0.02). This is the flow-field look — filaments trailing off a ring, not rings.
- **Point symmetry.** Every dot is drawn twice: at `(x, y)` and at `(1 - x, 1 - y)`, the second with hue offset by `divHue` (90°). That mirror is what makes it read as a mandala rather than a spiral. It is the single most important line to keep.
- **Colour.** HSB, `blendMode(SCREEN)`, `noStroke()`. `pHue = (baseHue + pRatio * 90 + noise(...) * 60 + bassEnergy * 50) % 360`, `pSat = baseSat * (1 - pRatio + rRatio) * (1 + midEnergy)`, `pBri = baseBri * (1 + pRatio) * (1 + trebleEnergy)`, `pSiz` scaled by `(1 + bassEnergy * 2)`. `baseHue` drifts `0.5 * rotationSpeed` per frame.
- **The zoom, which is the headline.** `soundDrivenZoom` lerps (0.2) toward `1 + (level - soundThreshold) * soundSensitivity`, clamped to `[1, 1 + sensitivity]`, and decays back to 1 at `zoomDecayRate` (0.05) when the room is quiet. It scales `size = min(width, height) * initialSize * soundDrivenZoom`, so the whole figure breathes outward when you speak.

Two things in it do not survive contact with this app, and they are the crux of the port:

1. **`background((baseHue + divHue * 0.5) % 360, 90, 10, 100)` every frame.** The reference paints an opaque dark ground. Our window is transparent and click-through. The orb must `clear()` and draw on nothing, which means the SCREEN-blend bloom has to come from our own additive compositing rather than from having a dark ground to blend against.
2. **~30,000 `ellipse()` calls per frame** — 500 seeds × 10–30 steps × 2 mirrors, at 60fps. The current ribbon is **55 strokes at 30fps**, and `docs/performance.md` records it landing at 13.5% GPU with the explicit finding that what remains is *compositing a transparent window, not drawing*. A literal port is two orders of magnitude over budget.

Also: p5 is not available. The CSP in `index.html` is `script-src 'self'`, and the repo has no runtime dependencies. This is a port, not an embed — including `noise()`, which has to be ours.

## Architecture

### A second window, fed five numbers

The orb is in the lower-left of the screen; the strip is a full-width band at the top. They cannot be the same window without the strip covering the screen, which would break click-through and the whole layout. So: a small, square, always-on-top, **permanently click-through** window in the corner, containing one canvas and nothing else.

Audio does not move. The microphone, the `AnalyserNode` and the VAD stay in the strip's renderer, which is the single source of truth for what the room is doing and whether the app is listening, speaking, or armed. The orb window gets a **signal** — about five numbers, at the visualizer's own frame rate:

```
{ bass, mid, treble, level, active, mode, hue }
```

posted from the strip renderer to main and forwarded to the orb window. The reference only ever reads three band energies, so there is no reason to ship raw FFT bins across IPC. Cheap enough to be uninteresting: five floats at 30fps.

The orb window is a dumb renderer. It owns no state that matters, can be created and destroyed at will, and if it never opens nothing else notices.

### Click-through, always

The orb has no controls and nothing to click, so it is `setIgnoreMouseEvents(true)` for its whole life and never wakes. That deletes a whole class of problem: no hover machine, no dwell, no dead corners.

If it ever gains a click target, `overlay.js` will need a radial hit test beside `contains()` — a round thing in a square window has four corners that would otherwise swallow the pointer. Not needed for this plan; noted so it is not rediscovered.

## Files

**New**

- `src/renderer/orb.js` — pure, `band.js`'s sibling and written to match it. The seed ring, the walk, the mirror, the zoom envelope. No DOM, no canvas, no Electron. Includes a small seeded value-noise function (~30 lines): p5's `noise()` is not available and ours being seeded and pure is what makes the walk testable.
- `src/renderer/orb-viz.js` — the canvas half, modelled on `visualizer.js`: the offscreen-blur-blit pipeline, the 30fps/8fps-quiet frame budget, the `ResizeObserver`, the `visibilitychange` handling. Copied deliberately rather than abstracted; see the note on refactoring below. Built twice against the same `orb.js` — the outer orb for the room, the inner one for the app's own voice — onto one canvas.
- `src/renderer/orb.html` + a small entry script — the orb window's document. One canvas, transparent body, nothing else.
- `src/renderer/orb-saying.js` — the inner orb: `orb-viz.js` again, wired to `saying.js`'s arithmetic analyser, the way `saying-viz.js` wires `visualizer.js` today. Thin; it is configuration, not a second renderer.
- `test/orb.test.js`.

**Changed**

- `src/main/overlay.js` — `orbBounds(display, {size, margin})` beside `stripBounds`, anchored to `workArea` (which already excludes the Dock, so the orb sits above it with no special case).
- `src/main/index.js` — create, destroy and position the orb window when `layout` changes; relay the signal; keep it on top and on the same display as the strip.
- `src/renderer/app.js` — post the signal each visualizer frame; hide both `#viz` and `#say-viz` when the layout is `orb`; forward the saying envelope on the same signal so the inner orb can pulse with it.
- `src/preload/index.cjs` — the signal channel.
- `src/main/config.js`, `src/renderer/settings-schema.js` — the settings below.
- `docs/performance.md` — the measured cost, next to the ribbon's.
- `README.md` — one line and probably a second GIF.

## Making it affordable

The budget is the whole design constraint, so it is decided up front rather than discovered:

- **Filaments become stroked paths, not dots.** Each seed's walk is one path through `quadraticCurveTo`, using the same midpoint-smoothing `stroke()` helper `visualizer.js` already has. ~30,000 fills becomes ~240 strokes. The dots' individual per-step hue and size are lost; a per-filament gradient along the path gets most of it back, and the mirror keeps the character.
- **Seeds down to ~120, steps ~14**, both configurable. With the mirror that is ~240 paths a frame against the ribbon's 55 strokes — about 4×, at the same frame budget.
- **One blur of the finished layer.** `visualizer.js`'s comment records `shadowBlur` costing 75% of the app's GPU (49% → 12%) because it rasterises a blur per stroke. That lesson transfers unchanged: draw the orb to an offscreen canvas, blit it blurred, then blit it crisp.
- **The existing frame budget.** 30fps active, 8fps quiet, nothing at all when hidden — and quietness comes from the VAD, not from the model's own level, for the reason already recorded in `visualizer.js`: `levelGain` multiplies ambient noise past any threshold, so a level-based idle test never idles.

A 300px square window composites far fewer pixels than a full-width 180px strip on a wide display. The orb may well come out **cheaper** than the ribbon it replaces. Measure it and put the number in `docs/performance.md` beside the existing one rather than assuming either way.

## Carrying the app's signals

The ribbon says things, and the orb has to say the same things or the app gets quieter without anyone deciding to make it quieter:

- **Command mode** — the strip goes amber. The orb takes an amber wash.
- **Who is speaking** — an answer is spoken in the agent's own hue. The orb's `baseHue` shifts to it for the duration.
- **The app's own voice** — `saying-viz.js` draws a small counter-facing ribbon in the middle of the strip while it talks. In the orb it becomes a **miniature orb inside the orb**: the same generator at a smaller radius, not a second widget bolted on. See below.

### The inner orb — the app's own voice

Both strip canvases hide in orb mode. `#say-viz` does not move to the corner as a second small ribbon; it is **redesigned as a concentric miniature of the orb**, so the app has one place it expresses itself and one visual language it expresses itself in.

`saying-viz.js` already makes the argument for how: it is `createVisualizer` again — the same renderer, handed an analyser that is arithmetic rather than an ear — because "a second visualizer that merely resembled the first would be a second thing to keep in step, and the point is that this reads as the same instrument turned around." The orb inherits that decision unchanged. `orb-viz.js` gets built twice against the same `orb.js`, once for the room and once for the app, and `saying.js`'s `sayingSpectrum` / `sayingLevel` keep feeding the second one exactly as they feed `say-viz` today.

What separates the inner orb from the outer, by analogy with what separates `say-viz` from the ribbon — warmth, size, and direction:

- **Radius.** Seed ring at roughly 0.10 of unit space against the outer 0.25, drawn to the same canvas so the two share the additive blit and the bloom reads as one object rather than two stacked ones.
- **Counter-rotation.** `rotationSpeed` negated. The mandala turning one way with a smaller one turning the other inside it is the orb's version of `say-viz`'s counter-facing ribbon, and it is what makes "the app is talking" legible at a glance without a label.
- **Warmth.** Held inside the same narrow red-through-amber band `say-viz` uses (`hueBase` 0.02, spread 0–0.1), against the outer orb's drifting hue. Note the collision with command mode's amber wash: while the app is speaking in command mode, the wash should back off or shift so the inner orb still separates from it. Decide by eye when tuning.
- **Cost.** Far fewer seeds and steps — start around a quarter of the outer's, same way `say-viz` runs 3 lines to the ribbon's larger family, and for the same reason: at this radius a full-density walk fills in as a solid disc. `orbSaySeeds` / `orbSaySteps` if the dials earn their place; otherwise derive them from `orbSeeds` / `orbSteps`.
- **Presence.** Only drawn while there is something to say, on `sayingLevel`'s existing envelope, fading in and out with it rather than appearing and vanishing.
- **The mirror stays.** The inner orb keeps the `(1 - x, 1 - y)` point symmetry. It is the line that makes the figure read as a mandala at any radius, and dropping it for the small one would make the inside look like a different kind of thing.

The zoom is the outer orb's alone — it is the room breathing. The inner orb pulses on `sayingLevel` instead, so the two never fight over the same envelope.

**Keep the drift, drop the randomisation.** The reference re-rolls `plotMult`, `baseHue`, `xBase`, `yBase` and `noiseScale` on every load, so it looks like a different sketch each time. Here `baseHue` should keep drifting the way `band.js` already drifts it, and the rest should be stable, so it stays recognisably the same app between launches.

**Keep reacting to music.** The reference gates its zoom behind `soundThreshold`. We have better inputs — the VAD and `confidenceFloor` — but the README's choice is deliberate: *"Ignores music and background noise rather than transcribing it, while the visualizer still reacts to it."* The orb should keep blooming for music in the room. It just must not write it down.

## Settings

- `layout: 'strip' | 'orb'` — which visualizer is running. Spoken: "switch to the orb", "put it back on the strip".
- `orbSize`, `orbMargin` — the window, in points, and its inset from the corner of the work area.
- `orbSeeds`, `orbSteps` — the cost dials, the way `vizLinesPerFamily` and `vizPoints` are for the ribbon.
- `orbZoomGain`, `orbZoomDecay` — the reference's `soundSensitivity` and `zoomDecayRate` under names that say what they do here.
- `orbSayScale` — the inner orb's radius as a fraction of the outer's, defaulting to about 0.4. Its seed and step counts derive from `orbSeeds` / `orbSteps` unless tuning proves they need `orbSaySeeds` / `orbSaySteps` of their own.

Applied live, like everything else in the panel — creating and destroying a small window is cheap, and a visual setting you have to relaunch to see is a setting you tune badly. `restart: true` only if that proves hairy.

`test/settings-schema.test.js` holds these to `config.js` in both directions, so each needs a row or a place on one of the exemption lists.

## Tests

`test/orb.test.js`, in `band.test.js`'s style:

- seed ring positions at a known frame, and that the ring rotates with `frmRatio`
- the walk is deterministic under an injected rng and noise, and stays inside unit space
- the mirror is exact: every point has its `(1 - x, 1 - y)` partner
- filament length varies around the ring and travels with the frame
- zoom: attack toward the target, the clamp at both ends, and decay to exactly 1 in silence
- the inner orb: the same generator at the smaller radius and negated rotation, mirror intact, and its points staying clear of the outer ring's
- the noise function is seeded, in range, and continuous enough to be worth having

`test/overlay.test.js`: `orbBounds` across displays, on a Dock-reduced work area, and on a display too small for the requested size.

## Risks

1. **The budget.** Everything above is a guess until it is measured. If ~240 paths at 30fps does not hold, the dials are `orbSeeds` and `orbSteps` and they are already exposed.
2. **Additive glow with no ground.** The reference's look depends on SCREEN blending against a dark background. On a transparent window the bloom has to come from `lighter` compositing and the one-blur blit, and it may need real tuning to avoid looking either washed out or like a smear.
3. **Two windows.** A second always-on-top window is a second thing to keep on the right display, to hide with `⌃⌥Space`, to not have appear in screenshots or Mission Control oddly, and to tear down cleanly on quit.
4. **The signal is a new coupling** between the strip renderer's frame loop and a second window. Keep it one-way and lossy on purpose: a dropped frame of orb signal is a dropped frame of animation and nothing more.
5. **Copying `visualizer.js`'s pipeline** rather than extracting it means two places to fix a compositing bug. Extract a shared runtime only if it falls out naturally while writing `orb-viz.js`; do not refactor the working ribbon to make room for a visualizer that does not exist yet.

## Sequencing

Land after the frontier-escalation work is merged and green. That feature is editing `app.js`, `config.js`, `settings-schema.js` and `main/index.js`, all four of which this touches.

Suggested order: `orb.js` and its tests first, standalone and provable with no window anywhere; then `orb-viz.js` against a plain HTML page fed a fake analyser, so the look can be tuned without Electron in the loop; then the window, the signal, and the settings last.
