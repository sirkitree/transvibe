/**
 * Who you can talk to.
 *
 * The app used to have one wake phrase and one behaviour behind it. A name is a
 * better unit than a phrase: "Mira, delete that" and "Ada, what's a leap year"
 * are different requests to different things, and saying which one you mean is
 * something you were already doing anyway. So a wake phrase became a roster,
 * and each name carries what happens when you use it.
 *
 *   commands   the editing and settings parser — everything the app did before
 *   chat       a local model, answering out loud
 *   external   reserved: a name that hands the sentence to another program
 *              entirely. Defined here so the record does not have to change
 *              shape later; refused at the point of use until it exists.
 *
 * Voice, rate and hue live on the agent rather than in one global setting, so
 * an answer says who it came from three ways: the words, the voice speaking
 * them, and the colour of the ribbon while they are spoken.
 *
 * Pure — no DOM, no Electron, no I/O. Both sides need it: the main process to
 * migrate the file, the renderer to route an utterance.
 */

export const KINDS = ['commands', 'chat', 'external']

/* The model an agent gets when nothing else says otherwise: small, fast, and
   the one the app used to hold as a single global setting. There is no global
   any more — a model belongs to whoever is thinking with it. */
export const DEFAULT_MODEL = 'gemma4:e2b'

/* Hues around the wheel, far enough apart to be told apart at a glance, and
   assigned in order to agents that have not been given one. Warm first, and
   the strip's own green last: an agent's colour is what the speaking ribbon
   wears, and the first thing it must not look like is the listening ribbon
   above it. */
export const HUES = [0.03, 0.55, 0.72, 0.14, 0.86, 0.38]

/** The next colour along, for cycling through them by hand. */
export function nextHue (current) {
  const at = HUES.findIndex(h => Math.abs(h - current) < 0.001)
  return HUES[(at + 1) % HUES.length]
}

const text = v => (typeof v === 'string' ? v.trim() : '')

const finite = (v, fallback = null) => (Number.isFinite(v) ? v : fallback)

/** Wrapped into [0, 1) so a hue given in the wrong unit still draws something. */
function hue (v, index) {
  if (!Number.isFinite(v)) return HUES[index % HUES.length]
  const w = v % 1
  return w < 0 ? w + 1 : w
}

/**
 * One agent record, filled in and made safe to use.
 *
 * @param {object} raw    whatever was in the file
 * @param {number} index  its position, which decides its colour if it has none
 * @returns {object|null} null when there is no name, because a nameless agent
 *   can never be addressed and would only sit in the panel confusing people
 */
export function normalizeAgent (raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const name = text(source.name)
  if (!name) return null

  const kind = KINDS.includes(source.kind) ? source.kind : 'commands'
  return {
    name,
    kind,
    // Null means "whatever the app is set to" rather than a value of its own.
    voice: text(source.voice) || null,
    // null and '' both mean "inherit", and Number() turns both into a very
    // finite zero — which would read as a rate the agent had chosen.
    rate: source.rate == null || source.rate === '' ? null : finite(Number(source.rate), null),
    hue: hue(Number(source.hue), index),
    /* The local model this one uses. A chat agent answers with it; an agent
       that runs commands hands it the misses — working out what an unrecognised
       command meant, and shortening a confirmation into something worth
       hearing. Both are that agent's thinking, so both are its model to
       choose. Null means the default in Advanced. */
    model: text(source.model) || null,
    run: kind === 'external' ? (text(source.run) || null) : null
  }
}

/**
 * The whole roster, in the order it will be matched.
 *
 * Duplicates by name are dropped rather than merged: two agents answering to
 * one name is a question with no right answer, and the first one wins for the
 * same reason the first one is listed.
 */
export function normalizeRoster (list) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const agent = normalizeAgent(raw, out.length)
    if (!agent) continue
    const key = agent.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(agent)
  }
  return out
}

/**
 * The roster a settings file describes, including one that predates rosters.
 *
 * Anyone running this app already has a wake phrase they are used to saying,
 * and it must keep working across the update without being retyped — so a file
 * with no `agents` becomes a roster of one, wearing the name it already had.
 *
 * @param {object} settings
 * @returns {object[]}
 */
export function migrateRoster (settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const roster = normalizeRoster(source.agents)
  if (roster.length) return roster

  const legacy = text(source.wakeWord)
  return legacy ? normalizeRoster([{ name: legacy, kind: 'commands' }]) : []
}

