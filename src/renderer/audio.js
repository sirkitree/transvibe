import { configureVoiceIsolation } from './voice-isolation.js'
import { createInterimPolicy } from './interim-policy.js'
import { createVad } from './vad.js'
import { captureStart, captureHangover } from './capture-timing.js'
import { createRecordingBuffer } from './recording-buffer.js'

const SAMPLE_RATE = 16000
const FRAME_MS = 20
/* Enough history that a segment starting mid-buffer is never clipped. */
const RING_SECONDS = 30

/**
 * Opens the microphone once and serves both consumers from it: an AnalyserNode
 * for the visualizer, and an AudioWorklet feeding the VAD + a ring buffer that
 * closed segments are sliced out of.
 */
export async function startCapture ({ onSegment, onPartial, onLevel, onError, onRecording = () => {}, onVad = () => {}, isConversation = () => false, settings }) {
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        voiceIsolation: { ideal: !!settings.voiceIsolation },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    onError(`Microphone unavailable: ${err.message}`)
    return null
  }

  const microphone = stream.getAudioTracks()[0]
  const voiceIsolation = await configureVoiceIsolation(microphone, settings.voiceIsolation)

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
  let earliestFrame = 0
  let hangoverMs = settings.hangoverMs
  let conversationHangoverMs = settings.conversationHangoverMs ?? 950

  const vad = createVad({
    frameMs: FRAME_MS,
    threshold: settings.threshold,
    minSegmentMs: settings.minSegmentMs,
    hangoverMs: settings.hangoverMs
  })

  /* Interim passes over the still-open utterance, so text appears while you
     are talking instead of only after the hangover expires. */
  let interimFrames = Math.max(
    1, Math.round((settings.interimMs ?? 700) / FRAME_MS))
  const minInterimFrames = Math.round(500 / FRAME_MS)
  let openStart = null
  let lastInterim = 0
  const previews = createInterimPolicy()

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

  /* Deaf while the app is talking back. The frames still arrive and are still
     pushed — the VAD's frame counter has to stay in lockstep with the ring, and
     the ring itself must not gain a hole — but they are pushed as silence, so
     what comes out of the speakers cannot open a segment and be transcribed
     back at us. Echo cancellation alone does not survive a laptop speaker at
     arm's length. */
  let deaf = false
  const recording = createRecordingBuffer(onRecording)

  /* vad.frame advances in lockstep with writeFrame, so a segment event's
     frame indices are already absolute indices into the ring. */
  collector.port.onmessage = ({ data }) => {
    recording.push(data.pcm)
    ring.set(data.pcm, (writeFrame % ringFrames) * frameSize)
    writeFrame++

    onLevel(deaf ? 0 : data.rms)

    vad.setHangoverMs(captureHangover(isConversation(), hangoverMs, conversationHangoverMs))
    const ev = vad.push(deaf ? 0 : data.rms)
    if (ev) onVad({ ...ev, boundary: ev.type, deaf, threshold: vad.threshold, noiseFloor: vad.noiseFloor })
    // Silence still closes whatever was open when we went deaf; that event is
    // the app's own doing and nothing should be transcribed from it.
    if (deaf) return

    if (ev && ev.type === 'start') {
      previews.newSegment()
      openStart = captureStart(ev.startFrame, earliestFrame)
      lastInterim = writeFrame
      return
    }

    if (ev && ev.type === 'end') {
      previews.newSegment()
      const seg = ev.reason === 'discarded' ? null : sliceFrames(openStart ?? ev.startFrame, ev.atFrame)
      const retrySamples = seg ? sliceFrames(Math.max(earliestFrame, (openStart ?? ev.startFrame) - 50), ev.atFrame) : null
      earliestFrame = ev.atFrame + 1
      // a 'max' flush reopens on the same frame, so the utterance keeps going
      openStart = ev.reason === 'max' ? ev.atFrame : null
      lastInterim = writeFrame
      if (seg) onSegment(seg, { ...ev, retrySamples })
      return
    }

    if (openStart === null || !onPartial) return
    const here = writeFrame - 1
    if ((here - lastInterim) * FRAME_MS < previews.intervalMs(interimFrames * FRAME_MS)) return
    if (here - openStart < minInterimFrames) return
    lastInterim = here
    const partial = sliceFrames(previews.fromFrame(openStart, here), here)
    const token = previews.generation
    if (partial) Promise.resolve(onPartial(partial)).then(result => previews.observe(result, token)).catch(() => {})
  }

  return {
    analyser,
    vad,
    recordingInfo: { voiceIsolation, microphone: stream.getAudioTracks()[0]?.label, constraints: stream.getAudioTracks()[0]?.getSettings(), sampleRate: ctx.sampleRate },
    setRecording: active => recording.setActive(active),
    flushRecording: () => recording.flush(),
    /* Anything half-heard when the app started speaking is abandoned rather
       than resumed: the words either side of a spoken confirmation are two
       different thoughts, and stitching them into one utterance is worse than
       losing the syllable. */
    setDeaf (value) {
      const next = !!value
      if (next === deaf) return
      deaf = next
      previews.newSegment()
      earliestFrame = writeFrame
      if (next) {
        openStart = null
        lastInterim = writeFrame
      }
    },
    get deaf () { return deaf },
    setThreshold: t => vad.setThreshold(t),
    setMinSegmentMs: ms => vad.setMinSegmentMs(ms),
    setHangoverMs: ms => { hangoverMs = ms },
    setConversationHangoverMs: ms => { conversationHangoverMs = ms },
    /* The settings panel retunes a live microphone rather than reopening it:
       getUserMedia again would drop the utterance in progress. */
    setInterimMs (ms) {
      if (Number.isFinite(ms) && ms > 0) interimFrames = Math.max(1, Math.round(ms / FRAME_MS))
    },
    stop () {
      recording.setActive(false)
      collector.port.onmessage = null
      collector.disconnect()
      source.disconnect()
      stream.getTracks().forEach(t => t.stop())
      ctx.close()
    }
  }
}
