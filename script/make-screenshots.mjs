#!/usr/bin/env node
/**
 * Take the screenshots in docs/images/, so they can be retaken rather than
 * being a set of files nobody remembers how to reproduce.
 *
 * Run `npm run dev` first — this drives that instance over its CDP port.
 *
 *   npm run dev &
 *   node script/make-screenshots.mjs
 *
 * The strip is a transparent, click-through window: capturing it as it really
 * sits means capturing whatever happens to be on the screen behind it, which
 * is nobody's business and different every time. So each shot puts a plain
 * dark backdrop behind the page for the length of the capture and takes it
 * away again. Everything in front of that backdrop is the real app in a real
 * state — the transcript is pushed in through the same path a finished
 * utterance takes, and the panels are opened by clicking their buttons.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images')
const PAD = 26            // breathing room around the captured element

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

/* A HUD with no window of its own has nothing to sit on in a screenshot. This
   is the closest honest thing: a flat dark surface, the sort of window it
   normally hangs over. */
const BACKDROP = `
  #shot-backdrop {
    position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(120% 90% at 50% 0%, #14202b 0%, #0b1016 60%, #070a0e 100%);
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
  })()
`)

/**
 * @param {string} name  file written as docs/images/<name>.png
 * @param {string|string[]} selector element(s) the shot is framed around; more
 *   than one is framed around the union, which is how a popover that hangs
 *   below the strip stays in the picture.
 * @param {string} setup expression run first, to put the app in the state
 */
async function shot (name, selector, setup = 'true', { width } = {}) {
  const selectors = Array.isArray(selector) ? selector : [selector]
  await evaluate(setup)
  await wait(700)
  const box = await evaluate(`
    (() => {
      const rects = ${JSON.stringify(selectors)}
        .map(s => document.querySelector(s))
        .filter(el => el && !el.hidden)
        .map(el => el.getBoundingClientRect())
      const left = Math.min(...rects.map(r => r.left))
      const right = Math.max(...rects.map(r => r.right))
      const top = Math.min(...rects.map(r => r.top))
      const bottom = Math.max(...rects.map(r => r.bottom))
      return {
        x: left, y: top, width: right - left, height: bottom - top,
        viewW: document.documentElement.clientWidth,
        viewH: document.documentElement.clientHeight
      }
    })()
  `)
  // The stage is as wide as the screen while the thing worth looking at is a
  // few hundred pixels in the middle of it. A narrower crop, centred, is the
  // difference between a readable image and a letterbox.
  const w = Math.min(width ?? box.width + PAD * 2, box.viewW)
  const x = Math.max(0, Math.min(box.x + box.width / 2 - w / 2, box.viewW - w))
  const y = Math.max(0, box.y - PAD)
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: {
      x,
      y,
      width: w,
      height: Math.min(box.height + PAD * 2, box.viewH - y),
      scale: 2          // retina, so the text is not soft on a retina screen
    }
  })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`${name}.png  ${box.width | 0}×${box.height | 0}`)
}

/* Sample text rather than a live recording: a screenshot has to say the same
   thing every time it is taken, and this is the shape of a real transcript —
   a couple of settled sentences with the in-flight one still highlighted. */
const say = (finals, live = '') => `
  (() => {
    const s = window.__transvibe.state
    s.finals = ${JSON.stringify(finals)}
    s.live = ${JSON.stringify(live)}
    s.presence.activity(Date.now())
    document.body.classList.add('awake')
    document.body.classList.remove('faded')
    window.__transvibe.render()
    return true
  })()`

const closePanels = `
  (() => {
    for (const id of ['settings', 'glossary', 'help']) {
      const close = document.getElementById(id + '-close')
      if (!document.getElementById(id).hidden) close.click()
    }
    document.getElementById('fixer').hidden = true
    return true
  })()`

/* The microphone is open while this runs, and an interim result landing
   between setting the transcript and taking the shot would wipe it. Pausing is
   the same thing the mute button does. */
await evaluate(`
  (() => {
    window.__shotWasListening = window.__transvibe.state.listening
    if (window.__shotWasListening) document.getElementById('mute').click()
    // Pausing lights the mic button, and a screenshot of the ordinary state
    // should not show it lit. The class is put back at the end.
    document.getElementById('mute').classList.remove('on')
    return true
  })()`)

/* The status line is a live thing — the last hover description, or whatever
   the engine last said. Each shot sets it to what it would plausibly read. */
const hint = text => `document.getElementById('hint').textContent = ${JSON.stringify(text)}`

fs.mkdirSync(OUT, { recursive: true })

await shot('strip', '.stage', `
  ${say(
    ['Clicks land in whatever is behind the strip,'],
    ' until you rest the pointer on it'
  )};
  ${hint('listening · ggml-small.en.bin · server')}`, { width: 1180 })

await shot('settings', '#settings', `
  ${closePanels};
  document.getElementById('settings-btn').click();
  [...document.querySelectorAll('.set-nav button')]
    .find(b => b.textContent === 'Listening').click()`)

await shot('settings-transcription', '#settings', `
  [...document.querySelectorAll('.set-nav button')]
    .find(b => b.textContent === 'Transcription').click()`)

/* The glossary is the one panel whose contents are the user's own — client
   names, project jargon, whatever they have had to teach it. A screenshot of
   it goes in a public README, so the panel is rendered from a demo glossary
   held in memory for the length of the shot. Nothing is saved: the panel reads
   `state.settings`, and the real one is put back below. */
await evaluate(`
  (() => {
    const s = window.__transvibe.state
    window.__shotGlossary = {
      vocabulary: s.settings.vocabulary,
      corrections: s.settings.corrections
    }
    s.settings = {
      ...s.settings,
      vocabulary: ['Drupal', 'Lullabot', 'Tugboat'],
      corrections: { 'drupple': 'Drupal', 'lulla bot': 'Lullabot', 'tug boat': 'Tugboat' }
    }
    return true
  })()`)

await shot('glossary', '#glossary', `
  ${closePanels};
  document.getElementById('glossary-btn').click()`)

await evaluate(`
  (() => {
    const s = window.__transvibe.state
    s.settings = { ...s.settings, ...window.__shotGlossary }
    delete window.__shotGlossary
    return true
  })()`)

await shot('help', '#help', `
  ${closePanels};
  document.getElementById('help-btn').click()`)

await shot('fixer', ['.stage', '.fixer'], `
  ${closePanels};
  ${say(['Deploying the site with Tugboat and Drupal.'])};
  [...document.querySelectorAll('.transcript .w')].find(w => w.textContent === 'Tugboat').click();
  ${hint('click a word to fix it')}`, { width: 1180 })

await shot('command-mode', '.stage', `
  ${closePanels};
  document.body.classList.add('command-mode');
  ${say(['Deploying the site with Tugboat and Drupal.'], ' scratch that')};
  ${hint('command mode · say what to do')}`, { width: 1180 })

// Put it back the way it was found.
await evaluate(`
  (() => {
    if (window.__shotWasListening) document.getElementById('mute').click()
    document.getElementById('mute').classList.toggle('on', !window.__transvibe.state.listening)
    document.body.classList.remove('command-mode')
    document.getElementById('shot-style')?.remove()
    document.getElementById('shot-backdrop')?.remove()
    const s = window.__transvibe.state
    s.finals = []
    s.live = ''
    window.__transvibe.render()
    return true
  })()
`)
ws.close()