/**
 * The model each agent thinks with, filled in from the setting that used to
 * hold one for all of them.
 *
 * Same shape of migration as the wake phrase: what someone had configured has
 * to survive becoming a per-agent choice, and then the old key goes, so there
 * is one place that answers "which model" rather than two that can disagree.
 */
export function migrateModels (roster, legacyModel) {
  const fallback = text(legacyModel) || DEFAULT_MODEL
  return normalizeRoster(roster).map((agent, i) =>
    normalizeAgent({ ...agent, model: agent.model || fallback }, i))
}

/**
 * How this agent should sound, falling back to the app's own voice.
 *
 * The fallback is not a formality: a command armed with the key rather than
 * with a name has no agent to ask, and it still has to sound like something.
 */
export function speechFor (agent, settings = {}) {
  const from = agent && typeof agent === 'object' ? agent : {}
  return {
    voice: from.voice || settings.speakVoice || null,
    rate: Number.isFinite(from.rate) ? from.rate : (settings.speakRate || 0)
  }
}

/** The first agent that runs commands, for the paths that have no name to go
    on — the hold-a-key route, and anything the menu bar fires. */
export function commandAgent (roster) {
  const list = Array.isArray(roster) ? roster : []
  return list.find(a => a.kind === 'commands') || null
}

/**
 * The model to think with when nobody was addressed.
 *
 * Tidying dictation is the case: it is not a reply to anyone, it happens to
 * text you were dictating rather than saying to a name. The agent that runs
 * commands is the app as far as anyone is concerned, so its model is the one
 * the app uses when it is being nobody in particular.
 */
export function defaultModel (roster) {
  const first = commandAgent(roster) || (Array.isArray(roster) ? roster[0] : null)
  return (first && first.model) || DEFAULT_MODEL
}

/* ------------------------------------------------------------------ *
 * editing the roster
 * ------------------------------------------------------------------ */

/* Same shape as the glossary's edit rules, for the same reason: every failure
   here is something someone typed and needs to be told about, not an exception
   to throw. `{ ok, agents, error }` in and out, and the panel shows the error. */

const same = (a, b) => text(a).toLowerCase() === text(b).toLowerCase()

/**
 * @param {object[]} roster
 * @param {object} raw the new agent — a name at minimum
 */
export function addAgent (roster, raw) {
  const agents = normalizeRoster(roster)
  const name = text(raw && raw.name)
  if (!name) return { ok: false, agents, error: 'a name is the one thing it needs' }
  if (agents.some(a => same(a.name, name))) {
    return { ok: false, agents, error: `${name} is already on the list` }
  }
  // A new name starts out thinking with whatever the rest of them think with,
  // rather than with nothing and a dropdown you have to notice.
  const agent = normalizeAgent(
    { model: defaultModel(agents), ...raw, name }, agents.length)
  return { ok: true, agents: [...agents, agent] }
}

/**
 * Change one field, or several, on the agent with this name.
 *
 * A rename is a change like any other, except that it can collide — and a
 * roster with two agents answering to one name is a question with no right
 * answer, so it is refused rather than resolved.
 */
export function updateAgent (roster, name, patch) {
  const agents = normalizeRoster(roster)
  const index = agents.findIndex(a => same(a.name, name))
  if (index < 0) return { ok: false, agents, error: 'no such agent' }

  const next = { ...agents[index], ...(patch && typeof patch === 'object' ? patch : {}) }
  const renamed = text(next.name)
  if (!renamed) return { ok: false, agents, error: 'a name is the one thing it needs' }
  if (agents.some((a, i) => i !== index && same(a.name, renamed))) {
    return { ok: false, agents, error: `${renamed} is already on the list` }
  }

  const out = agents.slice()
  out[index] = normalizeAgent(next, index)
  return { ok: true, agents: out }
}

/**
 * Take one off the list.
 *
 * The last agent that runs commands is kept: removing it would leave the
 * spoken route with nothing to answer to and no way back except the keyboard,
 * which is not a state anyone means to be in. Rename it instead.
 */
export function removeAgent (roster, name) {
  const agents = normalizeRoster(roster)
  const victim = agents.find(a => same(a.name, name))
  if (!victim) return { ok: false, agents, error: 'no such agent' }

  const out = agents.filter(a => a !== victim)
  if (victim.kind === 'commands' && !out.some(a => a.kind === 'commands')) {
    return { ok: false, agents, error: 'the last agent that runs commands stays — rename it instead' }
  }
  return { ok: true, agents: out }
}
