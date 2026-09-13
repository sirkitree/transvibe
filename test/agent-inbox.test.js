import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentInbox } from '../src/main/agent-inbox.js'

/**
 * The watcher, in a directory of its own.
 *
 * Driven by writing files, because that is all the hook does, and the point
 * of choosing a directory over a socket was that this could be tested without
 * a terminal or an agent at the other end of it.
 *
 * Two things get more attention than the happy path. Requests that nobody
 * answers, because a hook is blocked behind every one of them and forgetting
 * one is a session hanging for no visible reason. And the sweep, because
 * fs.watch on macOS drops events and the sweep is what makes that survivable
 * — so it is tested with watching effectively out of the picture.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = name =>
  fs.readFileSync(path.join(HERE, 'fixtures', 'hooks', `${name}.json`), 'utf8')

let dir
let inbox

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-inbox-')) })
afterEach(() => {
  inbox?.stop()
  inbox = null
  fs.rmSync(dir, { recursive: true, force: true })
})

const at = (...parts) => path.join(dir, 'agent', ...parts)
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
const listing = kind => (fs.existsSync(at(kind)) ? fs.readdirSync(at(kind)) : [])

/** The hook's side: drop a payload in and hand back its id. */
function drop (name, id = `20260913T000000Z-${Math.random().toString(36).slice(2, 8)}`) {
  fs.writeFileSync(at('requests', `${id}.json`), fixture(name))
  return id
}

/** As the hook reads it: the four files, once `.done` exists. */
const replyTo = id => read(at('replies', `${id}.done`)) === null
  ? null
  : {
      exit: Number(read(at('replies', `${id}.exit`))),
      out: read(at('replies', `${id}.out`)),
      err: read(at('replies', `${id}.err`))
    }

