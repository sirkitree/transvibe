/**
 * What a coding agent is asking for, and what to send it back.
 *
 * A session running in somebody's terminal reaches this app through a hook —
 * see docs/plans/agent-plugin.md. The hook is twenty lines of sh that cannot
 * read what it carries, which is deliberate: the whole protocol lives here
 * instead, where it is one file and can be tested without a terminal, an
 * agent, or a microphone in the room.
 *
 * Three jobs, in the order they happen:
 *
 *   readRequest   a payload off the filesystem, checked and reduced to the
 *                 handful of fields anything downstream is allowed to see
 *   whatToSay     whether this is worth interrupting a room for, and if so
 *                 what to show and what to say
 *   replyFor      what the user said, turned into the exit code and streams
 *                 the hook prints back
 *
 * Pure. No fs, no Electron, no clock. The one thing it imports is the app's
 * own idea of how long a spoken line may be, because an agent's message is
 * subject to exactly the same limit as a model's answer and two answers to
 * that question would be one too many.
 */

import { forSpeech } from './response-format.js'

/* Payloads are small — the largest recorded is under two kilobytes — and the
   one field that could be enormous is `tool_input`, which never gets read.
   The cap is here so that a file that has gone wrong is refused rather than
   parsed, and it is generous enough that a real one cannot reach it. */
export const MAX_BYTES = 256 * 1024

/** The events the plugin registers. Anything else is a payload from a version
    of the plugin this build does not know about, and is ignored rather than
    guessed at. */
export const EVENTS = ['SessionStart', 'Stop', 'Notification', 'PermissionRequest']

/* Long enough for any message worth hearing; short enough that a payload
   cannot make the strip or the speaker its problem. `forSpeech` cuts it
   properly afterwards — this is only an outer bound. */
const MAX_MESSAGE = 4000
const MAX_TARGET = 200
const MAX_SAID = 2000

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/* Anything that would move a cursor, ring a bell, or start an escape sequence
   in the terminal this is printed back into. Tabs and newlines go too: what
   comes through here is one spoken sentence, not a document. */
const clean = (value, max) =>
  squash(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, max)

/**
 * A payload off disk, or a reason it is not one.
 *
 * Everything the rest of the app sees of a request is built here, and it is
 * deliberately less than arrived. `tool_input` in particular is dropped: for
 * a Write it holds the entire contents of the file, and a module that cannot
 * pass that on is a module that cannot say it out loud by accident.
 *
 * @param {string} text the file as written by the hook
 * @returns {{ok: true, request: object}|{ok: false, reason: string}}
 */
export function readRequest (text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return { ok: false, reason: 'empty' }
  // TextEncoder rather than Buffer: shared/ is imported by the renderer too,
  // and there is no Buffer there.
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return { ok: false, reason: 'too big' }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not json' }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'not an object' }
  }

  const event = squash(payload.hook_event_name)
  if (!EVENTS.includes(event)) return { ok: false, reason: 'unknown event' }

  return {
    ok: true,
    request: {
      event,
      sessionId: squash(payload.session_id),
      /* The join between a permission request and the notification that
         doubles it six seconds later. Both carry it; so does Stop. */
      promptId: squash(payload.prompt_id),
      cwd: squash(payload.cwd),
      model: squash(payload.model) || null,
      message: clean(payload.last_assistant_message || payload.message, MAX_MESSAGE),
      notification: squash(payload.notification_type) || null,
      tool: squash(payload.tool_name) || null,
      target: toolTarget(payload.tool_input),
      /* True when this Stop follows a turn a Stop hook continued — ours,
         which means it is the reply to what somebody said out loud. Kept
         because it is worth recording, not because it silences anything. */
      stopHookActive: payload.stop_hook_active === true
    }
  }
}

/* The one part of `tool_input` that can be said out loud. A path or a command
   describes the request; the content of a file is the request's cargo and is
   nobody's business here — often a hundred lines, occasionally a secret, and
   never the thing you are being asked about. An allowlist rather than a
   denylist, because a new tool with a new field must default to silence. */
const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'url', 'pattern', 'query']

function toolTarget (input) {
  if (!input || typeof input !== 'object') return null
  for (const key of TARGET_KEYS) {
    const value = clean(input[key], MAX_TARGET)
    if (value) return value
  }
  return null
}

/* What the tool does, in a word somebody would use out loud. Unknown tools
   are named rather than described: "wants to use Firecrawl" is honest, and
   inventing a verb for a tool this build has never seen is not. */
const VERBS = {
  Write: 'write', Edit: 'edit', NotebookEdit: 'edit', Read: 'read',
  Bash: 'run', Glob: 'search for', Grep: 'search for',
  WebFetch: 'fetch', WebSearch: 'search the web for', Task: 'start an agent',
  Agent: 'start an agent', Artifact: 'publish'
}

/* Notifications this app has an opinion about. The rest — an auth success, a
   quota notice, an elicitation dialog — are things the terminal is already
   showing the person sitting at it, and saying them into a room is noise.
   `agent_completed` is left out for a different reason: Stop already covers a
   turn that finished, and both would say it twice. */
const WORTH_SAYING = new Set(['idle_prompt', 'permission_prompt', 'agent_needs_input'])

/** A file path said out loud is its name. The directory is on screen for
    anyone who wants it, and eleven spoken path segments locate nothing. */
const spokenTarget = target =>
  target && target.startsWith('/') ? target.split('/').filter(Boolean).pop() : target

