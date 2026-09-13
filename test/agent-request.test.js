import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readRequest, whatToSay, replyFor, allowDecision, sessionName, MAX_BYTES
} from '../src/shared/agent-request.js'

/**
 * The protocol, without a terminal at either end of it.
 *
 * Everything here runs against the payloads recorded in step one of
 * docs/plans/agent-plugin.md — real ones, from a session somebody used, so
 * that the shape being tested is the shape that arrives rather than the one
 * this app would have guessed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const raw = name =>
  fs.readFileSync(path.join(HERE, 'fixtures', 'hooks', `${name}.json`), 'utf8')
const load = name => {
  const result = readRequest(raw(name))
  expect(result.ok).toBe(true)
  return result.request
}

describe('reading a payload', () => {
  it('keeps what can be spoken and drops what cannot', () => {
    const request = load('PermissionRequest-write')
    expect(request).toMatchObject({
      event: 'PermissionRequest',
      tool: 'Write',
      target: '/Users/example/repos/transvibe/hooktest.txt'
    })
    /* The file's contents arrived in this payload and are not here. That is
       the point of the reduction: what this module cannot hold, it cannot
       say out loud, put on screen, or write into a log. */
    expect(JSON.stringify(request)).not.toContain('hooktest\n')
    expect(request.toolInput).toBeUndefined()
    expect(request.content).toBeUndefined()
  })

  it('finds the fields each event actually carries', () => {
    expect(load('Stop-question')).toMatchObject({
      event: 'Stop', stopHookActive: false, cwd: '/Users/example/repos/transvibe'
    })
    expect(load('Stop-question').message).toMatch(/Want it at/)
    expect(load('SessionStart')).toMatchObject({ model: 'claude-opus-5[1m]' })
    expect(load('Notification-idle')).toMatchObject({
      notification: 'idle_prompt', message: 'Claude is waiting for your input'
    })
  })

  it('refuses anything that is not a payload, with the reason', () => {
    expect(readRequest('')).toEqual({ ok: false, reason: 'empty' })
    expect(readRequest('{oh no')).toEqual({ ok: false, reason: 'not json' })
    expect(readRequest('[]')).toEqual({ ok: false, reason: 'not an object' })
    expect(readRequest('"a string"')).toEqual({ ok: false, reason: 'not an object' })
    expect(readRequest('{}')).toEqual({ ok: false, reason: 'unknown event' })
    expect(readRequest('{"hook_event_name":"PreCompact"}'))
      .toEqual({ ok: false, reason: 'unknown event' })
    expect(readRequest(JSON.stringify({
      hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(MAX_BYTES)
    }))).toEqual({ ok: false, reason: 'too big' })
  })

  it('strips what would steer the terminal it gets printed back into', () => {
    const { request } = readRequest(JSON.stringify({
      hook_event_name: 'Stop',
      last_assistant_message: 'done\u001b[2Jcleared\u0007 and\nwrapped'
    }))
    expect(request.message).toBe('done [2Jcleared and wrapped')
    expect(request.message).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

describe('what is worth saying', () => {
  /* The recorded one ends in two markdown links to weather forecasts, which
     is the ordinary case and the one worth getting right: the strip keeps the
     address because you might want it, and the speaker never reads a query
     string out loud. */
  it('keeps an address on the strip and out of the room', () => {
    const said = whatToSay(load('Stop-long'))
    expect(said).toMatchObject({ kind: 'finished', answerable: true })
    expect(said.show).toContain('https://forecast.weather.gov')
    expect(said.show).not.toMatch(/[[\]]\(/)      // the markdown itself is gone
    expect(said.spoken).not.toMatch(/https?:\/\/|lat=|MapClick/)
    expect(said.spoken).toContain('High near 71')
  })

  it('cuts a long turn down to what a microphone can sit through', () => {
    const { request } = readRequest(JSON.stringify({
      hook_event_name: 'Stop',
      last_assistant_message: 'I changed the file. '.repeat(60)
    }))
    const said = whatToSay(request)
    expect(said.spoken.split(/\s+/).length).toBeLessThanOrEqual(60)
    // And what is left is whole sentences, not a sentence cut in half.
    expect(said.spoken).toMatch(/\.$/)
  })

  /* The reply to what you just said. Staying quiet here — which is what
     `stop_hook_active` first read as — ends every conversation after exactly
     one exchange, which is the opposite of the feature. */
  it('reads out the answer to the last thing said out loud', () => {
    const { request } = readRequest(JSON.stringify({
      hook_event_name: 'Stop', stop_hook_active: true,
      last_assistant_message: 'Right, doing that now.'
    }))
    expect(whatToSay(request)).toMatchObject({
      kind: 'finished', spoken: 'Right, doing that now.', answerable: true
    })
  })

  it('still says nothing when there is nothing to say', () => {
    for (const message of ['', '   ', null]) {
      const { request } = readRequest(JSON.stringify({
        hook_event_name: 'Stop', last_assistant_message: message
      }))
      expect(whatToSay(request)).toBeNull()
    }
  })

  it('describes a permission request by its tool, never by its argument', () => {
    const said = whatToSay(load('PermissionRequest-write'))
    expect(said).toMatchObject({ kind: 'permission', answerable: true })
    // The name on the strip, the basename in the room.
    expect(said.show).toBe('wants to write /Users/example/repos/transvibe/hooktest.txt')
    expect(said.spoken).toBe('wants to write hooktest.txt')
  })

  it('names a tool it has never heard of rather than inventing a verb for it', () => {
    const speak = (tool, input) => whatToSay(readRequest(JSON.stringify({
      hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input
    })).request).spoken
    expect(speak('Bash', { command: 'npm test' })).toBe('wants to run npm test')
    expect(speak('WebFetch', { url: 'https://example.com' })).toBe('wants to fetch https://example.com')
    expect(speak('Firecrawl', { nothing_we_know: 'x' })).toBe('wants to use Firecrawl')
    expect(speak(null, null)).toBe('wants to use a tool')
  })

  describe('notifications', () => {
    it('reads out the ones written for a person to read', () => {
      expect(whatToSay(load('Notification-idle'))).toMatchObject({
        kind: 'needs you', spoken: 'Claude is waiting for your input', answerable: false
      })
    })

    /* The finding that step one existed to make. A permission prompt fires
       twice — the request, then a notification about it six seconds later —
       and asking the room the same question twice is worse than not asking. */
    it('drops the one that doubles a permission request already in hand', () => {
      const doubled = load('Notification-permission')
      expect(whatToSay(doubled)).not.toBeNull()
      expect(whatToSay(doubled, { asked: new Set([doubled.promptId]) })).toBeNull()
      // A different prompt is a different question, not a repeat.
      expect(whatToSay(doubled, { asked: new Set(['some-other-prompt']) })).not.toBeNull()
    })

    it('stays quiet about what the terminal is already showing', () => {
      for (const type of ['auth_success', 'elicitation_dialog', 'quota_auto_resume_fired',
        'agent_completed', '', 'something_new']) {
        const { request } = readRequest(JSON.stringify({
          hook_event_name: 'Notification', notification_type: type, message: 'Something happened'
        }))
        expect(whatToSay(request)).toBeNull()
      }
    })
  })

  it('never announces a session starting', () => {
    expect(whatToSay(load('SessionStart'))).toBeNull()
  })
})

describe('yes, no, or neither', () => {
  it('hears consent', () => {
    for (const said of ['yes', 'Yeah', 'yep', 'sure', 'OK', 'okay please', 'go ahead',
      'do it', 'Do it, please', 'allow it', 'approve that', 'fine', 'sounds good',
      'yes go ahead', "yes, that's fine".replace(",", '')]) {
      expect(allowDecision(said)).toBe('allow')
    }
  })

  it('hears refusal', () => {
    for (const said of ['no', 'Nope', 'no thanks', "don't", 'do not', 'deny it',
      'stop', 'cancel', 'skip it', 'not now', 'leave it']) {
      expect(allowDecision(said)).toBe('deny')
    }
  })

  /* The ones that decide nothing, and the reason the grammar matches whole
     utterances rather than looking for a word inside one. "Do it later" is
     not "do it", and the difference is whether a command runs. */
  it('hears neither, and says so', () => {
    for (const said of ['do it later', 'what does it do', 'why does it want that',
      'yes but not that file', 'no idea', 'allow it if the tests pass', '', null,
      'hmm', 'read me the file first']) {
      expect(allowDecision(said)).toBeNull()
    }
  })
})

describe('what the hook prints back', () => {
  it('continues a finished turn with exit 2 and the words on stderr', () => {
    const reply = replyFor(load('Stop-question'), 'Yes, put it in the repo root.')
    expect(reply).toEqual({ exit: 2, out: '', err: 'Yes, put it in the repo root.' })
  })

  /* Saying nothing is an answer everywhere, and never an error. A microphone
     that heard nothing must not break somebody's session. */
  it('lets a turn end when nobody answered', () => {
    for (const said of [null, '', '   ']) {
      expect(replyFor(load('Stop-question'), said)).toEqual({ exit: 0, out: '', err: '' })
    }
  })

  it('decides a permission request on stdout, because exit 2 is ignored there', () => {
    const allow = replyFor(load('PermissionRequest-write'), 'go ahead')
    expect(allow.exit).toBe(0)
    expect(JSON.parse(allow.out).hookSpecificOutput).toMatchObject({
      hookEventName: 'PermissionRequest', decision: 'allow'
    })
    expect(JSON.parse(replyFor(load('PermissionRequest-write'), 'no').out)
      .hookSpecificOutput.decision).toBe('deny')
  })

  it('abstains rather than guessing, and hands the question back', () => {
    for (const said of [null, 'do it later', 'what is that file']) {
      const out = JSON.parse(replyFor(load('PermissionRequest-write'), said).out)
      expect(out.hookSpecificOutput.decision).toBe('abstain')
      expect(out.hookSpecificOutput.decisionReason).toMatch(/terminal/)
    }
  })

  it('prints nothing for the events that cannot be answered', () => {
    for (const name of ['SessionStart', 'Notification-idle']) {
      expect(replyFor(load(name), 'yes')).toEqual({ exit: 0, out: '', err: '' })
    }
    expect(replyFor(null, 'yes')).toEqual({ exit: 0, out: '', err: '' })
  })

  it('cannot be made to print a control sequence or a novel', () => {
    const reply = replyFor(load('Stop-question'), `ok\u001b]0;pwned\u0007 ${'x'.repeat(5000)}`)
    expect(reply.err).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(reply.err.length).toBeLessThanOrEqual(2000)
  })
})

describe('who is asking', () => {
  it('is named for where it is running, since that is what tells two apart', () => {
    expect(sessionName(load('Stop-question'))).toBe('Claude in transvibe')
    expect(sessionName({ cwd: '/' })).toBe('Claude')
    expect(sessionName({})).toBe('Claude')
    expect(sessionName(null)).toBe('Claude')
  })
})
