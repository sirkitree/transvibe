#!/usr/bin/env node
/**
 * Enrol a voice, and find the threshold that separates it from everyone else.
 *
 *   node script/voiceprint.mjs enrol     — enrol from this app's own recordings
 *   node script/voiceprint.mjs score     — score every recorded utterance
 *   node script/voiceprint.mjs forget    — throw the profile away
 *
 * Enrolment needs about a minute of you talking, and it already exists: debug
 * recording writes one wav per utterance, so the corpus is whatever you have
 * already said to this app. The five longest are the profile — longest because
 * a long utterance carries more of a voice than a short one does, and five
 * because that is where the benchmark stops improving.
 *
 * `score` is the half that matters afterwards. It prints every utterance the
 * recordings hold, ranked, so the threshold is chosen by looking at where the
 * gap actually falls on this microphone in this room rather than by trusting
 * the default. Anything you recognise as somebody else scoring near your own
 * utterances is the number to raise the threshold above.
 */

import fs from 'node:fs'
import path from 'node:path'
import * as config from '../src/main/config.js'
const { DIR } = config
import { createVoiceprint, modelReady, downloadModel, MODEL_PATH } from '../src/main/voiceprint.js'
import { ENROLL_TARGET, ENROLL_MIN_SECONDS } from '../src/shared/voiceprint-gate.js'

const RECORDINGS = path.join(DIR, 'recordings')

/** 16-bit PCM wav → Float32Array, which is what the extractor wants. */
function readWav (file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  // walk the chunks rather than assuming a 44-byte header
  let at = 12, dataAt = 0, dataLen = 0, bits = 16, channels = 1
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') { channels = buf.readUInt16LE(at + 10); bits = buf.readUInt16LE(at + 22) }
    if (id === 'data') { dataAt = at + 8; dataLen = Math.min(size, buf.length - dataAt); break }
    at += 8 + size + (size & 1)
  }
  if (!dataAt || bits !== 16 || channels !== 1) return null
  const out = new Float32Array(dataLen >> 1)
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(dataAt + i * 2) / 32768
  return out
}

/** Every utterance wav the recordings hold, with whatever was transcribed. */
function utterances () {
  if (!fs.existsSync(RECORDINGS)) return []
  const rows = []
  for (const session of fs.readdirSync(RECORDINGS).sort()) {
    const dir = path.join(RECORDINGS, session)
    if (!fs.statSync(dir).isDirectory()) continue
    const text = new Map()
    const events = path.join(dir, 'events.jsonl')
    if (fs.existsSync(events)) {
      for (const line of fs.readFileSync(events, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line)
          if (e.type === 'transcription-result' && e.debugId) text.set(e.debugId, (e.text || '').trim())
        } catch { /* a half-written line at the end of an interrupted session */ }
      }
    }
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('utterance-') || !file.endsWith('.wav')) continue
      const samples = readWav(path.join(dir, file))
      if (!samples) continue
      rows.push({
        session: session.slice(0, 19),
        seconds: samples.length / 16000,
        text: text.get(file.slice(10, -4)) || '',
        samples
      })
    }
  }
  return rows
}

async function ensureModel () {
  if (modelReady()) return true
  process.stdout.write('downloading the speaker model (27 MB)… ')
  try {
    await downloadModel(p => process.stdout.write(`\rdownloading the speaker model (27 MB)… ${Math.round(p * 100)}%  `))
    console.log('\rdownloading the speaker model (27 MB)… done   ')
    return true
  } catch (err) {
    console.error(`\nfailed: ${err.message}`)
    console.error(`put the file at ${MODEL_PATH} by hand if the download is blocked.`)
    return false
  }
}

const vp = createVoiceprint({ onError: m => console.error(m) })
const command = process.argv[2] || 'score'

if (command === 'forget') {
  vp.forget()
  /* Off as well as forgotten. Leaving the setting on with no profile behind
     it is the state where the gate looks armed and does nothing. */
  config.save({ voiceprint: false })
  console.log('profile forgotten, and "Only answer to my voice" switched off.')
  process.exit(0)
}

if (!await ensureModel()) process.exit(1)

const all = utterances()
if (!all.length) {
  console.error(`no recordings under ${RECORDINGS}.`)
  console.error('turn on debug recording in settings, talk to the app for a minute, then run this again.')
  process.exit(1)
}

