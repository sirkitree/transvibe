import { createTurnBuffer } from './turn-buffer.js'
import { startCapture } from './audio.js'
import { createVisualizer } from './visualizer.js'
import { createSayingViz } from './saying-viz.js'
import {
  parseCommand, applyCommand, spokenFor, splitChain, looksLikeSwitch, UNIVERSAL,
  COMMANDS
} from './commands.js'
import { matchAgent } from './wake.js'
import { allowAgent, thresholdFor } from '../shared/voiceprint-gate.js'
import {
  startEnrolment, readingHeard, currentLine, progress, enrolmentSummary, LINE_COUNT
} from '../shared/enroll-script.js'
import { parseSettingCommand, applySettingCommand, settingPhrases } from './settings-voice.js'
import { FIELDS, resolveChoice } from './settings-schema.js'
import {
  speechFor, commandAgent, defaultModel, addAgent, updateAgent, removeAgent,
  nextHue, isRemote, KINDS, PROVIDERS, DEFAULT_MODELS
} from '../shared/agents.js'
import { attribute, escalationChain } from '../shared/escalate.js'
import {
  addTerms, removeTerm, addCorrection, removeCorrection, sortedEntries, splitWords
} from './glossary-edit.js'
import { applyCorrections } from '../shared/glossary.js'
import { describeModel, canThink } from '../shared/assist.js'
import { createPresence } from './presence.js'
import { isAcknowledgment } from '../shared/reply-policy.js'
import { createConversationWindow } from './conversation-window.js'
import { createWaiting } from './waiting.js'
import { clampPlacement, heightFor, isReachable, MARGIN } from './placement.js'
import { createSettingsPanel } from './settings-panel.js'
import { createVizPreview } from './viz-preview.js'

const $ = id => document.getElementById(id)
// Breathing room under the last thing on the strip, so nothing sits flush
// against the window edge.
const BOTTOM_MARGIN = 18
const transcriptEl = $('transcript')
const conversationEl = $('conversation')
const convoIndicatorEl = $('convo-indicator')
const convoIndicatorLabelEl = $('convo-indicator-label')
const hintEl = $('hint')

const state = {
  finals: [],
  live: '',          // interim text for the utterance still being spoken
  liveSeq: 0,        // guards against a slow interim landing after a newer one
  interimBusy: false,
  commandMode: false,
  voiceprintStatus: null,  // { enrolled, available, count } — see main/voiceprint.js
  enrolling: null,         // { state, clips } while reading the lines aloud
  undoStack: [],
  pending: 0,
  listening: true,
  settings: null,
  /* The named desktop Spaces, from the marker folder. Held here rather than
     asked for per utterance: the parser needs them to tell "switch to SDSU"
     from a sentence about switching, and that decision happens on every
     command. Empty until the main process answers, and empty for good if no
     folder is set — in which case those words stay dictation. */
  spaces: [],
  capture: null,
  viz: null,
  sayingViz: null,   // the app's own voice, drawn while it is talking
  /* Who is being addressed. Set the moment a name is heard and held while the
     app answers, because everything about the answer — which parser reads it,
     which voice says it, what colour the ribbon is — belongs to whoever was
     asked, not to the app in general. */
  agent: null,
  /* The chat agent whose thread is open, as distinct from `agent`, which is
     whoever the *current* utterance is for. They part ways the moment you say
     "hey Trinity, erase all" in the middle of talking to Mira: Trinity runs
     that one command and speaks its confirmation, and Mira's thread is still
     open for the next thing you say. A name opens a thread; a different name
     borrows one sentence from it. */
  talkingTo: null,
  /* Every turn of the open conversation, oldest first — what you asked and
     what came back, each tagged with the agent that answered so it can be
     coloured and re-sent. Kept apart from `finals` on purpose: the transcript
     is yours, and ⌃⌥↩ sends it — a question or an answer landing in it would
     paste the model's words into your document. This *is* what gets fed back
     to the model on the next turn, trimmed by `trimHistory` at the point it's
     sent rather than here, so the bubbles on screen always show the whole
     thread even once the model itself has started forgetting the start of it. */
  history: [],
  // The follow-up countdown is suspended until speech and its echo tail end.
  conversationWindow: createConversationWindow(),
  asking: false,
  askSeq: 0,         // guards against a slow answer landing after a newer question
  pendingPlacement: null,   // where a panel is being dragged to, until released
  // Which glossary fix is loaded into the form for editing, by what it hears.
  editingRule: null,
  // What settings.json would hold if it had never been written to. Read at
  // startup; the settings panel marks and reverts against it.
  defaults: null,
  // The word fixer's checkboxes, remembered across opens: whoever turns
  // 'remember' off is usually making a run of one-off fixes, not one.
  fixRemember: true,
  fixListen: true,
  awake: false,
  presence: null,
  /* The clock on a question that has gone off the machine. Null until the
     first one: a roster that never escalates never builds it, and everything
     that reads it checks. Its `holdsStrip` is the reason it is on `state` at
     all — `syncHold` has to be able to ask about a call it did not start. */
  waiting: null,
  // How many spoken replies are in flight. A count rather than a flag: two
  // commands in quick succession must not have the first one's reply un-deafen
  // the microphone while the second is still talking.
  deaf: 0,
  // The open utterance starts with the wake phrase: the strip goes amber
  // while you are still speaking, so you can see it landed before you commit
  // to the rest of the sentence.
  liveWake: false
}

let hintTimer = null
let status = ''          // the last real message, restored after a hover

/* The status line is normally invisible. Showing it for a moment when it
   changes is the compromise: you see 'sent to Safari' or an error, and then
   the strip goes back to being nothing but a ribbon. */
function hint (text) {
  status = text
  hintEl.textContent = text
  hintEl.classList.add('flash')
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => hintEl.classList.remove('flash'), 2600)
}

/* Hovering a button borrows the status line to describe it. There is already a
   line of text under the buttons saying what the app is doing; a second
   floating tooltip on a transparent overlay would be one thing too many, so
   the description takes that line over and hands it straight back. */
function describe (text) {
  hintEl.textContent = text ?? status
  hintEl.classList.toggle('describe', text != null)
}

function wireButtonHints () {
  for (const btn of document.querySelectorAll('.btn')) {
    btn.addEventListener('mouseenter', () => describe(hintFor(btn)))
    btn.addEventListener('mouseleave', () => describe(null))
    // A click can change what the button now means — pause becomes resume.
    // Deferred by a tick so it reads the state the click produced, not the
    // one it started from.
    btn.addEventListener('click', () => setTimeout(() => describe(hintFor(btn)), 0))
  }
}

function hintFor (btn) {
  if (btn.id === 'mute') return state.listening ? 'Pause listening' : 'Resume listening'
  return btn.dataset.hint || ''
}

/* Each final is rendered word by word so a single word can be clicked and
   corrected. The gaps between words are kept verbatim, so the transcript still
   copies out exactly as it read. */
function finalNode (text) {
  const span = document.createElement('span')
  span.className = 'final'
  for (const part of splitWords(text + ' ')) {
    if (!part.word) { span.append(part.text); continue }
    const word = document.createElement('span')
    word.className = 'w'
    word.textContent = part.text
    span.append(word)
  }
  return span
}

/* One turn of a conversation, as a chat bubble: yours on one side, the
   agent's on the other, tinted with that agent's own hue so which one
   answered is visible without reading the words. */
function bubbleNode (turn) {
  const bubble = document.createElement('div')
  bubble.className = `bubble ${turn.role}`
  if (turn.role === 'assistant') {
    /* Named as well as coloured: two chat agents can share a thread, and a
       hue alone is not a name you can read back. */
    if (turn.name) {
      const who = document.createElement('div')
      who.className = 'who'
      who.textContent = turn.name
      bubble.append(who)
    }
    if (Number.isFinite(turn.hue)) {
      bubble.style.color = `hsl(${Math.round(turn.hue * 360)} 80% 76%)`
    }
  }
  bubble.append(document.createTextNode(turn.content))
  return bubble
}

/* Whether there is a thread on screen. Turns stay in `state.history` until
   the thread itself is cleared (idle timeout, Esc, "clear"), so this covers
   the "thinking…" gap after a question too — the question is already a
   bubble by then. */
function conversing () {
  return state.history.length > 0 || state.asking
}

/* The transcript and the conversation are two different things and both can
   be on screen: dictate a sentence, ask Mira about it, and the sentence is
   still what ⌃⌥↩ sends, so it must stay visible above the bubbles rather
   than be hidden behind them. Only the live, in-flight words have to pick a
   side, and they go to whichever the utterance is for. */
/* The name the enrolment lines should use. The first agent on the roster is
   the one somebody is most likely to say, and a line naming an agent that does
   not exist would teach the wrong phrase. */
function firstAgentName () {
  const roster = state.settings?.agents || []
  return roster[0]?.name || ''
}

/**
 * Teach it your voice: five lines, read aloud, measured, saved.
 *
 * Driven entirely by the microphone that is already running — `onSegment`
 * hands readings here instead of to the recogniser while this is live, so
 * there is no second capture path to keep in step with the first.
 */
async function enrolVoice () {
  if (state.enrolling) return
  if (!state.voiceprintStatus?.modelReady) {
    hint('fetching the speaker model…')
    const got = await window.transvibe.voiceprintDownload()
    if (!got.ok) return hint(`could not fetch the speaker model — ${got.error}`)
    state.voiceprintStatus = await window.transvibe.voiceprintStatus()
  }
  togglePanel('settings', false)
  state.enrolling = { state: startEnrolment(), clips: [] }
  hint('read each line out loud — esc to stop')
  render()
}

function stopEnrolling (message) {
  state.enrolling = null
  if (message) hint(message)
  render()
}

/** One reading has arrived from the microphone. */
async function enrolSegment (samples, text) {
  const enrol = state.enrolling
  if (!enrol) return
  const seconds = samples.length / 16000
  const verdict = readingHeard(enrol.state, seconds, text)
  if (!verdict.accepted) return void (hint(verdict.message), render())

  enrol.clips.push(samples)
  enrol.state = verdict.state
  if (!verdict.done) { hint(verdict.message); return void render() }

  hint(verdict.message)
  const result = await window.transvibe.voiceprintEnroll(enrol.clips)
  /* Scored against the profile they just made — the readings agreeing with
     each other is the one thing that can be checked without asking for more
     audio, and readings that do not agree are how a profile ends up averaging
     two people together. */
  const scores = result.ok
    ? (await window.transvibe.voiceprintProbe(enrol.clips)).map(r => r.score)
    : []
  state.voiceprintStatus = await window.transvibe.voiceprintStatus()
  state.settings = await window.transvibe.getSettings()
  stopEnrolling(enrolmentSummary({ ...result, scores, threshold: state.settings.voiceprintThreshold }))
}

function render () {
  recordDisplay()
  const chat = conversing()
  // Words still being spoken belong to the thread when they are a follow-up
  // or the question being asked; otherwise they are dictation on the way in.
  const liveToChat = chat && !state.liveWake && (state.asking || inConversation())
  const inflight = state.live || state.pending > 0

  /* Reading the lines takes the strip over completely. Everything else here
     is about words coming *in*; this is the one moment the app has something
     for you to say, and burying it in the hint line under a live transcript
     would be asking somebody to read aloud from a status bar. */
  if (state.enrolling) {
    const line = currentLine(state.enrolling.state, firstAgentName())
    const box = document.createElement('div')
    box.className = 'enrol'
    const count = progress(state.enrolling.state)
    box.append(Object.assign(document.createElement('div'),
      { className: 'enrol-step', textContent: `Read this aloud — ${count.done + 1} of ${count.total}` }))
    box.append(Object.assign(document.createElement('div'),
      { className: 'enrol-line', textContent: line || '' }))
    transcriptEl.replaceChildren(box)
    transcriptEl.hidden = false
    conversationEl.hidden = true
    syncHeight()
    return
  }

  transcriptEl.replaceChildren(...state.finals.map(finalNode))
  if (inflight && !liveToChat) {
    const live = document.createElement('span')
    live.className = 'live'
    live.textContent = state.live || '…'
    transcriptEl.append(live)
  }
  transcriptEl.hidden = transcriptEl.childElementCount === 0
  transcriptEl.scrollTop = transcriptEl.scrollHeight

  conversationEl.hidden = !chat
  if (chat) {
    conversationEl.replaceChildren(...state.history.map(bubbleNode))
    if (state.asking) {
      /* A local answer lands before you have finished looking at the bubble,
         so '…' is the whole truth about it. A frontier CLI takes between two
         and fourteen seconds and prints nothing until it is done, so the same
         bubble carries the name of whoever was asked and a second count that
         moves — the only honest difference between "working" and "hung". */
      const wait = state.waiting && state.waiting.waiting ? state.waiting : null
      const who = wait || (state.agent && state.agent.kind === 'chat' ? state.agent : null)
      conversationEl.append(bubbleNode({
        role: 'assistant',
        content: wait ? wait.label(Date.now()) : '…',
        name: who && who.name,
        hue: who && who.hue
      }))
    }
    if (inflight && liveToChat) {
      conversationEl.append(bubbleNode({ role: 'user', content: state.live || '…' }))
    }
    // Newest turn is the one worth seeing; the thread scrolls up under it.
    conversationEl.scrollTop = conversationEl.scrollHeight
  }

  // The scrim behind the text only exists while there is text, so the strip is
  // genuinely empty — not a faint rectangle — when nothing has been said.
  document.body.classList.toggle('has-text',
    !transcriptEl.hidden || (chat && conversationEl.childElementCount > 0))
  document.body.classList.toggle('command-mode', state.commandMode || state.liveWake)
  renderConvoIndicator()
  syncHeight()
}

function fullText () {
  return state.finals.join(' ').replace(/[^\S\n]+/g, ' ').trim()
}

function setText (text) {
  state.finals = text ? [text] : []
}

/* A conversation is not transcript. It is shown, it is spoken, and it goes
   away with everything else — but `fullText()` never sees it, so what you
   send with ⌃⌥↩ is only ever what you dictated, never a question or an
   answer. Ending it here means the next turn starts a new thread rather than
   picking the old one back up half an hour later. */
function clearConversation () {
  turnBuffer.reset()
  if (state.asking) window.transvibe.cancelEscalation()
  state.askSeq++
  debugEvent('conversation-clear')
  state.asking = false
  state.history = []
  state.talkingTo = null
  state.conversationWindow.clear()
}

/** The thread as text, both sides, for copying out. */
function conversationText () {
  return state.history
    .map(t => `${t.role === 'user' ? 'You' : (t.name || 'Agent')}: ${t.content}`)
    .join('\n')
}

/** The last thing a chat agent said, or ''. */
function lastAnswer () {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'assistant') return state.history[i].content
  }
  return ''
}

function setCommandMode (active) {
  state.commandMode = active
  if (!active) state.live = ''
  render()
}

