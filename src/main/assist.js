import {
  buildCleanupMessage, acceptCleanup, buildCommandMessage, parseCommandReply,
  buildSpeakMessage, acceptSpoken, worthShortening
} from '../shared/assist.js'
import { buildAskMessages, acceptAnswer } from '../shared/conversation.js'

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
/* What /api/show says about one model, or nothing if it will not say.
   Capabilities are the useful part: a model that cannot think should not be
   offered a switch that silently does nothing. */
async function modelCapabilities (url, name) {
  try {
    const res = await fetch(`${url}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) return null
    const body = await res.json()
    return Array.isArray(body?.capabilities) ? body.capabilities : null
  } catch {
    return null
  }
}

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
      .filter(m => m && String(m.name ?? '').trim())
      .map(m => ({
        name: String(m.name),
        /* Everything the picker can say about a model without running it:
           roughly what it will cost in memory, and how long a cold start is
           going to be. Missing fields are left null rather than guessed —
           an unlabelled model reads as its bare name, which is what it did
           before any of this. */
        bytes: Number.isFinite(m.size) ? m.size : null,
        params: String(m?.details?.parameter_size ?? '') || null,
        quant: String(m?.details?.quantization_level ?? '') || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    /* Asked for each of them at once. It is a handful of local calls and the
       panel is already waiting on the list; a model that will not answer is
       reported as unknown rather than as incapable. */
    const capabilities = await Promise.all(
      models.map(m => modelCapabilities(url, m.name)))
    models.forEach((m, i) => { m.capabilities = capabilities[i] })

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

  /* One exchange. `message` is either a string — the three prompt-shaped jobs,
     which have no history — or a messages array for a conversation, which
     does. `at` names the model, because a chat agent may be pointed at a
     better one than the small model doing the cleanup.
   
     Returns the reply and how many tokens it took, because how long a model
     takes to answer is the number that decides which one to use and no amount
     of knowing its size will tell you. */
  async function chat (message, ms = timeoutMs, at = model, think = false) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: at,
          messages: Array.isArray(message)
            ? message
            : [{ role: 'user', content: message }],
          temperature: 0,
          stream: false,
          /* Thinking is on by default and costs ~1s of latency for a task that
             needs none — it turned a 290ms call into 1.4s in testing. Asked
             for, though, it is left alone: on qwen3:30b-a3b this parameter
             does not stop the model reasoning, it stops the reasoning being
             held apart from the answer, and the whole chain of thought lands
             in what gets said out loud. */
          ...(think ? {} : { reasoning_effort: 'none' })
        }),
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      return {
        text: String(body?.choices?.[0]?.message?.content ?? ''),
        tokens: Number(body?.usage?.completion_tokens) || 0
      }
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
        return acceptCleanup(before, (await chat(buildCleanupMessage(before))).text)
      } catch (err) {
        return { text: before, used: false, reason: err.name === 'AbortError' ? 'timed out' : err.message }
      }
    },

    /**
     * Shorten a confirmation into something worth hearing out loud.
     *
     * On a much tighter leash than the other two: the reply is spoken while
     * the microphone is deaf, so a slow answer costs the user the start of
     * their next sentence. A second and a bit, then the plain message wins.
     *
     * @param {string} message the applier's own wording
     * @returns {Promise<{text: string, used: boolean, reason?: string}>}
     *   `text` is always sayable — the model's line, or the one passed in.
     */
    async speak (message, { model: at = null } = {}) {
      const before = String(message == null ? '' : message)
      if (!before.trim() || available === false) {
        return { text: before, used: false, reason: 'skipped' }
      }
      // Four words or fewer is already a spoken reply. Asking anyway costs a
      // second and risks the model improving "not a command" into a
      // confirmation of something that did not happen.
      if (!worthShortening(before)) return { text: before, used: false, reason: 'short enough' }
      try {
        return acceptSpoken(before,
          (await chat(buildSpeakMessage(before), 1200, at || model)).text)
      } catch (err) {
        return { text: before, used: false, reason: err.name === 'AbortError' ? 'timed out' : err.message }
      }
    },

    /**
     * Answer a question, out loud.
     *
     * Nothing is parsed on this path: a chat agent was addressed, so the
     * sentence is a question and the answer is whatever comes back — checked
     * for shape, never for truth. A longer leash than the other calls, because
     * this one is the whole point of the wait rather than a tidy-up nobody
     * asked for; still bounded, because the strip cannot show "thinking"
     * forever.
     *
     * @param {string} question
     * @param {Array<{role: string, content: string}>} history earlier turns
     * @param {{model?: string, thinking?: boolean}} options the agent's own
     *   model and whether it is allowed to reason before answering
     * @returns {Promise<{text: string, ok: boolean, reason?: string}>}
     */
    async ask (question, history = [], { model: at = null, thinking = false, canEscalate = true } = {}) {
      if (!String(question || '').trim()) return { text: '', ok: false, reason: 'nothing asked' }
      if (available === false && !at) {
        return { text: '', ok: false, reason: 'the local model is not running' }
      }
      const started = Date.now()
      try {
        const reply = await chat(buildAskMessages(question, history, { canEscalate }),
          20000, at || model, thinking)
        /* How long it took and how much it said, reported alongside the
           answer. The caller keeps it: this is the only honest source for
           "which of these models is worth waiting for", and it costs nothing
           because the question was being asked anyway. */
        return {
          ...acceptAnswer(reply.text),
          ms: Date.now() - started,
          tokens: reply.tokens,
          model: at || model
        }
      } catch (err) {
        return {
          text: '',
          ok: false,
          reason: err.name === 'AbortError' ? 'took too long' : err.message
        }
      }
    },

    /**
     * Last resort for an utterance the rule parser did not recognise.
     *
     * @param {string} text
     * @param {string[]} phrases the example phrases the rule parser understands
     * @returns {Promise<string|null>} one of those phrases, or null
     */
    async command (text, phrases, { model: at = null } = {}) {
      if (!String(text || '').trim() || available === false) return null
      try {
        return parseCommandReply(
          (await chat(buildCommandMessage(text, phrases), timeoutMs, at || model)).text, phrases)
      } catch {
        return null
      }
    }
  }
}
