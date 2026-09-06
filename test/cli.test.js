import { describe, it, expect } from 'vitest'
import { claudeArgs, codexArgs, parseClaudeJson, parseCodexJsonl, CLAUDE_MODEL } from '../src/shared/cli.js'
import { FRONTIER_ASK_PROMPT } from '../src/shared/conversation.js'

/* Captured from the real CLIs, abbreviated but structurally exact. */

const CLAUDE_STDOUT = '{"duration_api_ms":2140,"stop_reason":"end_turn","session_id":"0d17","total_cost_usd":0.0367,"usage":{"input_tokens":2,"cache_creation_input_tokens":8790,"cache_read_input_tokens":10025,"output_tokens":46},"permission_denials":[],"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"Voice activity detection, or VAD, is a technique that automatically detects whether a segment of audio contains human speech.","type":"result","duration_ms":1648}'

const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"01a0"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\'ll check this week\'s news.\\n"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"web_search","query":"news"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"One headline this week is \\"[Some headline](https://apnews.com/article/x)\\" (AP, September 6)."}}',
  '{"type":"turn.completed","usage":{"input_tokens":37905,"cached_input_tokens":29824,"output_tokens":112}}'
].join('\n')

describe('claudeArgs', () => {
  it('builds the measured invocation, with the trimming flags that make it fast', () => {
    const args = claudeArgs('what is a VAD')
    expect(args).toContain('--output-format')
    expect(args).toContain('--restricted')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--disable-slash-commands')
    expect(args[args.indexOf('--model') + 1]).toBe(CLAUDE_MODEL)
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(FRONTIER_ASK_PROMPT)
    expect(args[args.length - 2]).toBe('-p')
    expect(args[args.length - 1]).toBe('what is a VAD')
  })

  it('never passes --bare, which would bill an API key instead of the subscription', () => {
    expect(claudeArgs('hello')).not.toContain('--bare')
  })

  it('takes a different model and system prompt when asked', () => {
    const args = claudeArgs('hello', { model: 'claude-opus-5', system: 'Be brief.' })
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Be brief.')
  })

  it('adds no argument for a timeout, which is the spawner\'s job', () => {
    expect(claudeArgs('hello', { timeoutMs: 9000 })).toEqual(claudeArgs('hello'))
  })

  it('keeps a question that reads like flags as one single argument', () => {
    const hostile = '--dangerously-skip-permissions rm -rf /'
    const args = claudeArgs(hostile)
    expect(args).toEqual([...claudeArgs('anything').slice(0, -1), hostile])
    expect(args.filter(a => a === hostile).length).toBe(1)
    expect(args).not.toContain('--dangerously-skip-permissions')
    // Every flag in there is one this module wrote — the hostile string is the
    // last element, and is an argument no matter how many dashes it starts with.
    expect(args.slice(0, -1).filter(a => a.startsWith('-'))).toEqual([
      '--output-format', '--restricted', '--strict-mcp-config',
      '--disable-slash-commands', '--system-prompt', '--model', '-p'
    ])
  })
})

describe('codexArgs', () => {
  it('runs exec with json output and no git repo check', () => {
    expect(codexArgs('what happened this week').slice(0, 3))
      .toEqual(['exec', '--json', '--skip-git-repo-check'])
  })

  it('turns web search on only when asked, since it costs five seconds', () => {
    expect(codexArgs('hello')).not.toContain('tools.web_search=true')
    const args = codexArgs('hello', { webSearch: true })
    expect(args[args.indexOf('-c') + 1]).toBe('tools.web_search=true')
  })

  it('folds the system framing into the prompt, ahead of the question', () => {
    const prompt = codexArgs('what is a VAD').at(-1)
    expect(prompt).toBe(`${FRONTIER_ASK_PROMPT}\n\nwhat is a VAD`)
  })

  it('keeps a question that reads like flags as one argument that cannot start with a dash', () => {
    const hostile = '--dangerously-skip-permissions rm -rf /'
    const args = codexArgs(hostile, { webSearch: true })
    expect(args.filter(a => a.includes(hostile)).length).toBe(1)
    expect(args).not.toContain(hostile)
    expect(args.at(-1).startsWith('-')).toBe(false)
    expect(args.filter(a => a.startsWith('-'))).toEqual([
      '--json', '--skip-git-repo-check', '-c'
    ])
  })

  /* The no-dash guarantee rests on the framing being there, so a caller must
     not be able to take it away — including by asking politely with ''. */
  it('puts the framing back when a caller asks for none, so a hostile question still cannot lead', () => {
    const args = codexArgs('-rf / --and-then-some', { system: '' })
    expect(args.at(-1).startsWith(FRONTIER_ASK_PROMPT)).toBe(true)
    expect(args.at(-1).startsWith('-')).toBe(false)
  })
})

