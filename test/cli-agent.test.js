import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createCliAgent, listCliAgents } from '../src/main/cli-agent.js'

/* No real CLI is ever spawned in here. `claude -p` costs money to run and
   `codex exec` needs a network, so every test drives a fake process that
   behaves the way the captured output says the real one does. That is the
   whole reason `spawn` is an option on the factory. */

function fakeSpawn (script) {
  const calls = []
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.signals = []
    child.kill = signal => { child.signals.push(signal || 'SIGTERM'); return true }
    const call = { bin, args, opts, child }
    calls.push(call)
    /* A microtask, not synchronously: a real process is never finished before
       spawn returns, and a fake that is would hide a listener attached late. */
    queueMicrotask(() => script(child, call))
    return child
  }
  spawn.calls = calls
  spawn.last = () => calls[calls.length - 1]
  return spawn
}

/** The commonest fake of all: prints this, exits zero. */
const prints = (stdout, code = 0) => (child) => {
  child.stdout.emit('data', stdout)
  child.emit('close', code)
}

const CLAUDE_STDOUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1648,
  total_cost_usd: 0.0367,
  usage: { input_tokens: 2, cache_read_input_tokens: 10025, output_tokens: 46 },
  result: 'Voice activity detection is a way of telling speech from silence.'
})

const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"01a0"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"I\'ll check this week\'s news."}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"The rate was held at four percent."}}',
  '{"type":"turn.completed","usage":{"input_tokens":37905,"cached_input_tokens":29824,"output_tokens":112}}'
].join('\n')

describe('createCliAgent ask', () => {
  it('speaks the answer the claude CLI printed', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    const agent = createCliAgent({ provider: 'claude', spawn })
    const answer = await agent.ask('what is a VAD')

    expect(answer.ok).toBe(true)
    expect(answer.text).toBe('Voice activity detection is a way of telling speech from silence.')
    expect(answer.model).toBe('claude-sonnet-5')
    expect(answer.tokens).toEqual({ input: 10027, output: 46 })
    expect(answer.costUsd).toBeCloseTo(0.0367)
    expect(answer.ms).toBeGreaterThanOrEqual(0)
  })

  it('spawns the binary with an argv array, no shell, and stdin closed', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    await createCliAgent({ spawn }).ask('what is a VAD')
    const { bin, args, opts } = spawn.last()

    expect(bin).toBe('claude')
    expect(Array.isArray(args)).toBe(true)
    expect(opts.shell).toBeUndefined()
    // codex sits waiting on an open stdin forever; claude has nothing to read.
    expect(opts.stdio[0]).toBe('ignore')
  })

  it('runs somewhere empty and temporary, never the project it was launched from', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    await createCliAgent({ spawn }).ask('what is a VAD')

    expect(spawn.last().opts.cwd).not.toBe(process.cwd())
    expect(spawn.last().opts.cwd).toMatch(/transvibe-cli$|^\/.*tmp/i)
  })

  it('puts the question in the argv as one element and never as a flag', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    const hostile = '--dangerously-skip-permissions and then rm -rf /'
    await createCliAgent({ spawn }).ask(hostile)
    const { args } = spawn.last()

    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--bare')
    const prompt = args[args.length - 1]
    expect(prompt).toContain(hostile)
    expect(args.filter(a => a.includes(hostile))).toHaveLength(1)
  })

  it('carries the thread so far and what the local model already said', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    await createCliAgent({ spawn }).ask('and what does it cost', [
      { role: 'user', content: 'what is a VAD' },
      { role: 'assistant', content: 'A video assisted delivery.' }
    ], { priorAnswer: 'A video assisted delivery.' })

    const prompt = spawn.last().args[spawn.last().args.length - 1]
    expect(prompt).toContain('what is a VAD')
    expect(prompt).toContain('A video assisted delivery.')
    expect(prompt).toContain('and what does it cost')
  })

  it('holds a frontier answer to the same spoken shape as a local one', async () => {
    /* acceptAnswer, same as assist.ask. Two dozen sentences out of the
       speakers is a wall of speech nobody can interrupt, however good the
       model — but on the strip it is just an answer worth having waited for,
       so only the spoken half is held to the short shape. */
    const long = Array.from({ length: 24 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ')
    const spawn = fakeSpawn(prints(JSON.stringify({ result: long, is_error: false })))
    const answer = await createCliAgent({ spawn }).ask('explain everything')

    expect(answer.ok).toBe(true)
    expect(answer.spoken.split(/\s+/).length).toBeLessThanOrEqual(60)
    expect(answer.text.split(/\s+/).length)
      .toBeGreaterThan(answer.spoken.split(/\s+/).length)
  })

  it('reports a PASS the same way the local model does, so the chain can go on', async () => {
    const spawn = fakeSpawn(prints(JSON.stringify({ result: 'PASS', is_error: false })))
    const answer = await createCliAgent({ spawn }).ask('what did I have for lunch')

    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('pass')
  })

  it('refuses to spawn anything for an empty question', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    const answer = await createCliAgent({ spawn }).ask('   ')

    expect(answer).toMatchObject({ ok: false, reason: 'nothing asked' })
    expect(spawn.calls).toHaveLength(0)
  })
})