/* What the assist model is allowed to answer with. The settings half is
   generated from the schema, so "make it stop talking to me" can land on
   "turn off spoken replies" without a rule for that phrasing, and a wrong
   answer still cannot name a setting the app does not have. */
const commandPhrases = () => [
  ...COMMANDS.flatMap(c => c.examples),
  ...settingPhrases(FIELDS),
  // Space names come from this machine, not from the contract, so they are
  // added here rather than living in COMMANDS' examples.
  ...state.spaces.map(s => `switch to ${s.name}`)
]

/**
 * Hand an utterance to whichever agent was named.
 *
 * The name is the routing decision, which is why there is no guessing to do
 * here: Mira runs commands because Mira is a commands agent, not because the
 * sentence looked like one. What a name means is a thing you set up once, in
 * the panel, rather than something the app infers every time you speak.
 *
 * @param {object} agent
 * @param {string} utterance what was said after the name
 * @param {{keep?: function}} options `keep` puts the words back as dictation
 */
async function addressAgent (agent, utterance, { keep = null } = {}) {
  if (!agent || agent.kind === 'commands') {
    turnBuffer.abort()
    return runCommand(utterance, { keep })
  }

  if (agent.kind === 'chat') {
    /* A handful of commands work whoever you are addressing — you have to be
       able to interrupt it, and switching names to close a panel would be
       absurd. Everything else said to a chat agent is a question, including
       the sentences that happen to look like commands. */
    const cmd = parseCommand(utterance, parseOptions())
    if (cmd && UNIVERSAL.has(cmd.action)) return runCommand(utterance)
    return converse(agent, utterance)
  }

  /* Reserved, and refused rather than quietly ignored: a name that is set up
     to hand the sentence somewhere else should say so until it can. */
  if (agent.kind === 'external') {
    hint(`${agent.name} cannot run anything yet`)
    say('not wired up yet')
    if (keep) keep()
    render()
    return
  }

  return runCommand(utterance, { keep })
}

/* Everything the parsers have to be told about this machine. `spaces` decides
   whether "switch to home" is a command; `remotes` decides the same thing for
   "ask Claude" — with no remote agent on the roster the words are dictation,
   which is why the roster is passed rather than a flag. */
function parseOptions () {
  return { spaces: state.spaces, remotes: (state.settings.agents || []).filter(isRemote) }
}

/* The wait clock, built the first time something is waited on and kept after
   that — a roster that never leaves this machine never builds one at all. Its
   timeout is fixed at construction, so changing that setting drops it and the
   next wait builds a new one. */
function waiting () {
  if (!state.waiting) {
    state.waiting = createWaiting({
      timeoutMs: state.settings && state.settings.remoteTimeoutMs
    })
  }
  return state.waiting
}

/**
 * Who this question is likely to end up with, off the machine, or null.
 *
 * Asked before the question goes out, because the answer decides whether the
 * strip shows a counting bubble or the ordinary '…'. It is a guess and it is
 * allowed to be: a local agent that *can* escalate usually will not, and when
 * it does not the clock is stopped again a few hundred milliseconds later,
 * before the bubble has had a second to count. Guessing the other way is what
 * costs — a fourteen-second wait behind a static ellipsis reads as a hang.
 */
function remoteTarget (agent) {
  if (!agent || !state.settings.remote) return null
  if (isRemote(agent)) return agent
  return escalationChain(state.settings.agents || [], agent).find(isRemote) || null
}

/* Both edges of a wait. The hold is the important half: the transcript fades
   after `idleFadeMs` — 6s by default — of nothing being said, and a remote
   call is silent by definition, so without it the question, the thread and the
   indicator all fade out from under an answer that has not arrived yet. It
   goes through `syncHold` rather than straight at presence, because a panel
   may be holding the strip too and the last one to speak must not win. */
function startWaiting (who) {
  waiting().start(Date.now(), { name: who.name, hue: who.hue })
  syncHold()
  noteActivity()
  if (!pulseFrame) pulseFrame = requestAnimationFrame(pulseIndicator)
}

function stopWaiting () {
  if (!state.waiting || !state.waiting.waiting) return
  state.waiting.stop()
  syncHold()
  // The loop notices on its own next frame; the redraw here is what puts the
  // dot back to a steady glow rather than leaving it wherever it stopped.
  renderConvoIndicator()
}

/* "stop", "be quiet" and Esc all mean the same thing about a call in flight:
   kill the subprocess and stop pretending. The answer may already be sitting
   on the CLI's stdout — the main process throws it away rather than speak it,
   because after "stop" nothing is what you asked for.
   @returns {boolean} whether there was anything to stop */
function cancelEscalation () {
  if (!state.asking && !turnBuffer.pending && (!state.waiting || !state.waiting.waiting)) return false
  turnBuffer.reset()
  state.askSeq++
  window.transvibe.cancelEscalation()
  state.asking = false
  stopWaiting()
  hint('stopped asking')
  /* Said here rather than left to the caller, because one of the callers is
     the Esc key and has no voice of its own — and a call that stopped without
     saying so is indistinguishable from one still running. */
  say('stopped asking', { plain: true })
  render()
  return true
}

/** The last thing you asked, for a follow-up that names no question of its own. */
function lastQuestion () {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'user') return state.history[i].content
  }
  return ''
}

/* The agent an answer came back from, by the name the main process reported.
   A remote answer is attributed to a roster agent when one matches, so the
   bubble can wear its colour, and to the bare name when none does — 'claude'
   said outright names no agent and still has to be credited. */
function agentNamed (name) {
  const flat = String(name || '').trim().toLowerCase()
  if (!flat) return null
  return (state.settings.agents || []).find(a => a.name.toLowerCase() === flat) || null
}

/**
 * Ask a chat agent something, and say the answer.
 *
 * The answer is shown and spoken and then forgotten with everything else. It
 * never joins the transcript: what ⌃⌥↩ pastes is what you said, and a model's
 * words landing in your document because you asked it a question out loud
 * would be a genuinely bad surprise.
 *
 * Nothing here judges whether the answer is true — nothing here could. The
 * prompt asks for uncertainty rather than invention, and the agent can be
 * pointed at a better model than the one doing the cleanup.
 */
const turnBuffer = createTurnBuffer({
  dispatch: (agent, question) => dispatchConversation(agent, question),
  cancel: turn => {
    state.askSeq++
    window.transvibe.cancelEscalation()
    state.asking = false
    stopWaiting()
    const last = state.history.at(-1)
    if (last?.role === 'user' && last.content === turn.question) state.history = state.history.slice(0, -1)
    debugEvent('conversation-continuation', { question: turn.question })
  }
})

async function converse (agent, question) {
  state.talkingTo = agent
  state.conversationWindow.open(state.settings.conversationMs || 0)
  turnBuffer.submit(agent, question)
  hint(`${agent.name} is listening…`)
  noteActivity()
  render()
}

async function dispatchConversation (agent, question) {
  // What the model sees on this turn — before the question below joins the
  // bubbles on screen, so it is not sent to itself as part of its own history.
  const priorHistory = state.history
  debugEvent('conversation-question', { agent: agent.name, question, history: priorHistory })

  /* Which question this is, the way `liveSeq` guards a slow interim. A local
     answer is back in half a second and nobody can speak over it, but a
     frontier one takes three to fourteen, which is long enough to say
     something else — and then the first answer lands in the thread underneath
     the second question, answering something nobody can see any more. So a
     newer question ends the older one: it is cancelled where it is running,
     and if it answers anyway that answer is dropped on the floor here. */
  if (state.asking) window.transvibe.cancelEscalation()
  const seq = ++state.askSeq

  state.asking = true
  state.talkingTo = agent
  state.history = [...priorHistory, { role: 'user', content: question }]
  if (isAcknowledgment(question)) {
    turnBuffer.complete()
    state.asking = false
    stopWaiting()
    state.conversationWindow.open(state.settings.conversationMs || 0)
    debugEvent('acknowledgment', { question })
    noteActivity()
    render()
    return
  }
  hint(`${agent.name} is thinking…`)
  noteActivity()

  /* Started before the question goes out and stopped in a `finally`, so the
     strip is held awake for every way this can end — an answer, a refusal, a
     timeout, Ollama being down. Only when the question can leave the machine:
     a local answer is back before a counter would show anything but 0s. */
  const bound = remoteTarget(agent)
  if (bound) startWaiting(bound)
  render()

  try {
    const answer = await window.transvibe.ask(question, priorHistory,
      { agent: agent.name, model: agent.model, thinking: agent.thinking })
    // Overtaken while it was out. Someone else's turn now, and everything
    // below would be writing into a thread that has moved on.
    if (seq !== state.askSeq) return
    turnBuffer.complete()
    state.asking = false
    if (answer.silent) {
      state.conversationWindow.open(state.settings.conversationMs || 0)
      render()
      return
    }
    if (!answer.ok) {
      /* Cancelled is the one failure nobody needs told about out loud: you
         are the one who said stop, and the strip has already said so. */
      if (answer.reason === 'cancelled') { render(); return }
      hint(answer.reason || 'no answer')
      say(answer.reason || 'no answer', { plain: true })
      render()
      return
    }

    say(landAnswer(answer, agent), { plain: true })
  } catch (err) {
    if (seq !== state.askSeq) return
    turnBuffer.complete()
    state.asking = false
    hint(err.message)
    render()
  } finally {
    // The newer question started its own clock; stopping it here would take
    // the counter off the screen while that one is still running.
    if (seq === state.askSeq) stopWaiting()
  }
}

/* The four ways a question ends up somewhere else, said the way you would say
   them. `shouldEscalate` returns the word; this turns it into the half of a
   sentence that goes after the agent's name. */
const WHY = {
  pass: 'said it could not answer',
  unsure: 'was not sure',
  failed: 'did not answer',
  empty: 'came back with nothing',
  fresh: 'has no clock',
  verification: 'was asked to verify'
}

/**
 * One answer, however it was reached: put on screen and turned into the line
 * to speak.
 *
 * Attribution is the whole point of escalating. An answer from a better model
 * that arrives in Mira's voice, in Mira's colour, with no mention of where it
 * came from, is the app quietly taking credit for a call it made on your
 * behalf and billed to your subscription. So when `via` names somebody other
 * than the agent you asked, the bubble wears that one's name and hue and the
 * spoken line is prefixed — "Claude said, …".
 *
 * Once, not twice: the name is a label on the bubble and a prefix in the
 * sentence, and you are only ever taking in one of the two.
 *
 * @returns {string} what to say
 */
function landAnswer (answer, asked) {
  debugEvent('conversation-answer', { asked: asked.name, answer })
  const from = answer.via || ''
  const via = from && from.toLowerCase() !== asked.name.toLowerCase() ? from : null
  const who = via ? (agentNamed(via) || { name: via, hue: null }) : asked

  state.history = [...state.history,
    { role: 'assistant', content: answer.text, name: who.name, hue: who.hue,
      ...(answer.verification ? { verification: answer.verification, sources: answer.sources || [] } : {}) }]
  /* The thread stays open for a while, so the next sentence can be "and how
     far is that from London" rather than the whole name again. */
  state.conversationWindow.open(state.settings.conversationMs || 0)
  hint(answer.text)
  /* The daily cap and a frontier model that would not answer are both facts
     about an answer that still arrived, from the local model. They go to the
     status line rather than into the spoken reply: the reply is an answer to
     what you asked, and neither of these is. */
  if (answer.note) hint(answer.note)
  else if (answer.remoteFailed) hint(`${answer.remoteFailed} — answered locally`)
  /* Why a question left the machine, in the status line. Not narrated and not
     spoken — you asked a question, not for an account of how it was routed —
     but written down, because "it went to Claude and I do not know why" is a
     complaint with nothing to act on. Each of these names one rule in
     escalate.js, so the line and the rule that fired can be read together. */
  else if (via && answer.escalated) hint(`${asked.name} ${WHY[answer.escalated] || 'gave up'} — asked ${via}`)
  noteActivity()
  render()

  /* What is said is the answer with its addresses taken out — they are on the
     strip, where they can be read and copied, and a URL spoken aloud is a
     minute of slashes you cannot write down. Same words otherwise: the bubble
     is not a longer version of the reply, it is the same reply with the parts
     that only work in writing left in. */
  const line = answer.spoken || answer.text

  // Off, the escalation still happens and is still visible; it just stops
  // being narrated. The bubble is the record either way.
  return via && state.settings.remoteAnnounce !== false
    ? attribute(via, line)
    : line
}

/**
 * Hand the question to a frontier model, because you said so.
 *
 * The automatic path escalates when the local model admits it is stuck. This
 * is the other half: you heard the answer, you did not believe it, and you
 * said "ask Claude about that". What gets sent is the thread — the question
 * that is already on screen and the answer that disappointed you — and never
 * the transcript. There is no referent without a thread, and rather than
 * reach for the nearest text and send your dictation off the machine, it
 * refuses.
 */
async function escalate (args, announce) {
  const speak = announce || ((line, options) => say(line, options))
  const to = agentNamed(args.to)
  const named = (to && to.name) || args.to

  if (!state.settings.remote) {
    hint('asking a frontier model is switched off')
    speak('that is switched off', { plain: true })
    return
  }

  const question = args.question || lastQuestion()
  if (!question) {
    hint('nothing to ask about')
    speak('nothing to ask about', { plain: true })
    return
  }

  // The thread as it stood, so the frontier model is not shown the question
  // twice, and the answer it is being asked to check.
  const priorHistory = state.history
  const priorAnswer = lastAnswer()

  if (state.asking) window.transvibe.cancelEscalation()
  const seq = ++state.askSeq
  state.asking = true
  if (!state.talkingTo && to) state.talkingTo = to
  if (args.question) state.history = [...priorHistory, { role: 'user', content: question }]
  hint(`asking ${named}…`)
  noteActivity()
  startWaiting(to || { name: named, hue: null })
  render()

  try {
    const answer = await window.transvibe.escalate(question, priorAnswer, priorHistory,
      { to: args.to })
    if (seq !== state.askSeq) return
    turnBuffer.complete()
    state.asking = false
    if (!answer || !answer.ok) {
      if (answer && answer.reason === 'cancelled') { render(); return }
      const why = (answer && answer.reason) || 'no answer'
      hint(why)
      speak(why, { plain: true })
      render()
      return
    }
    /* Credited against whoever's thread this is. Mid-conversation that is the
       local agent, so the frontier answer is somebody else's and is spoken as
       "Claude said" — the case this command exists for. Said into no thread at
       all, `talkingTo` is the frontier agent itself, the two names match and
       the prefix is dropped: you addressed Claude, the bubble says Claude, and
       being told so a third time is the duplication landAnswer avoids. */
    speak(landAnswer(answer, state.talkingTo || { name: '', hue: null }), { plain: true })
  } catch (err) {
    if (seq !== state.askSeq) return
    turnBuffer.complete()
    state.asking = false
    hint(err.message)
    speak(err.message, { plain: true })
    render()
  } finally {
    if (seq === state.askSeq) stopWaiting()
  }
}

