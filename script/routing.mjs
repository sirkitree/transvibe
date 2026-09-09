#!/usr/bin/env node
/**
 * How well the escalation rules are doing — from both directions.
 *
 * `node script/routing.mjs`
 *
 * Two halves, and they answer different questions. The corpus replay says
 * whether the rules classify the cases somebody has already written down; it
 * needs no model, no Ollama and nothing billed, because shared/escalate.js is
 * pure. The tally says what actually happened on this machine — which rules
 * fire, and how often the frontier model then agreed with the small one
 * anyway, which is the escalation that bought nothing.
 *
 * Neither half tunes anything. Sample sizes here are a few dozen questions a
 * week from one person, and a threshold fitted to that is fitting noise; worse,
 * a phrase list you can read and predict is the reason any of this is
 * debuggable at all. So this prints, and you edit escalate.js and add a line
 * to test/routing-cases.js. That is the loop.
 */

import fs from 'node:fs'
import path from 'node:path'
import { needsFreshFacts, saysUnsure, answersAgree } from '../src/shared/escalate.js'
import { DIR } from '../src/main/config.js'
import { QUESTIONS, ANSWERS, PAIRS } from '../test/routing-cases.js'

const pct = (n, of) => of ? `${Math.round((n / of) * 100)}%` : '—'

/* One rule against its cases. `known` is counted apart rather than as a
   failure: it is a case nobody has a clean fix for, and rolling it into the
   miss count would make the number move every time somebody writes one down. */
function replay (title, cases, run, want, show) {
  const misses = []
  const known = []
  let checked = 0

  for (const item of cases) {
    const got = run(item)
    const expected = want(item)
    if (item.known) {
      known.push(item)
      continue
    }
    checked += 1
    if (got !== expected) misses.push({ item, got, expected })
  }

  console.log(`\n${title}`)
  console.log(`  ${checked - misses.length}/${checked} correct${misses.length ? '' : '  ✓'}`)
  for (const { item, got, expected } of misses) {
    console.log(`  ✗ ${show(item)}`)
    console.log(`      wanted ${expected}, got ${got}`)
  }
  for (const item of known) {
    console.log(`  ~ known gap: ${show(item)}`)
    console.log(`      ${item.known}`)
  }
}

console.log('THE CORPUS — test/routing-cases.js, replayed against the rules')

replay('needsFreshFacts', QUESTIONS,
  q => needsFreshFacts(q.ask), q => q.route === 'fresh', q => q.ask || '(nothing)')

replay('saysUnsure', ANSWERS,
  a => saysUnsure(a.said), a => a.unsure, a => a.note || a.said.slice(0, 64) || '(nothing)')

replay('answersAgree', PAIRS,
  p => answersAgree(p.a, p.b), p => p.agree, p => `${p.a} / ${p.b}`)

/* ------------------------------------------------------------------ */

console.log('\n\nTHIS MACHINE — settings.json, since the counters were added')

const file = path.join(DIR, 'settings.json')
if (!fs.existsSync(file)) {
  console.log('\n  no settings file yet — the app has not been run.\n')
  process.exit(0)
}

const stats = (JSON.parse(fs.readFileSync(file, 'utf8')).routingStats) || {}
const rows = Object.entries(stats)
if (!rows.length) {
  console.log('\n  nothing counted yet. Ask an agent something.\n')
  process.exit(0)
}

/* What each row means, because "differed: 3" on its own is a number and not a
   finding. The reading is in the last column. */
const MEANS = {
  kept: 'answered here, nothing sent out',
  direct: 'you asked a CLI by name — not the router',
  pass: 'the model said it could not answer',
  unsure: 'the model hedged',
  failed: 'no answer came back',
  empty: 'the model replied with nothing',
  fresh: 'a question with a date on it',
  asked: 'you reached past the router yourself'
}

console.log('\n  reason    fired  agreed  differed   ')
for (const [reason, row] of rows.sort((a, b) => b[1].fired - a[1].fired)) {
  const judged = row.agreed + row.differed
  console.log(`  ${reason.padEnd(9)} ${String(row.fired).padStart(4)}` +
    `  ${String(row.agreed).padStart(5)}  ${String(row.differed).padStart(7)}   ` +
    `${MEANS[reason] || ''}`)
  if (judged) {
    console.log(`            ${pct(row.agreed, judged)} of the ${judged} that could be compared ` +
      'said the same thing as the local model')
  }
}

const unsure = stats.unsure
if (unsure && unsure.agreed + unsure.differed >= 10) {
  const judged = unsure.agreed + unsure.differed
  console.log(`\n  ${unsure.agreed} of ${judged} hedges escalated to the same answer. ` +
    'If that fraction is high,\n  HEDGES or LEAD_WORDS in escalate.js is too loose — ' +
    'it is throwing away answers\n  that were already right.')
}

if (stats.asked && stats.asked.differed) {
  console.log(`\n  You asked for a better answer ${stats.asked.fired} times and got a different one ` +
    `${stats.asked.differed}.\n  Those are escalations the rules should have made and did not. ` +
    'Turn on\n  debugRouting to catch the next one with its question attached.')
}

console.log()
