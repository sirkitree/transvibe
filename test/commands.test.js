import { describe, it, expect } from 'vitest'
import {
  parseCommand,
  applyCommand,
  splitSentences,
  splitWords,
  COMMANDS
} from '../src/renderer/commands.js'

const parse = (utterance) => parseCommand(utterance)
const actionOf = (utterance) => {
  const c = parseCommand(utterance)
  return c && c.action
}

describe('parseCommand — capitalize', () => {
  it('handles every listed phrasing', () => {
    expect(parse('capitalize that')).toMatchObject({
      action: 'capitalize',
      target: 'last-sentence',
      count: null
    })
    expect(parse('capitalise that')).toMatchObject({ action: 'capitalize' })
    expect(parse('capitalize the last word')).toMatchObject({
      action: 'capitalize',
      target: 'last-word'
    })
    expect(parse('capitalize the last sentence')).toMatchObject({
      action: 'capitalize',
      target: 'last-sentence'
    })
  })

  it('keeps the raw utterance untouched', () => {
    expect(parse('  Capitalize That.  ').raw).toBe('  Capitalize That.  ')
  })
})

describe('parseCommand — uppercase / lowercase', () => {
  it('recognises uppercase phrasings', () => {
    for (const u of ['uppercase that', 'upper case that', 'all caps that', 'make that all caps', 'shout that']) {
      expect(actionOf(u), u).toBe('uppercase')
      expect(parse(u).target, u).toBe('last-sentence')
    }
  })

  it('recognises lowercase phrasings', () => {
    for (const u of ['lowercase that', 'lower case that', 'make that lowercase', 'no caps']) {
      expect(actionOf(u), u).toBe('lowercase')
      expect(parse(u).target, u).toBe('last-sentence')
    }
  })

  it('carries word targets through', () => {
    expect(parse('uppercase the last two words')).toMatchObject({
      action: 'uppercase',
      target: 'last-n-words',
      count: 2
    })
  })
})

describe('parseCommand — delete', () => {
  it('recognises every phrasing', () => {
    for (const u of ['delete that', 'scratch that', 'strike that']) {
      expect(parse(u), u).toMatchObject({ action: 'delete', target: 'last-sentence' })
    }
    expect(parse('delete the last word')).toMatchObject({
      action: 'delete',
      target: 'last-word',
      count: null
    })
    expect(parse('delete the last sentence')).toMatchObject({
      action: 'delete',
      target: 'last-sentence'
    })
    for (const u of ['delete everything', 'delete all']) {
      expect(parse(u), u).toMatchObject({ action: 'delete', target: 'all' })
    }
  })

  it('accepts spelled-out numbers one..twenty', () => {
    const words = [
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
      'seventeen', 'eighteen', 'nineteen', 'twenty'
    ]
    words.forEach((word, i) => {
      const c = parse(`delete the last ${word} words`)
      expect(c, word).toMatchObject({ action: 'delete', target: 'last-n-words', count: i + 1 })
    })
  })

  it('accepts digits, which whisper also emits', () => {
    expect(parse('delete the last 3 words')).toMatchObject({
      action: 'delete',
      target: 'last-n-words',
      count: 3
    })
    expect(parse('delete the last 12 words').count).toBe(12)
  })
})

describe('parseCommand — undo, punctuate, newParagraph', () => {
  it('recognises undo phrasings', () => {
    for (const u of ['undo', 'undo that', 'never mind', 'nevermind']) {
      expect(actionOf(u), u).toBe('undo')
    }
  })

  it('maps punctuation words to marks', () => {
    const cases = [
      ['period', '.'],
      ['full stop', '.'],
      ['comma', ','],
      ['question mark', '?'],
      ['exclamation point', '!'],
      ['exclamation mark', '!'],
      ['colon', ':'],
      ['semicolon', ';'],
      ['make that a question', '?']
    ]
    for (const [u, mark] of cases) {
      const c = parse(u)
      expect(c, u).toMatchObject({ action: 'punctuate' })
      expect(c.args.mark, u).toBe(mark)
    }
  })

  it('recognises new paragraph phrasings', () => {
    for (const u of ['new paragraph', 'new line', 'line break']) {
      expect(actionOf(u), u).toBe('newParagraph')
    }
  })
})