if (command === 'enrol' || command === 'enroll') {
  /* The corpus is not all you. Debug recording captures whatever the
     microphone heard, and a call coming out of the speakers transcribes just
     as willingly as you do — "- Yeah." over eleven seconds is a meeting, not a
     sentence. Picking the longest utterances with words in them picks those
     first, which would enrol the room.

     So nothing is trusted about *which* utterance is yours. Every candidate
     is measured against every other, and the largest group that agrees with
     itself wins. That group is you by weight of evidence: these are your
     recordings of your app, and whoever turns up in most of them is whoever
     has been using it. A visitor appears a handful of times and falls out. */
  const usable = all.filter(u => u.seconds >= ENROLL_MIN_SECONDS && u.text)
  if (usable.length < ENROLL_TARGET) {
    console.error(`only ${usable.length} usable utterances — ${ENROLL_TARGET} wanted. Talk to the app a little more first.`)
    process.exit(1)
  }

  process.stdout.write(`measuring ${usable.length} utterances… `)
  const vectors = usable.map(u => vp.embed(u.samples))
  const keep = usable.map((u, i) => ({ ...u, v: vectors[i] })).filter(u => u.v)
  console.log('done')

  const cos = (a, b) => {
    let d = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
  }
  /* How many others each utterance sounds like. The same speaker recorded
     twice scores far above 0.4; two different people score near zero, so the
     count is not sensitive to exactly where this sits. */
  const AGREE = 0.4
  const friends = keep.map(u => keep.filter(o => o !== u && cos(u.v, o.v) >= AGREE).length)
  const best = friends.indexOf(Math.max(...friends))
  const anchor = keep[best]
  const mine = keep.filter(u => cos(anchor.v, u.v) >= AGREE)

  if (mine.length < ENROLL_TARGET) {
    console.error(`\nthe largest group of similar-sounding utterances has only ${mine.length}.`)
    console.error('that usually means the recordings are mostly other people, or mostly noise.')
    process.exit(1)
  }
  const outsiders = keep.length - mine.length
  console.log(`${mine.length} of ${keep.length} utterances sound like the same person` +
    (outsiders ? `; ${outsiders} left out as somebody else` : ''))

  /* Longest first *within* the group — length helps, but only once the
     question of whose voice it is has already been settled. */
  const chosen = mine.sort((a, b) => b.seconds - a.seconds).slice(0, ENROLL_TARGET)
  console.log(`\nenrolling from ${chosen.length} utterances (${chosen.reduce((a, u) => a + u.seconds, 0).toFixed(0)}s):`)
  for (const u of chosen) console.log(`  ${u.seconds.toFixed(1)}s  "${u.text.slice(0, 60)}"`)
  if (outsiders) {
    console.log('\nleft out (check none of these are you):')
    for (const u of keep.filter(u => !mine.includes(u)).slice(0, 6)) {
      console.log(`  ${u.seconds.toFixed(1)}s  "${u.text.slice(0, 50)}"`)
    }
  }

  const result = vp.enroll(chosen.map(u => u.samples))
  if (!result.ok) { console.error(`\nfailed: ${result.error}`); process.exit(1) }
  /* Enrolling is the moment the setting can be switched on and mean
     something: before it there was no voice to compare against. The app reads
     settings.json at startup, so this takes effect on the next launch. */
  const settings = config.load()
  if (!settings.voiceprint) {
    config.save({ voiceprint: true })
    console.log(`\nenrolled from ${result.count} utterances, and "Only answer to my voice" is now on.`)
    console.log('restart the app for it to pick that up.')
  } else {
    console.log(`\nenrolled from ${result.count} utterances. The setting was already on.`)
  }
  console.log('run `node script/voiceprint.mjs score` and check the gap before trusting the threshold.')
  process.exit(0)
}

/* score */
if (!vp.status.enrolled) {
  console.error('nothing enrolled yet — run `node script/voiceprint.mjs enrol` first.')
  process.exit(1)
}

const scored = all.map((u, i) => ({ ...u, score: vp.probe([u.samples])[0].score }))
  .filter(u => Number.isFinite(u.score))
  .sort((a, b) => b.score - a.score)

console.log(`\n${scored.length} utterances, highest score first. Everything above the gap should be you.\n`)
let previous = null
for (const u of scored) {
  /* The gap is the whole point, so it is drawn rather than described: one
     rule at the widest fall between two consecutive scores. */
  if (previous !== null && previous - u.score > 0.15) {
    const mid = (previous + u.score) / 2
    console.log(`  ${'─'.repeat(58)}  ← widest gap, threshold ${mid.toFixed(2)}`)
  }
  console.log(`  ${u.score.toFixed(3)}  ${u.seconds.toFixed(1).padStart(5)}s  ${u.session}  "${u.text.slice(0, 44)}"`)
  previous = u.score
}

const byLength = [[0, 1.5], [1.5, 2.5], [2.5, 4], [4, Infinity]]
console.log('\nby utterance length — short ones always score lower:')
for (const [lo, hi] of byLength) {
  const b = scored.filter(u => u.seconds >= lo && u.seconds < hi)
  if (!b.length) continue
  const avg = b.reduce((a, u) => a + u.score, 0) / b.length
  console.log(`  ${lo}–${hi === Infinity ? '∞' : hi}s  n=${String(b.length).padStart(3)}  avg ${avg.toFixed(3)}  min ${Math.min(...b.map(u => u.score)).toFixed(3)}`)
}
console.log('\nset the threshold below your own worst utterance and above anybody else\'s best.')
console.log('Settings › Agents › “How closely the voice must match”.')
