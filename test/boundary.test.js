import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one boundary in this app that is not allowed to move.
 *
 * `cleanup` and `commandFallback` see words nobody addressed to anyone — a
 * microphone in a room hears the room — and neither of them may ever leave
 * this machine, whatever `remote` says. src/main/index.js states that the
 * guarantee is structural rather than a check: those two handlers call
 * `assist`, which is bound to 127.0.0.1, and there is no path from either of
 * them to a CLI or to a spawn.
 *
 * "There is no path" is a claim about the import graph, and until now nothing
 * checked it. This does: it walks the graph from both halves of the assist
 * model and fails if anything that can start a process turns up in it. An
 * ordinary refactor cannot trip it; wiring a provider into the cleanup path
 * is the only thing that can.
 *
 * It is half of the guard. The other half is REMOTE_JOBS in index.js, which
 * catches the other way in — a handler that reaches askRemote directly rather
 * than by importing anything new. Neither one alone is enough.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* Every `from '...'` and bare `import '...'` in a module. A regex rather than
   a parser because the thing being looked for is a specifier, and a specifier
   is a string literal in a fixed position in all three spellings. Dynamic
   `import(expr)` with a computed path would slip past — and would itself be
   the finding, since nothing in this graph has any business having one. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

function importsOf (file) {
  const source = fs.readFileSync(file, 'utf8')
  const found = []
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1] || match[2])
  return found
}

/** Every module reachable from a starting file, and every bare specifier it
    asks the runtime for along the way. */
function closure (entry) {
  const files = new Set()
  const bare = new Set()
  const queue = [path.resolve(ROOT, entry)]

  while (queue.length) {
    const file = queue.pop()
    if (files.has(file)) continue
    files.add(file)
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier)
        continue
      }
      const next = path.resolve(path.dirname(file), specifier)
      if (fs.existsSync(next)) queue.push(next)
    }
  }

  return { files: [...files].map(f => path.relative(ROOT, f)), bare: [...bare] }
}

/* Anything that can start another program. `child_process` is the one that
   matters; the rest are here so that a clever way round it is also a failure
   rather than a gap. */
const SPAWNS = /child_process|node:worker_threads|^execa$|^cross-spawn$/

describe('dictation never leaves the machine', () => {
  for (const entry of ['src/main/assist.js', 'src/shared/assist.js']) {
    it(`${entry} cannot reach a CLI`, () => {
      const { files, bare } = closure(entry)
      expect(files.filter(f => f.includes('cli-agent') || f.includes('shared/cli.js')))
        .toEqual([])
      expect(bare.filter(b => SPAWNS.test(b))).toEqual([])
    })
  }

  it('walks a real graph, so an empty result cannot pass by accident', () => {
    // The crawler has to actually find things, or the assertions above are
    // vacuous and would keep passing after someone broke the import parsing.
    const { files } = closure('src/main/assist.js')
    expect(files).toContain('src/shared/assist.js')
    expect(files).toContain('src/shared/conversation.js')
  })

  it('finds a CLI when there is one to find', () => {
    // The same crawl over a module that does spawn, proving the check would
    // fail if the boundary moved rather than only ever passing.
    const { bare } = closure('src/main/cli-agent.js')
    expect(bare.some(b => SPAWNS.test(b))).toBe(true)
  })
})