describe('parseCommand — replace', () => {
  it('recognises all three verbs', () => {
    for (const u of ['replace cat with dog', 'change cat to dog', 'swap cat for dog']) {
      const c = parse(u)
      expect(c, u).toMatchObject({ action: 'replace', target: null })
      expect(c.args, u).toEqual({ from: 'cat', to: 'dog' })
    }
  })

  it('handles multi-word operands', () => {
    expect(parse('replace big red dog with small blue cat').args).toEqual({
      from: 'big red dog',
      to: 'small blue cat'
    })
  })
})

describe('parseCommand — app-level commands', () => {
  it('recognises copy', () => {
    for (const u of ['copy that', 'copy all', 'copy everything', 'copy the transcript']) {
      expect(parse(u), u).toMatchObject({ action: 'copy', target: 'all' })
    }
  })

  it('recognises clear', () => {
    for (const u of ['clear all', 'clear everything', 'clear the transcript', 'start over']) {
      expect(parse(u), u).toMatchObject({ action: 'clear', target: 'all' })
    }
  })

  it('recognises pause, resume and hide', () => {
    for (const u of ['stop listening', 'pause listening', 'pause']) {
      expect(actionOf(u), u).toBe('pause')
    }
    for (const u of ['start listening', 'resume listening', 'resume']) {
      expect(actionOf(u), u).toBe('resume')
    }
    for (const u of ['hide', 'hide the window', 'go away', 'dismiss']) {
      expect(actionOf(u), u).toBe('hide')
    }
  })
})

describe('parseCommand — normalisation', () => {
  it('tolerates trailing periods and capitalisation from whisper', () => {
    expect(actionOf('Capitalize that.')).toBe('capitalize')
    expect(actionOf('Scratch that!')).toBe('delete')
    expect(actionOf('  DELETE THE LAST WORD  ')).toBe('delete')
    expect(actionOf('"New paragraph."')).toBe('newParagraph')
  })

  it('tolerates a leading filler word', () => {
    for (const filler of ['uh', 'um', 'okay', 'please', 'now']) {
      expect(actionOf(`${filler} delete that`), filler).toBe('delete')
    }
    expect(actionOf('Um, scratch that.')).toBe('delete')
  })

  it('collapses runs of whitespace', () => {
    expect(actionOf('delete   the    last   word')).toBe('delete')
  })

  it('does not eat words that merely start with a filler', () => {
    expect(parse('umbrella')).toBeNull()
  })
})

describe('parseCommand — refuses to guess', () => {
  it('returns null for plain dictation that starts with a command verb', () => {
    const dictation = [
      'capitalize the report before sending it',
      'delete the file from the server',
      'please copy the notes into the doc tomorrow',
      'we should replace the old router',
      'change the meeting',
      'clear the table after dinner',
      'undo the damage from last week',
      'i had to shout across the room',
      'hide the presents in the closet somewhere'
    ]
    for (const u of dictation) {
      expect(parse(u), u).toBeNull()
    }
  })

  it('returns null for empty, whitespace and non-string input', () => {
    expect(parse('')).toBeNull()
    expect(parse('   ')).toBeNull()
    expect(parse('...')).toBeNull()
    expect(parse(null)).toBeNull()
    expect(parse(undefined)).toBeNull()
    expect(parse(42)).toBeNull()
    expect(parse({})).toBeNull()
  })

  it('returns null for an unparseable count', () => {
    expect(parse('delete the last several words')).toBeNull()
    expect(parse('delete the last zero words')).toBeNull()
  })
})