describe('createCliAgent ask, codex', () => {
  it('takes the last agent message and not the "I will go and look" one', async () => {
    const spawn = fakeSpawn(prints(CODEX_STDOUT))
    const answer = await createCliAgent({ provider: 'codex', spawn }).ask('what did the bank do')

    expect(answer.ok).toBe(true)
    expect(answer.text).toBe('The rate was held at four percent.')
    expect(answer.tokens).toEqual({ input: 67729, output: 112 })
  })

  it('asks for web search only when it was asked for', async () => {
    const off = fakeSpawn(prints(CODEX_STDOUT))
    await createCliAgent({ provider: 'codex', spawn: off }).ask('what happened today')
    expect(off.last().args).not.toContain('tools.web_search=true')

    const on = fakeSpawn(prints(CODEX_STDOUT))
    await createCliAgent({ provider: 'codex', webSearch: true, spawn: on }).ask('what happened today')
    expect(on.last().args).toContain('tools.web_search=true')
  })
})

describe('createCliAgent when the CLI misbehaves', () => {
  it('says what stderr said when the CLI exits non-zero with nothing to show', async () => {
    const spawn = fakeSpawn(child => {
      child.stderr.emit('data', 'Not logged in. Run `claude login`.\nStack: ...')
      child.emit('close', 1)
    })
    const answer = await createCliAgent({ spawn }).ask('what is a VAD')

    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('Not logged in. Run `claude login`.')
    expect(answer.text).toBe('')
  })

  it('still speaks an answer that arrived alongside a non-zero exit', async () => {
    // Both CLIs will happily print the answer and then complain about an
    // update or a sandbox on the way out. The answer is the better evidence.
    const spawn = fakeSpawn(child => {
      child.stdout.emit('data', CLAUDE_STDOUT)
      child.stderr.emit('data', 'warning: a new version is available')
      child.emit('close', 1)
    })
    const answer = await createCliAgent({ spawn }).ask('what is a VAD')

    expect(answer.ok).toBe(true)
    expect(answer.text).toMatch(/^Voice activity detection/)
  })

  it('treats garbage on stdout as no answer rather than as a crash', async () => {
    const spawn = fakeSpawn(prints('Segmentation fault: 11\n'))
    const answer = await createCliAgent({ spawn }).ask('what is a VAD')

    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('not json')
  })

  it('reports the error the CLI itself put in its JSON', async () => {
    const spawn = fakeSpawn(prints(JSON.stringify({ is_error: true, result: 'Credit balance too low' })))
    const answer = await createCliAgent({ spawn }).ask('what is a VAD')

    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('Credit balance too low')
  })

  it('names the missing command, and does not go looking for it twice', async () => {
    const spawn = fakeSpawn(child => {
      const err = new Error('spawn codex ENOENT')
      err.code = 'ENOENT'
      child.emit('error', err)
    })
    const agent = createCliAgent({ provider: 'codex', spawn })

    const first = await agent.ask('what happened today')
    expect(first.ok).toBe(false)
    expect(first.reason).toMatch(/codex/)
    expect(first.reason).toMatch(/not installed/)

    const second = await agent.ask('and then what')
    expect(second.ok).toBe(false)
    expect(spawn.calls).toHaveLength(1)
  })
})

