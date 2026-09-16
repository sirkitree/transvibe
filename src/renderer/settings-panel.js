import {
  SECTIONS, coerce, formatValue, fieldApplies, isDefault, sectionDefaults,
  fieldMatches
} from './settings-schema.js'

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
  getOptions, panes: extraPanes = new Map(), actions = {}, relaunch = null,
  getDefaults = () => null, previews = {}
}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const inputs = new Map()   // key -> the element showing it
  /* Every row, in order, with the section it belongs to and the pane it sits
     in. `inputs` cannot stand in for this: an action row has no value, so it
     is never in `inputs`, and search still has to be able to hide it. */
  const rows = []
  const customPanes = new Map()
  /* Whatever a preview handed back when it was built. Told about every save,
     because a preview of the visualizer is only worth the pixels if moving a
     dial moves it. */
  const livePreviews = []
  /* Sub-headings, with the fields under each, so a heading whose whole group
     is hidden goes with it rather than sitting over nothing. */
  const groups = []
  let built = false

  /* Range labels read as what they are — 350ms, 0.020, 24 — not as raw floats.
     Shared with the voice side, which has to say the same thing out loud. */
  const format = formatValue

  function row (field, section) {
    const wrap = el('div', `set-row set-${field.type}`)
    rows.push({ field, wrap, section: section.title })

    /* A picture, not a value. Like an action it skips the whole commit path
       below — it has nothing to read back and nothing to write — but unlike an
       action it wants to know when something under it changed, which is what
       the handle it gets back from the renderer is for. */
    if (field.type === 'preview') {
      const host = el('div', 'set-preview')
      wrap.append(host)
      const make = previews[field.preview]
      if (make) livePreviews.push(make(host))
      return wrap
    }

    /* A button, not a value. It reads nothing back and writes nothing, so it
       skips the whole commit path below — `show()` has nothing to show for
       it, and `inputs` never learns about it. */
    if (field.type === 'action') {
      const button = el('button', 'set-action', field.label)
      button.type = 'button'
      button.addEventListener('click', async () => {
        const run = actions[field.action]
        if (!run) return note(`${field.label} · unavailable`)
        button.disabled = true
        try { await run() } catch (err) { note(err.message) } finally { button.disabled = false }
      })
      wrap.append(button)
      if (field.help) wrap.append(el('p', 'set-help', field.help))
      return wrap
    }

    const input = field.type === 'select' ? el('select') : el('input')
    const value = el('span', 'set-value')

    /* Marks the settings that only take hold at launch. It was a whole
       sentence under every such row; as a tag beside the label it says the
       same thing in the place you are already looking, and the banner at the
       top of the panel does the explaining once something actually changes. */
    const restartTag = () => {
      const tag = el('span', 'set-tag', 'restart')
      tag.title = 'Only takes effect when transvibe restarts'
      return tag
    }

    if (field.type === 'toggle') {
      // A checkbox with its label is the whole row — a value readout beside it
      // would only say again what the tick already says.
      input.type = 'checkbox'
      const label = el('label', 'set-check')
      label.append(input, el('span', null, field.label))
      if (field.restart) label.append(restartTag())
      wrap.append(label)
    } else {
      const head = el('div', 'set-head')
      /* The label and the revert arrow travel together, so the arrow sits
         against the name of the setting it puts back rather than drifting to
         the far side of the row where it reads as punctuation after the
         value. */
      const named = el('div', 'set-named')
      named.append(el('label', null, field.label))
      head.append(named)
      if (field.restart) head.append(restartTag())
      if (field.type === 'range') {
        input.type = 'range'
        input.min = field.min
        input.max = field.max
        input.step = field.step
        head.append(value)
      } else if (field.type === 'select') {
        /* Filled in by show(), which asks for the list every time the panel
           opens — another app can download a model while this one is running.
           It can also download one while the panel is *already* open, which is
           why the readout is a button: it is the only thing on the row that
           was ever going to be clicked to ask again. */
        value.classList.add('set-refresh')
        const refresh = el('button', 'set-refresh-btn')
        refresh.type = 'button'
        refresh.title = 'Look again'
        refresh.textContent = '⟳'
        refresh.addEventListener('click', async () => {
          refresh.disabled = true
          try { await show(field) } finally { refresh.disabled = false }
        })
        head.append(value, refresh)
      } else {
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        if (field.placeholder) input.placeholder = field.placeholder
      }
      wrap.append(head, input)
    }

    /* Moved from where it shipped. The dot says so and puts it back, which is
       the only way to undo a setting you tuned by ear over a week and can no
       longer remember the shape of. Hidden entirely while the value is the
       default, so a panel you have not touched has nothing extra on it. */
    const revert = el('button', 'set-revert')
    revert.type = 'button'
    revert.hidden = true
    // An arrow rather than a dot: a dot says something is marked, an arrow
    // says what clicking it would do.
    revert.textContent = '↺'
    revert.title = 'Back to the default'
    revert.setAttribute('aria-label', `Put ${field.label} back to its default`)
    revert.addEventListener('click', async () => {
      const defaults = getDefaults()
      if (!defaults || !(field.key in defaults)) return
      wrap.classList.remove('invalid')
      await write(defaults[field.key])
    })
    // On a toggle the whole row is the label, so the dot goes after it rather
    // than inside the thing a click would tick.
    if (field.type === 'toggle') wrap.append(revert)
    else wrap.querySelector('.set-named').append(revert)

    if (field.help) wrap.append(el('p', 'set-help', field.help))

    /* One path to the file, whether the value came from the control or from
       the defaults. Reverting is a save like any other: it applies live, it
       re-reads, it flashes, and it warns about a restart if that is what it
       needs — none of which would be true of quietly writing the key. */
    const write = async next => {
      if (field.external) await setExternal(field.key, next)
      else {
        await save({ [field.key]: next })
        applyLive(field.key)
        // Choosing the orb takes the ribbon's dials off the page and puts the
        // orb's there, in the same gesture that changed it.
        applyVisibility()
      }
      // Showing it again rather than trusting the click: an external setting
      // can refuse (macOS declining a login item), and then the tick has to go
      // back to what is true.
      await show(field)
      note(`${field.label} · saved`)
      flash(wrap)
      refreshPreviews()
      // Written, but not in effect until the engine is built again. The banner
      // is how you find that out without reading every row you touched.
      if (field.restart) showRestart()
    }

    const commit = async () => {
      const raw = field.type === 'toggle' ? input.checked : input.value
      const next = coerce(field, raw)
      /* Nothing usable came out of it. Putting the old value back silently
         looks like the typing was dropped on the floor, so the row is marked
         and the footer says which field and why, and both clear the moment
         something usable is typed. */
      if (next === undefined) {
        wrap.classList.add('invalid')
        note(`${field.label} · needs a value`)
        return show(field)
      }
      wrap.classList.remove('invalid')
      await write(next)
    }

    /* Ranges update their readout on every pixel of the drag but only write on
       release: dragging from 6s to 30s would otherwise be twenty-four writes.

       Release is not the only way a range changes, though. Held down, an arrow
       key fires `change` on every repeat, which is the same twenty-four writes
       the drag was careful to avoid — so the write is held back until the
       value has stopped moving. A drag pays a quarter of a second for it and
       does not notice; a keyboard pays it once for the whole run. */
    if (field.type === 'range') {
      let settle = null
      input.addEventListener('input', () => { value.textContent = format(field, input.value) })
      input.addEventListener('change', () => {
        clearTimeout(settle)
        settle = setTimeout(commit, 250)
      })
    } else if (field.type === 'toggle' || field.type === 'select') {
      input.addEventListener('change', commit)
    } else {
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
    }

    inputs.set(field.key, { field, input, value, wrap, revert })
    return wrap
  }

  /* The footer says what was saved, but the footer is at the bottom of a panel
     760px wide and your eye is on the control you just moved. The row says it
     too, where you are looking, and then stops saying it. */
  /* A setting changed, so whatever is drawing a picture of the settings is
     out of date. Each preview decides for itself whether that means anything
     to it — most saves are nothing to do with the visualizer. */
  function refreshPreviews () {
    for (const preview of livePreviews) {
      try { preview && preview.update && preview.update(getSettings()) } catch { /* a preview is never worth a broken panel */ }
    }
  }

  function flash (wrap) {
    wrap.classList.remove('saved')
    // Forcing a reflow: re-adding a class in the same frame does not restart
    // the animation, and dragging a slider twice should flash twice.
    void wrap.offsetWidth
    wrap.classList.add('saved')
  }

  /* One banner for the whole panel rather than one per pane: a restart is the
     app's, not the section's, and you can change the model in Transcription
     and voice isolation in Listening before you are ready to act on either. */
  let restartBanner = null

  function showRestart () {
    if (restartBanner) restartBanner.hidden = false
  }

  function buildRestartBanner () {
    const bar = el('div', 'set-restart')
    bar.hidden = true
    bar.role = 'status'
    bar.append(el('span', null,
      'Some of what you changed is built when transvibe starts, so it is saved but not yet in effect.'))
    if (relaunch) {
      const button = el('button', null, 'Restart now')
      button.type = 'button'
      button.addEventListener('click', () => relaunch())
      bar.append(button)
    }
    const dismiss = el('button', 'set-restart-hide', '×')
    dismiss.type = 'button'
    dismiss.title = 'Not now'
    dismiss.addEventListener('click', () => { bar.hidden = true })
    bar.append(dismiss)
    return bar
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
    markChanged(entry, current)
  }

  /* A row is 'changed' relative to what the app ships with, not to what it
     held a moment ago: the point is to find the three settings you moved
     among the fifty you did not. */
  function markChanged (entry, current) {
    const { field, wrap, revert } = entry
    const defaults = getDefaults()
    const moved = !!defaults && (field.key in defaults) &&
      !isDefault(field, current, defaults)
    wrap.classList.toggle('changed', moved)
    if (revert) revert.hidden = !moved
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

  /* An id per section, so a tab and its pane can point at each other. Scoped
     with a prefix because the panel shares a document with the strip. */
  const slug = title => 'set-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  function buildTabs (panes) {
    const nav = el('nav', 'set-nav')
    nav.role = 'tablist'
    nav.setAttribute('aria-orientation', 'vertical')
    nav.setAttribute('aria-label', 'Settings sections')
    const tabs = new Map()

    const select = (title, focus = false) => {
      currentTab = title
      for (const [name, pane] of panes) pane.hidden = name !== title
      for (const [name, tab] of tabs) {
        const on = name === title
        tab.classList.toggle('on', on)
        tab.setAttribute('aria-selected', String(on))
        /* Only the open tab is a tab stop. Tab moves to the settings; the
           arrows move between sections — which is what a tablist is, and what
           seven buttons in a row would otherwise cost seven presses. */
        tab.tabIndex = on ? 0 : -1
      }
      if (focus) tabs.get(title)?.focus()
      // A tab is a different page, not a scroll position: it starts at the top.
      body.scrollTop = 0
    }

    /* Coming back out of a search: the tab that was open before it started is
       open again, and everything else is hidden again. Search does not change
       which tab you are on, because you were not choosing one. */
    const restore = () => {
      for (const [name, pane] of panes) pane.hidden = name !== currentTab
    }

    const order = panes.map(([title]) => title)
    const step = (from, delta) => {
      const at = order.indexOf(from)
      if (at < 0) return
      // Wrapping, because a list you can fall off the end of is a list you
      // have to look at to use.
      select(order[(at + delta + order.length) % order.length], true)
    }

    for (const [title, pane] of panes) {
      const tab = el('button', null, title)
      tab.type = 'button'
      tab.role = 'tab'
      tab.id = `${slug(title)}-tab`
      tab.tabIndex = -1
      tab.setAttribute('aria-controls', slug(title))
      pane.id = slug(title)
      pane.role = 'tabpanel'
      pane.setAttribute('aria-labelledby', tab.id)
      // A pane is scrolled and focusable in its own right, so the arrow keys
      // that moved between tabs do not have to be the only way back into it.
      pane.tabIndex = 0
      tab.onclick = () => select(title)
      tab.addEventListener('keydown', e => {
        const move = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
        if (move) { e.preventDefault(); return step(title, move) }
        if (e.key === 'Home') { e.preventDefault(); return select(order[0], true) }
        if (e.key === 'End') { e.preventDefault(); return select(order[order.length - 1], true) }
      })
      tabs.set(title, tab)
      nav.append(tab)
    }

    return { nav, select, restore, has: title => tabs.has(title) }
  }

  /**
   * The way in when you do not know which tab a setting is in — which is most
   * times, because the tabs are named for what the app does and you are
   * looking for what a setting is called. Typing replaces the tabs with every
   * match, under the name of the section each came from, so the search also
   * teaches you where the thing lives.
   */
  function buildSearch () {
    const wrap = el('div', 'set-search')
    const input = el('input')
    input.type = 'search'
    input.placeholder = 'Search settings'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', 'Search settings')

    const run = () => {
      query = input.value
      applyVisibility()
      body.scrollTop = 0
    }
    input.addEventListener('input', run)
    /* Escape empties the box rather than closing the panel: with something
       typed, the search is the thing in the way, and the panel is not. The
       strip's own escape handler gets it back once the box is empty. */
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape' && input.value) {
        e.stopPropagation()
        input.value = ''
        run()
      }
    })
    wrap.append(input)
    return wrap
  }

  let tabs = null
  /* The panes, each with the rows in it, so search can ask a pane whether it
     still has anything to show. */
  const paneList = []
  let empty = null

  /* What is being searched for, or '' for the ordinary tabbed panel. Held
     here rather than read off the box, because visibility is recomputed after
     every save as well as after every keystroke. */
  let query = ''

  /* Which rows belong on screen at all, given what the settings say and what
     is being looked for. Run on every open, after every change — a change is
     exactly what can make a row stop applying — and on every keystroke in the
     search box.

     Searching does not rebuild anything: the rows are already in their panes,
     so a search is every pane open at once with the rows that do not match
     taken out of it. Which means a setting found by search is the same row,
     with the same handlers, in the same place it will be next time you come
     looking for it in its tab. */
  function applyVisibility () {
    const settings = getSettings()
    const searching = !!query.trim()

    for (const { field, wrap, section } of rows) {
      wrap.hidden = !fieldApplies(field, settings) ||
        (searching && !fieldMatches(field, query, section))
    }

    const rowHidden = key => {
      const found = rows.find(r => r.field.key === key)
      return !found || found.wrap.hidden
    }
    for (const { heading, fields } of groups) {
      heading.hidden = fields.length > 0 && fields.every(f => rowHidden(f.key))
    }

    body.classList.toggle('searching', searching)
    if (!searching) return tabs && tabs.restore()

    /* Every pane that still has something in it, all at once and each under
       its own name — the name being the thing you did not know, which is why
       you were typing. */
    let hits = 0
    for (const { pane, rows: paneRows } of paneList) {
      const shown = paneRows.filter(r => !r.wrap.hidden).length
      hits += shown
      pane.hidden = shown === 0
    }
    if (empty) empty.hidden = hits > 0
  }

  function build () {
    const content = el('div', 'set-sections')
    const panes = []

    for (const section of SECTIONS) {
      // No heading inside the pane: the tab beside it, lit, at the same height,
      // is already the title. Two of them was just the word twice.
      const pane = el('section', 'set-pane')
      /* Except while searching, when the tabs are gone and several panes are
         on screen at once. Then it is the only thing saying which section a
         row was found in — which is the answer you came for. */
      pane.append(el('h3', 'set-pane-title', section.title))
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
      let entry = null
      for (const field of section.fields) {
        if (field.group && field.group !== group) {
          const heading = el('h4', 'set-group', field.group)
          entry = { heading, fields: [] }
          groups.push(entry)
          pane.append(heading)
        }
        group = field.group || group
        if (entry && field.group === group) entry.fields.push(field)
        pane.append(row(field, section))
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

      /* Putting a whole section back. Armed on the first click like the agent
         roster's remove, because it is the one control here that throws away
         work — every other button in this panel changes one value you can see
         the old shape of. */
      // Built before the defaults have arrived, so the test is what the
      // section holds rather than what would be written: a pane of nothing but
      // buttons and external settings has nothing to put back.
      if (section.fields.some(f => f.type !== 'action' && !f.external)) {
        const reset = el('button', 'set-reset', 'Reset this section')
        reset.type = 'button'
        let armed = false
        const disarm = () => {
          armed = false
          reset.textContent = 'Reset this section'
          reset.classList.remove('armed')
        }
        reset.addEventListener('click', async () => {
          if (!armed) {
            armed = true
            reset.textContent = `Put all of ${section.title} back?`
            reset.classList.add('armed')
            return note('Click again to confirm.')
          }
          disarm()
          const defaults = getDefaults()
          if (!defaults) return note('Defaults unavailable')
          const patch = sectionDefaults(section, defaults)
          if (!Object.keys(patch).length) return note('Nothing to reset')
          await save(patch)
          for (const key of Object.keys(patch)) applyLive(key)
          applyVisibility()
          await showAll()
          refreshPreviews()
          if (section.fields.some(f => f.restart)) showRestart()
          note(`${section.title} · back to defaults`)
        })
        reset.addEventListener('mouseleave', disarm)
        reset.addEventListener('blur', disarm)
        pane.append(reset)
      }

      content.append(pane)
      panes.push([section.title, pane])
      paneList.push({
        pane,
        rows: rows.filter(r => r.section === section.title)
      })
    }

    tabs = buildTabs(panes)
    restartBanner = buildRestartBanner()
    empty = el('p', 'set-empty', 'Nothing here goes by that name.')
    empty.hidden = true
    content.append(empty)
    body.append(buildSearch(), restartBanner, tabs.nav, content)
    tabs.select(currentTab && tabs.has(currentTab) ? currentTab : panes[0][0])

    built = true
  }

  /** Every row re-read from the file. What a section reset has to do, and
      what opening the panel does. */
  function showAll () {
    return Promise.all([...inputs.values()].map(({ field }) => show(field)))
  }

  return {
    /** Called every time the panel opens: build once, then re-read the file. */
    render () {
      if (!built) build()
      // Not awaited: the panel is already on screen, and the one external
      // field filling in a tick later is better than the whole panel waiting.
      applyVisibility()
      showAll()
      refreshPreviews()
      for (const preview of livePreviews) preview && preview.start && preview.start()
      for (const { pane, render } of customPanes.values()) render(pane)
    },

    /** Called when the panel closes. A preview drawing thirty frames a second
        behind a hidden panel is the app's own frame budget spent on nothing. */
    suspend () {
      for (const preview of livePreviews) preview && preview.stop && preview.stop()
    }
  }
}
