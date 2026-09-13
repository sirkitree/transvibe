// Retry unusual speaker labels and uncertain final decodes, never interim
// text or very low-confidence noise. Do not delete names or replace homophones.
export const speakerLabel = text => /^\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\s*:\s*\S/.test(String(text || ''))
export function shouldRetryTranscript (result, interim = false) {
  return !interim && !!result.text?.trim() &&
    (speakerLabel(result.text) || (Number.isFinite(result.confidence) && result.confidence >= -0.85 && result.confidence < -0.45))
}
export function preferRetry (original, retry) {
  if (!retry.text?.trim() || speakerLabel(retry.text)) return false
  if (!Number.isFinite(retry.confidence)) return false
  if (speakerLabel(original.text)) return retry.confidence >= -0.6
  return retry.confidence >= original.confidence + 0.08
}