describe('applyCommand — text edits', () => {
  it('capitalises every word of a word target', () => {
    const r = applyCommand(parse('capitalize the last two words'), 'a quick brown fox')
    expect(r.text).toBe('a quick Brown Fox')
    expect(r.changed).toBe(true)
    expect(r.effect).toBeNull()
  })

  it('capitalises only the first letter of a sentence target', () => {
    const r = applyCommand(parse('capitalize that'), 'one two. three four.')
    expect(r.text).toBe('one two. Three four.')
  })

  it('uppercases and lowercases', () => {
    expect(applyCommand(parse('all caps that'), 'hi there. shout this').text)
      .toBe('hi there. SHOUT THIS')
    expect(applyCommand(parse('lowercase the last word'), 'hello WORLD').text)
      .toBe('hello world')
  })

  it('reports no change when the text is already in that form', () => {
    const r = applyCommand(parse('uppercase the last word'), 'hello WORLD')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('hello WORLD')
  })

  it('deletes words, sentences and everything', () => {
    expect(applyCommand(parse('delete the last word'), 'one two three').text)
      .toBe('one two')
    expect(applyCommand(parse('delete the last 2 words'), 'one two three').text)
      .toBe('one')
    expect(applyCommand(parse('scratch that'), 'First one. Second one.').text)
      .toBe('First one.')
    const all = applyCommand(parse('delete everything'), 'anything at all')
    expect(all.text).toBe('')
    expect(all.changed).toBe(true)
  })

  it('clamps a count larger than the transcript', () => {
    const r = applyCommand(parse('delete the last twenty words'), 'only three words')
    expect(r.text).toBe('')
    expect(r.changed).toBe(true)
  })

  it('appends a new paragraph', () => {
    const r = applyCommand(parse('new paragraph'), 'first thought')
    expect(r.text).toBe('first thought\n\n')
    expect(r.changed).toBe(true)
  })
})

describe('applyCommand — punctuate', () => {
  it('appends the mark', () => {
    expect(applyCommand(parse('period'), 'hello there').text).toBe('hello there.')
    expect(applyCommand(parse('comma'), 'hello there').text).toBe('hello there,')
    expect(applyCommand(parse('semicolon'), 'hello there').text).toBe('hello there;')
  })

  it('collapses an existing trailing mark and the space before it', () => {
    expect(applyCommand(parse('period'), 'hello .').text).toBe('hello.')
    expect(applyCommand(parse('question mark'), 'hello there.').text).toBe('hello there?')
    expect(applyCommand(parse('make that a question'), 'is it raining.').text)
      .toBe('is it raining?')
    expect(applyCommand(parse('exclamation point'), 'wow   ').text).toBe('wow!')
  })

  it('reports no change when the mark is already there', () => {
    const r = applyCommand(parse('period'), 'done.')
    expect(r.text).toBe('done.')
    expect(r.changed).toBe(false)
  })
})

describe('applyCommand — replace', () => {
  it('replaces the LAST occurrence only', () => {
    const r = applyCommand(parse('replace cat with dog'), 'the cat saw a cat today')
    expect(r.text).toBe('the cat saw a dog today')
    expect(r.changed).toBe(true)
  })

  it('matches case-insensitively while preserving surrounding text', () => {
    const r = applyCommand(parse('change cat to dog'), 'A Cat sat. Another CAT sat.')
    expect(r.text).toBe('A Cat sat. Another dog sat.')
  })

  it('reports a miss without changing anything', () => {
    const r = applyCommand(parse('swap zebra for dog'), 'no such animal here')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('no such animal here')
    expect(r.message).toMatch(/not found/)
  })
})

describe('applyCommand — effects', () => {
  it('returns undo without touching the text', () => {
    const r = applyCommand(parse('undo that'), 'some text')
    expect(r).toMatchObject({ text: 'some text', effect: 'undo', changed: false })
  })

  it('returns copy, pause, resume and hide effects', () => {
    expect(applyCommand(parse('copy all'), 'text').effect).toBe('copy')
    expect(applyCommand(parse('pause'), 'text').effect).toBe('pause')
    expect(applyCommand(parse('resume'), 'text').effect).toBe('resume')
    expect(applyCommand(parse('hide'), 'text').effect).toBe('hide')
    for (const u of ['copy all', 'pause', 'resume', 'hide']) {
      expect(applyCommand(parse(u), 'text').text, u).toBe('text')
      expect(applyCommand(parse(u), 'text').changed, u).toBe(false)
    }
  })

  it('clears the transcript', () => {
    const r = applyCommand(parse('clear everything'), 'goodbye')
    expect(r).toMatchObject({ text: '', effect: 'clear', changed: true })
  })
})

