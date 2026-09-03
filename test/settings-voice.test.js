import { describe, it, expect } from 'vitest'
import {
  spokenNumber, parseSettingCommand, applySettingCommand, spokenAliases,
  spokenValue, nudgeFor, settingPhrases
} from '../src/renderer/settings-voice.js'
import { FIELDS } from '../src/renderer/settings-schema.js'
import { DEFAULTS } from '../src/main/config.js'
import { COMMANDS, parseCommand } from '../src/renderer/commands.js'

const field = key => FIELDS.find(f => f.key === key)
const parse = utterance => parseSettingCommand(utterance, FIELDS)
const run = (utterance, current) => {
  const cmd = parse(utterance)
  if (!cmd) return null
  const f = field(cmd.key)
  return applySettingCommand(cmd, f, current === undefined ? DEFAULTS[cmd.key] : current)
}

describe('spokenNumber', () => {
  it('reads digits, decimals included', () => {
    expect(spokenNumber('0.03')).toMatchObject({ value: 0.03 })
    expect(spokenNumber('200')).toMatchObject({ value: 200 })
    expect(spokenNumber('1.5 seconds')).toMatchObject({ value: 1.5, unit: 's' })
  })

  it('reads the same numbers said as words', () => {
    expect(spokenNumber('two hundred').value).toBe(200)
    expect(spokenNumber('two hundred and fifty').value).toBe(250)
    expect(spokenNumber('a thousand').value).toBe(1000)
    expect(spokenNumber('twenty five').value).toBe(25)
  })

  it('reads a spoken decimal digit by digit', () => {
    // "zero point zero three" is 0.03, not 0.3 and not 0.03 by luck.
    expect(spokenNumber('zero point zero three').value).toBe(0.03)
    expect(spokenNumber('point five').value).toBe(0.5)
  })

  it('picks up the unit and says what is left over', () => {
    expect(spokenNumber('ten seconds')).toMatchObject({ value: 10, unit: 's', rest: '' })
    expect(spokenNumber('200 words per minute')).toMatchObject({ value: 200, unit: 'wpm' })
    expect(spokenNumber('six seconds or so').rest).toBe('or so')
  })

  it('is null on anything that does not start with a number', () => {
    expect(spokenNumber('karen')).toBe(null)
    expect(spokenNumber('')).toBe(null)
    expect(spokenNumber(null)).toBe(null)
  })
})

describe('parseSettingCommand — toggles', () => {
  it('takes both word orders and both verbs', () => {
    for (const said of [
      'turn off spoken replies', 'turn spoken replies off', 'disable spoken replies',
      'stop spoken replies', 'spoken replies off'
    ]) {
      expect(parse(said), said).toMatchObject({ key: 'speakReplies', value: false })
    }
    for (const said of ['turn on cleanup', 'enable cleanup', 'cleanup on']) {
      expect(parse(said), said).toMatchObject({ key: 'cleanup', value: true })
    }
  })

  it('takes a setting by any of its spoken names', () => {
    expect(parse('stop talking back').key).toBe('speakReplies')
    expect(parse('turn off always on top').key).toBe('alwaysOnTop')
    expect(parse('turn on launching at login').key).toBe('launchAtLogin')
  })

  it('hears the name with or without its article', () => {
    expect(parse('what is the threshold').key).toBe('threshold')
    expect(parse('what is threshold').key).toBe('threshold')
  })
})

describe('parseSettingCommand — sliders', () => {
  it('sets a value, in whatever unit it was said', () => {
    expect(run('set the fade to ten seconds').value).toBe(10000)
    expect(run('set the fade to 800 milliseconds').value).toBe(1000)  // clamped
    expect(run('set the threshold to zero point zero three').value).toBe(0.03)
    expect(run('set the speaking rate to two hundred').value).toBe(200)
  })

  it('reads a bare number on a millisecond setting as seconds', () => {
    // Nobody asks for a ten-millisecond fade, and this is how people say it.
    expect(run('set the fade to ten').value).toBe(10000)
  })

  it('clamps to the field’s own bounds rather than trusting the speaker', () => {
    expect(run('set the frame rate to a thousand').value).toBe(field('vizFps').max)
    expect(run('set the threshold to zero').value).toBe(field('threshold').min)
  })

  it('nudges by something you would notice, not by one step', () => {
    const fade = field('idleFadeMs')
    const step = nudgeFor(fade, DEFAULTS.idleFadeMs)
    expect(step).toBeGreaterThan(fade.step)
    expect(run('raise the fade').value).toBe(DEFAULTS.idleFadeMs + step)
    expect(run('lower the fade').value).toBe(DEFAULTS.idleFadeMs - step)
    expect(run('the fade up').value).toBeGreaterThan(DEFAULTS.idleFadeMs)
  })

  it('scales the nudge to where the setting sits, not to its range', () => {
    // A tenth of the fade's range is six seconds, which from a six-second
    // fade is all of it. A quarter of where it is lands somewhere sensible
    // at both ends of the slider.
    expect(run('raise the fade', 2000).value).toBe(3000)
    expect(run('raise the fade', 40000).value).toBe(50000)
  })

  it('starts a nudge from where a zeroed setting really sits', () => {
    // The rate is 0 — "the voice's own" — so "faster" must not land on 40wpm.
    expect(run('speed up the speaking rate').value).toBe(230)
  })

  it('never writes a floating-point tail into the file', () => {
    // 0.02 + 0.006 in binary floating point is 0.026000000000000002.
    expect(run('raise the threshold').value).toBe(0.026)
  })
})

