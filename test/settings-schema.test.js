import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/main/config.js'
import {
  SECTIONS, FIELDS, GLOSSARY_KEYS, PANEL_KEYS, REMEMBERED_KEYS, EXTERNAL_KEYS,
  coerce, formatValue, resolveChoice, fieldApplies, isDefault, sectionDefaults,
  fieldMatches, searchFields
} from '../src/renderer/settings-schema.js'

/* An action is a button and a preview is a picture. Neither is a setting: no
   value, nothing in config.js, and nothing to read back. */
const NOT_SETTINGS = ['action', 'preview']
const fileKeys = FIELDS
  .filter(f => !f.external && !NOT_SETTINGS.includes(f.type))
  .map(f => f.key)

describe('the settings schema against config.js', () => {
  it('has a row for every setting in the file', () => {
    const missing = Object.keys(DEFAULTS)
      .filter(k => !GLOSSARY_KEYS.includes(k) && !PANEL_KEYS.includes(k) &&
        !REMEMBERED_KEYS.includes(k) && !fileKeys.includes(k))
    expect(missing).toEqual([])
  })

  it('has no row for a setting the file does not hold', () => {
    const unknown = fileKeys.filter(k => !(k in DEFAULTS))
    expect(unknown).toEqual([])
  })

  it('shows each setting exactly once', () => {
    expect(new Set(fileKeys).size).toBe(fileKeys.length)
  })

  it('keeps the external settings out of the file', () => {
    for (const key of EXTERNAL_KEYS) expect(key in DEFAULTS).toBe(false)
  })

  it('gives every field a type the panel can build', () => {
    for (const field of FIELDS) {
      expect(['toggle', 'range', 'text', 'select', 'action', 'preview'])
        .toContain(field.type)
      if (field.type === 'action') expect(field.action).toBeTruthy()
      if (field.type === 'preview') expect(field.preview).toBeTruthy()
      // A preview has no label: it is the picture, not a row about one.
      if (field.type !== 'preview') expect(field.label).toBeTruthy()
      if (field.type === 'range') {
        expect(field.min).toBeLessThan(field.max)
        expect(field.step).toBeGreaterThan(0)
      }
    }
  })

  it('puts every default inside its own range', () => {
    for (const field of FIELDS) {
      if (field.type !== 'range') continue
      const value = DEFAULTS[field.key]
      expect(value, field.key).toBeGreaterThanOrEqual(field.min)
      expect(value, field.key).toBeLessThanOrEqual(field.max)
    }
  })

  it('gives every section a title and at least one field', () => {
    for (const section of SECTIONS) {
      expect(section.title).toBeTruthy()
      expect(section.fields.length).toBeGreaterThan(0)
    }
  })
})

describe('coerce', () => {
  const range = { type: 'range' }
  const text = { type: 'text' }
  const nullable = { type: 'text', nullable: true }

  it('reads a range back as a number', () => {
    expect(coerce(range, '350')).toBe(350)
    expect(coerce(range, '0.024')).toBe(0.024)
  })

  it('refuses a range that is not a number, rather than writing NaN', () => {
    expect(coerce(range, 'soon')).toBeUndefined()
  })

  it('trims text and drops an empty non-nullable field', () => {
    expect(coerce(text, '  gemma4:e2b ')).toBe('gemma4:e2b')
    expect(coerce(text, '   ')).toBeUndefined()
  })

  it('reads an emptied nullable field as unset', () => {
    // "no forced target app", not the empty string — sendTarget is checked for
    // null, and '' would read as an app with no name.
    expect(coerce(nullable, '')).toBeNull()
  })

  it('takes a select value exactly as given', () => {
    const select = { type: 'select', nullable: true }
    // A model path is a filename, not prose: nothing about it is trimmable.
    expect(coerce(select, '/Users/me/Library/ggml-small.en.bin'))
      .toBe('/Users/me/Library/ggml-small.en.bin')
    expect(coerce(select, '')).toBeNull()
    expect(coerce({ type: 'select' }, '')).toBeUndefined()
  })

  it('reads a toggle as a boolean either way', () => {
    expect(coerce({ type: 'toggle' }, true)).toBe(true)
    expect(coerce({ type: 'toggle' }, false)).toBe(false)
  })
})

describe('formatValue', () => {
  const fade = FIELDS.find(f => f.key === 'idleFadeMs')
  const hangover = FIELDS.find(f => f.key === 'hangoverMs')
  const forget = FIELDS.find(f => f.key === 'idleClearMs')

  it('writes a long duration as seconds rather than as five zeroes', () => {
    expect(formatValue(fade, 10000)).toBe('10s')
    expect(formatValue(fade, 1500)).toBe('1.5s')
  })

  it('leaves a short one in milliseconds, which is how it is thought of', () => {
    expect(formatValue(hangover, 550)).toBe('550ms')
  })

  it('says what a zero means rather than saying zero', () => {
    expect(formatValue(forget, 0)).toBe('never')
  })

  it('says a toggle as on or off', () => {
    expect(formatValue({ type: 'toggle' }, true)).toBe('on')
  })
})

