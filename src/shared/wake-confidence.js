const tokens = text => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []

// Only a complete, explicitly configured multiword address can use this
// fallback. It cannot admit a command, a fuzzy guess, or ungated room noise.
export function acceptShortAddress ({ text, confidence, durationMs, names = [], gated, interim, floor = -0.85 }) {
  if (!gated || interim || !Number.isFinite(confidence) || confidence < floor ||
      durationMs < 250 || durationMs > 2500) return false
  const heard = tokens(text)
  if (heard.length < 2 || heard.length > 4) return false
  return names.some(name => tokens(name).join(' ') === heard.join(' '))
}
