import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The hook, driven the way Claude Code drives it, against a fake app.
 *
 * It is twenty lines of sh and it carries somebody's session in its hands,
 * so the things worth proving are about what it does when nothing goes to
 * plan: nobody listening, an answer that never comes, a reply file full of
 * nonsense, a signal partway through. The answer in every one of those cases
 * is the same — exit 0, leave nothing behind — because on Stop a non-zero
 * exit is not an error, it is an instruction to keep going.
 *
 * The payloads are real ones, recorded from a session against this repo and
 * generalised. A fixture is worth more than a handwritten object here: the
 * shape is somebody else's to change, and a guess about it that nobody ever
 * ran is the thing these recordings exist to avoid.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', 'plugin', 'bin', 'transvibe-hook')
const FIXTURES = path.join(HERE, 'fixtures', 'hooks')
const fixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
const RECORDED = fs.readdirSync(FIXTURES).filter(n => n.endsWith('.json'))
  .map(n => n.replace(/\.json$/, ''))

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-hook-'))
  listening(true)
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** The app's "I am watching" file: written while it listens, gone when it is
    not running. The hook tests for it before it does anything at all. */
function listening (on) {
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true })
  const file = path.join(dir, 'agent', 'listening')
  if (on) fs.writeFileSync(file, String(process.pid))
  else fs.rmSync(file, { force: true })
}

const at = (...parts) => path.join(dir, 'agent', ...parts)
const listing = kind => (fs.existsSync(at(kind)) ? fs.readdirSync(at(kind)) : [])

/** Start the hook and hand back its streams when it exits. */
function start (payload, { env = {}, cwd = dir } = {}) {
  const child = spawn(HOOK, {
    cwd,
    env: { ...process.env, TRANSVIBE_DIR: dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.stdin.end(payload)
  const done = new Promise(resolve =>
    child.on('close', code => resolve({ code, out, err })))
  return { child, done }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The app's side: wait for a request to appear and hand back its id. */
async function waitForRequest (timeout = 3000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const [file] = listing('requests').filter(n => n.endsWith('.json'))
    if (file) return file.replace(/\.json$/, '')
    await sleep(10)
  }
  throw new Error('no request appeared')
}

/** Ack it, the way the app does: the contents are the seconds it wants. */
function ack (id, seconds = 30) {
  fs.writeFileSync(at('replies', `${id}.ack`), String(seconds))
}

/** Answer it. `done` is written last, because it is what releases the hook. */
function answer (id, { exit = 0, out = '', err = '' } = {}) {
  fs.writeFileSync(at('replies', `${id}.out`), out)
  fs.writeFileSync(at('replies', `${id}.err`), err)
  fs.writeFileSync(at('replies', `${id}.exit`), String(exit))
  fs.writeFileSync(at('replies', `${id}.done`), '')
}

const nothingLeftBehind = () => {
  expect(listing('requests')).toEqual([])
  expect(listing('replies')).toEqual([])
}

describe('carrying the payload', () => {
  it.each(RECORDED)('writes %s through byte for byte', async name => {
    const payload = fixture(name)
    const running = start(payload)
    const id = await waitForRequest()

    // Whatever the app parses later, it parses what Claude Code actually
    // sent, not this script's idea of it.
    const wrote = fs.readFileSync(at('requests', `${id}.json`), 'utf8')
    expect(JSON.parse(wrote)).toEqual(JSON.parse(payload))

    ack(id)
    answer(id)
    expect((await running.done).code).toBe(0)
  })

  it('never leaves a half-written file for the watcher to read', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    expect(listing('requests')).toEqual([`${id}.json`])   // no .tmp alongside it
    ack(id)
    answer(id)
    await running.done
  })

  it('writes nothing at all for an empty payload', async () => {
    expect((await start('').done).code).toBe(0)
    nothingLeftBehind()
  })
})

describe('answering', () => {
  /* The whole feature in one test: a finished turn, a sentence said out loud,
     and an exit 2 that turns it into the next prompt. */
  it('continues a turn with exit 2 and the words on stderr', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    ack(id)
    answer(id, { exit: 2, err: 'Yes, put it in the repo root.' })

    expect(await running.done).toEqual({
      code: 2, out: '', err: 'Yes, put it in the repo root.'
    })
    nothingLeftBehind()
  })

  it('prints a permission decision on stdout and exits 0', async () => {
    const decision = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: 'allow' }
    })
    const running = start(fixture('PermissionRequest-write'))
    const id = await waitForRequest()
    ack(id)
    answer(id, { exit: 0, out: decision })

    const result = await running.done
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).hookSpecificOutput.decision).toBe('allow')
    nothingLeftBehind()
  })

  it('takes the exit code from the app rather than from anything it printed', async () => {
    for (const [exit, expected] of [[0, 0], [2, 2], [1, 1]]) {
      const running = start(fixture('Stop-question'))
      const id = await waitForRequest()
      ack(id)
      answer(id, { exit, err: 'something' })
      expect((await running.done).code).toBe(expected)
    }
  })
})