describe('resolveChoice', () => {
  const layout = FIELDS.find(f => f.key === 'layout')

  it('takes the value itself', () => {
    expect(resolveChoice(layout, 'orb')).toBe('orb')
    expect(resolveChoice(layout, 'strip')).toBe('strip')
  })

  it('takes a word out of the label, which is how it would be said', () => {
    // "change the visualizer to the orb"
    expect(resolveChoice(layout, 'the orb')).toBe('orb')
    expect(resolveChoice(layout, 'Ribbon')).toBe('strip')
    expect(resolveChoice(layout, 'the corner')).toBe('orb')
  })

  it('is undefined rather than a wrong guess', () => {
    expect(resolveChoice(layout, 'the blob')).toBeUndefined()
    expect(resolveChoice(layout, '')).toBeUndefined()
    expect(resolveChoice(layout, null)).toBeUndefined()
    expect(resolveChoice({ type: 'select' }, 'orb')).toBeUndefined()
    expect(resolveChoice(null, 'orb')).toBeUndefined()
  })

  it('does not match a label as a whole phrase by accident', () => {
    // a partial word is not a choice: "or" must not land on "orb"
    expect(resolveChoice(layout, 'or')).toBeUndefined()
  })
})

describe('fieldApplies', () => {
  const ribbon = FIELDS.find(f => f.key === 'vizPoints')
  const orb = FIELDS.find(f => f.key === 'orbSeeds')
  const layout = FIELDS.find(f => f.key === 'layout')
  const always = FIELDS.find(f => f.key === 'threshold')

  it('shows only the running visualizer\'s dials', () => {
    expect(fieldApplies(ribbon, { layout: 'strip' })).toBe(true)
    expect(fieldApplies(orb, { layout: 'strip' })).toBe(false)
    expect(fieldApplies(ribbon, { layout: 'orb' })).toBe(false)
    expect(fieldApplies(orb, { layout: 'orb' })).toBe(true)
  })

  it('always shows the switch between them, and everything unconditional', () => {
    for (const settings of [{ layout: 'strip' }, { layout: 'orb' }]) {
      expect(fieldApplies(layout, settings)).toBe(true)
      expect(fieldApplies(always, settings)).toBe(true)
    }
  })

  it('is true for a field that asks for nothing, whatever it is given', () => {
    expect(fieldApplies({}, {})).toBe(true)
    expect(fieldApplies(null, null)).toBe(true)
    expect(fieldApplies(always, null)).toBe(true)
  })

  it('hides rather than shows when the setting is missing entirely', () => {
    // A file with no `layout` at all is one config.js will have filled in by
    // the time the panel reads it; showing both sets would be the wrong guess.
    expect(fieldApplies(ribbon, {})).toBe(false)
    expect(fieldApplies(orb, {})).toBe(false)
  })

  it('leaves every conditional field reachable by voice', () => {
    // Only the panel hides them. The schema still has them, so the voice path
    // and the config test both still see them.
    const hidden = FIELDS.filter(f => f.showWhen)
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.every(f => f.spoken && f.spoken.length)).toBe(true)
  })
})

describe('telling a changed setting from an untouched one', () => {
  const range = { key: 'threshold', type: 'range' }
  const toggle = { key: 'vad', type: 'toggle' }
  const text = { key: 'sendTarget', type: 'text', nullable: true }

  it('matches a number the DOM handed back as a string', () => {
    expect(isDefault(range, String(DEFAULTS.threshold), DEFAULTS)).toBe(true)
    expect(isDefault(range, DEFAULTS.threshold, DEFAULTS)).toBe(true)
    expect(isDefault(range, DEFAULTS.threshold + 0.01, DEFAULTS)).toBe(false)
  })

  it('reads an empty text field as the null it defaults to', () => {
    expect(DEFAULTS.sendTarget).toBe(null)
    expect(isDefault(text, '', DEFAULTS)).toBe(true)
    expect(isDefault(text, null, DEFAULTS)).toBe(true)
    expect(isDefault(text, undefined, DEFAULTS)).toBe(true)
    expect(isDefault(text, 'Ghostty', DEFAULTS)).toBe(false)
  })

  it('compares a toggle as true or false, not as what it was stored as', () => {
    expect(isDefault(toggle, !!DEFAULTS.vad, DEFAULTS)).toBe(true)
    expect(isDefault(toggle, !DEFAULTS.vad, DEFAULTS)).toBe(false)
  })

  it('calls a setting the defaults have no opinion about unchanged', () => {
    expect(isDefault({ key: 'launchAtLogin', type: 'toggle' }, true, DEFAULTS)).toBe(true)
    expect(isDefault(range, 1, null)).toBe(true)
    expect(isDefault(null, 1, DEFAULTS)).toBe(true)
  })

  it('agrees with the defaults on every field in the schema', () => {
    // Nothing should read as changed on a fresh install.
    for (const field of FIELDS) {
      if (field.external || field.type === 'action') continue
      expect([field.key, isDefault(field, DEFAULTS[field.key], DEFAULTS)])
        .toEqual([field.key, true])
    }
  })
})

