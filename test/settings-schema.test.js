import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/main/config.js'
import {
  SECTIONS, FIELDS, GLOSSARY_KEYS, PANEL_KEYS, REMEMBERED_KEYS, EXTERNAL_KEYS,
  coerce, formatValue, resolveChoice, fieldApplies
} from '../src/renderer/settings-schema.js'

const fileKeys = FIELDS.filter(f => !f.external).map(f => f.key)

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
      expect(['toggle', 'range', 'text', 'select']).toContain(field.type)
      expect(field.label).toBeTruthy()
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
