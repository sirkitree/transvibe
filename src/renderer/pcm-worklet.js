/**
 * Captures raw mono PCM and forwards it to the main thread in fixed frames,
 * along with that frame's RMS so the VAD does not have to re-scan the samples.
 */
class PcmCollector extends AudioWorkletProcessor {
  constructor (options) {
    super()
    const frameMs = (options.processorOptions && options.processorOptions.frameMs) || 20
    this.frameSize = Math.round((sampleRate * frameMs) / 1000)
    this.buf = new Float32Array(this.frameSize)
    this.filled = 0
  }

  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.filled++] = ch[i]
      if (this.filled === this.frameSize) {
        let sum = 0
        for (let j = 0; j < this.frameSize; j++) sum += this.buf[j] * this.buf[j]
        this.port.postMessage(
          { rms: Math.sqrt(sum / this.frameSize), pcm: this.buf.slice() }
        )
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-collector', PcmCollector)