/** Is a chat agent still owed a follow-up, said without its name? Asked of
    the thread's owner, not of whoever ran the last command — a one-off
    "hey Trinity, copy the answer" does not hang up on Mira. */
function inConversation () {
  return !!state.talkingTo && state.conversationWindow.isOpen()
}

/* Whoever the next thing said will go to, or null when that is nobody.
 *
 * Three ways to be listening to someone and one indicator for all of them: an
 * open conversation, a name heard at the front of the sentence you are still
 * saying, and the key — which names nobody, so it addresses whoever runs
 * commands. The key is the case this was added for. The strip swings amber
 * either way, and amber says "something is listening" without saying what,
 * which is the question you actually have. */
function addressed () {
  if (inConversation()) return state.talkingTo
  /* A name still being said beats the roster's answer: "hey Trinity" in the
     middle of a thread with Mira is addressed to Trinity. */
  if (state.liveWake && state.agent) return state.agent
  if (!state.commandMode) return null
  /* The key names nobody, so it reaches whoever runs commands — and never
     `state.agent`, which is whoever was addressed last and may well be the
     chat agent you finished talking to a minute ago. */
  return commandAgent((state.settings && state.settings.agents) || [])
}

/* On or off, on the ribbon rather than in the stage: this has to be readable
   whether or not the transcript has faded, so it is redrawn on its own —
   from the idle tick as well as from render() — rather than only when
   something else already needed a redraw. The follow-up window running out is not
   an event, it is a clock, and nothing else changing means nothing else
   would ever notice it happened. */
function renderConvoIndicator () {
  /* A call that has left the machine takes the indicator over: for the ten
     seconds it may run, who the app is waiting on matters more than who it is
     listening to, and they are usually not the same one. */
  const wait = state.waiting && state.waiting.waiting && state.waiting.name
    ? state.waiting
    : null
  const who = wait || addressed()
  convoIndicatorEl.hidden = !who && !state.talkingTo
  if (!who) {
    convoIndicatorLabelEl.textContent = state.talkingTo ? `Say ${state.talkingTo.name} to continue` : ''
    return
  }
  const seconds = Math.ceil(state.conversationWindow.remainingMs() / 1000)
  convoIndicatorLabelEl.textContent = wait ? `${who.name} · waiting`
    : state.deaf ? `${who.name} · speaking`
      : `${who.name}${seconds ? ` · listening ${seconds}s` : ''}`
  const dot = convoIndicatorEl.querySelector('.dot')
  const hue = Number.isFinite(who.hue) ? who.hue : 0.58
  const color = `hsl(${Math.round(hue * 360)} 90% 65%)`
  convoIndicatorEl.style.color = color
  dot.style.background = color
  /* Breathing rather than steady, and only while waiting: the dot is the one
     thing on the strip that can say "still going" without words, and it is
     drawn off the wait's own clock so it cannot drift from the count in the
     bubble. Not the speaking ribbon — that one means the app is talking, and
     it is silent for every second of this. */
  const breath = wait ? wait.pulse(Date.now()) : null
  dot.style.boxShadow = `0 0 ${(breath === null ? 8 : 6 + 10 * breath).toFixed(1)}px ${color}`
  dot.style.opacity = breath === null ? '' : (0.45 + 0.55 * breath).toFixed(2)
}

/* The breath, on its own frame loop for exactly as long as a call is out.
   Everything else on the strip is redrawn by the 400ms idle tick, which is
   right for a number that changes once a second and visibly wrong for
   something meant to look alive: sampled two and a half times a second, a
   0.55Hz pulse reads as a stutter. The loop is started by `startWaiting` and
   ends by itself the moment the wait does. */
let pulseFrame = null
function pulseIndicator () {
  pulseFrame = null
  renderConvoIndicator()
  if (state.waiting && state.waiting.waiting) pulseFrame = requestAnimationFrame(pulseIndicator)
}

/* One spoken utterance, interpreted as an editing command rather than as text
   to insert. A parse failure must never silently swallow what was said. */
async function runCommand (utterance, { retry = true, keep = null, collect = null } = {}) {
  /* Asked for at the moment it is needed rather than kept up to date, because
     what you can switch to includes whatever is running, and that is different
     every time you look. Only for a sentence that opens with the verb — the
     lookup costs a quarter of a second, which is not worth paying on "delete
     that". */
  if (looksLikeSwitch(utterance)) await refreshSpaces()

  const cmd = parseCommand(utterance, parseOptions())

  /* Inside a chain the confirmations are gathered and said once at the end.
     Saying each one as it happens would not work anyway: a second `say`
     interrupts the first, so all you would hear is the last command. */
  const announce = (line, options) => {
    if (collect) collect.push(line)
    else say(line, options)
  }

  /* "change voice to Karen" is a replace as far as the editing rules are
     concerned — swap the word "voice" for the word "Karen" — and a settings
     command to everyone else. A sentence that names a setting is about that
     setting, so the settings reading wins over a replace, and only over a
     replace: every other command shape is unambiguous. */
  if (cmd && cmd.action === 'replace') {
    const named = parseSettingCommand(utterance, FIELDS)
    if (named && await runSettingCommand(named, { collect })) return
  }

  if (!cmd) {
    /* The other kind of command: one about the app rather than about the
       text. Tried after the editing rules, so nothing that already worked
       changes, and strict about naming a setting out loud — "turn off the
       lights" finds no setting and carries on down to being dictation. */
    const setting = parseSettingCommand(utterance, FIELDS)
    if (setting && await runSettingCommand(setting, { collect })) return

    // Two commands in one breath. Tried before the model is asked, and only
    // when the sentence made no sense as a single command.
    if (!collect && await runChain(utterance)) return

    console.info('[transvibe] unrecognised command:', JSON.stringify(utterance))

    /* The seam the rules leave open. The assist model does not invent a
       command — it picks one of the phrases the parser already understands,
       and that phrase goes back through the same parser, so a wrong answer
       can only ever produce a command the app implements. The key path is
       safe to ask from because command mode was armed deliberately; the wake
       phrase is a weaker signal, which is why that caller hands over a `keep`
       to put the words back if nothing lands. */
    if (retry && state.settings.commandFallback) {
      hint('working out what you meant…')
      const phrase = await window.transvibe.assistCommand(utterance, commandPhrases(),
        { model: state.agent && state.agent.model })
      if (phrase) return runCommand(phrase, { retry: false, keep, collect })
    }

    /* Armed with a key, a miss is just a miss: you meant a command and it is
       better to be told than to have a stray sentence appear. Triggered by a
       wake phrase, the app is the one that decided this was a command, so it
       owes you the words back rather than eating them. */
    if (keep) {
      keep()
      hint(`not a command — kept "${utterance}"`)
      announce('kept as dictation')
      render()
      return
    }

    hint(`not a command: "${utterance}"`)
    announce(spokenFor(null))
    return
  }

  /* Asking someone else is not an edit, and it has to be taken out before the
     referent rules below: they read "the conversation" as a thing to copy or
     wipe, and "ask Claude about the conversation" is neither. */
  if (cmd.action === 'escalate') return escalate(cmd.args, announce)

  const before = fullText()

  /* The conversation is the other thing a command can be about. Named
     outright — "copy the answer", "clear the conversation" — it is that,
     whatever the transcript holds. Unnamed — "copy that", "erase all" — it
     is the transcript, and only when the transcript is empty does the thread
     on screen stand in for it: applyCommand never sees the thread, so left
     alone it would say "nothing to act on" about a screen full of bubbles.

     Wiping is the one verb that takes both. "Erase all" means the screen. */
  const wipes = cmd.action === 'clear' ||
    (cmd.action === 'delete' && (cmd.target === 'all' || cmd.target === 'conversation'))
  const named = cmd.target === 'answer' || cmd.target === 'conversation'
  const chatty = state.history.length > 0
  if ((named || (!before.trim() && chatty && wipes)) ||
      (!before.trim() && chatty && (cmd.action === 'copy' || cmd.action === 'send'))) {
    if (wipes) {
      // Named, it is only the thread that goes: "clear the conversation" with
      // a sentence dictated above it leaves the sentence. Unnamed, on an
      // empty transcript, the thread is all there is.
      if (cmd.target !== 'conversation') {
        if (before) state.undoStack.push(before)
        setText('')
      }
      clearConversation()
      announce('cleared')
      hint('cleared conversation')
      render()
      return
    }
    const text = cmd.target === 'conversation' ? conversationText() : lastAnswer()
    if (!text) {
      announce('nothing to act on')
      return hint('nothing to act on')
    }
    const what = cmd.target === 'conversation' ? 'conversation' : 'answer'
    if (cmd.action === 'copy') {
      window.transvibe.copy(text)
      announce('copied')
      hint(`copied ${what}`)
      return
    }
    if (cmd.action === 'send') {
      announce('sent')
      return sendText(text, what)
    }
    // A chat target on any other verb is not a thing that can be done.
    announce('nothing to act on')
    return hint(`cannot ${cmd.action} the ${what}`)
  }

  const result = applyCommand(cmd, before)

  if (result.effect === 'undo') {
    /* "Never mind" is an undo, except while a question is out: then it is
       about the question, which is the only thing that has not finished
       happening yet. Nothing has changed in the transcript to take back. */
    if (cancelEscalation()) return
    const previous = state.undoStack.pop()
    if (previous === undefined) {
      announce('nothing to undo')
      return hint('nothing to undo')
    }
    setText(previous)
    hint('undone')
    announce(spokenFor(cmd, result))
    render()
    return
  }

  if (result.changed) {
    state.undoStack.push(before)
    if (state.undoStack.length > 20) state.undoStack.shift()
    setText(result.text)
    // "Erase all" with both on screen takes both — the same as 'clear' below.
    if (wipes) clearConversation()
  }

  /* Said before the effect runs, not after: 'send' hands focus to another app
     and never comes back here, and 'hide' takes the strip away, so a
     confirmation queued behind either would be a confirmation of nothing.

     A jump is said plainly, never handed to the model to shorten. The names
     *are* the confirmation — "switched to Home and Communications" is five
     words, one over the threshold, and what came back was "switched to Home",
     which is a report of half the thing that happened. */
  announce(spokenFor(cmd, result), { plain: result.effect === 'space' })

  switch (result.effect) {
    case 'copy': window.transvibe.copy(fullText()); break
    case 'send': doSend(); return
    case 'clear':
      state.undoStack.push(before)
      setText('')
      // Whatever agent said this, "clear" means everything on screen — the
      // conversation goes with the transcript, the same as the trash button.
      clearConversation()
      break
    case 'pause': setListeningState(false); break
    case 'resume': setListeningState(true); break
    case 'hide': window.transvibe.hide(); break
    case 'settings': window.transvibe.openPanel('settings'); break
    case 'agents': window.transvibe.openPanel('agents'); break
    case 'glossary': window.transvibe.openPanel('glossary'); break
    case 'help': window.transvibe.openPanel('help'); break
    case 'show': window.transvibe.showWindow(); break
    case 'revealModels': window.transvibe.revealModels(); break
    case 'quit': window.transvibe.quit(); break
    case 'stopTalking':
      window.transvibe.hush()
      /* "Be quiet" is about every noise the app is making, and a subprocess
         that is going to speak in eight seconds is one of them. */
      cancelEscalation()
      // Interrupting is also how you end a conversation: the next thing said
      // after cutting one off is not a follow-up.
      state.conversationWindow.clear()
      break
    case 'closePanel': closeOpenPanel(); break
    /* Awaited, unlike the rest. The others are done the moment they are asked
       for; a jump is not, and the next command in a chain is usually "send it"
       — which pastes into whatever is frontmost. Let this one run loose and
       the paste lands in the app you were switching away from. */
    case 'space': await goToSpace(cmd.args.spaces, cmd.args.name); break
  }

  hint(result.message)
  render()
}

/* Jump to a named desktop Space.
 *
 * The confirmation has already been said by the time this runs — deliberately,
 * as with 'send': the screen is about to be replaced and a line spoken after
 * the switch is a line about a desktop you have already left. Only the failure
 * is reported here, and only because it means nothing happened at all. */
async function refreshSpaces () {
  try {
    state.spaces = await window.transvibe.listSpaces()
  } catch (err) {
    console.warn('[transvibe] could not list places to switch to:', err.message)
  }
}

async function goToSpace (spaces, name) {
  const result = await window.transvibe.openSpace(spaces.map(s => s.key))
  if (!result || !result.ok) {
    hint(`could not switch to ${name}`)
    say(`no space called ${name}`)
    return
  }
  /* The Dock click is the jump, and it needs Accessibility. Without it the
     marker is merely activated — the menu bar changes and the desktop does
     not — which looks like nothing happened, so it has to be said. */
  if (result.stuck && result.stuck.length) {
    hint('switching a desktop needs Accessibility permission')
    return
  }

  /* Two markers on the same display cannot both be in front of you: the second
     one lands on top of the first and the first jump is undone. Worth saying,
     because from here it looks like a name was ignored. */
  if (result.clashed && result.clashed.length) {
    hint(`${result.clashed.join(' and ')} share a display`)
  }
}

/**
 * Two or three commands said in one breath: "open settings and change the
 * voice to Karen".
 *
 * All or nothing. The parts are checked before any of them runs, because "and"
 * is a word that turns up inside commands as well as between them — "replace
 * cat and dog with pets" splits into nonsense — and half a chain executed on a
 * misreading is worse than no chain at all. The whole sentence has already
 * failed to parse on its own by the time this is reached, so nothing that
 * worked before can end up here.
 *
 * @returns {Promise<boolean>} whether it was a chain and was run
 */
async function runChain (utterance) {
  const parts = splitChain(utterance)
  if (parts.length < 2) return false

  const parsed = parts.map(part => {
    const cmd = parseCommand(part, parseOptions())
    const setting = parseSettingCommand(part, FIELDS)
    // Same preference as a single command: naming a setting beats a replace.
    if (setting && (!cmd || cmd.action === 'replace')) return { part, setting }
    return cmd ? { part, cmd } : null
  })
  if (parsed.some(p => p === null)) return false

  const lines = []
  for (const step of parsed) {
    if (step.setting) await runSettingCommand(step.setting, { collect: lines })
    else await runCommand(step.part, { retry: false, collect: lines })
  }

  const said = lines.filter(Boolean)
  if (said.length) {
    hint(said.join(' · '))
    // Plain, and once: a joined line is not worth handing to the model, and
    // one `say` per part would cut each other off.
    say(said.join(', '), { plain: true })
  }
  return true
}