describe('parseClaudeJson', () => {
  it('reads the answer, the timing, the cost and the tokens off one JSON object', () => {
    const r = parseClaudeJson(CLAUDE_STDOUT)
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^Voice activity detection, or VAD,/)
    expect(r.ms).toBe(1648)
    expect(r.costUsd).toBe(0.0367)
    // Cached input was still input: 2 + 8790 + 10025.
    expect(r.tokens).toEqual({ input: 18817, output: 46 })
  })

  it('steps over an update notice printed above the JSON', () => {
    const r = parseClaudeJson(`A new version of Claude Code is available.\n${CLAUDE_STDOUT}\n`)
    expect(r.ok).toBe(true)
    expect(r.ms).toBe(1648)
  })

  it('reads a pretty-printed object too', () => {
    const r = parseClaudeJson(JSON.stringify(JSON.parse(CLAUDE_STDOUT), null, 2))
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^Voice activity detection/)
  })

  it('fails with the error text when the CLI reports one', () => {
    const r = parseClaudeJson('{"is_error":true,"subtype":"error_during_execution","result":"Invalid API key","type":"result","duration_ms":90}')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Invalid API key')
    expect(r.text).toBe('')
    expect(r.ms).toBe(90)
  })

  it('fails rather than throwing on nothing, prose, or half a line', () => {
    for (const junk of ['', '   ', 'Please run /login first.', '{"result":', undefined, null]) {
      const r = parseClaudeJson(junk)
      expect(r.ok).toBe(false)
      expect(typeof r.reason).toBe('string')
      expect(r.text).toBe('')
    }
    expect(parseClaudeJson('').reason).toBe('no output')
    expect(parseClaudeJson('Please run /login first.').reason).toBe('not json')
  })

  it('fails when the object came back without a result', () => {
    expect(parseClaudeJson('{"type":"result","is_error":false,"duration_ms":12}').reason).toBe('no answer')
  })
})

describe('parseCodexJsonl', () => {
  it('takes the last agent message, not the first', () => {
    const r = parseCodexJsonl(CODEX_STDOUT)
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^One headline this week/)
    expect(r.text).not.toMatch(/I'll check/)
    expect(r.tokens).toEqual({ input: 67729, output: 112 })
  })

  it('skips lines that are not JSON at all', () => {
    const noisy = `codex 0.9.1 is out of date\n${CODEX_STDOUT}\n\nwarning: web search is experimental`
    expect(parseCodexJsonl(noisy).text).toMatch(/^One headline this week/)
  })

  it('reports the stream error when the turn produced no message', () => {
    const r = parseCodexJsonl('{"type":"thread.started","thread_id":"01a0"}\n{"type":"error","message":"Not logged in. Run codex login."}')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Not logged in. Run codex login.')
  })

  it('fails rather than throwing on nothing, prose, or a truncated stream', () => {
    expect(parseCodexJsonl('').reason).toBe('no output')
    expect(parseCodexJsonl('Reading additional input from stdin...').reason).toBe('not json')
    expect(parseCodexJsonl('{"type":"turn.started"}').reason).toBe('no answer')
    expect(parseCodexJsonl(undefined).ok).toBe(false)
  })

  it('ignores an empty agent message rather than answering with nothing', () => {
    const r = parseCodexJsonl([
      '{"type":"item.completed","item":{"type":"agent_message","text":"The answer."}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"  "}}'
    ].join('\n'))
    expect(r.text).toBe('The answer.')
  })
})
