import { acceptAnswer } from './response-format.js'
import { sourceName, answerSources } from './sources.js'
export { sourceName, answerSources } from './sources.js'
const plain = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

export function isAcknowledgment (text) {
  return /^(?:(?:ok|okay|yes|yeah|great|thanks|thank you|got it|understood|thats great|sounds good|all right|alright)(?:\s+|$))+$/.test(plain(text))
}

export function needsVerification (question, history = []) {
  const q = plain(question)
  if (/\b(?:verify|fact check|look it up|look that up|find (?:the|an) (?:article|source)|check (?:the|your) sources|are you (?:sure|certain)|provide (?:a |the )?(?:source|citation))\b/.test(q)) return true
  return /\b(?:actual (?:answer|response)|what did .+ find|did you find|verified yet)\b/.test(q) &&
    history.some(t => t.role === 'user' && needsVerification(t.content))
}

export const UNVERIFIED = "I don't have a verified result with a source yet."
export const LOCAL_CAPABILITIES = 'You have no browser, search tools, or ability to perform actions. Never claim you searched, looked something up, found an article, or verified a fact yourself. A promise in conversation history is not a completed action. You may report sourced results received from another agent in the conversation, crediting that agent. Distinguish a received source from independently checking its truth. When no result is recorded, say so. Do not invent citations.'

export function claimsLocalSearch (text) {
  return /\b(?:after (?:searching|browsing|looking (?:it |that )?up)|i(?:ve| have)? (?:searched|browsed|looked (?:it |that )?up|verified|confirmed)|i found (?:that|an? (?:article|source)|the (?:article|source)))\b/i.test(String(text || '').replace(/[’']/g, ''))
}

// A URL is necessary evidence for a verification reply, not proof by itself.
// Incomplete or unsourced replies must not replace the unverified claim.
export function verificationReply (answer) {
  if (!answer?.ok || !/https?:\/\/[^\s]+/i.test(answer.text || '') ||
      /\b(?:i(?:'|’)ll|i will|let me) (?:look|search|check|verify|find)\b/i.test(answer.text || '')) {
    const text = answer?.reason === 'took too long'
      ? 'The lookup timed out before I got a verified result. I do not have a source confirming that answer.'
      : UNVERIFIED
    return { text, spoken: text, ok: true, verification: 'unconfirmed', reason: answer?.reason || 'no source supplied' }
  }
  return { ...answer, verification: 'source supplied', sources: answerSources(answer.text) }
}


// These are app facts, not a model's recollection or hypothetical integrations.
export function conversationFact (question, history = []) {
  const q = plain(question)
  const reply = text => acceptAnswer(text)
  if (/\b(?:can|could|do|are) you\b/.test(q) && /\b(?:calendar|appointments?)\b/.test(q)) {
    return reply('I do not have calendar access in this app, so I cannot see your schedule or change appointments.')
  }
  const turns = Array.isArray(history) ? history : []
  const result = [...turns].reverse().find(t => t.role === 'assistant' && t.verification)
  if (/\b(?:which source|what source|source supports|where did .+ (?:find|read))\b/.test(q)) {
    const sources = result?.sources || []
    if (!sources.length) return reply('I do not have a recorded source for that answer.')
    return { ...reply(`The source returned was ${sources.map(s => s.label || sourceName(s.url)).join(' and ')}.`),
      text: sources.map(s => `${s.label || sourceName(s.url)}: ${s.url}`).join('\n') }
  }
  if (/\b(?:receive .*(?:verified|result)|still waiting|verified yet|lookup status|verification status)\b/.test(q)) {
    if (!result) return reply('I have no completed lookup recorded in this conversation.')
    if (result.verification !== 'source supplied') return reply('The last lookup did not return a sourced result.')
    return reply(`${(result.name || 'The other agent').replace(/^hey /i, '')} returned a sourced answer; the lookup is complete.`)
  }
  const named = q.match(/\b(codex|claude|mira|atlas)(?:s)? (?:actual )?(?:answer|response)\b/)
  if (named) {
    const turn = [...turns].reverse().find(t => t.role === 'assistant' && plain(t.name).replace(/^hey /, '') === named[1])
    const cleaned = turn ? acceptAnswer(turn.content, { speakerNames: turns.filter(t => t?.name).map(t => t.name) }) : null
    return reply(cleaned?.ok ? `${turn.name.replace(/^hey /i, '')} said: ${cleaned.text}` : `${named[1][0].toUpperCase() + named[1].slice(1)} has not answered in this conversation.`)
  }
  return null
}
