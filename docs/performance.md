# Visualizer cost

Notes from tuning the band, kept because the intuition about where the cost sits turned out to be wrong twice.

The whole app idles at roughly 12% CPU in a quiet room on an M-series Mac: ~4% GPU process, ~6% renderer, ~1% whisper-server.

## What mattered

**`shadowBlur` was almost all of it.** It rasterises a blur *per stroke*, and the band draws 55 strokes a frame. Disabling that one line took the GPU process from 49% to 12%. The glow now comes from drawing the band to an offscreen canvas and blitting it twice, blurred then crisp — one blur per frame instead of 55.

![The ribbon at full travel](images/visualizer.png)

**Frame pacing was the rest.** 30fps is indistinguishable from 60 for a flowing ribbon, and a silent room drops to 8. The idle path did not engage at first: it tested `model.level`, which `levelGain` multiplies well past any threshold, so a quiet room still painted at 26fps. It now keys off the VAD's own state, which is the thing that actually knows whether anyone is talking.

## What did not

Cutting the line budget from 54 to 36, and points from 220 to 160, changed nothing measurable — 13.5% either way. Once the blur was gone the cost was compositing a transparent window, not drawing into it, so the line budget stayed generous.

Below ~10% the differences stop being resolvable by process sampling at all. `backdrop-filter` measured *higher* switched off than on, which is only noise.

## The orb

The round visualizer is a second window, and the plan for it guessed it might come out *cheaper* than the ribbon — a 300pt square composites far fewer pixels than a full-width strip on a wide display. Measured, it does not. Same machine, same room, both forced to 30fps so the frame budget is not doing the comparing:

| | GPU process | renderer |
|---|---|---|
| ribbon | 3.8% | 6.1% |
| orb | 10.1% | 13.9% |

Roughly two and a half times, and the reason is drawing after all: 120 filaments drawn twice is 240 strokes a frame against the ribbon's 55, each with a gradient of its own. The renderer column counts both windows, because in orb mode the strip's renderer is still awake — it owns the microphone and the analyser, and posts the orb its signal.

Idle, the two are indistinguishable — 5.2% against 5.4% GPU in a silent room, which is inside the noise. Both drop to `vizQuietFps` when the VAD says nobody is talking, the orb's signal included: there is no point sending thirty messages a second to a window drawing eight frames.

![The orb, with the app's own voice as the smaller ring turning inside it](images/orb.png)

## Knobs

`vizLinesPerFamily`, `vizPoints`, `vizFps`, `vizQuietFps` in settings. For the orb, `orbSeeds` first — it is the stroke count, and halving it halves the drawing — then `orbSteps`.