describe('applyCommand — empty transcript is always safe', () => {
  const utterances = [
    'capitalize that',
    'uppercase that',
    'lowercase that',
    'delete that',
    'delete everything',
    'undo',
    'period',
    'make that a question',
    'new paragraph',
    'replace cat with dog',
    'copy all',
    'clear all',
    'pause',
    'resume',
    'hide'
  ]

  for (const source of ['', '   ', '\n\n']) {
    for (const u of utterances) {
      it(`${u} on ${JSON.stringify(source)}`, () => {
        const cmd = parse(u)
        expect(cmd, u).not.toBeNull()
        let r
        expect(() => { r = applyCommand(cmd, source) }).not.toThrow()
        expect(r.text).toBe(source)
        expect(r.changed).toBe(false)
        expect(typeof r.message).toBe('string')
        expect(r.message.length).toBeGreaterThan(0)
      })
    }
  }

  it('says there is nothing to act on for text edits', () => {
    expect(applyCommand(parse('delete that'), '').message).toMatch(/nothing/)
    expect(applyCommand(parse('period'), '').message).toMatch(/nothing/)
    expect(applyCommand(parse('clear all'), '').message).toMatch(/nothing/)
  })

  it('never throws on rubbish input', () => {
    expect(() => applyCommand(null, 'text')).not.toThrow()
    expect(applyCommand(null, 'text')).toMatchObject({ text: 'text', changed: false })
    expect(applyCommand({ action: 'wat' }, 'text').changed).toBe(false)
    expect(applyCommand(parse('delete that'), null).text).toBe('')
    expect(applyCommand(parse('delete that'), undefined).changed).toBe(false)
  })
})

describe('applyCommand — messages', () => {
  it('are short and human', () => {
    expect(applyCommand(parse('capitalize the last word'), 'hello world').message)
      .toBe('capitalized "World"')
    expect(applyCommand(parse('delete the last word'), 'hello world').message)
      .toBe('deleted "world"')
    expect(applyCommand(parse('replace cat with dog'), 'a cat').message)
      .toBe('replaced "cat" with "dog"')
    expect(applyCommand(parse('period'), 'hi').message).toBe('added "."')
  })

  it('truncates a long quoted chunk', () => {
    const long = 'word '.repeat(40).trim()
    const msg = applyCommand(parse('delete everything'), long).message
    expect(msg.length).toBeLessThan(60)
  })
})

describe('splitWords', () => {
  it('splits on runs of whitespace', () => {
    expect(splitWords('one  two\tthree\nfour')).toEqual(['one', 'two', 'three', 'four'])
  })

  it('is empty for empty or non-string input', () => {
    expect(splitWords('')).toEqual([])
    expect(splitWords('   ')).toEqual([])
    expect(splitWords(null)).toEqual([])
  })

  it('keeps punctuation attached to its word', () => {
    expect(splitWords('hello, world.')).toEqual(['hello,', 'world.'])
  })
})

