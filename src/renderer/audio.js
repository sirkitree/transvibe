import { createVad } from './vad.js'

const SAMPLE_RATE = 16000
const FRAME_MS = 20
/* Enough history that a segment starting mid-buffer is never clipped. */
const RING_SECONDS = 30

/**
 * Opens the microphone once and serves both consumers from it: an AnalyserNode
 * for the visualizer, and an AudioWorklet feeding the VAD + a ring buffer that
 * closed segments are sliced out of.
 */
export async function startCapture ({ onSegment, onPartial, onLevel, onError, settings }) {
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    onError(`Microphone unavailable: ${err.message}`)
    return null
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (ctx.state === 'suspended') await ctx.resume()

  const source = ctx.createMediaStreamSource(stream)

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.72
  source.connect(analyser)

  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url))
  const collector = new AudioWorkletNode(ctx, 'pcm-collector', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { frameMs: FRAME_MS }
  })
  source.connect(collector)

  const frameSize = Math.round((SAMPLE_RATE * FRAME_MS) / 1000)
  const ringFrames = Math.ceil((RING_SECONDS * 1000) / FRAME_MS)
  const ring = new Float32Array(ringFrames * frameSize)
  let writeFrame = 0

  const vad = createVad({
    frameMs: FRAME_MS,
    threshold: settings.threshold,
    hangoverMs: settings.hangoverMs
  })

  /* Interim passes over the still-open utterance, so text appears while you
     are talking instead of only after the hangover expires. */
  let interimFrames = Math.max(
    1, Math.round((settings.interimMs ?? 700) / FRAME_MS))
  const minInterimFrames = Math.round(500 / FRAME_MS)
  let openStart = null
  let lastInterim = 0

  const sliceFrames = (from, to) => {
    const count = to - from + 1
    if (count <= 0 || count > ringFrames) return null
    const out = new Float32Array(count * frameSize)
    for (let f = 0; f < count; f++) {
      const at = ((from + f) % ringFrames) * frameSize
      out.set(ring.subarray(at, at + frameSize), f * frameSize)
    }
    return out
  }

  /* vad.frame advances in lockstep with writeFrame, so a segment event's
     frame indices are already absolute indices into the ring. */
  collector.port.onmessage = ({ data }) => {
    ring.set(data.pcm, (writeFrame % ringFrames) * frameSize)
    writeFrame++

    onLevel(data.rms)

    const ev = vad.push(data.rms)

    if (ev && ev.type === 'start') {
      openStart = ev.startFrame
      lastInterim = writeFrame
      return
    }

    if (ev && ev.type === 'end') {
      const seg = ev.reason === 'discarded' ? null : sliceFrames(ev.startFrame, ev.atFrame)
      // a 'max' flush reopens on the same frame, so the utterance keeps going
      openStart = ev.reason === 'max' ? ev.atFrame : null
      lastInterim = writeFrame
      if (seg) onSegment(seg, ev)
      return
    }

    if (openStart === null || !onPartial) return
    const here = writeFrame - 1
    if (here - lastInterim < interimFrames) return
    if (here - openStart < minInterimFrames) return
    lastInterim = here
    const partial = sliceFrames(openStart, here)
    if (partial) onPartial(partial)
  }

  return {
    analyser,
    vad,
    setThreshold: t => vad.setThreshold(t),
    setHangoverMs: ms => vad.setHangoverMs(ms),
    /* The settings panel retunes a live microphone rather than reopening it:
       getUserMedia again would drop the utterance in progress. */
    setInterimMs (ms) {
      if (Number.isFinite(ms) && ms > 0) interimFrames = Math.max(1, Math.round(ms / FRAME_MS))
    },
    stop () {
      collector.port.onmessage = null
      collector.disconnect()
      source.disconnect()
      stream.getTracks().forEach(t => t.stop())
      ctx.close()
    }
  }
}