describe('when something goes wrong', () => {
  /* The one that matters more than the rest together, in its two forms. An
     app that is not running costs a test for a file; an app that died with
     its file still there costs a second and a half, once. Neither costs the
     session anything else, ever. */
  it('does nothing, instantly, when the app is not running', async () => {
    listening(false)
    const started = Date.now()
    expect(await start(fixture('Stop-question')).done).toEqual({ code: 0, out: '', err: '' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(listing('requests')).toEqual([])
  })

  it('gives up and cleans up when nobody acks', async () => {
    const started = Date.now()
    const result = await start(fixture('Stop-question')).done
    expect(result).toEqual({ code: 0, out: '', err: '' })
    expect(Date.now() - started).toBeLessThan(4000)
    nothingLeftBehind()
  })

  it('stops waiting after the seconds the app asked for', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    ack(id, 1)                       // one second, then give up
    const started = Date.now()
    expect((await running.done).code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(5000)
    nothingLeftBehind()
  })

  it('treats an unreadable deadline as a sane one rather than as forever', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    fs.writeFileSync(at('replies', `${id}.ack`), 'whenever you like')
    await sleep(300)
    answer(id, { exit: 2, err: 'still here' })
    expect(await running.done).toMatchObject({ code: 2, err: 'still here' })
  })

  it('exits 0 rather than crashing on a reply file full of nonsense', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    ack(id)
    fs.writeFileSync(at('replies', `${id}.exit`), 'two')
    fs.writeFileSync(at('replies', `${id}.done`), '')
    expect((await running.done).code).toBe(0)
    nothingLeftBehind()
  })

  it('leaves nothing behind when it is killed mid-wait', async () => {
    const running = start(fixture('Stop-question'))
    const id = await waitForRequest()
    ack(id, 60)
    await sleep(150)
    running.child.kill('SIGTERM')
    await running.done
    // A request left lying here would later read as somebody still waiting.
    nothingLeftBehind()
    expect(id).toBeTruthy()
  })
})

describe('the two off switches, which are about this terminal', () => {
  it('does nothing at all with TRANSVIBE_AGENT=0', async () => {
    expect((await start(fixture('Stop-question'), { env: { TRANSVIBE_AGENT: '0' } }).done).code).toBe(0)
    expect(fs.existsSync(at('requests'))).toBe(false)
  })

  it('does nothing in a project that has been switched off', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-project-'))
    try {
      // The hash is the hook's own, so ask a shell for it rather than
      // reimplementing cksum here and testing the reimplementation.
      const { execFileSync } = await import('node:child_process')
      const hash = execFileSync('sh', ['-c', 'printf %s "$PWD" | cksum | cut -d" " -f1'],
        { cwd: project, encoding: 'utf8' }).trim()
      fs.mkdirSync(at('off'), { recursive: true })
      fs.writeFileSync(at('off', hash), '')

      expect((await start(fixture('Stop-question'), { cwd: project }).done).code).toBe(0)
      expect(listing('requests')).toEqual([])
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('keeping a copy, for working on this', () => {
  it('is off unless asked for, and names what it kept', async () => {
    const quiet = start(fixture('Notification-idle'))
    answer(await waitForRequest(), {})   // no ack: it gives up on its own
    await quiet.done
    expect(listing('capture')).toEqual([])

    const running = start(fixture('Notification-idle'), { env: { TRANSVIBE_CAPTURE: '1' } })
    const id = await waitForRequest()
    ack(id)
    answer(id)
    await running.done

    const kept = listing('capture')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/-Notification\.json$/)
    expect(JSON.parse(fs.readFileSync(at('capture', kept[0]), 'utf8')))
      .toEqual(JSON.parse(fixture('Notification-idle')))
  })
})
