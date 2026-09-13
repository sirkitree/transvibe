// An accepted request is not proof: report the actual microphone setting.
export async function configureVoiceIsolation (track, requested) {
  const supported = track.getCapabilities?.().voiceIsolation?.includes(true) === true
  let error = null
  if (supported) {
    try { await track.applyConstraints({ voiceIsolation: { exact: !!requested } }) } catch (err) { error = err.message }
  }
  return { requested: !!requested, supported, active: track.getSettings().voiceIsolation === true, ...(error ? { error } : {}) }
}
