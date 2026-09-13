// Preview work is optional. After repeated non-speech results, poll a small
// recent window less often; final utterances always bypass this policy.
export function createInterimPolicy () {
  let rejected = 0
  let generation = 0
  return {
    newSegment () { return ++generation },
    get generation () { return generation },
    intervalMs (normal) { return Math.max(normal, rejected ? Math.min(2000, 500 * 2 ** Math.min(rejected, 2)) : 0) },
    fromFrame (start, here, frameMs = 20) { return rejected ? Math.max(start, here - Math.round(2000 / frameMs) + 1) : start },
    observe (result, token) {
      if (token !== generation || !result || result.error) return
      if (result.text?.trim() && !result.dropped) rejected = 0
      else rejected = Math.min(2, rejected + 1)
    }
  }
}