function build (options = {}) {
  const seen = []
  const expired = []
  const errors = []
  inbox = createAgentInbox({
    dir,
    sweepMs: 20,
    onRequest: r => seen.push(r),
    onExpire: r => expired.push(r),
    onError: e => errors.push(e),
    ...options
  })
  return { seen, expired, errors }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Long enough for the sweep to have run, whatever fs.watch did. */
const settle = () => sleep(80)

describe('saying whether anyone is home', () => {
  it('writes the flag the hook tests for, and takes it away again', () => {
    build()
    expect(fs.existsSync(at('listening'))).toBe(false)
    inbox.start()
    expect(fs.existsSync(at('listening'))).toBe(true)
    expect(inbox.status).toMatchObject({ listening: true, open: 0, error: null })

    inbox.stop()
    expect(fs.existsSync(at('listening'))).toBe(false)
    expect(inbox.listening).toBe(false)
  })

  it('makes the directories the hook expects to find', () => {
    build().errors
    inbox.start()
    for (const kind of ['requests', 'replies', 'off']) {
      expect(fs.existsSync(at(kind))).toBe(true)
    }
  })
})

describe('taking a request', () => {
  it('hands a finished turn to the app and holds the hook for an answer', async () => {
    const { seen } = build()
    inbox.start()
    const id = drop('Stop-question')
    await settle()

    expect(seen).toHaveLength(1)
    expect(seen[0].id).toBe(id)
    expect(seen[0].say).toMatchObject({ kind: 'finished', answerable: true })
    expect(seen[0].say.spoken).toMatch(/read-only filesystem/)

    // Acked with the deadline, and nothing else yet: the hook waits.
    expect(read(at('replies', `${id}.ack`))).toBe('90')
    expect(replyTo(id)).toBeNull()
    expect(inbox.open).toBe(1)

    expect(inbox.answer(id, 'Yes, the repo root please.')).toBe(true)
    expect(replyTo(id)).toEqual({ exit: 2, out: '', err: 'Yes, the repo root please.' })
    expect(inbox.open).toBe(0)
  })

  it('reads a notification out and lets go of the hook at once', async () => {
    const { seen } = build()
    inbox.start()
    const id = drop('Notification-idle')
    await settle()

    expect(seen[0].say).toMatchObject({ answerable: false })
    expect(seen[0].say.spoken).toBe('Claude is waiting for your input')
    /* Released immediately: the terminal it came from is not waiting on the
       room, and ninety seconds of an agent doing nothing for the sake of a
       sentence would be a bad trade. */
    expect(replyTo(id)).toEqual({ exit: 0, out: '', err: '' })
    expect(inbox.open).toBe(0)
  })

  it('says nothing about a session starting, and still releases it', async () => {
    const { seen } = build()
    inbox.start()
    const id = drop('SessionStart')
    await settle()

    expect(seen).toEqual([])
    expect(replyTo(id)).toEqual({ exit: 0, out: '', err: '' })
  })

  /* The finding step one existed to make, enforced here because this is the
     only place that knows both halves: the request is in hand, and the
     notification about it arrives six seconds later. */
  it('does not put the same permission prompt to the room twice', async () => {
    const { seen } = build()
    inbox.start()
    const permission = drop('PermissionRequest-write')
    await settle()
    expect(seen).toHaveLength(1)
    expect(seen[0].say.spoken).toBe('wants to write hooktest.txt')

    const doubled = drop('Notification-permission')
    await settle()
    expect(seen).toHaveLength(1)                     // still just the one
    expect(replyTo(doubled)).toEqual({ exit: 0, out: '', err: '' })

    // And once it is answered, a later prompt is a new question again.
    inbox.answer(permission, 'go ahead')
    expect(JSON.parse(replyTo(permission).out).hookSpecificOutput.decision).toBe('allow')
    drop('Notification-permission')
    await settle()
    expect(seen).toHaveLength(2)
  })

  it('reads each request once, however many times it is noticed', async () => {
    const { seen } = build()
    inbox.start()
    drop('Stop-question')
    await sleep(150)                                 // several sweeps
    expect(seen).toHaveLength(1)
  })
})

describe('requests nobody answers', () => {
  it('gives up on the same clock the hook does, and says so', async () => {
    vi.useFakeTimers()
    try {
      const { seen, expired } = build({ replySeconds: 30 })
      inbox.start()
      const id = drop('Stop-question')
      // The scan is synchronous inside start/sweep; drive it rather than wait.
      vi.advanceTimersByTime(25)
      expect(seen).toHaveLength(1)
      expect(replyTo(id)).toBeNull()

      vi.advanceTimersByTime(30 * 1000 + 600)
      expect(expired).toHaveLength(1)
      expect(expired[0].id).toBe(id)
      expect(replyTo(id)).toEqual({ exit: 0, out: '', err: '' })
      expect(inbox.open).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets everything go when the app quits, rather than leaving it to time out', async () => {
    build()
    inbox.start()
    const id = drop('Stop-question')
    await settle()
    expect(inbox.open).toBe(1)

    inbox.stop()
    expect(replyTo(id)).toEqual({ exit: 0, out: '', err: '' })
    expect(fs.existsSync(at('listening'))).toBe(false)
  })

  it('declines without inventing an answer', async () => {
    build()
    inbox.start()
    const stop = drop('Stop-question')
    const permission = drop('PermissionRequest-write')
    await settle()

    inbox.decline(stop)
    expect(replyTo(stop)).toEqual({ exit: 0, out: '', err: '' })

    inbox.decline(permission)
    const out = JSON.parse(replyTo(permission).out)
    expect(out.hookSpecificOutput.decision).toBe('abstain')
  })

  it('answers an id it does not know with nothing at all', () => {
    build()
    inbox.start()
    expect(inbox.answer('never-heard-of-it', 'yes')).toBe(false)
    expect(listing('replies')).toEqual([])
  })
})

describe('when the directory has something odd in it', () => {
  it('releases a hook stuck behind a payload it cannot read, and says why', async () => {
    const { seen, errors } = build()
    inbox.start()
    fs.writeFileSync(at('requests', 'bad-one.json'), '{ not json')
    await settle()

    expect(seen).toEqual([])
    expect(errors.join(' ')).toMatch(/not json/)
    // Answered rather than ignored: a hook is blocked behind it either way.
    expect(replyTo('bad-one')).toEqual({ exit: 0, out: '', err: '' })
  })

  it('leaves alone anything that is not a request', async () => {
    const { seen, errors } = build()
    inbox.start()
    fs.writeFileSync(at('requests', 'notes.txt'), 'hello')
    fs.writeFileSync(at('requests', '.DS_Store'), '')
    await settle()
    expect(seen).toEqual([])
    expect(errors).toEqual([])
    expect(listing('requests').sort()).toEqual(['.DS_Store', 'notes.txt'])
  })

  /* A request already acked belongs to an earlier run of this app, whose
     answer the hook has either had or given up on. Reading it again would put
     a question from a dead session to the room. */
  it('does not re-open a request a previous run already took', async () => {
    const { seen } = build()
    inbox.start()
    const id = drop('Stop-question')
    fs.writeFileSync(at('replies', `${id}.ack`), '90')
    await settle()
    expect(seen).toEqual([])
  })

  it('sweeps up debris, and only debris', async () => {
    const { seen } = build({ staleMs: 50 })
    inbox.start()
    const dead = drop('Stop-question', 'long-abandoned')
    fs.writeFileSync(at('replies', 'long-abandoned.ack'), '90')
    const live = drop('Stop-question')
    await settle()
    expect(seen).toHaveLength(1)                     // the live one only

    await sleep(120)                                 // now both are "old"
    expect(listing('requests')).not.toContain(`${dead}.json`)
    // The one being waited on is not debris, however long it has been open.
    expect(inbox.open).toBe(1)
    expect(fs.existsSync(at('requests', `${live}.json`))).toBe(true)
  })
})

/* Every other test here fakes one end or the other. This one fakes neither:
   the real script, the real inbox, and the protocol between them — which is
   four file extensions and an integer, and is exactly the kind of agreement
   that rots quietly when each side is only ever tested against a mock. */
describe('against the real hook', () => {
  const HOOK = path.join(HERE, '..', 'plugin', 'bin', 'transvibe-hook')

  const run = async payload => {
    const { spawn } = await import('node:child_process')
    const child = spawn(HOOK, {
      cwd: dir,
      env: { ...process.env, TRANSVIBE_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.stdin.end(payload)
    return new Promise(resolve => child.on('close', code => resolve({ code, out, err })))
  }

  it('carries a spoken answer back into the session', async () => {
    build({ onRequest: ({ id }) => setTimeout(() => inbox.answer(id, 'The repo root, please.'), 50) })
    inbox.start()

    expect(await run(fixture('Stop-question'))).toEqual({
      code: 2, out: '', err: 'The repo root, please.'
    })
    // Both sides cleaned up after themselves.
    expect(listing('requests')).toEqual([])
    expect(listing('replies')).toEqual([])
  })

  it('carries a spoken permission decision back into the session', async () => {
    build({ onRequest: ({ id }) => setTimeout(() => inbox.answer(id, 'yes, go ahead'), 50) })
    inbox.start()

    const result = await run(fixture('PermissionRequest-write'))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).hookSpecificOutput).toMatchObject({
      hookEventName: 'PermissionRequest', decision: 'allow'
    })
  })

  it('releases a notification without holding the session up', async () => {
    const { seen } = build()
    inbox.start()
    const started = Date.now()
    expect(await run(fixture('Notification-idle'))).toEqual({ code: 0, out: '', err: '' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(seen).toHaveLength(1)
  })

  it('is invisible to a session when it is not listening', async () => {
    build()
    inbox.start()
    inbox.stop()
    const started = Date.now()
    expect(await run(fixture('Stop-question'))).toEqual({ code: 0, out: '', err: '' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(listing('requests')).toEqual([])
  })
})

describe('when the inbox itself fails', () => {
  it('switches itself off and reports rather than taking the app with it', () => {
    const { errors } = build()
    // A file where the requests directory has to be.
    fs.mkdirSync(at(), { recursive: true })
    fs.writeFileSync(at('requests'), 'not a directory')

    expect(inbox.start()).toBe(false)
    expect(inbox.listening).toBe(false)
    expect(errors).toHaveLength(1)
    expect(inbox.status.error).toBeTruthy()
    // And it is not claiming to listen.
    expect(fs.existsSync(at('listening'))).toBe(false)
  })
})
