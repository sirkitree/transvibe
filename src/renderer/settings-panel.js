import { SECTIONS, coerce } from './settings-schema.js'

/**
 * Builds the settings panel from the schema and saves each change as it is
 * made.
 *
 * There is no Save button and no form: a setting you are tuning by ear — the
 * speech threshold, the fade delay — is only tunable if the effect is
 * immediate, and once every change saves on the spot, a Save button is a
 * button that can only ever be redundant or wrong. Ranges save as you drag.
 * Text fields save on blur, so a half-typed URL is never written.
 *
 * Every save round-trips through the main process and the reply is the new
 * settings, same as the glossary panel: what is on screen is what was written,
 * not an optimistic guess a failed write would leave standing.
 */
export function createSettingsPanel ({
  body, note, getSettings, save, applyLive, open, getExternal, setExternal, getOptions
}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const inputs = new Map()   // key -> the element showing it
  let built = false

  /** Range labels read as what they are — 350ms, 0.020, 24 — not as raw floats. */
  const format = (field, value) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    const text = field.decimals != null ? n.toFixed(field.decimals) : String(n)
    return field.unit ? `${text}${field.unit}` : text
  }

  function row (field) {
    const wrap = el('div', `set-row set-${field.type}`)
    const input = field.type === 'select' ? el('select') : el('input')
    const value = el('span', 'set-value')

    if (field.type === 'toggle') {
      // A checkbox with its label is the whole row — a value readout beside it
      // would only say again what the tick already says.
      input.type = 'checkbox'
      const label = el('label', 'set-check')
      label.append(input, el('span', null, field.label))
      wrap.append(label)
    } else {
      const head = el('div', 'set-head')
      head.append(el('label', null, field.label))
      if (field.type === 'range') {
        input.type = 'range'
        input.min = field.min
        input.max = field.max
        input.step = field.step
        head.append(value)
      } else if (field.type === 'select') {
        // Filled in by show(), which asks for the list every time the panel
        // opens — another app can download a model while this one is running.
        head.append(value)
      } else {
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        if (field.placeholder) input.placeholder = field.placeholder
      }
      wrap.append(head, input)
    }

    if (field.help) wrap.append(el('p', 'set-help', field.help))
    if (field.restart) wrap.append(el('p', 'set-help restart', 'Takes effect when transvibe restarts.'))

    const commit = async () => {
      const raw = field.type === 'toggle' ? input.checked : input.value
      const next = coerce(field, raw)
      if (next === undefined) return show(field)   // unusable input: put it back
      if (field.external) await setExternal(field.key, next)
      else {
        await save({ [field.key]: next })
        applyLive(field.key)
      }
      // Showing it again rather than trusting the click: an external setting
      // can refuse (macOS declining a login item), and then the tick has to go
      // back to what is true.
      await show(field)
      note(`${field.label} · saved`)
    }

    // Ranges update their readout on every pixel of the drag but only write on
    // release: dragging from 6s to 30s would otherwise be twenty-four writes.
    if (field.type === 'range') {
      input.addEventListener('input', () => { value.textContent = format(field, input.value) })
      input.addEventListener('change', commit)
    } else if (field.type === 'toggle' || field.type === 'select') {
      input.addEventListener('change', commit)
    } else {
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
    }

    inputs.set(field.key, { field, input, value })
    return wrap
  }

  async function show (field) {
    const entry = inputs.get(field.key)
    if (!entry) return
    const current = field.external
      ? await getExternal(field.key)
      : getSettings()[field.key]
    if (field.type === 'toggle') entry.input.checked = !!current
    else if (field.type === 'range') {
      entry.input.value = current
      entry.value.textContent = format(field, current)
    } else if (field.type === 'select') {
      await fillSelect(entry, current)
    } else entry.input.value = current == null ? '' : String(current)
  }

  /**
   * A select is the one field whose choices come from outside the schema. The
   * options are rebuilt on every open rather than once, and the readout beside
   * the label says which one is actually loaded — with "Automatic" chosen,
   * that is the only way to know which file the engine picked.
   */
  async function fillSelect (entry, current) {
    const { field, input, value } = entry
    const { options, chosen, note: readout } = await getOptions(field)
    input.replaceChildren()
    for (const option of options) {
      const node = el('option', null, option.label)
      node.value = option.value
      if (option.disabled) node.disabled = true
      input.append(node)
    }
    // A model that has since been deleted must not silently read as
    // "Automatic": it is still what the file says, and saying so is how you
    // find out why the engine did not start.
    const want = current == null ? '' : String(current)
    if (want && !options.some(o => o.value === want)) {
      const missing = el('option', null, `${want} ${field.missingSuffix ?? '— missing'}`)
      missing.value = want
      input.append(missing)
    }
    input.value = want
    value.textContent = readout ?? chosen ?? ''
  }

  function build () {
    for (const section of SECTIONS) {
      body.append(el('h3', null, section.title))
      if (section.note) body.append(el('p', 'note', section.note))
      for (const field of section.fields) body.append(row(field))
    }

    // The two settings with an editor of their own, and the reference for the
    // rest of the app: reachable from here rather than only from the strip.
    body.append(el('h3', null, 'Elsewhere'))
    const links = el('div', 'set-links')
    for (const [label, panel] of [['Glossary', 'glossary'], ['Keys & commands', 'help']]) {
      const button = el('button', null, label)
      button.type = 'button'
      button.onclick = () => open(panel)
      links.append(button)
    }
    body.append(links)
    body.append(el('p', 'note',
      'Words to listen for and fixes for the ones it mishears live in the ' +
      'glossary, which is a better editor for them than a text field.'))

    built = true
  }

  return {
    /** Called every time the panel opens: build once, then re-read the file. */
    render () {
      if (!built) build()
      // Not awaited: the panel is already on screen, and the one external
      // field filling in a tick later is better than the whole panel waiting.
      for (const { field } of inputs.values()) show(field)
    }
  }
}