/* Change one setting, or say where it sits.
 *
 * Everything the panel does on a click, minus the click: write it, apply it
 * live, and re-read the panel if it happens to be open, so the slider is never
 * showing a value the app has already moved past.
 *
 * @returns {Promise<boolean>} false if the setting could not be acted on at
 *   all, which puts the utterance back on the unrecognised path rather than
 *   swallowing it.
 */
async function runSettingCommand (cmd, { collect = null } = {}) {
  const field = FIELDS.find(f => f.key === cmd.key)
  if (!field) return false
  const announce = line => { if (collect) collect.push(line); else say(line, { plain: true }) }

  /* "change your voice to Karen" said to Mira is about Mira, not about the
     app's default. The two settings that agents can override are answered by
     whoever is being addressed; everything else is the app's. */
  if (state.agent && (field.key === 'speakVoice' || field.key === 'speakRate')) {
    return runAgentVoiceCommand(cmd, field, announce)
  }

  /* A select whose choices the schema already knows: "change the visualizer
     to the orb". No machine to ask, so it is answered from the schema. */
  if (cmd.resolve === 'choices') {
    const picked = resolveChoice(field, cmd.value)
    if (!picked) {
      hint(`no ${field.label.toLowerCase()} called "${cmd.value}"`)
      announce(`there is no ${field.label.toLowerCase()} called ${cmd.value}`)
      return true
    }
    cmd = { ...cmd, value: picked }
  }

  /* A select's values belong to the machine, not the schema: "make the voice
     Karen" is only a command if this Mac has a Karen. */
  if (cmd.resolve === 'voices') {
    const name = await resolveVoiceName(cmd.value)
    if (!name) {
      hint(`no voice called "${cmd.value}"`)
      announce(`no voice called ${cmd.value}`)
      return true
    }
    cmd = { ...cmd, value: name }
  }

  const current = field.external
    ? await window.transvibe.getLaunchAtLogin()
    : state.settings[field.key]
  const result = applySettingCommand(cmd, field, current)

  if (result.changed) {
    if (field.external) await window.transvibe.setLaunchAtLogin(result.value)
    else state.settings = await saveSettings({ [field.key]: result.value })
    // The spoken confirmation is itself the preview when it is a voice or a
    // rate that just changed — it comes out in the new one — so the panel's
    // sample line would be the same sentence twice.
    const heard = state.settings.speakReplies &&
      (field.key === 'speakVoice' || field.key === 'speakRate')
    applyLiveSetting(field.key, { preview: !heard })
    if (openPanel() === 'settings') state.settingsPanel.render()
  }

  hint(result.message)
  // Said as written: a settings line carries a value, and the assist model
  // rephrasing it is how "the speaking rate is the voice's own" becomes
  // "voice is speaking".
  announce(result.message)
  return true
}

/**
 * The voice or rate of whoever you are talking to.
 *
 * Same command, different target: the parser produced "set the voice to Karen"
 * from a sentence addressed to an agent, so the agent is what it means. Asking
 * about it answers for the agent too, falling back to the app's default when
 * that one has not chosen — because that is what you would actually hear.
 */
async function runAgentVoiceCommand (cmd, field, announce) {
  const agent = state.agent
  const sound = speechFor(agent, state.settings)
  const current = field.key === 'speakVoice' ? sound.voice : sound.rate

  if (cmd.op === 'get') {
    const line = `${agent.name} speaks with ${current || 'the system voice'}`
    hint(line)
    announce(line)
    return true
  }

  if (cmd.resolve === 'voices') {
    const name = await resolveVoiceName(cmd.value)
    if (!name) {
      hint(`no voice called "${cmd.value}"`)
      announce(`no voice called ${cmd.value}`)
      return true
    }
    cmd = { ...cmd, value: name }
  }

  const result = applySettingCommand(cmd, field, current)
  if (!result.changed) {
    hint(result.message)
    announce(result.message)
    return true
  }

  const saved = updateAgent(state.settings.agents, agent.name, {
    [field.key === 'speakVoice' ? 'voice' : 'rate']: result.value
  })
  if (!saved.ok) {
    hint(saved.error)
    return true
  }
  state.settings = await saveSettings({ agents: saved.agents })
  state.agent = saved.agents.find(a => a.name === agent.name) || agent
  if (openPanel() === 'settings') state.settingsPanel.render()
  for (const into of document.querySelectorAll('[data-agents]')) renderAgents(into)

  const line = `${agent.name} ${result.message}`
  hint(line)
  // Said in the new voice, which is the only demonstration that matters.
  announce(line)
  return true
}

/* Voices are named, and names are misheard. An exact match first, then the
   first voice whose name starts with what was heard, so "Karen" finds Karen
   and "sam" finds Samantha rather than nothing. */
async function resolveVoiceName (heard) {
  const wanted = String(heard || '').trim().toLowerCase()
  if (!wanted) return null
  const voices = (await window.transvibe.listVoices())
    .filter(v => SPOKEN_LOCALE.test(v.locale))
  const exact = voices.find(v => v.name.toLowerCase() === wanted)
  if (exact) return exact.name
  const starts = voices.find(v => v.name.toLowerCase().startsWith(wanted))
  return starts ? starts.name : null
}

let setListeningState = () => {}

/* One settled utterance, appended as text. Text that has already faded is
   history: the strip shows what you would send, so a new utterance starts a
   new transcript rather than silently appending to something invisible. */
function dictate (text, wasStale) {
  if (wasStale) state.finals = []
  /* Dictation is what happens when nobody is being talked to: inside the
     window every unnamed sentence is a follow-up, so reaching here means the
     thread has lapsed. It ends here rather than lingering under the new
     text — you are back to writing, and a stale conversation left on screen
     reads as one that is still going. */
  if (state.history.length) clearConversation()
  state.finals.push(text)
  tidy(text, state.finals.length - 1)
}

/* Something happened worth reading. Restarts the idle countdown and brings the
   transcript back if it had already faded out. */
function noteActivity () {
  if (!state.presence) return
  state.presence.activity(Date.now())
  applyFade()
}

/* Hand a settled utterance to the assist model and swap in the tidier version
   if one comes back. Deliberately fire-and-forget: the text is on screen the
   moment whisper produces it, and the rewrite lands a few hundred ms later or
   not at all. The index is re-checked before writing, because a clear, a
   command or a word fix may have moved on in the meantime. */
async function tidy (original, index) {
  if (!state.settings.cleanup) return
  const result = await window.transvibe.cleanup(original)
  if (!result.used || state.finals[index] !== original) return
  state.finals[index] = result.text
  render()
}

/* The room keeps ringing for a moment after `say` exits, and the VAD's onset
   run is only three frames. */
const SPEECH_TAIL_MS = 250

/* Say what just happened, and go deaf while saying it.
 *
 * The strip already shows this line, but the strip is not what you are looking
 * at: the wake phrase exists so you can edit a transcript without leaving the
 * app you are dictating into, and a confirmation you have to look up to read
 * gives that back. So it is spoken as well.
 *
 * The microphone is stopped for exactly the length of the reply. Echo
 * cancellation is on and still not enough — the speakers are a foot from the
 * mic — and an app that transcribes its own confirmations, then hears the wake
 * phrase in one of them, is an app that talks to itself. */
async function voice (line, options) {
  if (!line || !state.settings.speakReplies) return
  // Whoever was addressed answers in their own voice, so you can hear which
  // one of them it was without being told.
  const sound = speechFor(state.agent, state.settings)
  const model = state.agent && state.agent.model
  debugEvent('speech-start', { text: line, agent: state.agent?.name, ...sound })
  try {
    const result = await whileDeaf(() => window.transvibe.speak(line, { ...sound, model, ...options }))
    debugEvent('speech-end', { result })
  } catch (err) {
    debugEvent('speech-error', { error: err.message })
    throw err
  }
}

/* Everything that makes noise goes through here, so there is one place that
   owns the microphone being off and one place that guarantees it comes back
   on. `speak` resolves when the speaker is quiet; the tail covers the room. */
async function whileDeaf (speaking) {
  debugEvent('microphone-gate', { muted: true })
  state.conversationWindow.pause()
  state.deaf++
  if (state.capture) state.capture.setDeaf(true)
  // Both halves of the same moment: the microphone goes off and the app's own
  // ribbon comes on, for exactly as long as the speakers are busy — wearing
  // the colour of whoever is doing the talking.
  /* In orb mode the inner ring says this instead, off `state.deaf` — so the
     strip's canvas is not left drawing at 30fps into something CSS is
     hiding. One place the app expresses itself, not two. */
  if (state.sayingViz && state.settings.layout !== 'orb') {
    if (state.agent) state.sayingViz.setHue(state.agent.hue)
    state.sayingViz.start()
  }
  try {
    const result = await speaking()
    debugEvent('speech-playback-complete', { result })
    if (state.sayingViz) state.sayingViz.stop()
    await new Promise(resolve => setTimeout(resolve, SPEECH_TAIL_MS))
  } finally {
    if (state.sayingViz) state.sayingViz.stop()
    state.deaf = Math.max(0, state.deaf - 1)
    // Whatever went wrong, the microphone comes back on: deaf is a state no
    // failure is allowed to leave the app stuck in.
    if (state.capture && state.deaf === 0) state.capture.setDeaf(false)
    state.conversationWindow.resume()
    debugEvent('microphone-gate', { muted: state.deaf > 0, followUpOpen: inConversation() })
  }
}

/** Fire-and-forget: nothing waits on the app finishing its sentence. */
function say (line, options) {
  voice(line, options).catch(err => console.warn('[transvibe] speech failed:', err.message))
}

/* A voice is chosen by ear. Changing it — or the rate — says one line back in
   it there and then, rather than making you go and run a command to find out
   what you picked. It plays even with replies switched off: picking a voice is
   a question about the voice, not a change of mind about the feature. */
function previewVoice (options) {
  whileDeaf(() => window.transvibe.previewVoice(options))
    .catch(err => console.warn('[transvibe] voice preview failed:', err.message))
}

function applyFade () {
  document.body.classList.toggle('faded', state.presence.faded)
}

/* The window is only as tall as what is in it. Measured from the laid-out
   content rather than guessed at, because the transcript's height depends on
   how the text wrapped — a fixed strip clipped the last line of a three-line
   utterance and cut the buttons sitting under it in half.

   Deliberately not shrunk while the text is faded: the stage still has to be
   hoverable at zero opacity, and it cannot be hovered if it is outside the
   window. */
let heightFrame = null
function syncHeight () {
  if (heightFrame) return
  heightFrame = requestAnimationFrame(() => {
    heightFrame = null
    // The stage and the word fixer, never an open panel: a panel is sized in
    // percentages of the window, so measuring it would feed its own height
    // back in and the strip would grow without limit. The main process takes
    // the larger of this and its fixed panel height.
    //
    // The fixer has to be in here because it hangs below the row it belongs
    // to: measuring the stage alone left its last two checkboxes outside the
    // window, where they were not merely hidden but unclickable.
    const fixer = $('fixer')
    /* A panel that has been dragged is measured too, and only then. Left where
       it starts it is sized as a share of the window, and measuring that would
       feed its own height back in — but once moved its height is frozen in
       pixels, and if it is not measured the next redraw shrinks the window out
       from under it and cuts off everything below the fold. */
    const placed = document.querySelector('.panel.placed:not([hidden])')
    const bottom = Math.max(
      document.querySelector('.stage').getBoundingClientRect().bottom,
      fixer.hidden ? 0 : fixer.getBoundingClientRect().bottom,
      placed ? placed.getBoundingClientRect().bottom + MARGIN - BOTTOM_MARGIN : 0
    )
    window.transvibe.setHeight(Math.ceil(bottom + BOTTOM_MARGIN))
  })
}

/* The idle window ran out with the text already faded and nobody reaching for
   it. Whatever the strip heard — a song, a conversation that was not aimed at
   it — was not dictation, so it goes rather than sitting there waiting to be
   pasted somewhere by mistake. The undo stack goes with it: "forgotten" that
   ⌘Z brings back is not forgotten. */
function forgetTranscript () {
  if (!state.finals.length && !state.live && !state.history.length) return
  /* Not while a chat agent is still listening: the conversation window is
     its own clock and is allowed to be longer than the idle one. The tick
     asks again once the window has lapsed. */
  if (inConversation() || state.asking || turnBuffer.pending || state.deaf > 0) return
  state.finals = []
  state.live = ''
  state.liveSeq++
  state.undoStack = []
  // The thread goes with it. Picking a conversation back up half an hour
  // later, out of a strip that has been cleared, is not continuing it.
  clearConversation()
  render()
}

/* Esc with nothing else open means "get out of the way": the transcript goes,
   and the strip is a bare ribbon again. The conversation goes with it too —
   Esc is as much an ending as letting the thread fade on its own, and it
   should not leave the model still primed with a thread the screen no longer
   shows any trace of. */
function dismiss () {
  state.finals = []
  state.live = ''
  state.liveSeq++
  state.undoStack = []
  clearConversation()
  render()
  closeFixer()
}

/* The command reference is generated from COMMANDS, the same array the parser
   is driven by, so the help can never drift from what actually works. */
