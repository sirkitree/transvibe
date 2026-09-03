import { SECTIONS, coerce, formatValue } from './settings-schema.js'

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
  body, note, getSettings, save, applyLive, open, getExternal, setExternal,
  getOptions, panes: extraPanes = new Map()
}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const inputs = new Map()   // key -> the element showing it
  const customPanes = new Map()
  let built = false

  /* Range labels read as what they are — 350ms, 0.020, 24 — not as raw floats.
     Shared with the voice side, which has to say the same thing out loud. */
  const format = formatValue

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

  /* Tabs down the left rather than one long scroll. Eight sections of settings
     is more than a scroll bar communicates, and scrolling past six of them to
     reach the seventh means reading six you did not come for. One section at a
     time also means the panel is as tall as what you are looking at.

     The tab stays put across closes and reopens: changing a setting, watching
     what it did, and coming back to change it again is the whole reason this
     panel exists, and landing back on the first section every time would make
     that a chore. */
  let currentTab = null

  function buildTabs (panes) {
    const nav = el('nav', 'set-nav')
    const tabs = new Map()

    const select = title => {
      currentTab = title
      for (const [name, pane] of panes) pane.hidden = name !== title
      for (const [name, tab] of tabs) {
        tab.classList.toggle('on', name === title)
        tab.setAttribute('aria-selected', String(name === title))
      }
      // A tab is a different page, not a scroll position: it starts at the top.
      body.scrollTop = 0
    }

    for (const [title] of panes) {
      const tab = el('button', null, title)
      tab.type = 'button'
      tab.role = 'tab'
      tab.onclick = () => select(title)
      tabs.set(title, tab)
      nav.append(tab)
    }

    return { nav, select, has: title => tabs.has(title) }
  }

  let tabs = null

  function build () {
    const content = el('div', 'set-sections')
    const panes = []

    for (const section of SECTIONS) {
      // No heading inside the pane: the tab beside it, lit, at the same height,
      // is already the title. Two of them was just the word twice.
      const pane = el('section', 'set-pane')
      if (section.note) pane.append(el('p', 'note lead', section.note))

      /* A block the panel cannot build from fields — the agent roster is a
         list of records, not a set of rows — rendered on open rather than now,
         because it asks the machine what voices and models it has and neither
         answer keeps. It goes above the fields: it is what the tab is about,
         and the fields underneath are how it behaves. */
      if (section.custom && extraPanes.has(section.custom)) {
        const host = el('div', 'set-custom')
        pane.append(host)
        customPanes.set(section.custom, { pane: host, render: extraPanes.get(section.custom) })
      }

      /* Sub-headings inside a long pane. Six settings read as a list; ten read
         as a wall, and the two at the bottom never get found. */
      let group = null
      for (const field of section.fields) {
        if (field.group && field.group !== group) pane.append(el('h4', 'set-group', field.group))
        group = field.group || group
        pane.append(row(field))
      }

      /* The lists with an editor of their own, beside the settings they belong
         with rather than in a tab of leftovers at the end. */
      if (section.links) {
        const links = el('div', 'set-links')
        for (const [label, panel] of section.links) {
          const button = el('button', null, label)
          button.type = 'button'
          button.onclick = () => open(panel)
          links.append(button)
        }
        pane.append(links)
      }

      content.append(pane)
      panes.push([section.title, pane])
    }

    tabs = buildTabs(panes)
    body.append(tabs.nav, content)
    tabs.select(currentTab && tabs.has(currentTab) ? currentTab : panes[0][0])

    built = true
  }

  return {
    /** Called every time the panel opens: build once, then re-read the file. */
    render () {
      if (!built) build()
      // Not awaited: the panel is already on screen, and the one external
      // field filling in a tick later is better than the whole panel waiting.
      for (const { field } of inputs.values()) show(field)
      for (const { pane, render } of customPanes.values()) render(pane)
    }
  }
}