describe('splitSentences', () => {
  it('keeps trailing punctuation with its sentence', () => {
    expect(splitSentences('One thing. Two things! Three?'))
      .toEqual(['One thing.', 'Two things!', 'Three?'])
  })

  it('handles no trailing punctuation at all', () => {
    expect(splitSentences('just a fragment')).toEqual(['just a fragment'])
  })

  it('keeps multiple terminators together', () => {
    expect(splitSentences('Wait!! Really?')).toEqual(['Wait!!', 'Really?'])
    expect(splitSentences('What?!')).toEqual(['What?!'])
  })

  it('does not split on abbreviations', () => {
    expect(splitSentences('Mr. Smith went home.')).toEqual(['Mr. Smith went home.'])
    expect(splitSentences('Bring a coat, e.g. the blue one.'))
      .toEqual(['Bring a coat, e.g. the blue one.'])
    expect(splitSentences('Dr. Who and Mrs. Peel.')).toEqual(['Dr. Who and Mrs. Peel.'])
  })

  it('does not split on ellipses', () => {
    expect(splitSentences('Hold on... I am thinking.'))
      .toEqual(['Hold on... I am thinking.'])
    expect(splitSentences('Hold on… I am thinking.'))
      .toEqual(['Hold on… I am thinking.'])
  })

  it('treats newlines as separators', () => {
    expect(splitSentences('first line\nsecond line')).toEqual(['first line', 'second line'])
    expect(splitSentences('one.\n\ntwo')).toEqual(['one.', 'two'])
  })

  it('is empty for empty or non-string input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   \n  ')).toEqual([])
    expect(splitSentences(null)).toEqual([])
  })
})

describe('send', () => {
  it('fires on whole-transcript phrasings', () => {
    for (const said of ['send that', 'send it', 'send everything', 'send all',
                        'send the transcript', 'ship it', 'Send that.', 'send']) {
      expect(parseCommand(said), said).toMatchObject({ action: 'send' })
    }
  })

  it('does not fire on dictation that merely mentions sending', () => {
    for (const said of [
      'send that email to Bob',
      'send the report to the team when ready',
      'i will send that over later',
      'send them a message about the meeting',
      'we should send a follow up tomorrow',
      'can you send the invoice to accounting'
    ]) {
      expect(parseCommand(said), said).toBeNull()
    }
  })

  it('reports the send effect without touching the text', () => {
    const text = 'hello there'
    const res = applyCommand(parseCommand('send that'), text)
    expect(res.effect).toBe('send')
    expect(res.text).toBe(text)
    expect(res.changed).toBe(false)
  })

  it('is safe on an empty transcript', () => {
    const res = applyCommand(parseCommand('send that'), '')
    expect(res.changed).toBe(false)
    expect(() => applyCommand(parseCommand('send that'), '')).not.toThrow()
  })
})

describe('COMMANDS stays in sync with the parser', () => {
  it('covers every action the contract lists, once each', () => {
    const actions = COMMANDS.map((c) => c.action)
    expect(new Set(actions).size).toBe(actions.length)
    expect(actions.sort()).toEqual([
      'capitalize', 'clear', 'copy', 'delete', 'hide', 'lowercase',
      'newParagraph', 'pause', 'punctuate', 'replace', 'resume', 'send', 'undo',
      'uppercase'
    ].sort())
  })

  it('has help text and at least one example per entry', () => {
    for (const entry of COMMANDS) {
      expect(Array.isArray(entry.examples), entry.action).toBe(true)
      expect(entry.examples.length, entry.action).toBeGreaterThan(0)
      expect(typeof entry.help, entry.action).toBe('string')
      expect(entry.help.length, entry.action).toBeGreaterThan(0)
    }
  })

  it('parses every documented example to its own action', () => {
    for (const entry of COMMANDS) {
      for (const example of entry.examples) {
        const parsed = parseCommand(example)
        expect(parsed, example).not.toBeNull()
        expect(parsed.action, example).toBe(entry.action)
      }
    }
  })

  it('applies every documented example without throwing', () => {
    const sample = 'The quick brown fox. It jumped over a lazy cat.'
    for (const entry of COMMANDS) {
      for (const example of entry.examples) {
        const cmd = parseCommand(example)
        let result
        expect(() => { result = applyCommand(cmd, sample) }, example).not.toThrow()
        expect(typeof result.text, example).toBe('string')
        expect(typeof result.changed, example).toBe('boolean')
        expect(typeof result.message, example).toBe('string')
      }
    }
  })
})