describe('resetting a section', () => {
  const listening = SECTIONS.find(s => s.title === 'Listening')
  const agents = SECTIONS.find(s => s.title === 'Agents')

  it('writes each of the settings the section owns', () => {
    const patch = sectionDefaults(listening, DEFAULTS)
    const keys = listening.fields.map(f => f.key)
    expect(Object.keys(patch).sort()).toEqual(keys.sort())
    for (const key of keys) expect(patch[key]).toEqual(DEFAULTS[key])
  })

  it('leaves out the buttons and the settings the file does not hold', () => {
    const patch = sectionDefaults(agents, DEFAULTS)
    // 'Teach it my voice' is an action, and the roster has its own editor.
    expect('enrolVoice' in patch).toBe(false)
    for (const key of Object.keys(patch)) expect(key in DEFAULTS).toBe(true)
  })

  it('touches nothing outside the section', () => {
    const patch = sectionDefaults(listening, DEFAULTS)
    expect('layout' in patch).toBe(false)
    expect(sectionDefaults(null, DEFAULTS)).toEqual({})
    expect(sectionDefaults(listening, null)).toEqual({})
  })
})

describe('finding a setting by typing what you call it', () => {
  const find = q => searchFields(q).map(r => r.field.key)

  it('matches words anywhere in the label, in any order', () => {
    expect(find('silence turn')).toEqual(['conversationHangoverMs'])
    expect(find('turn silence')).toEqual(['conversationHangoverMs'])
  })

  it('narrows as words are added', () => {
    const one = find('silence')
    const two = find('silence conversation')
    expect(one.length).toBeGreaterThan(two.length)
    expect(one).toEqual(expect.arrayContaining(two))
  })

  it('finds a setting by what you would say out loud', () => {
    // 'the noise gate' is nowhere in the label or the help; it is a spoken
    // alias, which is exactly the name someone reaches for.
    const vad = FIELDS.find(f => f.key === 'vad')
    expect(vad.label.toLowerCase()).not.toContain('noise gate')
    expect(find('noise gate')).toContain('vad')
  })

  it('finds a setting by the section it lives in', () => {
    expect(find('transcription').length).toBeGreaterThan(0)
  })

  it('finds a setting by its key, which is what the file calls it', () => {
    expect(find('hangoverMs')).toContain('hangoverMs')
  })

  it('returns everything for an empty query', () => {
    expect(searchFields('').length).toBe(FIELDS.length)
    expect(searchFields('   ').length).toBe(FIELDS.length)
  })

  it('returns nothing for a word no setting has', () => {
    expect(find('kumquat')).toEqual([])
  })

  it('will not surface a row the panel is hiding', () => {
    const ribbon = FIELDS.filter(f => f.showWhen && f.showWhen.layout === 'strip')
    expect(ribbon.length).toBeGreaterThan(0)
    const hidden = searchFields('', f => fieldApplies(f, { layout: 'orb' }))
      .map(r => r.field.key)
    for (const field of ribbon) expect(hidden).not.toContain(field.key)
  })

  it('says which section each hit came from', () => {
    const [hit] = searchFields('noise gate')
    expect(hit.section).toBe('Listening')
  })

  it('is safe with nothing to match against', () => {
    expect(fieldMatches(null, 'x')).toBe(false)
    expect(fieldMatches(null, '')).toBe(true)
    expect(fieldMatches({ label: 'A' }, null)).toBe(true)
  })
})

describe('the sub-headings inside a section', () => {
  /* The panel opens a heading when `group` changes and closes it when it
     changes again, so a group that appears, stops, and appears again gets two
     headings with the same name and its rows split between them. Contiguity is
     not a style rule here; it is what the builder can express. */
  it('never repeats a group after leaving it', () => {
    for (const section of SECTIONS) {
      const seen = []
      let last = null
      for (const field of section.fields) {
        const group = field.group || null
        if (group === last) continue
        expect([section.title, group, seen]).toEqual([section.title, group, seen.filter(g => g !== group)])
        seen.push(group)
        last = group
      }
    }
  })

  it('does not leave a row stranded under a heading it is not part of', () => {
    // An ungrouped field after a grouped one renders below that heading while
    // belonging to nothing, which reads as a lie about what the heading covers.
    for (const section of SECTIONS) {
      let grouped = false
      for (const field of section.fields) {
        if (field.group) grouped = true
        else expect([section.title, field.key, grouped]).toEqual([section.title, field.key, false])
      }
    }
  })
})