/**
 * Whether this is worth interrupting a room for, and what it sounds like.
 *
 * Null means say nothing — which is most of what arrives. A session starting
 * is a fact to record, not an announcement; a notification about a quota is
 * already on the screen of the person it concerns; and a permission prompt
 * that this app has already put to the room must not be put to it twice,
 * which is what `asked` is for.
 *
 * @param {object} request from `readRequest`
 * @param {{asked?: Set<string>}} [options] prompt ids already spoken
 * @returns {{kind: string, show: string, spoken: string, answerable: boolean}|null}
 */
export function whatToSay (request, { asked = new Set() } = {}) {
  if (!request) return null

  if (request.event === 'Stop') {
    /* `stop_hook_active` is not a reason to stay quiet, which is what this
       first assumed and what a day of using it disproved: it marks the reply
       to the last thing said out loud, and refusing to read that out ends
       every conversation after exactly one exchange. The flag guards against
       a hook that answers *itself* into a loop. This one cannot — every turn
       of it costs a person a sentence, and silence is what ends it. */
    if (!request.message) return null
    const { text, spoken } = forSpeech(request.message)
    if (!spoken) return null
    return { kind: 'finished', show: text, spoken, answerable: true }
  }

  if (request.event === 'PermissionRequest') {
    const verb = VERBS[request.tool] || `use ${request.tool || 'a tool'}`
    const target = spokenTarget(request.target)
    const line = `wants to ${verb}${target ? ` ${target}` : ''}`
    return {
      kind: 'permission',
      show: `wants to ${verb}${request.target ? ` ${request.target}` : ''}`,
      spoken: line,
      answerable: true
    }
  }

  if (request.event === 'Notification') {
    if (!WORTH_SAYING.has(request.notification)) return null
    /* The prompt this app is already holding, announced a second time by a
       hook that cannot answer it. One question per question. */
    if (request.notification === 'permission_prompt' && asked.has(request.promptId)) return null
    const { text, spoken } = forSpeech(request.message)
    if (!spoken) return null
    return { kind: 'needs you', show: text, spoken, answerable: false }
  }

  return null   // SessionStart: registered, never spoken
}

const plain = value =>
  String(value ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim()

/* Whole utterances, not words inside them. "Do it" is consent and "do it
   later" is not, and a rule that went looking for "do it" inside a sentence
   could not tell them apart — which is the difference between running a
   command and not running it. Anything this does not recognise is neither,
   and neither is a real answer: the terminal asks in the ordinary way. */
const ALLOW = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|fine|alright|all right|of course|please)\s+)*(?:yes|yeah|yep|yup|sure|ok|okay|fine|alright|all right|go ahead|go for it|do it|allow (?:it|that)?|approve (?:it|that)?|permit (?:it|that)?|accept (?:it|that)?|let it|thats fine|sounds good)(?:\s+(?:please|thanks|thank you|go ahead|do it))*$/
const DENY = /^(?:(?:no|nope|nah)\s+)*(?:no|nope|nah|dont|do not|dont do (?:it|that)|deny (?:it|that)?|refuse (?:it|that)?|reject (?:it|that)?|stop|cancel|skip (?:it|that)?|not now|no thanks|leave it|dont bother)(?:\s+(?:please|thanks|thank you))*$/

/**
 * Yes, no, or neither.
 *
 * @param {string} said what was heard
 * @returns {'allow'|'deny'|null}
 */
export function allowDecision (said) {
  const words = plain(said)
  if (!words) return null
  if (ALLOW.test(words)) return 'allow'
  if (DENY.test(words)) return 'deny'
  return null
}

/** The name a session goes by: where it is running, since that is what tells
    two of them apart on one machine. */
export function sessionName (request) {
  const dir = String(request?.cwd || '').split('/').filter(Boolean).pop()
  return dir ? `Claude in ${dir}` : 'Claude'
}

/* Three files and a number, which is the whole of what the hook prints. The
   app decides them rather than the hook, so changing what an event does needs
   no reinstall and the script stays something you can read in one sitting. */
const nothing = { exit: 0, out: '', err: '' }

/**
 * What the hook should print, and what it should exit with.
 *
 * The exit codes are the contract, and they are not symmetric. Continuing a
 * finished turn is `exit 2` with the words on stderr — the documented way to
 * stop Claude Code stopping, and the reason a spoken sentence can become the
 * next prompt. A permission decision is `exit 0` with JSON on stdout, because
 * exit 2 is explicitly ignored on that event. Everything else is exit 0 and
 * silence.
 *
 * Saying nothing is a first-class outcome everywhere. Not answering an agent
 * lets it finish; not answering a permission prompt abstains, which hands the
 * question back to the terminal the person is sitting at. Neither is a
 * failure, and neither may ever become one — a hook that errors on this path
 * would break a session over a microphone that heard nothing.
 *
 * @param {object} request
 * @param {string|null} said what was heard, or null for declined or timed out
 * @returns {{exit: number, out: string, err: string}}
 */
export function replyFor (request, said) {
  if (!request) return nothing
  const words = clean(said, MAX_SAID)

  if (request.event === 'Stop') {
    /* Exit 2 with an empty reason would continue the conversation with
       nothing to continue it about, so silence exits 0 and lets it stop. */
    return words ? { exit: 2, out: '', err: words } : nothing
  }

  if (request.event === 'PermissionRequest') {
    const decision = allowDecision(words) || 'abstain'
    return {
      exit: 0,
      out: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision,
          decisionReason: decision === 'abstain'
            ? 'No answer out loud; leaving it to the terminal.'
            : `Answered out loud through transvibe: "${words}"`
        }
      }),
      err: ''
    }
  }

  return nothing
}