describe('parseSettingCommand — selects and questions', () => {
  it('hands a voice name back for the caller to resolve', () => {
    expect(parse('make the voice Karen')).toMatchObject({
      key: 'speakVoice', resolve: 'voices', value: 'Karen'
    })
  })

  it('wins over the replace rule, which reads the same sentence as an edit', () => {
    // "change voice to Karen" is a replace of the word "voice" to the editing
    // parser. Both parse; the app prefers this one, and the test pins the
    // half that makes that possible.
    expect(parseCommand('change voice to karen')).toMatchObject({ action: 'replace' })
    expect(parse('change voice to karen')).toMatchObject({
      key: 'speakVoice', value: 'karen'
    })
  })

  it('keeps the capitals a voice name needs', () => {
    // macOS wants "Samantha", and the parser works on lowercased text.
    expect(parse('set the voice to Samantha').value).toBe('Samantha')
  })

  it('answers someone who does not know what the setting is called', () => {
    // The person asking "what is the fade" already knows the answer's name.
    expect(parse('what is the setting for when text disappears').key).toBe('idleFadeMs')
    expect(parse('what is the option for when text is forgotten').key).toBe('idleClearMs')
    expect(parse('turn off the setting for auto copy')).toMatchObject({
      key: 'autoCopy', value: false
    })
    expect(parse('what is the setting for dinner')).toBe(null)
  })

  it('answers a question without changing anything', () => {
    const r = run("what's the threshold")
    expect(r.changed).toBe(false)
    expect(r.message).toBe('the threshold is 0.020')
    expect(run('is cleanup on').message).toBe('cleanup is off')
    expect(run('what is the fade').message).toBe('the fade is 6 seconds')
  })

  it('says so rather than pretending when nothing moved', () => {
    expect(run('turn off spoken replies', false).changed).toBe(false)
    expect(run('turn off spoken replies', false).message).toContain('already')
  })
})

describe('parseSettingCommand — what it must not catch', () => {
  it('leaves ordinary speech alone', () => {
    for (const said of [
      'turn off the lights',
      'set the table for dinner',
      'raise the issue with him tomorrow',
      'what is the capital of france',
      'stop the car',
      'i need to lower my expectations',
      'turn the page'
    ]) {
      expect(parse(said), said).toBe(null)
    }
  })

  it('leaves every editing command to the editing parser', () => {
    for (const { examples } of COMMANDS) {
      for (const example of examples) {
        expect(parse(example), example).toBe(null)
      }
    }
  })

  it('refuses a slider set to something that is not a number', () => {
    expect(parse('set the threshold to whatever')).toBe(null)
    expect(parse('set the fade to ten seconds please')).toBe(null)
  })

  it('refuses a setting with no spoken name', () => {
    // The wake phrase is panel-only on purpose: mishearing it would take the
    // voice commands with it.
    expect(parse('set the wake phrase to hey robot')).toBe(null)
    expect(parse('set the language to french')).toBe(null)
  })
})

describe('the aliases themselves', () => {
  const aliases = spokenAliases(FIELDS)

  it('gives every alias to exactly one setting', () => {
    const seen = new Map()
    for (const { field: f, bare } of aliases) {
      expect(seen.has(bare) ? seen.get(bare) : f.key, bare).toBe(f.key)
      seen.set(bare, f.key)
    }
  })

  it('never shadows an editing command', () => {
    for (const { alias, bare } of aliases) {
      for (const said of [alias, bare]) {
        expect(parseCommand(said), said).toBe(null)
      }
    }
  })

  it('matches the longest name first', () => {
    // "the quiet frame rate" must not be read as "the frame rate".
    expect(parse('raise the quiet frame rate').key).toBe('vizQuietFps')
    expect(parse('raise the frame rate').key).toBe('vizFps')
  })

  it('reaches every toggle and slider the panel has', () => {
    const reachable = FIELDS.filter(f => f.spoken).map(f => f.key)
    const panelOnly = FIELDS.filter(f => !f.spoken).map(f => f.key)
    expect(reachable).toHaveLength(26)
    // Free text and paths, and nothing else.
    expect(panelOnly.sort()).toEqual(
      ['assistModel', 'assistUrl', 'language', 'modelPath', 'sendTarget'])
  })
})

describe('spokenValue', () => {
  it('says a duration in seconds, whatever the file holds', () => {
    expect(spokenValue(field('idleFadeMs'), 6000)).toBe('6 seconds')
    expect(spokenValue(field('idleFadeMs'), 1000)).toBe('1 second')
    expect(spokenValue(field('hangoverMs'), 550)).toBe('550 milliseconds')
  })

  it('says what a zero means, rather than saying zero', () => {
    expect(spokenValue(field('idleClearMs'), 0)).toBe('never')
    expect(spokenValue(field('speakRate'), 0)).toBe('the voice’s own')
  })

  it('says a toggle as on or off', () => {
    expect(spokenValue(field('cleanup'), true)).toBe('on')
    expect(spokenValue(field('cleanup'), false)).toBe('off')
  })
})

describe('settingPhrases', () => {
  const phrases = settingPhrases(FIELDS)

  it('offers the assist model only phrases that parse back', () => {
    for (const phrase of phrases) {
      expect(parse(phrase), phrase).not.toBe(null)
    }
  })

  it('covers every reachable setting', () => {
    const keys = new Set(phrases.map(p => parse(p).key))
    expect(keys.size).toBe(FIELDS.filter(f => f.spoken).length)
  })
})
