#!/usr/bin/env node
/**
 * Record the visualizer: docs/images/visualizer.png and visualizer.gif.
 *
 *   npm run dev &
 *   node script/make-visualizer-media.mjs
 *
 * The ribbon is the one part of the app a still cannot really show — it is a
 * band that moves with what it hears, and a frozen frame of it is a squiggle.
 * So this records it moving, and it records it hearing something real: macOS
 * `say` reads a line out loud, the microphone picks it up like any other
 * sound in the room, and the frames are whatever the app drew in response.
 * The transcript that appears in them is that sentence, actually transcribed.
 *
 * Needs ffmpeg for the GIF (`brew install ffmpeg`); the PNG is written either
 * way.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'images')

/* A fixed rectangle rather than a measured one: every frame has to be exactly
   the same size or ffmpeg has nothing to stitch. The height stays under the
   180px minimum strip height so the window can never be shorter than the clip,
   and the width is the readable middle of a screen-wide strip. */
const CLIP = { width: 1180, height: 176 }
const FPS = 12
const SECONDS = 4.5
/* Short and plainly worded on purpose. This is read out loud and transcribed
   for real, so a sentence the model is likely to get right is the difference
   between a recording of the app working and a recording of it misheard. */
const LINE = 'The words appear while you are still talking.'

const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.endsWith('index.html'))
if (!page) {
  console.error('no transvibe window on port 9333 — run `npm run dev` first')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id
  pending.set(n, { resolve, reject })
  ws.send(JSON.stringify({ id: n, method, params }))
})
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  const p = m.id && pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
}
await new Promise(r => { ws.onopen = r })

const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
const wait = ms => new Promise(r => setTimeout(r, ms))

const BACKDROP = `
  #shot-backdrop {
    position: fixed; inset: 0; z-index: -1;
    background: radial-gradient(120% 90% at 50% 0%, #14202b 0%, #0b1016 60%, #070a0e 100%);
  }`

await evaluate(`
  (() => {
    const style = document.createElement('style')
    style.id = 'shot-style'
    style.textContent = ${JSON.stringify(BACKDROP)}
    document.head.append(style)
    const bg = document.createElement('div')
    bg.id = 'shot-backdrop'
    document.body.append(bg)
    // Awake, because the buttons are part of what the strip looks like, and
    // empty, because the sentence is about to arrive on its own.
    document.body.classList.add('awake')
    document.body.classList.remove('faded')
    const s = window.__transvibe.state
    s.finals = []
    s.live = ''
    window.__transvibe.render()
    return true
  })()`)

// Centred on the screen, because the transcript is centred on the screen and
// a crop pinned to the left edge cuts the end off every sentence.
const viewW = await evaluate('document.documentElement.clientWidth')
const clip = {
  ...CLIP,
  x: Math.max(0, Math.round((viewW - CLIP.width) / 2)),
  y: 0,
  scale: 1
}
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-frames-'))
const capture = async () => (await send('Page.captureScreenshot', { format: 'png', clip })).data

// Speaking and capturing at once: the frames have to be of the app reacting,
// not of the app after the fact.
execFile('say', ['-r', '180', LINE], () => {})

const total = Math.round(FPS * SECONDS)
const interval = 1000 / FPS
let n = 0
const started = Date.now()
for (let i = 0; i < total; i++) {
  const data = await capture()
  fs.writeFileSync(path.join(frames, `f${String(n++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'))
  // Capturing takes time of its own; sleep only for what is left of the frame.
  const due = started + (i + 1) * interval
  const left = due - Date.now()
  if (left > 0) await wait(left)
}
console.log(`${n} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`)

/* The still is the frame with the most going on rather than the first one: a
   frame captured between words is a flat line, which is exactly the picture
   this is trying not to be. PNG size stands in for detail — a busy ribbon
   compresses worse than a calm one. */
const busiest = fs.readdirSync(frames)
  .map(f => ({ f, size: fs.statSync(path.join(frames, f)).size }))
  .sort((a, b) => b.size - a.size)[0]
fs.copyFileSync(path.join(frames, busiest.f), path.join(OUT, 'visualizer.png'))
console.log(`visualizer.png  from ${busiest.f}`)

try {
  const palette = path.join(frames, 'palette.png')
  const common = ['-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png')]
  execFileSync('ffmpeg', [...common, '-vf', 'scale=780:-1:flags=lanczos,palettegen=max_colors=128', palette], { stdio: 'ignore' })
  execFileSync('ffmpeg', [
    ...common, '-i', palette,
    '-lavfi', 'scale=780:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', path.join(OUT, 'visualizer.gif')
  ], { stdio: 'ignore' })
  const kb = (fs.statSync(path.join(OUT, 'visualizer.gif')).size / 1024) | 0
  console.log(`visualizer.gif  ${kb} KB`)
} catch (err) {
  console.error('no GIF (ffmpeg failed or missing):', err.message)
}

fs.rmSync(frames, { recursive: true, force: true })

await evaluate(`
  (() => {
    document.getElementById('shot-style')?.remove()
    document.getElementById('shot-backdrop')?.remove()
    return true
  })()`)
ws.close()