describe('createCliAgent deadlines and cancelling', () => {
  it('signals, then kills, a CLI that runs past its deadline', async () => {
    vi.useFakeTimers()
    try {
      // A process that ignores SIGTERM entirely: it never closes on its own.
      const spawn = fakeSpawn(() => {})
      const agent = createCliAgent({ spawn, timeoutMs: 5000 })
      const pending = agent.ask('what is a VAD')

      await vi.advanceTimersByTimeAsync(5000)
      expect(spawn.last().child.signals).toEqual(['SIGTERM'])

      await vi.advanceTimersByTimeAsync(2000)
      expect(spawn.last().child.signals).toContain('SIGKILL')

      const answer = await pending
      expect(answer).toMatchObject({ ok: false, reason: 'took too long' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a well behaved CLI exit on its own after the signal', async () => {
    vi.useFakeTimers()
    try {
      const spawn = fakeSpawn(child => {
        child.kill = signal => { child.signals = [signal]; child.emit('close', null); return true }
      })
      const agent = createCliAgent({ spawn, timeoutMs: 1000 })
      const pending = agent.ask('what is a VAD')

      await vi.advanceTimersByTimeAsync(1000)
      const answer = await pending
      expect(answer.reason).toBe('took too long')
      expect(spawn.last().child.signals).toEqual(['SIGTERM'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills an in-flight call when told to stop, and says nothing', async () => {
    let started
    const ready = new Promise(resolve => { started = resolve })
    const spawn = fakeSpawn(child => {
      child.kill = signal => { child.signals.push(signal); child.emit('close', null); return true }
      /* The answer is already on stdout when "stop" arrives — the point being
         that it is still not spoken. */
      child.stdout.emit('data', CLAUDE_STDOUT)
      started()
    })
    const agent = createCliAgent({ spawn })
    const pending = agent.ask('what is a VAD')
    await ready

    expect(agent.busy).toBe(true)
    agent.cancel()

    const answer = await pending
    expect(answer).toMatchObject({ ok: false, text: '', reason: 'cancelled' })
    expect(spawn.last().child.signals).toContain('SIGTERM')
    expect(agent.busy).toBe(false)
  })

  it('has nothing to do when there is no call to cancel', async () => {
    const spawn = fakeSpawn(prints(CLAUDE_STDOUT))
    const agent = createCliAgent({ spawn })
    expect(() => agent.cancel()).not.toThrow()
    expect((await agent.ask('what is a VAD')).ok).toBe(true)
  })
})

describe('createCliAgent check', () => {
  it('asks the binary its version and nothing that could be billed', async () => {
    const spawn = fakeSpawn(prints('2.0.14 (Claude Code)\n'))
    const agent = createCliAgent({ spawn })

    expect(await agent.check()).toBe(true)
    expect(agent.available).toBe(true)
    expect(spawn.last().args).toEqual(['--version'])
  })

  it('is false for a binary that is not there, and then asks nothing else', async () => {
    const spawn = fakeSpawn(child => {
      const err = new Error('spawn claude ENOENT')
      err.code = 'ENOENT'
      child.emit('error', err)
    })
    const agent = createCliAgent({ spawn })

    expect(await agent.check()).toBe(false)
    const answer = await agent.ask('what is a VAD')
    expect(answer.reason).toMatch(/not installed/)
    expect(spawn.calls).toHaveLength(1)
  })

  it('is false for a binary that answers, badly', async () => {
    const spawn = fakeSpawn(prints('unknown flag --version\n', 2))
    expect(await createCliAgent({ spawn }).check()).toBe(false)
  })
})

describe('listCliAgents', () => {
  it('reports both CLIs, present or not, and never throws about it', async () => {
    const spawn = fakeSpawn((child, call) => {
      if (call.bin === 'claude') {
        child.stdout.emit('data', '2.0.14 (Claude Code)\n')
        child.emit('close', 0)
      } else {
        const err = new Error('spawn codex ENOENT')
        err.code = 'ENOENT'
        child.emit('error', err)
      }
    })
    const found = await listCliAgents({ spawn })

    expect(found.map(f => f.provider)).toEqual(['claude', 'codex'])
    expect(found[0]).toMatchObject({ present: true, binary: 'claude', version: '2.0.14 (Claude Code)' })
    expect(found[1]).toMatchObject({ present: false, binary: 'codex', version: null })
  })

  it('is a list of absences on a machine with neither, which is the ordinary case', async () => {
    const spawn = fakeSpawn(child => {
      const err = new Error('ENOENT')
      err.code = 'ENOENT'
      child.emit('error', err)
    })
    expect((await listCliAgents({ spawn })).every(f => f.present === false)).toBe(true)
  })
})

describe('timeouts with partial output', () => {
  it('does not promote a progress message to a successful answer', async () => {
    vi.useFakeTimers()
    try {
      const spawn = fakeSpawn(child => {
        child.stdout.emit('data', '{"type":"item.completed","item":{"type":"agent_message","text":"I’ll look for the article to verify the state."}}\n')
        child.kill = () => { child.emit('close', null); return true }
      })
      const pending = createCliAgent({ provider: 'codex', spawn, timeoutMs: 30000 }).ask('Find the article and verify.')
      await vi.advanceTimersByTimeAsync(30000)
      expect(await pending).toMatchObject({ ok: false, reason: 'took too long', text: '' })
    } finally { vi.useRealTimers() }
  })
})
