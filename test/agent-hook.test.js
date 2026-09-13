import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The hook, driven the way Claude Code drives it.
 *
 * This is the capture-only version — step one of docs/plans/agent-plugin.md —
 * so there is not much of a protocol to check yet. What there is to check is
 * the part that must stay true of every version after it: the payload arrives
 * intact, the file appears whole or not at all, and nothing the hook does can
 * hold up or fail the session that called it.
 *
 * The payloads are real ones, recorded from a session against this repo and
 * generalised. A fixture is worth more than a handwritten object here: the
 * shape is somebody else's to change, and a guess about it that nobody ever
 * ran is the thing this test exists to avoid.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', 'plugin', 'bin', 'transvibe-hook')
const fixture = name =>
  fs.readFileSync(path.join(HERE, 'fixtures', 'hooks', `${name}.json`), 'utf8')

let dir

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-hook-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** @returns {{status: number, stdout: string}} */
function run (payload, env = {}, cwd = dir) {
  const stdout = execFileSync(HOOK, {
    input: payload,
    cwd,
    env: { ...process.env, TRANSVIBE_DIR: dir, ...env },
    encoding: 'utf8'
  })
  return stdout
}

const captured = () => {
  const at = path.join(dir, 'agent', 'capture')
  return fs.existsSync(at) ? fs.readdirSync(at) : []
}

/* Every payload recorded so far, so a capture added later is covered by
   being added rather than by somebody remembering to write a test for it. */
const RECORDED = fs.readdirSync(path.join(HERE, 'fixtures', 'hooks'))
  .filter(name => name.endsWith('.json'))
  .map(name => name.replace(/\.json$/, ''))

describe('the capture hook', () => {
  it.each(RECORDED)('writes %s through unchanged, under the name of its event', name => {
    const payload = fixture(name)
    expect(run(payload)).toBe('')

    const files = captured()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`-${JSON.parse(payload).hook_event_name}\\.json$`))
    // Byte for byte: whatever the app parses later, it parses what Claude Code
    // actually sent, not this script's idea of it.
    const wrote = fs.readFileSync(path.join(dir, 'agent', 'capture', files[0]), 'utf8')
    expect(JSON.parse(wrote)).toEqual(JSON.parse(payload))
  })

  /* The long one is here because it is the one the spoken-length rules will
     have to cut, and the question is here because "Want it at X instead?" is
     the whole feature in one sentence: an agent that has stopped, waiting on
     an answer nobody is at the terminal to give. */
  it('keeps a message long enough to need shortening, and one that asks something', () => {
    expect(JSON.parse(fixture('Stop-long')).last_assistant_message.length).toBeGreaterThan(200)
    expect(JSON.parse(fixture('Stop-question')).last_assistant_message.trim()).toMatch(/\?$/)
    expect(JSON.parse(fixture('Notification-idle')))
      .toMatchObject({ notification_type: 'idle_prompt', message: expect.any(String) })
  })

  it('names a payload it cannot classify rather than dropping it', () => {
    run('{"something":"else"}')
    expect(captured()[0]).toMatch(/-unknown\.json$/)
  })

  /* The one that matters more than the rest of them together. A hook that
     exits non-zero on Stop does not fail quietly — it tells Claude Code to
     keep going, with stderr as the reason. Nothing in a capture is worth
     that, so every path out of this script is exit 0. */
  it('exits 0 on an empty payload and on one it cannot write', () => {
    expect(run('')).toBe('')
    expect(captured()).toEqual([])

    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-blocked-'))
    try {
      fs.writeFileSync(path.join(blocked, 'agent'), 'not a directory')
      expect(execFileSync(HOOK, {
        input: fixture('Stop'),
        cwd: dir,
        env: { ...process.env, TRANSVIBE_DIR: blocked },
        encoding: 'utf8'
      })).toBe('')
    } finally {
      fs.rmSync(blocked, { recursive: true, force: true })
    }
  })

  it('leaves no half-written file behind for a watcher to read', () => {
    run(fixture('SessionStart'))
    expect(captured().some(name => name.endsWith('.tmp'))).toBe(false)
  })

  describe('the two off switches, which are about this terminal', () => {
    it('does nothing at all with TRANSVIBE_AGENT=0', () => {
      run(fixture('Stop'), { TRANSVIBE_AGENT: '0' })
      expect(captured()).toEqual([])
    })

    it('does nothing in a project that has been switched off', () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-project-'))
      try {
        // The hash is the hook's own, so ask it for one rather than
        // reimplementing cksum here and testing the reimplementation.
        run(fixture('Stop'), {}, project)
        expect(captured()).toHaveLength(1)
        const hash = execFileSync('sh', ['-c', 'printf %s "$PWD" | cksum | cut -d" " -f1'],
          { cwd: project, encoding: 'utf8' }).trim()

        fs.mkdirSync(path.join(dir, 'agent', 'off'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'agent', 'off', hash), '')
        run(fixture('Stop'), {}, project)
        expect(captured()).toHaveLength(1)   // still the first one, and only it
      } finally {
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  })
})
