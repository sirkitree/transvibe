// Replacement intent is explicit and leading. Ordinary corrections still
// extend the current thought, as do quoted mentions of cancellation.
export function replacementQuestion (text) {
  const source = String(text || '').trim()
  const match = source.match(/^(?:(?:actually|okay|ok)[,.]?\s+)?(?:forget (?:that|the) (?:lookup|request|question|search)|forget that|cancel (?:that|the) (?:lookup|request|question|search)|never mind|scratch that)\b[,.!;:\s]*(?:instead[,:]?\s*)?/i)
  return match ? source.slice(match[0].length).trim() : null
}

// Keep a thought open until its reply starts. Speech resuming during inference
// invalidates that answer, and the next segment extends the same user turn.
export function turnDelay (text) {
  const q = String(text || '').trim()
  if (/\?$/.test(q) || /^(?:what|why|how|when|where|who|which|can|could|do|does|is|are|tell|find|verify|give|repeat)\b/i.test(q)) return 250
  return 1400
}

export function createTurnBuffer ({ dispatch, cancel, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let turn = null
  let timer = null
  let speaking = false
  let running = false
  const stopTimer = () => { clearTimer(timer); timer = null }
  const schedule = () => {
    stopTimer()
    if (!turn || speaking || running) return
    timer = setTimer(() => {
      timer = null
      running = true
      dispatch(turn.agent, turn.question)
    }, turnDelay(turn.question))
  }
  return {
    submit (agent, question) {
      stopTimer()
      if (running) { cancel(turn); running = false }
      const replacement = replacementQuestion(question)
      if (replacement !== null) {
        turn = replacement ? { agent, question: replacement } : null
        schedule()
        return
      }
      turn = turn && turn.agent.name === agent.name
        ? { agent, question: `${turn.question} ${question}` } : { agent, question }
      schedule()
    },
    speechStart () {
      speaking = true
      stopTimer()
      if (running) { cancel(turn); running = false }
    },
    speechEnd (discarded = false) {
      speaking = false
      // A real segment is still being transcribed. Wait for submit(), not a
      // timer that could let the old reply start before its transcript lands.
      if (discarded) schedule()
    },
    complete () { stopTimer(); turn = null; running = false },
    abort () {
      stopTimer()
      if (running) cancel(turn)
      turn = null; running = false; speaking = false
    },
    reset () { stopTimer(); turn = null; running = false; speaking = false },
    get pending () { return !!turn }
  }
}