function buildHelp () {
  const body = $('help-body')
  if (body.childElementCount) return

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const section = (title, rows) => {
    body.append(el('h3', null, title))
    const dl = el('dl')
    for (const [term, def] of rows) {
      dl.append(el('dt', null, term))
      const dd = el('dd')
      if (typeof def === 'string') dd.textContent = def
      else dd.append(...def)
      dl.append(dd)
    }
    body.append(dl)
  }

  section('The strip', [
    ['clicks pass through', 'Until you rest the pointer on the strip; then it wakes'],
    ['text fades', 'A few seconds after you stop talking — ⌃⌥↩ still sends it'],
    ['esc', 'Closes this, then the fixer, then clears the transcript'],
    ['drag a panel', 'By its title bar; it stays put. Double-click the bar to centre it again']
  ])

  section('Keys', [
    ['hold right ⌥', 'Speak one command instead of dictating'],
    ['⌃⌥C', 'Same, without holding a key'],
    ['say a name', 'Same again, no key at all — “hey Claude, delete that”. The names are yours to set'],
    ['it answers back', 'Spoken aloud after each command, in that agent’s voice; the mic is deaf while it talks'],
    ['chain them', 'and / then / a comma: “open settings and change the voice to Karen”'],
    ['talk to one', 'An agent set to “talks back” answers questions out loud; the thread stays open, as bubbles'],
    ['borrow another', 'Mid-conversation, “hey Trinity, copy the answer” runs one command and hands back to the thread'],
    ['the answer', '“copy the answer”, “send the answer”, “copy the conversation” — what was said, not what you dictated'],
    ['stop talking', 'Cuts off a spoken reply, whoever you were addressing'],
    ['⌃⌥↩', 'Send the transcript to the app in front'],
    ['⌃⌥Space', 'Show or hide the strip'],
    ['⌘,', 'Settings, from the menu bar icon']
  ])

  section('Transcript', [
    ['click a word', 'Say what it should have been; untick “remember” for a one-off'],
    ['esc', 'Dismiss the fixer without changing anything'],
    ['drag', 'Select text as usual; a selection never opens the fixer']
  ])

  section('Buttons', [
    ['×', 'Clear the transcript and get out of the way'],
    ['➤', 'Send the transcript to the app in front'],
    ['copy', 'Copy the whole transcript'],
    ['trash', 'Clear the transcript'],
    ['book', 'Glossary — words to recognise, and fixes for the ones it misses'],
    ['gear', 'Settings — six tabs, applied as you change them. Agents is one of them'],
    ['?', 'This panel'],
    ['mic', 'Pause and resume listening']
  ])

  body.append(el('h3', null, 'Commands'))
  const dl = el('dl')
  for (const cmd of COMMANDS) {
    const dt = el('dt')
    for (const example of cmd.examples.slice(0, 3)) {
      dt.append(el('span', 'say', example))
    }
    dl.append(dt, el('dd', null, cmd.help))
  }
  body.append(dl)

  /* Generated from the same schema the panel is built from, so it cannot
     describe a setting that is not reachable — or miss one that is. */
  body.append(el('h3', null, 'Settings, by voice'))
  const grammar = el('dl')
  for (const [form, help] of [
    ['turn off spoken replies', 'Any on/off setting: turn on, turn off, enable, disable'],
    ['set the fade to ten seconds', 'Any slider. Seconds, milliseconds or a bare number'],
    ['raise the threshold', 'A nudge either way: raise, lower, speed up, slow down'],
    ['make the voice Karen', 'Any English voice installed on this Mac'],
    ["what's the threshold", 'Ask instead of change; it says where the setting sits']
  ]) {
    grammar.append(el('dt', null, form), el('dd', null, help))
  }
  body.append(grammar)

  const names = FIELDS.filter(f => f.spoken).map(f => f.spoken[0])
  body.append(el('p', 'note',
    `Settings you can name out loud: ${names.join(', ')}. The language, the ` +
    'send target and the model paths are panel-only — they are free text, ' +
    'and a misheard path is worse than no path.'))

  body.append(el('p', 'note',
    'The strip has no window: it hangs off the top of the screen and every ' +
    'click lands in whatever is behind it, until the pointer rests on it.'))
  body.append(el('p', 'note',
    'Commands only fire while command mode is armed, so ordinary dictation is ' +
    'never mistaken for one. Anything not recognised is shown rather than ' +
    'guessed at, so nothing you said is silently swallowed.'))
  body.append(el('p', 'note',
    'Everything runs on this Mac. Audio never leaves the device.'))
}

/* --------------------------------------------------------------------- agents
   A list of records rather than a set of fields, which is why it has a panel
   of its own instead of a row in settings: a name, what saying it does, and
   the voice the answer comes back in. Every change round-trips through the
   main process and the reply is the new settings, so what is on screen is
   what was saved. */

function agentsNote (text, warn = false) {
  // The tab inside settings has the settings panel's own footer; the panel on
  // the strip has its own. Whichever is on screen says it.
  if (!$('settings').hidden) settingsNote(text, warn)
  const note = $('agents-note')
  if (note && !note.closest('.panel').hidden) {
    note.textContent = text
    note.classList.toggle('warn', warn)
  }
}

/* The settings panel's own status line. It reverts to what the footer says
   when nothing has just happened, because a "saved" left standing for an hour
   is a claim about whatever you are looking at now rather than about the thing
   it was actually describing. */
const SETTINGS_FOOT = 'Saved as you change them.'
let settingsNoteTimer = null

function settingsNote (text, warn = false) {
  const note = $('settings-note')
  if (!note) return
  note.textContent = text
  note.classList.toggle('warn', warn)
  clearTimeout(settingsNoteTimer)
  settingsNoteTimer = setTimeout(() => {
    note.textContent = SETTINGS_FOOT
    note.classList.remove('warn')
  }, 4000)
}

async function saveAgents (result) {
  if (!result.ok) return agentsNote(result.error, true)
  state.settings = await saveSettings({ agents: result.agents })
  for (const into of document.querySelectorAll('[data-agents]')) renderAgents(into)
  agentsNote('Saved.')
}

const KIND_LABELS = {
  commands: 'runs commands',
  chat: 'talks back',
  external: 'hands it on (not yet)'
}

/* Where an agent thinks, said as what it does rather than as a product name:
   the choice you are making is whether this name's answers leave the machine,
   and 'ask Claude' says that where 'claude' does not. */
const PROVIDER_LABELS = {
  local: 'stays on this Mac',
  claude: 'ask Claude',
  codex: 'ask Codex'
}

async function renderAgents (into = null) {
  const body = into || $('agents-body')
  const roster = state.settings.agents || []
  body.dataset.agents = 'yes'
  body.replaceChildren()

  // The settings tab has already said this in its own note; the panel on the
  // strip has not, and opening it cold with a bare list explains nothing.
  if (!into) {
    body.append(el('p', 'note lead',
      'Say a name at the start of a sentence and the rest of it is addressed ' +
      'to that one. Each answers in its own voice, so you can hear which of ' +
      'them replied without being told.'))
  }

  const voices = await voiceOptions()

  for (const agent of roster) {
    const row = el('div', 'agent-row')

    /* The dot is the agent's colour, which is what the speaking ribbon wears
       while it is talking — and clicking it walks along the palette, because a
       colour you cannot change is a colour you have to live with. */
    const dot = el('button', 'agent-dot')
    dot.type = 'button'
    dot.style.color = `hsl(${Math.round(agent.hue * 360)} 85% 62%)`
    dot.title = 'Its colour on the strip — click for the next one'
    dot.onclick = () => saveAgents(updateAgent(roster, agent.name, {
      hue: nextHue(agent.hue)
    }))
    row.append(dot)

    const name = el('input')
    name.type = 'text'
    name.value = agent.name
    name.spellcheck = false
    name.title = 'What you say to address it'
    name.onchange = () => saveAgents(updateAgent(roster, agent.name, { name: name.value }))
    row.append(name)

    const kind = el('select')
    for (const k of KINDS) {
      const option = el('option', null, KIND_LABELS[k])
      option.value = k
      kind.append(option)
    }
    kind.value = agent.kind
    kind.onchange = () => saveAgents(updateAgent(roster, agent.name, { kind: kind.value }))
    row.append(kind)

    const voice = el('select')
    for (const option of voices.options) {
      const node = el('option', null, option.value ? option.label : 'Default voice')
      node.value = option.value
      voice.append(node)
    }
    voice.value = agent.voice || ''
    voice.title = 'Empty uses the default voice from settings'
    voice.onchange = async () => {
      await saveAgents(updateAgent(roster, agent.name, { voice: voice.value || null }))
      /* Auditioning the character rather than the voice: it says its own name,
         which is what you are actually choosing between. */
      previewVoice({
        voice: voice.value || undefined,
        rate: agent.rate ?? undefined,
        line: `${agent.name} here. This is how a reply sounds.`
      })
    }
    row.append(voice)

    /* Removing an agent takes its name, its voice, its colour and its model
       with it, and there is nothing to undo it with. One click arms the
       button and says so; the second does it. Moving the pointer away is how
       you change your mind, which is the gesture you were going to make
       anyway. */
    const drop = el('button', 'agent-drop', '×')
    drop.type = 'button'
    drop.title = `Remove ${agent.name}`
    let armed = false
    const disarm = () => {
      armed = false
      drop.textContent = '×'
      drop.classList.remove('armed')
    }
    drop.onclick = () => {
      if (armed) return saveAgents(removeAgent(roster, agent.name))
      armed = true
      drop.textContent = 'remove?'
      drop.classList.add('armed')
      agentsNote(`Click again to remove ${agent.name}.`)
    }
    drop.onmouseleave = disarm
    drop.onblur = disarm
    row.append(drop)

    /* Every agent gets its own local model. A chat agent answers with it; one
       that runs commands uses it for the guesswork — what an unrecognised
       command meant, and how to shorten a confirmation. Worth separating:
       asked what a VAD is, the small fast one offers "video-assisted delivery"
       while a bigger one gets it right, and the small fast one is exactly what
       you want deciding whether you said "delete that". */
    if (agent.kind !== 'external') {
      const sub = el('div', 'agent-sub')
      const aliasesLabel = el('label', 'agent-sub', 'Wake aliases ')
      const aliases = el('input')
      aliases.type = 'text'
      aliases.value = (agent.aliases || []).join(', ')
      aliases.placeholder = 'Hey Mera, Hey mirror'
      aliases.title = 'Alternate full wake phrases, separated by commas'
      aliases.onchange = () => saveAgents(updateAgent(roster, agent.name, {
        aliases: aliases.value.split(',')
      }))
      aliasesLabel.append(aliases)
      row.append(aliasesLabel)
      const remote = isRemote(agent)

      /* Where it thinks. Offered to a chat agent and to nothing else: the jobs
         a commands agent does with a model are tidying up your dictation and
         guessing what an unrecognised command meant, and both of those *are*
         the transcript. That never leaves this machine, so there is nothing
         here to choose between. In the second row rather than beside the kind
         because the first row is a fixed five-column grid and this is a fifth
         thing about the agent, not a fifth column. */
      if (agent.kind === 'chat') {
        const provider = el('select', 'agent-provider')
        for (const value of PROVIDERS) {
          const option = el('option', null, PROVIDER_LABELS[value])
          option.value = value
          provider.append(option)
        }
        provider.value = agent.provider || 'local'
        provider.title = 'A remote agent spawns the CLI you are already signed ' +
          'in to, so it bills against that subscription rather than an API key. ' +
          'Only what you say to this name is ever sent; your dictation is not.'
        provider.style.flex = '0 0 auto'
        provider.style.width = 'auto'
        provider.onchange = () => saveAgents(updateAgent(roster, agent.name, {
          provider: provider.value
        }))
        sub.append(provider)
      }

      /* Every local agent gets its own Ollama model. A chat agent answers with
         it; one that runs commands uses it for the guesswork — what an
         unrecognised command meant, and how to shorten a confirmation. Worth
         separating: asked what a VAD is, the small fast one offers
         "video-assisted delivery" while a bigger one gets it right, and the
         small fast one is exactly what you want deciding whether you said
         "delete that".

         A remote agent has no Ollama list to pick from, and showing it one
         would say the wrong thing about where its answers come from — so the
         row says what actually applies to the CLI instead. */
      if (!remote) {
        sub.append(el('span', 'note', agent.kind === 'chat' ? 'answers with' : 'thinks with'))
        const model = el('select')
        const { options, note } = await assistModelOptions()
        for (const option of options) {
          const node = el('option', null, option.label)
          node.value = option.value
          model.append(node)
        }
        model.value = agent.model || defaultModel(roster)
        // A model that is no longer pulled must not silently read as another
        // one: it is still what the file says, and saying so is how you find out
        // why the answers stopped coming.
        if (!options.some(o => o.value === model.value)) {
          const missing = el('option', null, `${model.value} — not pulled`)
          missing.value = model.value
          model.append(missing)
          model.value = model.value
        }
        model.onchange = () => saveAgents(updateAgent(roster, agent.name, {
          model: model.value || null
        }))
        sub.append(model)

        /* Whether it may reason before answering, next to the model because it
           is a property of the pairing rather than of either one: the same model
           is a different agent with it on. Only offered to a chat agent — the
           jobs a commands agent does with its model are rewrites on a tight
           clock, where reasoning is a second spent on nothing. It is not
           offered to a remote one either: a frontier CLI decides that for
           itself and there is no flag here that would change its mind. */
        if (agent.kind === 'chat') {
          const thinking = el('select', 'agent-thinking')
          for (const [value, label] of [['yes', 'thinks first'], ['no', 'answers straight']]) {
            const node = el('option', null, label)
            node.value = value
            thinking.append(node)
          }
          thinking.value = agent.thinking ? 'yes' : 'no'
          thinking.title = 'Thinking is slower but better reasoned. Not every ' +
            'model can be told to skip it — some answer with their reasoning ' +
            'in the reply instead.'
          thinking.onchange = () => saveAgents(updateAgent(roster, agent.name, {
            thinking: thinking.value === 'yes'
          }))

          /* A model with no reasoning to do should not be offered the choice.
             Said rather than hidden: the switch was there a moment ago for a
             different model, and a control that silently vanishes reads as a
             bug. Only when Ollama actually said so — an unknown model keeps the
             switch, because withholding it on a guess is worse. */
          const chosen = options.find(o => o.value === model.value)
          if (chosen && chosen.thinks === false) {
            thinking.disabled = true
            thinking.title = `${model.value} does not think — there is nothing to switch off`
          }
          sub.append(thinking)
        }

        sub.append(el('span', 'note', note || ''))
      } else if (agent.provider === 'claude') {
        /* Typed rather than picked from a list: the models the CLI accepts are
           whatever Anthropic is shipping this month, and a stale list that
           quietly rules out a new one is worse than an empty box. A wrong name
           is caught by the CLI, whose complaint is what you hear back. */
        sub.append(el('span', 'note', 'answers with'))
        const model = el('input', 'agent-model')
        model.type = 'text'
        model.spellcheck = false
        model.value = agent.model || DEFAULT_MODELS.claude || ''
        model.placeholder = DEFAULT_MODELS.claude || ''
        model.title = 'The --model the claude CLI is given. Empty uses its default.'
        model.onchange = () => saveAgents(updateAgent(roster, agent.name, {
          model: model.value.trim() || null
        }))
        sub.append(model)
        sub.append(el('span', 'note', 'via your own claude CLI'))
      } else {
        /* No model box for codex: the CLI chooses, and a field that cannot
           change anything is a field that lies about what it does. */
        const note = el('span', 'note', 'codex picks its own model')
        note.title = 'codex exec is given no --model; whatever it is configured ' +
          'with is what answers.'
        sub.append(note)
      }

      /* Who catches the question this one cannot answer. Only a local agent
         has anywhere to fall to: the frontier model is already the end of the
         chain, and pointing one at another would spend eight more seconds
         asking a second expensive question about an answer that was fine.

         Named agents only, never a bare "ask Claude" — what gets asked is a
         roster entry with a voice and a colour, so the answer arrives sounding
         like somebody rather than like the machine. */
      if (agent.kind === 'chat' && !remote) {
        const others = roster.filter(a => isRemote(a) && a.name !== agent.name)
        if (others.length) {
          sub.append(el('span', 'note', 'falls back to'))
          const to = el('select', 'agent-escalate')
          const none = el('option', null, 'nothing')
          none.value = ''
          to.append(none)
          for (const other of others) {
            const node = el('option', null, other.name)
            node.value = other.name
            to.append(node)
          }
          /* Matched case-insensitively: `escalateTo` is stored as it was
             typed, and a select whose value misses by a capital letter reads
             as "nothing" — which is the one answer it must not give wrongly. */
          const pointsAt = others.find(a =>
            a.name.toLowerCase() === String(agent.escalateTo || '').toLowerCase())
          to.value = pointsAt ? pointsAt.name : ''
          to.title = 'When it says it does not know, the question is asked ' +
            'again — out loud, in that one\u2019s name.'
          to.style.flex = '0 0 auto'
          to.style.width = 'auto'
          to.onchange = () => saveAgents(updateAgent(roster, agent.name, {
            escalateTo: to.value || null
          }))
          sub.append(to)
        }
      }

      row.append(sub)
    }

    body.append(row)
  }

  const add = el('form', 'gl-add')
  const input = el('input')
  input.type = 'text'
  input.placeholder = 'another name — “ada”'
  input.spellcheck = false
  const kind = el('select')
  for (const k of KINDS) {
    const option = el('option', null, KIND_LABELS[k])
    option.value = k
    kind.append(option)
  }
  const submit = el('button', null, 'add')
  submit.type = 'submit'
  add.append(input, kind, submit)
  add.onsubmit = async e => {
    e.preventDefault()
    const result = addAgent(roster, { name: input.value, kind: kind.value })
    if (result.ok) input.value = ''
    await saveAgents(result)
  }
  body.append(add)
}

