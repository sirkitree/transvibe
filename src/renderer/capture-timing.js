export function captureStart (onsetFrame, earliestFrame, preRollMs = 200, frameMs = 20) {
  const frames = Number.isFinite(preRollMs) ? Math.max(0, Math.round(preRollMs / frameMs)) : 0
  return Math.max(0, earliestFrame, onsetFrame - frames)
}

export function captureHangover (conversation, normal = 550, followUp = 950) {
  return conversation ? Math.max(normal, followUp) : normal
}
