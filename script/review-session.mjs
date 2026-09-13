#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEvents, reviewHtml } from '../src/main/debug-review.js'

const root = path.join(os.homedir(), 'Library/Application Support/transvibe/recordings')
const args = process.argv.slice(2)
const follow = args.includes('--follow')
const requested = args.find(a => a !== '--follow')
const names = !requested || requested === 'latest'
  ? fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'events.jsonl'))).sort() : []
const dir = requested && requested !== 'latest' ? path.resolve(requested) : names.length ? path.join(root, names.at(-1)) : null
if (!dir) throw new Error('No recorded sessions yet. Turn on debug recording in Advanced settings.')
const log = path.join(dir, 'events.jsonl')
let seen = 0
function review () {
  const events = parseEvents(fs.readFileSync(log, 'utf8'))
  fs.writeFileSync(path.join(dir, 'review.html'), reviewHtml(events), { mode: 0o600 })
  if (follow) {
    for (const event of events.slice(seen)) {
      if (['conversation-question', 'conversation-answer', 'transcript-route', 'speech-error'].includes(event.type)) console.log(JSON.stringify(event))
    }
  }
  seen = events.length
}
review()
const notes = path.join(dir, 'notes.md')
if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Session review notes\n\nFor each issue, record the event time or debugId.\n\n- What I actually said:\n- What appeared on the strip:\n- Intended addressee / action:\n- What Mira answered:\n- What a better answer should do:\n- Evidence vs inference:\n- Proposed settings, prompt, model, or code change:\n- Regression example to retain:\n', { mode: 0o600 })
console.log(path.join(dir, 'review.html'))
if (follow) fs.watchFile(log, { interval: 1000 }, () => { try { review() } catch (err) { console.error(err.message) } })