/* ------------------------------------------------------------------- glossary
   The panel edits `settings.vocabulary` and `settings.corrections` directly.
   Every change round-trips through the main process, which persists it and
   swaps it into the running engine, and the reply is the new settings — so
   what is on screen is always what was actually saved, never an optimistic
   guess that a failed write would leave lying. */

function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function glossaryNote (text, warn = false) {
  const note = $('glossary-note')
  note.textContent = text
  note.classList.toggle('warn', warn)
}

async function saveGlossary (patch) {
  state.settings = await saveSettings(patch)
  renderGlossary()
}

function renderGlossary () {
  const terms = state.settings.vocabulary || []
  const chips = $('term-chips')
  chips.replaceChildren()
  if (!terms.length) {
    chips.append(el('p', 'empty', 'No terms yet.'))
  } else {
    for (const term of terms) {
      const chip = el('span', 'chip', term)
      const remove = el('button', null, '×')
      remove.type = 'button'
      remove.title = `Remove ${term}`
      remove.onclick = () => saveGlossary({ vocabulary: removeTerm(terms, term).terms })
      chip.append(remove)
      chips.append(chip)
    }
  }

  const corrections = state.settings.corrections || {}
  const rows = $('rule-rows')
  rows.replaceChildren()
  const entries = sortedEntries(corrections)
  if (!entries.length) {
    rows.append(el('p', 'empty', 'No fixes yet.'))
  } else {
    for (const [from, to] of entries) {
      const row = el('div', 'rule')
      if (state.editingRule === from) row.classList.add('editing')
      /* A fix that turned out to be wrong used to be removed and retyped from
         nothing, both halves of it, to change one letter. Edit puts it back in
         the form it was written in — the same two fields, the same submit —
         and saving replaces the row it came from rather than adding a second
         one beside it. */
      const edit = el('button', null, '✎')
      edit.type = 'button'
      edit.title = `Edit ${from}`
      edit.onclick = () => editRule(from, to)
      const remove = el('button', null, '×')
      remove.type = 'button'
      remove.title = `Remove ${from}`
      remove.onclick = () => {
        if (state.editingRule === from) editRule(null)
        saveGlossary({ corrections: removeCorrection(corrections, from).corrections })
      }
      row.append(el('span', 'heard', from), el('span', 'arrow', '→'),
        el('span', 'wrote', to), edit, remove)
      rows.append(row)
    }
  }
}

/* Loading a fix back into the form, and the one bit of state that goes with
   it: which row will be replaced when the form is submitted. Called with null
   to stop editing, which is also what clicking the same row's pencil twice
   does — the way out has to be as cheap as the way in. */
function editRule (from, to = '') {
  const same = from !== null && state.editingRule === from
  state.editingRule = same ? null : from
  const fromEl = $('rule-from')
  const toEl = $('rule-to')
  fromEl.value = state.editingRule ? from : ''
  toEl.value = state.editingRule ? to : ''
  $('rule-form').classList.toggle('editing', !!state.editingRule)
  $('rule-submit').textContent = state.editingRule ? 'save' : 'add'
  renderGlossary()
  if (state.editingRule) fromEl.focus()
}

function wireGlossary () {
  $('term-form').onsubmit = async e => {
    e.preventDefault()
    const input = $('term-input')
    const result = addTerms(state.settings.vocabulary || [], input.value)
    if (!result.ok) return glossaryNote(result.error, true)
    input.value = ''
    await saveGlossary({ vocabulary: result.terms })
    glossaryNote(`added ${result.added.join(', ')}`)
    input.focus()
  }

  $('rule-form').onsubmit = async e => {
    e.preventDefault()
    const from = $('rule-from')
    const to = $('rule-to')
    const result = addCorrection(state.settings.corrections || {}, from.value, to.value,
      { replacing: state.editingRule || '' })
    if (!result.ok) return glossaryNote(result.error, true)
    const { added, replaced, edited } = result
    editRule(null)
    await saveGlossary({ corrections: result.corrections })
    /* Says what happened rather than that something did: typing three
       spellings into one field makes three rules, which is worth seeing once
       before you trust it. */
    glossaryNote(edited
      ? `fix updated${added.length > 1 ? ` — ${added.length} spellings` : ''}`
      : added.length > 1
        ? `added ${added.join(', ')}`
        : replaced.length ? 'replaced an existing fix' : 'fix added')
    from.focus()
  }

  // Escape backs out of an edit without touching the fix it came from.
  $('rule-form').addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.editingRule) {
      e.stopPropagation()
      editRule(null)
    }
  })
}

/* ---------------------------------------------------------------- word fixer
   Click a word in the transcript to say what it should have been. The fix is
   applied to the transcript straight away *and* saved to the glossary, so the
   same mishearing is corrected without being retyped next time. */

function closeFixer () {
  $('fixer').hidden = true
  syncHold()
  syncHeight()
}

function syncFixerOptions () {
  const remember = $('fixer-remember').checked
  // Disabled rather than merely faded, so the box greys out natively and the
  // row cannot be clicked into a state that would then be ignored.
  $('fixer-listen').disabled = !remember
  $('fixer-listen-row').classList.toggle('off', !remember)
}

function openFixer (wordEl) {
  const fixer = $('fixer')
  const shell = document.querySelector('.strip')
  const box = wordEl.getBoundingClientRect()
  const frame = shell.getBoundingClientRect()

  $('fixer-from').value = wordEl.textContent
  $('fixer-to').value = ''
  $('fixer-remember').checked = state.fixRemember
  $('fixer-listen').checked = state.fixListen
  syncFixerOptions()
  fixer.hidden = false

  // Sit under the word, nudged back inside the shell when it would overhang.
  const width = fixer.offsetWidth
  const left = Math.min(
    Math.max(box.left - frame.left, 12),
    Math.max(frame.width - width - 12, 12))
  const below = box.bottom - frame.top + 6
  const top = below + fixer.offsetHeight > frame.height - 12
    ? Math.max(box.top - frame.top - fixer.offsetHeight - 6, 12)
    : below
  fixer.style.left = `${left}px`
  fixer.style.top = `${top}px`
  syncHold()
  // The window is grown after the fixer is placed, not before: where it goes
  // is decided against the strip as it stands, and then the strip is made tall
  // enough to hold it.
  syncHeight()
  $('fixer-to').focus()
}

function wireFixer () {
  // A click that ends a drag is a text selection, not a request to fix a word.
  let dragged = false
  transcriptEl.addEventListener('pointerdown', () => { dragged = false })
  transcriptEl.addEventListener('pointermove', e => { if (e.buttons) dragged = true })

  transcriptEl.addEventListener('click', e => {
    const word = e.target.closest('.w')
    const selection = window.getSelection()
    if (!word || dragged || (selection && !selection.isCollapsed)) return closeFixer()
    openFixer(word)
  })

  $('fixer-close').onclick = closeFixer
  $('fixer-remember').onchange = () => {
    state.fixRemember = $('fixer-remember').checked
    syncFixerOptions()
  }
  $('fixer-listen').onchange = () => { state.fixListen = $('fixer-listen').checked }

  $('fixer-form').onsubmit = async e => {
    e.preventDefault()
    const heard = $('fixer-from').value.trim()
    const written = $('fixer-to').value.trim()
    if (!heard || !written) return hint('both sides are required')

    // The rewrite always happens; keeping the rule is the opt-out. A one-off
    // mishearing is not worth a permanent rule, and a glossary full of them
    // would only slow the real entries down.
    const rule = [[heard, written]]
    const before = fullText()
    const fixed = state.finals.map(t => applyCorrections(t, rule))
    const changed = fixed.join(' ') !== state.finals.join(' ')
    if (changed) {
      state.undoStack.push(before)
      state.finals = fixed
    }
    closeFixer()
    render()

    if (!state.fixRemember) {
      return hint(changed ? `"${heard}" → ${written}` : `"${heard}" not found`)
    }

    const result = addCorrection(state.settings.corrections || {}, heard, written)
    if (!result.ok) return hint(result.error)
    const patch = { corrections: result.corrections }
    if (state.fixListen) {
      const terms = addTerms(state.settings.vocabulary || [], written)
      // A term already listed is not a failure here — it is already doing its job.
      if (terms.ok) patch.vocabulary = terms.terms
    }
    state.settings = await saveSettings(patch)
    if (!$('glossary').hidden) renderGlossary()
    hint(`"${heard}" → ${written} · saved to glossary`)
  }
}

async function doSend () {
  const text = fullText()
  if (!text) return hint('nothing to send')
  return sendText(text, 'transcript')
}

/* Paste `text` into the app in front. The transcript is the usual thing;
   "send the answer" is the other, and it is the one case a model's words
   reach your document — because you asked for exactly that, by name. */
async function sendText (text, what) {
  hint('sending…')
  const res = await window.transvibe.send(text)
  hint(res.ok ? `sent ${what} to ${res.target}` : res.error)
}

/* Only one panel at a time — they occupy the same rectangle. Opening one also
   asks the main process for a taller strip and pins it awake, so it cannot go
   click-through while you are typing into it. */
const PANELS = {
  agents: { btn: null, open: renderAgents },
  help: { btn: 'help-btn', open: buildHelp },
  glossary: { btn: 'glossary-btn', open: renderGlossary },
  settings: {
    btn: 'settings-btn',
    open: () => state.settingsPanel.render(),
    // The visualizer preview animates. Closed, it would go on animating
    // against the same frame budget the real visualizer is spending.
    close: () => state.settingsPanel.suspend()
  }
}

function togglePanel (name, show) {
  const panel = $(name)
  const next = show ?? panel.hidden
  if (next) {
    for (const other of Object.keys(PANELS)) if (other !== name) togglePanel(other, false)
    PANELS[name].open()
    placePanel(panel)
  } else if (!panel.hidden && PANELS[name].close) {
    PANELS[name].close()
  }
  panel.hidden = !next
  // Not every panel has a button on the strip: agents is reached from the
  // settings panel and by voice, because eight buttons is already plenty.
  if (PANELS[name].btn) $(PANELS[name].btn).classList.toggle('on', next)
  syncHold()
  syncHeight()
}

function openPanel () {
  return Object.keys(PANELS).find(name => !$(name).hidden) || null
}

/** Whatever is open, closed — what esc does, for hands that are elsewhere. */
function closeOpenPanel () {
  const name = openPanel()
  if (name) togglePanel(name, false)
}

/* The model list is the machine's, not the app's: transvibe downloads one
   only when it cannot find any, so on a Mac that already runs another local
   whisper app every entry here belongs to that app. Sizes are shown because
   size is the trade — a small model is faster and wronger.

   "Automatic" is first and is what the setting holds by default; the readout
   beside it names the file that choice actually landed on, which is otherwise
   invisible. */
async function fieldOptions (field) {
  // A select whose choices are the schema's own — two layouts, and neither of
  // them is going to appear or vanish while the app is running.
  if (field.options === 'choices') return { options: field.choices }
  if (field.options === 'ollama') return assistModelOptions()
  if (field.options === 'voices') return voiceOptions()
  return speechModelOptions()
}

/* macOS's own voice list, cut down to the ones that speak English — 183
   installed here, 43 of them English. The lines being read are the app's own
   and are written in English; a Polish voice reading "deleted the last three
   words" is not a choice worth scrolling past forty others to avoid making.
   Region is kept, because that is the whole difference between the ones that
   are left.

   "System voice" is first and is the default: whatever `say` uses with no `-v`
   at all, which is also the way to reach a voice this filter hides — set
   `speakVoice` in settings.json by hand and the panel shows it rather than
   silently resetting it. */
const SPOKEN_LOCALE = /^en/i

async function voiceOptions () {
  const all = await window.transvibe.listVoices()
  const voices = all.filter(v => SPOKEN_LOCALE.test(v.locale))
  const options = [{ value: '', label: 'System voice' }]
  for (const v of voices) options.push({ value: v.name, label: `${v.name} · ${v.locale}` })
  if (!voices.length) options.push({ value: '', label: 'no English voices found', disabled: true })
  return { options, note: `${voices.length} English voices` }
}

/* The assist model is Ollama's, and Ollama is optional in the strongest sense:
   not running is the ordinary case, so the list says so plainly rather than
   coming up empty and looking broken. */
async function assistModelOptions () {
  const { models, reachable } = await window.transvibe.listAssistModels()
  /* What each one costs and what it did last time, on the line you choose it
     from. `thinks` rides along so the picker beside it can tell whether the
     model it has been paired with has any reasoning to switch off. */
  const options = models.map(model => ({
    value: model.name,
    label: describeModel(model),
    thinks: canThink(model)
  }))
  if (!reachable) {
    return { options, note: 'Ollama not running' }
  }
  if (!models.length) {
    return { options, note: 'nothing pulled yet' }
  }
  return { options, note: `${models.length} pulled` }
}

async function speechModelOptions () {
  const { models, inUse } = await window.transvibe.listModels()
  const options = [{ value: '', label: 'Automatic — first one found' }]
  for (const model of models) {
    options.push({
      value: model.path,
      label: `${model.name} · ${model.size} · ${model.from}`
    })
  }
  if (!models.length) {
    options.push({ value: '', label: 'no models on this Mac yet', disabled: true })
  }
  const loaded = models.find(m => m.path === inUse)
  return {
    options,
    note: loaded ? `using ${loaded.name}` : (inUse ? 'using a model not in the list' : 'none loaded')
  }
}

