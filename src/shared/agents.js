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
 * A chat agent also says where it thinks. `provider` is 'local' for the Ollama
 * model on this machine, or the name of a CLI already signed in on this Mac —
 * 'claude', 'codex' — that gets spawned with the question and bills against a
 * subscription rather than an API key. `escalateTo` is the name of another
 * agent to hand a question to when this one cannot answer it, which is how a
 * small local model that admits it does not know stops being a dead end.
 *
 * Those two together are the only path by which anything said in this room
 * leaves the machine, and they are per-agent for that reason: it has to be
 * visible which name is the one that goes out.
 *
 * Pure — no DOM, no Electron, no I/O. Both sides need it: the main process to
 * migrate the file, the renderer to route an utterance.
 */

export const KINDS = ['commands', 'chat', 'external']

/* The model an agent gets when nothing else says otherwise: small, fast, and
   the one the app used to hold as a single global setting. There is no global
   any more — a model belongs to whoever is thinking with it. */
export const DEFAULT_MODEL = 'gemma4:e2b'

/* Where an agent thinks. 'local' is Ollama on this machine and is what every
   agent has been until now; the other two are command-line tools already
   signed in on this Mac, spawned with the question so the answer comes out of
   a subscription the user is already paying for. */
export const PROVIDERS = ['local', 'claude', 'codex']

/* The model each provider gets when nobody has said otherwise.

   Null means two different things here, and both are right. For 'local' it is
   "the default in Advanced" — the app has one and the agent has not overridden
   it. For 'codex' there is nothing to override: the codex CLI picks its own
   model from its own config, and naming one here would only be a way to get it
   wrong. */
export const DEFAULT_MODELS = {
  local: DEFAULT_MODEL,
  claude: 'claude-sonnet-5',
  codex: null
}

/** Whether answering as this agent means leaving the machine. */
export function isRemote (agent) {
  const provider = agent && typeof agent === 'object' ? agent.provider : null
  return provider === 'claude' || provider === 'codex'
}

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
  /* Same defensive shape as `kind`, and for a stronger reason: a provider this
     version does not know about must not be treated as "some remote thing" and
     handed a sentence. Anything unrecognised is local. */
  const provider = PROVIDERS.includes(source.provider) ? source.provider : 'local'
  return {
    name,
    kind,
    provider,
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
       choose. Null means the default in Advanced.

       A remote provider falls back to its own default instead, because
       `claude --model gemma4:e2b` is not a thing that runs — and a local agent
       keeps falling back to null rather than to DEFAULT_MODELS.local, because
       null there means "whatever Advanced says", which is not the same as
       pinning the name Advanced happens to hold today. */
    model: text(source.model) || (provider === 'local' ? null : DEFAULT_MODELS[provider]),
    /* The agent to hand the question to when this one cannot answer it — by
       name, so it survives being reordered in the panel, and normalised the
       same way `name` is so the two can be compared. normalizeRoster is what
       makes sure the name still points at somebody. */
    escalateTo: text(source.escalateTo) || null,
    /* Whether that model is allowed to think before it answers.
   
       Only a chat agent uses it. The other three jobs a model does here —
       tidying an utterance, guessing a command, shortening a confirmation —
       are mechanical rewrites on a tight clock, and reasoning through one
       costs a second for nothing.
   
       On by default for a chat agent and off for the rest, which is both the
       useful default and the safe one: measured on qwen3:30b-a3b, asking for
       no reasoning does not stop it reasoning, it only stops the reasoning
       being kept separate — the whole chain of thought arrives in the answer
       and gets said out loud. */
    thinking: typeof source.thinking === 'boolean' ? source.thinking : kind === 'chat',
    run: kind === 'external' ? (text(source.run) || null) : null
  }
}

/**
 * The whole roster, in the order it will be matched.
 *
 * Duplicates by name are dropped rather than merged: two agents answering to
 * one name is a question with no right answer, and the first one wins for the
 * same reason the first one is listed.
 *
 * An escalateTo naming nobody on the roster is dropped here, and so is one
 * naming its own agent. A dangling reference is worse than a lost setting: it
 * costs nothing until the moment the local model gives up, and then it fails
 * in the one place it was there to cover. Losing it at least leaves the panel
 * showing the truth.
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
  for (const agent of out) {
    if (!agent.escalateTo) continue
    const target = agent.escalateTo.toLowerCase()
    if (target === agent.name.toLowerCase() || !seen.has(target)) agent.escalateTo = null
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
  return normalizeRoster(roster).map((agent, i) => normalizeAgent({
    ...agent,
    // Only the local ones: the setting being carried forward was an Ollama
    // model name, and a codex agent with no model has not forgotten one, it
    // has left the choice to the CLI.
    model: isRemote(agent) ? agent.model : (agent.model || fallback)
  }, i))
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
  // rather than with nothing and a dropdown you have to notice — unless it was
  // asked for on a provider of its own, where the rest of them are thinking
  // with a model that provider has never heard of.
  const seed = PROVIDERS.includes(raw && raw.provider) && raw.provider !== 'local'
    ? {}
    : { model: defaultModel(agents) }
  const agent = normalizeAgent({ ...seed, ...raw, name }, agents.length)
  // Back through normalizeRoster so an escalateTo that came in naming nobody
  // does not get onto the list in the first place.
  return { ok: true, agents: normalizeRoster([...agents, agent]) }
}

/**
 * Change one field, or several, on the agent with this name.
 *
 * A rename is a change like any other, except that it can collide — and a
 * roster with two agents answering to one name is a question with no right
 * answer, so it is refused rather than resolved.
 *
 * It is also the one change that can reach outside the record being changed:
 * anyone escalating to the old name is rewritten to the new one. Left alone
 * the rename would take the fallback away without saying so, and the only
 * place that shows up is a question that quietly stops being answered.
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

  /* Changing where an agent thinks changes what a model name means, so a model
     the patch did not mention is dropped rather than carried across: an Ollama
     tag left behind on a claude agent is a flag its CLI will refuse. */
  if (next.provider !== agents[index].provider && !(patch && 'model' in patch)) {
    next.model = null
  }

  const was = agents[index].name
  const out = agents.map((agent, i) => {
    if (i === index) return normalizeAgent(next, i)
    return same(agent.escalateTo, was) ? { ...agent, escalateTo: renamed } : agent
  })
  return { ok: true, agents: normalizeRoster(out) }
}

/**
 * Take one off the list.
 *
 * The last agent that runs commands is kept: removing it would leave the
 * spoken route with nothing to answer to and no way back except the keyboard,
 * which is not a state anyone means to be in. Rename it instead.
 *
 * Anyone who was escalating to the one that goes is left escalating to nobody,
 * which is the honest answer: the agent it was handing questions to is gone,
 * and a name still sitting in that field would only promise otherwise.
 */
export function removeAgent (roster, name) {
  const agents = normalizeRoster(roster)
  const victim = agents.find(a => same(a.name, name))
  if (!victim) return { ok: false, agents, error: 'no such agent' }

  const out = agents.filter(a => a !== victim)
  if (victim.kind === 'commands' && !out.some(a => a.kind === 'commands')) {
    return { ok: false, agents, error: 'the last agent that runs commands stays — rename it instead' }
  }
  return {
    ok: true,
    agents: out.map(a => (same(a.escalateTo, victim.name) ? { ...a, escalateTo: null } : a))
  }
}