describe('parseCommand — false positives in ordinary dictation', () => {
  // The worst failure mode: a dictated sentence that quietly fires a command
  // eats the user's speech. Commands are whole, short utterances; a command
  // word buried in a longer clause must never match.
  const dictation = [
    'I need to copy that file',
    "let's undo the last commit",
    'delete the old branch',
    'we should pause and think',
    'period costumes were expensive',
    'replace the washer with a new one',
    'clear all the dishes',
    'hide the evidence',
    'copy that down before the meeting',
    'scratch that itch on my arm',
    'strike that from the record please',
    'change that to a bigger size',
    'swap that for the other one',
    'undo that knot for me',
    'we need to clear everything off the counter',
    'copy everything into the new folder',
    'please delete everything in the trash',
    'delete all the temp files',
    'start over from the beginning of the chapter',
    'new line of thinking here',
    'a comma splice is a grammar mistake',
    'the colon is part of the digestive system',
    'hide the window from the sun',
    'go away he shouted',
    'dismiss the case entirely',
    'stop listening to him',
    'make that a question of priorities',
    'shout that from the rooftops',
    'capitalize that word in the title',
    'all caps that headline looks bad',
    'uppercase that column in the spreadsheet',
    'no caps lock on this keyboard',
    'full stop we are done here',
    'line break dancing was popular',
    'pause the movie for a second',
    'question mark tattoos are weird',
    'i want to remove that stain',
    'erase that drawing on the board',
    'change my flight to Tuesday',
    'swap the tires for winter ones',
    'replace it with something better'
  ]

  for (const u of dictation) {
    it(`ignores ${JSON.stringify(u)}`, () => {
      expect(parse(u), u).toBeNull()
    })
  }
})

describe('parseCommand — survives real whisper output', () => {
  it('tolerates capitalisation and terminal punctuation', () => {
    const cases = [
      ['Delete that.', 'delete'],
      ['Capitalize that!', 'capitalize'],
      ['Scratch that?', 'delete'],
      ['New paragraph!', 'newParagraph'],
      ['Question mark.', 'punctuate'],
      ['Make that a question?', 'punctuate'],
      ['Copy that.', 'copy'],
      ['Clear everything.', 'clear'],
      ['Start over.', 'clear'],
      ['Hide the window.', 'hide'],
      ['Replace cat with dog.', 'replace'],
      ['Undo that.', 'undo'],
      ['Never mind.', 'undo'],
      ['Stop listening.', 'pause']
    ]
    for (const [u, action] of cases) expect(actionOf(u), u).toBe(action)
  })

  it('accepts digits where whisper writes numerals', () => {
    expect(parse('Delete the last 3 words.')).toMatchObject({
      action: 'delete',
      target: 'last-n-words',
      count: 3
    })
    expect(parse('uppercase the last 2 words').count).toBe(2)
  })

  it('tolerates a dropped "the"', () => {
    expect(parse('delete last word')).toMatchObject({ target: 'last-word' })
    expect(parse('capitalize last sentence')).toMatchObject({ target: 'last-sentence' })
    expect(parse('delete last three words')).toMatchObject({ count: 3 })
  })

  it('tolerates a dropped plural or a dropped "words"', () => {
    expect(parse('delete the last two word')).toMatchObject({
      action: 'delete',
      target: 'last-n-words',
      count: 2
    })
    expect(parse('delete the last three')).toMatchObject({
      action: 'delete',
      target: 'last-n-words',
      count: 3
    })
  })

  it('tolerates stacked and trailing fillers', () => {
    expect(actionOf('uh um delete that')).toBe('delete')
    expect(actionOf('Okay, um, scratch that.')).toBe('delete')
    expect(actionOf('so delete that')).toBe('delete')
    expect(actionOf('just capitalize that')).toBe('capitalize')
    expect(actionOf('delete that please')).toBe('delete')
    expect(actionOf('capitalize that, please')).toBe('capitalize')
    expect(actionOf('delete the last word now')).toBe('delete')
  })
})

