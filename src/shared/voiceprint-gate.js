// Whether the voice that said a name is the voice allowed to use it.
//
// The wake word decides *what* was said. This decides *who said it*, and it
// exists because the two are not the same question: someone else on a call
// says "hey Mira" and the app, hearing only words, answers them.
//
// Pure like wake.js — the score arrives already computed, from a model living
// in the main process. What is worth testing on its own is the policy: when
// the gate applies at all, and what a failure falls back to.

/* A held key is already proof of presence. Someone on a call cannot press
   right ⌥ on this Mac, so the key path is never gated — which also means the
   one route that must never false-reject, never does. */
export const BYPASS_KEY = 'command-mode'

/* No profile, no model, no score: the gate is not configured, so it is not a
   gate. Failing open is deliberate — an app that stops answering because a
   model file moved is worse than one that occasionally answers the wrong
   person, and this was never a security control to begin with. */
export const BYPASS_UNSET = 'not-enrolled'

/**
 * Should this utterance be allowed to address an agent?
 *
 * @param {object} o
 * @param {number|null} o.score cosine against the enrolled profile, or null
 *   when nothing scored it (model missing, still loading, errored)
 * @param {number} o.threshold  score at or above which the voice is yours
 * @param {boolean} o.enabled   the setting
 * @param {boolean} o.enrolled  a profile exists
 * @param {boolean} o.commandMode armed by key rather than by name
 * @returns {{pass: boolean, reason: string, score: number|null}}
 *   `reason` is for the hint line and the debug log — every decision says why,
 *   because a gate that silently drops what you said is unexplainable from
 *   the outside, and this one is tuned by watching it work.
 */
export function allowAgent ({
  score = null, threshold = 0.35, enabled = false, enrolled = false, commandMode = false
} = {}) {
  if (commandMode) return { pass: true, reason: BYPASS_KEY, score }
  if (!enabled || !enrolled) return { pass: true, reason: BYPASS_UNSET, score }
  if (!Number.isFinite(score)) return { pass: true, reason: 'not-scored', score: null }
  return score >= threshold
    ? { pass: true, reason: 'voice-matched', score }
    : { pass: false, reason: 'voice-rejected', score }
}

/* Short utterances score lower — the same voice saying the same words scores
   ~0.74 at two seconds and ~0.89 past four, measured on this machine. A bare
   wake phrase is the shortest thing anybody says, so a threshold tuned on
   sentences would reject the one utterance that matters most.

   Rather than one threshold that has to be loose enough for a one-second
   "hey Mira" — and is then loose for everything — the threshold relaxes for
   short audio only. The floor is a fraction of the configured threshold, not
   a second setting, so there is still one number to tune. */
export function thresholdFor (durationSeconds, threshold) {
  if (!Number.isFinite(durationSeconds) || durationSeconds >= 4) return threshold
  const t = Math.max(0, Math.min(1, threshold))
  // 1s → 0.80×, 2s → 0.87×, 3s → 0.93×, 4s+ → 1×
  const relax = 0.8 + 0.2 * Math.max(0, Math.min(1, (durationSeconds - 1) / 3))
  return t * relax
}

/** Average of several embeddings, re-normalised — the profile a name is
    checked against. Each vector is normalised *before* averaging so that one
    loud, long utterance does not outvote four ordinary ones. */
export function centroid (vectors) {
  const list = (Array.isArray(vectors) ? vectors : []).filter(v => v && v.length)
  if (!list.length) return null
  const dim = list[0].length
  if (list.some(v => v.length !== dim)) return null
  const sum = new Float32Array(dim)
  for (const v of list) {
    let n = 0
    for (let i = 0; i < dim; i++) n += v[i] * v[i]
    n = Math.sqrt(n) || 1
    for (let i = 0; i < dim; i++) sum[i] += v[i] / n
  }
  let n = 0
  for (let i = 0; i < dim; i++) { sum[i] /= list.length; n += sum[i] * sum[i] }
  n = Math.sqrt(n) || 1
  for (let i = 0; i < dim; i++) sum[i] /= n
  return sum
}

/** Cosine similarity. -1 to 1; in practice your own voice lands 0.5–0.95 and
    anybody else lands near zero. */
export function cosine (a, b) {
  if (!a || !b || a.length !== b.length) return null
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : null
}

/* Five is where the benchmark stops improving and it is about a minute of
   talking — few enough to sit through, enough that one odd recording cannot
   define you. One utterance roughly doubles the error rate of five. */
export const ENROLL_TARGET = 5
export const ENROLL_MIN_SECONDS = 1.5
