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

## Knobs

`vizLinesPerFamily`, `vizPoints`, `vizFps`, `vizQuietFps` in settings.