describe('parseCommand — replace only takes literal operands', () => {
  it('rejects vague noun phrases that mean this is dictation', () => {
    for (const u of [
      'replace the washer with a new one',
      'change that to a bigger size',
      'swap that for the other one',
      'replace it with something better',
      'change my mind to something else'
    ]) {
      expect(parse(u), u).toBeNull()
    }
  })

  it('rejects operands too long to be a spoken snippet', () => {
    expect(parse('replace the first thing i said in this meeting with something shorter'))
      .toBeNull()
    expect(parse('replace cat with a very long winded phrase that runs on and on'))
      .toBeNull()
  })

  it('still accepts real replace commands', () => {
    expect(parse('replace cat with dog').args).toEqual({ from: 'cat', to: 'dog' })
    expect(parse('replace big red dog with small blue cat')).not.toBeNull()
  })
})

describe('applyCommand — replace robustness', () => {
  it('treats "from" literally, never as a regex', () => {
    expect(applyCommand(parse('replace c++ with rust'), 'i like c++ a lot').text)
      .toBe('i like rust a lot')
    expect(applyCommand(parse('replace (a) with b'), 'this (a) here').text)
      .toBe('this b here')
    expect(applyCommand(parse('replace $1 with x'), 'cost $1 today').text)
      .toBe('cost x today')
    expect(applyCommand(parse('replace a.b with c'), 'axb and a.b').text)
      .toBe('axb and c')
  })

  it('does not corrupt words that merely contain "from"', () => {
    const cmd = parse('replace cat with dog')
    expect(applyCommand(cmd, 'concatenate the cat').text).toBe('concatenate the dog')
    const miss = applyCommand(cmd, 'concatenate things')
    expect(miss.changed).toBe(false)
    expect(miss.text).toBe('concatenate things')
  })

  it('replaces "to" text containing a dollar sign verbatim', () => {
    expect(applyCommand(parse('replace cost with $5'), 'the cost').text).toBe('the $5')
  })
})

describe('applyCommand — edges of a short transcript', () => {
  it('handles a single-word transcript', () => {
    expect(applyCommand(parse('delete the last word'), 'hello').text).toBe('')
    expect(applyCommand(parse('capitalize the last word'), 'hello').text).toBe('Hello')
    expect(applyCommand(parse('delete the last five words'), 'one two').text).toBe('')
  })

  it('handles a single-sentence transcript', () => {
    const r = applyCommand(parse('delete that'), 'Only one sentence.')
    expect(r.text).toBe('')
    expect(r.changed).toBe(true)
  })

  it('keeps interior whitespace and trims only the deleted tail', () => {
    expect(applyCommand(parse('delete the last word'), 'one two  three').text)
      .toBe('one two')
    expect(applyCommand(parse('delete the last word'), 'one two three   ').text)
      .toBe('one two')
  })

  it('does not strand a separator after a delete', () => {
    expect(applyCommand(parse('delete the last word'), 'I like cats, dogs').text)
      .toBe('I like cats')
    expect(applyCommand(parse('delete the last word'), 'the list is: apples').text)
      .toBe('the list is')
  })

  it('keeps a sentence terminator that legitimately ends the text', () => {
    expect(applyCommand(parse('delete the last sentence'), 'First. Second.').text)
      .toBe('First.')
  })
})

describe('splitSentences — more speech-shaped edge cases', () => {
  it('keeps a closing quote with its sentence', () => {
    expect(splitSentences('He said "hi." She left.'))
      .toEqual(['He said "hi."', 'She left.'])
  })

  it('does not split inside an initialism', () => {
    expect(splitSentences('U.S. troops arrived. Then left.'))
      .toEqual(['U.S. troops arrived.', 'Then left.'])
  })

  it('handles an ellipsis followed by a real terminator', () => {
    expect(splitSentences('Wait... what? Really!!'))
      .toEqual(['Wait... what?', 'Really!!'])
  })

  it('splits on a blank line', () => {
    expect(splitSentences('one\n\ntwo. three')).toEqual(['one', 'two.', 'three'])
  })
})
