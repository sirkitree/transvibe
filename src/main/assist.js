import { buildCleanupMessage, acceptCleanup, buildCommandMessage, parseCommandReply } from '../shared/assist.js'

/**
 * The local assist model, served by Ollama.
 *
 * Still no cloud: Ollama runs on this machine and the request never leaves
 * 127.0.0.1. It is entirely optional — if Ollama is not running or the model
 * is not pulled, every call here returns "no answer" and the app behaves
 * exactly as it did before.
 *
 * Text in, text out. Audio deliberately does not come here: Gemma 4 can
 * transcribe directly, but measured against whisper small.en on the same
 * clips it was slower and less accurate ("Vinchi" for "Vinci", words dropped
 * off the end of a long sentence). Whisper keeps the audio; this model gets
 * the text, which is the job it is actually better at.
 */
/**
 * What Ollama has pulled on this machine, newest-looking first.
 *
 * Standalone rather than a method on an assist instance: the settings panel
 * needs the list before a model has been chosen, and creating an assist to ask
 * would mean creating one for a model that may not exist.
 *
 * A machine with no Ollama is the ordinary case, not an error — the whole
 * assist feature is optional — so an unreachable server comes back as an empty
 * list with a reason, never a throw.
 *
 * @returns {Promise<{models: string[], reachable: boolean}>}
 */
export async function listOllamaModels (url = 'http://127.0.0.1:11434') {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { models: [], reachable: false }
    const body = await res.json()
    const models = (body.models || [])
      .map(m => String(m?.name ?? ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    return { models, reachable: true }
  } catch {
    return { models: [], reachable: false }
  }
}

export function createAssist ({
  url = 'http://127.0.0.1:11434',
  model = 'gemma4:e2b',
  timeoutMs = 4000
} = {}) {
  let available = null      // null = not yet checked

  async function chat (message, ms = timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message }],
          temperature: 0,
          stream: false,
          // Thinking is on by default and costs ~1s of latency for a task that
          // needs none — it turned a 290ms call into 1.4s in testing.
          reasoning_effort: 'none'
        }),
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      return String(body?.choices?.[0]?.message?.content ?? '')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get model () { return model },

    /** @returns {Promise<boolean>} whether the model is there to be used */
    async check () {
      try {
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) })
        const body = await res.json()
        const names = (body.models || []).map(m => m.name)
        available = names.includes(model) || names.some(n => n.split(':')[0] === model.split(':')[0])
      } catch {
        available = false
      }
      return available
    },

    get available () { return available },

    /**
     * Tidy one dictated utterance.
     *
     * Returns the original untouched on any failure — a model that is down,
     * slow, or answering the question instead of rewriting it must never cost
     * the user their words.
     *
     * @param {string} text
     * @returns {Promise<{text: string, used: boolean, reason?: string}>}
     */
    async cleanup (text) {
      const before = String(text == null ? '' : text)
      if (!before.trim() || available === false) return { text: before, used: false, reason: 'skipped' }
      try {
        return acceptCleanup(before, await chat(buildCleanupMessage(before)))
      } catch (err) {
        return { text: before, used: false, reason: err.name === 'AbortError' ? 'timed out' : err.message }
      }
    },

    /**
     * Last resort for an utterance the rule parser did not recognise.
     *
     * @param {string} text
     * @param {string[]} phrases the example phrases the rule parser understands
     * @returns {Promise<string|null>} one of those phrases, or null
     */
    async command (text, phrases) {
      if (!String(text || '').trim() || available === false) return null
      try {
        return parseCommandReply(await chat(buildCommandMessage(text, phrases)), phrases)
      } catch {
        return null
      }
    }
  }
}