/* A setting is only worth a panel if changing it does something now. The main
   process already re-reads its own on every use and reapplies the ones the
   engine holds; these are the four the renderer captured at startup, plus the
   visualizer, which is cheap enough to simply rebuild.

   `language` and `modelPath` are not here: they are baked into a running
   whisper server, and the panel says so on the row rather than pretending.

   The two voice settings are here for a different reason: nothing needs
   applying — the main process reads them on every reply — but they are worth
   hearing the moment they change. */
function applyLiveSetting (key, { preview = true } = {}) {
  const value = state.settings[key]
  const capture = state.capture

  if (key === 'conversationMs' && !value) state.conversationWindow.clear()
  if (key === 'minSegmentMs' && capture) capture.setMinSegmentMs(value)
  if (key === 'threshold' && capture) capture.setThreshold(value)
  if (key === 'conversationHangoverMs' && capture) capture.setConversationHangoverMs(value)
  if (key === 'hangoverMs' && capture) capture.setHangoverMs(value)
  if (key === 'interimMs' && capture) capture.setInterimMs(value)
  if (key === 'idleFadeMs' && state.presence) state.presence.setIdleFadeMs(value)
  if (key === 'idleClearMs' && state.presence) state.presence.setIdleClearMs(value)
  /* The wait clock is built with the timeout it should give up drawing at, so
     changing that setting means building a new one. Safe to drop the old:
     nothing is in flight while the settings panel has focus. */
  if (key === 'remoteTimeoutMs') state.waiting = null
  if (preview && (key === 'speakVoice' || key === 'speakRate')) previewVoice()
  if (key.startsWith('viz')) rebuildVisualizer()
  if (key === 'layout') applyLayout()
}

function rebuildVisualizer () {
  if (!state.capture) return
  if (state.viz) state.viz.destroy()
  state.viz = createVisualizer($('viz'), {
    analyser: state.capture.analyser,
    centerRatio: 0.46,
    linesPerFamily: state.settings.vizLinesPerFamily,
    points: state.settings.vizPoints,
    fps: state.settings.vizFps,
    quietFps: state.settings.vizQuietFps
  })
  state.viz.start()
  applyLayout()
}

/* ------------------------------------------------------------------ the orb

   The orb is a second window in the corner of the screen, and it is deaf: the
   microphone, the analyser and the VAD are all here, and there is no reason to
   have two of any of them. So it gets a signal instead — a handful of numbers,
   one way, at the visualizer's own frame rate.

   Lossy on purpose. A dropped message is a dropped frame of animation, which
   is the whole of what the orb does with it. */

const ORB_BANDS = [
  [0, 0.06],      // bass: where a voice's body is
  [0.06, 0.2],    // mid: where the words are
  [0.2, 0.45]     // treble: sibilance and everything bright
]

/* The reference sketch read three band energies and nothing else, so three is
   what crosses. Only the lower half of the FFT is looked at at all: the top of
   a 2048-bin spectrum is near-silent whatever the room is doing, and averaging
   it in only drags every number toward zero. */
function bandEnergies (fft) {
  const out = [0, 0, 0]
  const len = fft.length
  if (!len) return out
  for (let b = 0; b < 3; b++) {
    const from = Math.floor(len * ORB_BANDS[b][0])
    const to = Math.max(from + 1, Math.floor(len * ORB_BANDS[b][1]))
    let sum = 0
    for (let i = from; i < to; i++) sum += fft[i]
    // The raw mean is a small number even for loud speech; the drive is the
    // same idea as the ribbon's levelGain and roughly the same size.
    out[b] = Math.min(1, (sum / ((to - from) * 255)) * 4.5)
  }
  return out
}

let orbFft = null
let orbRaf = null
let orbLast = 0

function startOrbFeed () {
  if (orbRaf || !state.capture) return
  const analyser = state.capture.analyser
  orbFft = new Uint8Array(analyser.frequencyBinCount)

  const tick = now => {
    orbRaf = requestAnimationFrame(tick)
    /* Paced like the ribbon, and for the same reason: a silent room does not
       need thirty messages a second, and the orb's own frame budget would
       throw most of them away anyway. Speaking is the VAD's answer, not the
       level's — the drive below multiplies an empty room past any threshold.
       The app talking counts as busy too: the inner ring is animating even
       though the microphone is deaf for exactly that window. */
    const speaking = state.capture.vad.state !== 'idle' || state.deaf > 0
    const rate = speaking
      ? (state.settings.vizFps || 30)
      : (state.settings.vizQuietFps || 8)
    if (now - orbLast < 1000 / Math.max(1, rate)) return
    orbLast = now

    analyser.getByteFrequencyData(orbFft)
    const [bass, mid, treble] = bandEnergies(orbFft)
    window.transvibe.orbSignal({
      bass,
      mid,
      treble,
      level: (bass + mid + treble) / 3,
      /* Active means the VAD hears something, not that the level is high:
         the drive above multiplies a quiet room past any threshold, which is
         the same reason the ribbon does not pace itself off its own level. */
      active: speaking,
      command: state.commandMode || state.liveWake,
      hue: state.agent ? state.agent.hue : undefined,
      /* The inner orb's envelope. `saying-viz` draws the strip's version of
         this; in the orb it is a smaller ring turning the other way, and all
         it needs from here is whether there is a sentence in progress. */
      saying: state.deaf > 0 ? 1 : 0,
      sayHue: state.agent ? state.agent.hue : undefined
    })
  }
  orbRaf = requestAnimationFrame(tick)
}

function stopOrbFeed () {
  if (orbRaf) cancelAnimationFrame(orbRaf)
  orbRaf = null
}

/**
 * Which visualizer is running.
 *
 * The orb carries everything the strip's two canvases carried — the room, the
 * command-mode amber, whose voice is answering, and the app's own speech — so
 * both of them go away rather than one of them staying behind to say the same
 * thing in a second place. Nothing else about the strip moves: the transcript,
 * the bubbles and the buttons stay exactly where they were.
 */
function applyLayout () {
  const orb = state.settings.layout === 'orb'
  document.body.classList.toggle('orb-layout', orb)
  if (state.viz) state.viz.setHidden(orb)
  if (orb) startOrbFeed()
  else stopOrbFeed()
}

/* --------------------------------------------------------------- dragging
   A panel is a window without a window: nothing about it can be moved by the
   system, because as far as macOS is concerned the whole strip is one
   click-through sheet. So it moves itself — grab the title bar, same as
   anything else — and the strip grows downward to keep hold of it, since the
   window is what catches the pointer and a panel drawn past its bottom edge is
   not merely clipped but unclickable. */

/** Put the panel where it was left, or back in the middle. */
function placePanel (panel) {
  const at = state.settings.panelPosition
  const view = { width: window.innerWidth, height: window.innerHeight }
  if (!isReachable(at, view)) {
    // Screens change. A position that no longer lands on one goes back to the
    // middle rather than opening somewhere you cannot reach.
    panel.classList.remove('placed')
    panel.style.left = panel.style.top = panel.style.maxHeight = ''
    return
  }
  panel.classList.add('placed')
  panel.style.left = `${at.x}px`
  panel.style.top = `${at.y}px`
  capHeight(panel, at.y)
  // Measured after the layout it just asked for, not before it: the panel is
  // only as tall as its content once that content is in it.
  requestAnimationFrame(() => askForRoom(panel, at))
}

/* A moved panel is capped against the *screen* rather than against the window.
   Its usual limit is a share of the window, which cannot be used here: the
   window grows to fit the panel, so a panel sized from the window would grow
   with it, which would grow the window again. The screen does not move when
   the window does, so measuring against it settles immediately.

   The first attempt froze the panel at whatever height it happened to be when
   it was first moved, which is how it ended up opening as a sliver: measured
   on a short tab, or a tick before its content had filled in, and then pinned
   there for good. */
function capHeight (panel, top) {
  const screenHeight = (window.screen && window.screen.availHeight) || 900
  const room = screenHeight - top - MARGIN * 2
  panel.style.maxHeight = `${Math.max(240, Math.round(room))}px`
}

function askForRoom (panel, at) {
  const box = panel.getBoundingClientRect()
  const limit = (window.screen && window.screen.availHeight) || 0
  window.transvibe.setHeight(heightFor(at, { height: box.height }, limit))
}

