/**
 * Where a question should go, and what a model declining sounds like.
 *
 * The corpus rather than the assertions, because these two lists are the part
 * that has to grow. Every rule in shared/escalate.js is a list of phrases
 * somebody wrote down from watching the app get one wrong, and the phrases are
 * worth nothing without the cases that made them necessary — delete the list
 * and rewrite it tomorrow and you would lose "the latest you can arrive"
 * again, because nobody thinks of it twice.
 *
 * So a misroute you notice becomes one line here, and the phrase lists can be
 * rewritten as freely as you like afterwards. escalate.js is pure, which is
 * what makes this cheap: `node script/routing.mjs` replays the whole corpus
 * in about a second, with no model, no Ollama and nothing billed.
 *
 * `known` marks a case the rules get wrong today and that nobody has a clean
 * fix for. It is not asserted — a red suite is not a to-do list — but the
 * replay script counts it and prints it, so the debt stays visible instead of
 * being quietly deleted the first time it is inconvenient.
 */

/** Should this question skip the local model and go straight to a CLI that
    can search? `route` is 'fresh' or 'local'. */
export const QUESTIONS = [
  // Nothing on this machine has a clock or a network. These are not questions
  // a bigger local model would do better on; they are questions no local model
  // can do at all, which is what earns the pre-emptive route.
  { ask: 'what is the latest version of node', route: 'fresh' },
  { ask: "what's in the news today", route: 'fresh' },
  { ask: 'who won the game last night, as of today', route: 'fresh' },
  { ask: 'what is the price of a bitcoin', route: 'fresh' },
  { ask: 'what is the release date for the next one', route: 'fresh' },
  { ask: 'what is the weather like', route: 'fresh' },
  { ask: 'what happened this week', route: 'fresh' },
  { ask: 'what are the headlines', route: 'fresh' },
  { ask: 'what is the current exchange rate for euros', route: 'fresh' },
  { ask: 'how much does a pint cost in london', route: 'fresh' },
  { ask: 'when does the next version ship', route: 'fresh' },

  // 'latest' is the word that does the most damage. Two of its three common
  // uses have nothing to do with news, and sending either one to a searching
  // CLI spends fourteen seconds on a question about lunch.
  { ask: 'what is the latest you can arrive', route: 'local', note: 'a deadline, not a release' },
  { ask: "what's the latest on that bug I mentioned", route: 'local', note: 'about this conversation' },

  // Questions whose answer has not moved in a century, and one that is about
  // this machine rather than about the world.
  { ask: 'what is the capital of france', route: 'local' },
  { ask: 'how do I reverse a string in javascript', route: 'local' },
  { ask: 'why is the sky blue', route: 'local' },
  { ask: 'good news or bad news first', route: 'local', note: 'news, but not the news' },
  { ask: 'what price did I pay for being clever there', route: 'local', note: 'price, but not the price of' },
  { ask: 'what is the current working directory', route: 'local', note: "current, but not current anything the world changes" },
  { ask: 'what does a voice activity detector do', route: 'local' },
  { ask: '', route: 'local' },

  {
    ask: 'what was the score of the 1966 world cup final',
    route: 'local',
    known: '"the score" is a phrase about now, and this one has a year on it. ' +
      'Costs a remote call on a question gemma had; the fix is a date test ' +
      'nobody has written, and the phrase list is more useful loose than it ' +
      'would be with a half-working one bolted to it.'
  }
]

/** Does this answer amount to the model saying it does not know? */
export const ANSWERS = [
  { said: "I'm not sure — that happened after my training data.", unsure: true },
  { said: 'I do not know.', unsure: true },
  { said: "I don't have access to current information.", unsure: true },
  { said: 'I cannot browse the web, so I cannot check.', unsure: true },
  { said: 'As an AI, I have no information about that.', unsure: true },
  { said: "I can't help with that one.", unsure: true },
  { said: 'Paris, I think, but I am not sure.', unsure: true, note: 'short enough that the hedge is the whole reply' },
  {
    said: 'I do not know which version that is, but the release before it ' +
      'changed the module resolution rules, added a permission model, and ' +
      'moved the test runner out of the experimental section entirely.',
    unsure: true,
    note: 'a hedge that opens a long answer is still the model declining'
  },

  // The expensive false positive: this answered the question, and re-asking a
  // frontier model would cost eight seconds to be told "Paris".
  {
    said: 'The capital of France is Paris, a city of a couple of million ' +
      'people depending on where you draw the boundary, though I am not sure ' +
      'about the exact population inside the city limits itself these days.',
    unsure: false,
    note: 'a caveat on the end of a good answer, not a decline'
  },
  { said: 'It is probably around ten milliseconds.', unsure: false },
  { said: 'Roughly forty, give or take.', unsure: false },
  { said: 'You can access it from the settings panel.', unsure: false, note: 'access, but not "no access"' },
  { said: 'Certainly — hold the key and speak.', unsure: false },
  { said: '', unsure: false }
]

/** Two answers to the same question, and whether they say the same thing.
    `agree` is null where there is not enough in either one to tell. */
export const PAIRS = [
  { a: 'Paris.', b: 'The capital of France is Paris.', agree: true, note: 'terse and verbose, same answer' },
  {
    a: 'A VAD is video-assisted delivery.',
    b: 'Voice activity detection — a way of telling speech from silence.',
    agree: false,
    note: 'the measured failure this whole feature exists for'
  },
  { a: 'Paris.', b: 'Lyon.', agree: false },
  { a: 'Yes.', b: 'Indeed.', agree: null, note: 'no content words in either' },
  { a: 'About ten.', b: 'Around eleven.', agree: null },
  { a: '', b: 'Paris.', agree: null }
]