function startPanelDrag (event, panel) {
  // Left button only, and never from a control that lives in the title bar.
  if (event.button !== 0 || event.target.closest('button')) return
  event.preventDefault()

  const box = panel.getBoundingClientRect()
  const grabX = event.clientX - box.left
  const grabY = event.clientY - box.top
  panel.classList.add('placed', 'dragging')

  const move = e => {
    const at = clampPlacement(
      { x: e.clientX - grabX, y: e.clientY - grabY },
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
    panel.style.left = `${at.x}px`
    panel.style.top = `${at.y}px`
    capHeight(panel, at.y)
    askForRoom(panel, at)
    state.pendingPlacement = at
  }

  const done = async () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', done)
    panel.classList.remove('dragging')
    if (!state.pendingPlacement) return
    // Saved on release rather than on every pixel: a drag is one decision.
    state.settings = await saveSettings({
      panelPosition: state.pendingPlacement
    })
    state.pendingPlacement = null
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', done)
}

/** Back to the middle, for when it has been dragged somewhere regrettable. */
async function resetPanelPlacement (panel) {
  panel.classList.remove('placed')
  panel.style.left = panel.style.top = panel.style.maxHeight = ''
  state.settings = await saveSettings({ panelPosition: null })
  syncHeight()
}

function wirePanelDragging () {
  /* A moved panel changes height without anything asking it to — a taller tab,
     an agent row appearing — and the window has to follow, or the bottom of it
     is drawn outside the window and cannot be clicked. Watching the box is the
     only way to catch every cause of that. */
  const watch = new ResizeObserver(() => {
    if (document.querySelector('.panel.placed:not([hidden])')) syncHeight()
  })

  for (const head of document.querySelectorAll('.panel .panel-head')) {
    const panel = head.closest('.panel')
    head.title = 'Drag to move — double-click to put it back'
    head.addEventListener('pointerdown', e => startPanelDrag(e, panel))
    head.addEventListener('dblclick', () => resetPanelPlacement(panel))
    watch.observe(panel)
  }
}

/* One place decides whether the strip is mid-interaction: any panel, the word
   fixer, or a question waiting on a frontier model. Both the hold (stay awake)
   and the height (make room) follow from it, so they can never disagree — and
   one owner is what stops a call ending from releasing a hold that an open
   panel still wants. */
function syncHold () {
  const panel = openPanel()
  document.body.classList.toggle('panel-open', !!panel)
  /* A question that has left the machine holds it too. The strip fades after
     six seconds of quiet and a remote call is quiet for up to thirty, so
     without this the thread you are waiting on disappears mid-call. */
  const held = !!panel || !$('fixer').hidden || !!(state.waiting && state.waiting.holdsStrip)
  window.transvibe.setPanelOpen(!!panel)
  window.transvibe.setHold(held)
  if (state.presence) state.presence.setHeld(held, Date.now())
}

let recordingStatus = { active: false }
let lastRecordedDisplay = ''
function debugEvent (type, detail = {}) {
  if (recordingStatus.active) window.transvibe.debugEvent(type, detail)
}
async function saveSettings (patch) {
  if (patch.debugRecording === false) state.capture?.flushRecording()
  return window.transvibe.setSettings(patch)
}
function recordDisplay () {
  if (!recordingStatus.active) return
  const snapshot = { transcript: state.finals, interim: state.live, history: state.history,
    agent: state.agent?.name, talkingTo: state.talkingTo?.name,
    listening: state.listening, followUpOpen: inConversation(), asking: state.asking }
  const serialized = JSON.stringify(snapshot)
  if (serialized !== lastRecordedDisplay) {
    lastRecordedDisplay = serialized
    debugEvent('display', snapshot)
  }
}
function updateRecording (status) {
  recordingStatus = status
  lastRecordedDisplay = ''
  state.capture?.setRecording(status.active && state.listening)
  if (status.active && state.capture) debugEvent('capture-info', state.capture.recordingInfo)
  const button = $('recording-status')
  button.hidden = !status.active && !status.error
  button.textContent = status.error ? `Recording stopped: ${status.error}` : '● Recording locally — stop'
  button.title = status.directory || status.error || ''
  recordDisplay()
  syncHeight()
}

async function main () {
  state.settings = await window.transvibe.getSettings()
  /* What the app would hold untouched. Read once — it is compiled into the
     build, not read from anywhere that can change while this is running — and
     used by the settings panel to mark and undo the rows you have moved. */
  state.defaults = await window.transvibe.getDefaults()
  /* Read once at startup and kept fresh by the main process, because the gate
     consults it on every utterance and an IPC round trip per segment to ask
     "is a voice enrolled" would be a round trip to learn something that
     changes about once. */
  state.voiceprintStatus = await window.transvibe.voiceprintStatus()
  window.transvibe.onVoiceprintStatus(status => { state.voiceprintStatus = status })
  window.transvibe.onDebugStatus(updateRecording)
  window.transvibe.onDebugFlush(() => {
    state.capture?.flushRecording()
    window.transvibe.debugFlushed()
  })
  updateRecording(await window.transvibe.debugStatus())
  $('recording-status').onclick = async () => {
    state.settings = await saveSettings({ debugRecording: false })
  }
  await refreshSpaces()
  // Point the folder setting somewhere else and the names change with it.
  window.transvibe.onSpaces(list => { state.spaces = Array.isArray(list) ? list : [] })
  state.settingsPanel = createSettingsPanel({
    // Who you can talk to is a setting, whatever shape it is stored in, so it
    // is a tab in the settings panel rather than only a panel of its own.
    panes: new Map([['agents', pane => { renderAgents(pane) }]]),
    body: $('settings-body'),
    note: settingsNote,
    getSettings: () => state.settings,
    save: async patch => { state.settings = await saveSettings(patch) },
    applyLive: applyLiveSetting,
    open: name => togglePanel(name, true),
    getExternal: () => window.transvibe.getLaunchAtLogin(),
    setExternal: (_key, value) => window.transvibe.setLaunchAtLogin(value),
    getOptions: fieldOptions,
    actions: { enrolVoice },
    relaunch: () => window.transvibe.relaunch(),
    getDefaults: () => state.defaults,
    previews: { viz: host => createVizPreview(host, () => state.settings) }
  })
  state.presence = createPresence({
    idleFadeMs: state.settings.idleFadeMs,
    idleClearMs: state.settings.idleClearMs
  })
  state.presence.activity(Date.now())

  /* The strip is click-through until the main process says the pointer has
     settled on it. Everything interactive keys off this class, so nothing
     advertises a hit target that clicks would fall straight through. */
  window.transvibe.onAwake(value => {
    state.awake = value
    document.body.classList.toggle('awake', value)
    state.presence.setAwake(value, Date.now())
    if (!value) closeFixer()
    applyFade()
    // The button row only takes up space once it is there.
    syncHeight()
  })

  /* Mouse-move events arrive even while the strip is click-through, which is
     what makes selective wake possible: the main process only counts the
     pointer as "on the strip" when it is over something worth clicking. Empty
     air between the ribbon and the words stays transparent to the mouse. */
  const TARGETS = '.bar, .panel, .fixer, .transcript, .recording-status'
  let overTarget = null
  const reportTarget = value => {
    if (overTarget === value) return
    overTarget = value
    window.transvibe.setOverTarget(value)
  }
  document.addEventListener('mousemove', e => {
    const over = !!(e.target instanceof Element && e.target.closest(TARGETS))
    // Reaching for the strip is interest: bring a faded transcript back before
    // the pointer arrives at a word it can no longer see.
    if (over && state.presence.faded) noteActivity()
    reportTarget(over)
  })
  document.addEventListener('mouseleave', () => reportTarget(false))

  // Idle is checked on a slow timer rather than on a fresh timeout per word —
  // one interval is cheaper than restarting a timer on every interim result.
  setInterval(() => {
    const { changed, expired } = state.presence.tick(Date.now())
    if (changed) applyFade()
    /* `expired` is reported once, and forgetTranscript declines it while a
       conversation is still open — so it is asked again on every tick past
       the line. Cheap: it returns at once unless there is something to do. */
    if (expired || state.presence.expired) forgetTranscript()
    // Fires every tick rather than only on an edge: the indicator's own
    // conversation clock is cheaper to just recheck than to track.
    renderConvoIndicator()
    /* And the other clock. The second count in the pending bubble has to move
       or the wait reads as a hang, and past the threshold the app says so out
       loud — once, latched inside the module, because the premise of this app
       is that you are looking at the window you are dictating into and not at
       the strip. The 2.7s claude path never reaches it. */
    if (state.waiting && state.waiting.waiting) {
      const beat = state.waiting.tick(Date.now())
      if (beat.nudge && !turnBuffer.pending && state.capture?.vad.state === 'idle') say(state.waiting.nudgeText, { plain: true })
      render()
    }
  }, 400)

  window.transvibe.onStatus(s => {
    if (s.state === 'ready') hint(`listening · ${s.message} · ${s.mode}`)
    else if (s.state === 'downloading') {
      hint(s.progress != null
        ? `downloading model ${Math.round(s.progress * 100)}%`
        : 'downloading model…')
    } else if (s.state === 'error') hint(s.message)
  })

  const capture = await startCapture({
    settings: state.settings,
    onError: msg => hint(msg),
    onRecording: (samples, detail) => window.transvibe.debugAudio(samples, detail),
    isConversation: () => inConversation() || state.liveWake || state.asking,
    onVad: detail => {
      debugEvent('vad', detail)
      if (!state.listening || detail.deaf) return
      if (detail.boundary === 'start') turnBuffer.speechStart()
      if (detail.boundary === 'end') turnBuffer.speechEnd(detail.reason === 'discarded')
    },
    onLevel: () => {
      // pace the visualizer off the VAD rather than off its own boosted level
      if (state.viz && state.capture) {
        const speaking = state.capture.vad.state !== 'idle'
        state.viz.setActive(speaking)
        // A silent room dims the ribbon to almost nothing; the moment there is
        // something to hear it lights up. That is the whole ambient display.
        document.body.classList.toggle('quiet', !speaking)
      }
    },
    onSegment: async (samples, detail) => {
      if (!state.listening) return
      /* Reading the lines borrows the microphone wholesale: nothing said now
         is dictation, a command, or addressed to anybody. */
      if (state.enrolling) {
        const heard = await window.transvibe.transcribe(samples, false).catch(() => ({ text: '' }))
        return enrolSegment(samples, heard.text || '')
      }
      // the utterance is over: whatever interim is in flight is now stale
      state.liveSeq++
      state.pending++
      const asCommand = state.commandMode
      /* Armed with a key rather than with a name: there is nobody to address,
         so it is whoever runs commands — which is also what makes the reply
         sound like something. A key means "a command", never a question. */
      if (asCommand && (!state.agent || state.agent.kind !== 'commands')) {
        state.agent = commandAgent(state.settings.agents)
      }
      // Read staleness before the new activity clears it: this utterance is
      // what decides whether the faded transcript was the end of a thought.
      const wasStale = state.presence.stale
      noteActivity()
      render()
      /* Started before the recogniser and joined after it. Measuring the voice
         takes about a twentieth of what transcribing it does, so running the
         two together puts the whole gate inside whisper's shadow — the answer
         is already waiting by the time there are words to gate. */
      const scoring = state.settings.voiceprint && !asCommand
        ? window.transvibe.voiceprintScore(samples).catch(() => ({ score: null }))
        : null
      try {
        const res = await window.transvibe.transcribe(samples, false, detail?.retrySamples,
          inConversation() ? state.history.filter(t => t.role === 'user').slice(-2).map(t => t.content).join(' ') : '')
        debugEvent('transcript-route', { debugId: res.debugId, text: res.text, dropped: res.dropped,
          error: res.error, asCommand, followUpOpen: inConversation(), talkingTo: state.talkingTo?.name,
          wake: matchAgent(res.text, (state.settings.agents || []), { fuzzy: state.settings.wakeWordFuzzy }) })
        if (res.error) hint(res.error)
        /* Said out loud on the strip rather than dropped in silence: the floor
           is a setting, and the only way to tune it is to see it working. */
        else if (res.dropped) { hint(`ignored — ${res.dropped}`); turnBuffer.speechEnd(true) }
        else if (!res.text) { turnBuffer.speechEnd(true) }
        // Not awaited: command mode has to disarm the moment the utterance is
        // consumed, and the assist fallback may still be thinking.
        /* Armed, and by whom matters: "hey Ada" on its own arms *her*, and the
           sentence that follows is a question rather than a command that will
           fail to parse. Straight to runCommand was the bug — being armed by
           a chat agent and then told "who is the president" answered "not a
           command", which is the one thing that path must never do. */
        else if (asCommand) {
          addressAgent(state.agent, res.text).catch(err => hint(err.message))
        }
        else {
          /* Nobody armed anything: the words themselves decide. An utterance
             that opens with an agent's name is addressed to it, and — unlike
             dictation — a faded transcript is left alone, because editing
             what is already on the strip is the whole point of saying it. */
          const wake = matchAgent(res.text, (state.settings.agents || []), {
            fuzzy: state.settings.wakeWordFuzzy
          })
          /* The name was heard. Whether it was *yours* to say is a separate
             question, and it is asked only here — dictation is nobody's to
             gate, and the key path answered it by being held down.

             A voice that does not match falls through to dictation rather
             than to silence: the words still land on the strip, so a false
             reject costs you a retry instead of the sentence. */
          const voice = allowAgent({
            score: scoring ? (await scoring).score : null,
            threshold: thresholdFor(samples.length / 16000, state.settings.voiceprintThreshold),
            enabled: !!state.settings.voiceprint,
            enrolled: !!state.voiceprintStatus?.enrolled,
            commandMode: false
          })
          debugEvent('voiceprint', { ...voice, seconds: samples.length / 16000, wake: wake.matched })
          if (!voice.pass && (wake.matched || inConversation())) {
            /* Somebody else said the name. Say so on the strip — a gate that
               drops what you said without a word is the one thing that cannot
               be tuned from the outside. */
            hint(`not your voice — ${voice.score.toFixed(2)}`)
            dictate(res.text, wasStale)
          } else if (wake.matched && wake.rest) {
            state.agent = wake.agent
            addressAgent(wake.agent, wake.rest, { keep: () => dictate(res.text, wasStale) })
              .catch(err => hint(err.message))
          } else if (!wake.matched && !wake.ambiguous && inConversation()) {
            /* Still talking to whoever answered a moment ago. The name opens a
               thread rather than addressing one sentence, so "and how far is
               that from London" is a follow-up and not dictation — even if
               Trinity was borrowed for a command in between. */
            state.agent = state.talkingTo
            addressAgent(state.talkingTo, res.text).catch(err => hint(err.message))
          } else if (wake.matched) {
            // The name on its own: you are about to say the rest of it.
            state.agent = wake.agent
            if (wake.agent.kind === 'chat') {
              /* Not command mode — there is no command coming. Opening the
                 conversation window is the same thing an answer does, so what
                 follows is a question with nothing else to be mistaken for. */
              state.talkingTo = wake.agent
              state.conversationWindow.open(state.settings.conversationMs || 0)
              hint(`${wake.agent.name} is listening…`)
            } else {
              window.transvibe.setCommandMode(true)
              setCommandMode(true)
              hint(`${wake.agent.name} is listening…`)
            }
          } else if (wake.ambiguous) {
            /* Two names equally close to what was heard. Guessing is how you
               address the wrong one, so the words go down as dictation and
               you say it again. */
            hint('heard a name, but not which one')
            dictate(res.text, wasStale)
          } else dictate(res.text, wasStale)
        }
      } finally {
        state.pending--
        state.live = ''
        state.liveWake = false
        if (asCommand) {
          window.transvibe.setCommandMode(false)
          setCommandMode(false)
        }
        /* `state.agent` is deliberately *not* cleared here. The command it was
           set for is still running — nothing on this path is awaited — and the
           reply it will eventually speak has to come out in the right voice.
           The next name said overwrites it, which is the only moment the
           addressee genuinely changes. */
        render()
      }
    },

    /* Interim pass over the open utterance. At most one is in flight at a
       time, so a slow model throttles these instead of queueing them up ahead
       of the final. */
    onPartial: async samples => {
      if (!state.listening || state.interimBusy) return
      state.interimBusy = true
      const seq = ++state.liveSeq
      try {
        const res = await window.transvibe.transcribe(samples, true)
        if (seq === state.liveSeq && res.text) {
          const wake = state.commandMode
            ? { matched: false, rest: res.text }
            : matchAgent(res.text, (state.settings.agents || []), {
              fuzzy: state.settings.wakeWordFuzzy
            })
          state.liveWake = wake.matched
          // Showing the command without its keyword: what is on the strip is
          // what the parser is going to be handed.
          state.live = wake.matched ? (wake.rest || res.text) : res.text
          noteActivity()
          render()
        }
        return res
      } catch {
        /* an interim that fails is simply skipped */
      } finally {
        state.interimBusy = false
      }
    }
  })

  if (!capture) return
  state.capture = capture
  capture?.setRecording(recordingStatus.active && state.listening)
  debugEvent('capture-info', capture.recordingInfo)
  // handy from the devtools console: `state` for VAD tuning, `render` to redraw
  // after poking at it, `runCommand` to fire one without saying it out loud
  window.__transvibe = { state, render, runCommand, addressAgent, say }

  // The ribbon rides high in its canvas so it reads as hanging off the top
  // edge of the screen, with the glow spreading down over the text. Built
  // through the same path a visualizer setting change takes, so there is one
  // description of it rather than two that can drift.
  rebuildVisualizer()

  /* The other visualizer, and the only one that is not fed by a microphone:
     it draws while the app is talking, which is the one thing the mic is
     guaranteed not to be hearing. */
  state.sayingViz = createSayingViz($('say-viz'))

  /* How tall the thread may grow before the oldest bubbles scroll off. Set
     from the screen, not the window: the window is sized to its content, so
     a percentage of *it* would be measuring the thing it is limiting. */
  document.documentElement.style.setProperty('--convo-max',
    `${Math.max(200, Math.round((window.screen.availHeight || 800) * 0.5))}px`)

  $('copy').onclick = async () => {
    const text = fullText()
    if (!text) return
    await window.transvibe.copy(text)
    hint('copied')
  }

  $('clear').onclick = () => {
    const before = fullText()
    if (before) state.undoStack.push(before)
    state.finals = []
    state.live = ''
    state.liveSeq++
    clearConversation()
    render()
  }

  // The × dismisses the text rather than the window: there is no window left
  // to close, and hiding the whole strip is what the menu bar is for.
  $('close').onclick = dismiss
  $('send').onclick = doSend
  $('help-btn').onclick = () => togglePanel('help')
  $('help-close').onclick = () => togglePanel('help', false)
  $('glossary-btn').onclick = () => togglePanel('glossary')
  $('glossary-close').onclick = () => togglePanel('glossary', false)
  $('agents-close').onclick = () => togglePanel('agents', false)
  $('settings-btn').onclick = () => togglePanel('settings')
  $('settings-close').onclick = () => togglePanel('settings', false)
  wireGlossary()
  wireFixer()
  wireButtonHints()
  wirePanelDragging()

  // Anywhere outside the popover dismisses it; the transcript's own handler
  // runs first and reopens it when the click landed on another word.
  document.addEventListener('pointerdown', e => {
    if (!$('fixer').hidden && !e.target.closest('#fixer') && !e.target.closest('.w')) closeFixer()
  })

  /* Esc unwinds one layer at a time — fixer, then panel, then the transcript
     itself — so it is always the key that gets something out of the way, and
     never the key that throws away work you could still see a use for. */
  document.addEventListener('keydown', e => {
    // '?' is a character someone can legitimately type into the glossary
    // fields, so the shortcut yields whenever a text field has focus.
    const typing = e.target instanceof HTMLInputElement
    if (e.key === 'Escape') {
      // A call in flight is the topmost layer there is: it is the only one
      // that is still costing you something while you wait for it.
      if (cancelEscalation()) return
      /* Above the panels: the lines are on the strip, over everything, and
         esc is the only way out of them. */
      if (state.enrolling) return stopEnrolling('stopped — your old voiceprint is untouched')
      if (!$('fixer').hidden) return closeFixer()
      const open = openPanel()
      if (open) return togglePanel(open, false)
      dismiss()
    } else if (e.key === '?' && !typing && !openPanel()) togglePanel('help', true)
  })

  function setListening (value) {
    state.listening = value
    if (!value) turnBuffer.abort()
    state.capture?.setRecording(recordingStatus.active && value)
    debugEvent('listening', { active: value })
    $('mute').classList.toggle('on', !value)
    hint(value ? 'listening' : 'paused')
  }
  setListeningState = value => {
    setListening(value)
    window.transvibe.setListening(value)
  }

  window.transvibe.onCommandMode(active => {
    setCommandMode(active)
    if (active) hint('command — say what to do')
  })

  $('mute').onclick = () => {
    setListening(!state.listening)
    window.transvibe.setListening(state.listening)
  }

  // the menu bar can drive the same actions as the buttons
  window.transvibe.onListening(setListening)
  window.transvibe.onCommand(name => {
    if (name === 'dismiss') dismiss()
    if (name === 'copy') $('copy').click()
    if (name === 'clear') $('clear').click()
    if (name === 'send') doSend()
    if (name in PANELS) togglePanel(name, true)
  })

  render()
}

main().catch(err => hint(`startup failed: ${err.message}`))
