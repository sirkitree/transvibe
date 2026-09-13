import fs from 'node:fs'
import path from 'node:path'
import { readRequest, whatToSay, replyFor } from '../shared/agent-request.js'

/**
 * The other end of the hook.
 *
 * A directory, watched. A coding agent's hook drops a request in it and
 * blocks; this reads it, decides whether it is worth interrupting a room for,
 * hands it to the app, and writes back whatever the app decides. See
 * docs/plans/agent-plugin.md for why it is a directory rather than a socket:
 * no port, no server, it survives this app being restarted mid-question, and
 * it can be tested by writing a file.
 *
 * Three promises to the session on the other side, and they are the whole
 * reason this module is careful:
 *
 *   It is told the truth about whether anyone is home. The `listening` file
 *   exists only while this is watching, and the hook tests for it before it
 *   does anything at all — so an app that is closed, or has this switched
 *   off, costs an agent nothing.
 *
 *   Nothing waits forever. A request that is not answered in time is finished
 *   here as well as given up on there, so the strip does not keep showing a
 *   question nobody can still answer.
 *
 *   A failure here is this feature's problem and nobody else's. Anything that
 *   throws stops the inbox and reports itself, the way the recorder does; it
 *   does not take the app down and it does not leave a hook hanging.
 */

/* Long enough to notice, think, and say a sentence; short enough that walking
   away from the desk does not strand a terminal. The hook is told this number
   rather than told to guess it. */
const REPLY_SECONDS = 90

/* Belt and braces for fs.watch, which on macOS coalesces events and
   occasionally drops one. A missed request would be a session hanging until
   its own deadline for no visible reason, so the directory is also swept. */
const SWEEP_MS = 1000

/* Files nobody is waiting on any more. A hook cleans up after itself, even
   when killed, so anything this old is the debris of something that died
   badly — a machine that slept, a process killed with -9. */
const STALE_MS = 5 * 60 * 1000

const REQUEST = /^[A-Za-z0-9-]+\.json$/

export function createAgentInbox ({
  dir,
  replySeconds = REPLY_SECONDS,
  sweepMs = SWEEP_MS,
  staleMs = STALE_MS,
  onRequest = () => {},
  onExpire = () => {},
  onError = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const root = path.join(dir, 'agent')
  const requests = path.join(root, 'requests')
  const replies = path.join(root, 'replies')
  const flag = path.join(root, 'listening')

  /** Requests put to the app and not yet answered, by id. */
  const open = new Map()
  /** Ids already read, so the sweep and the watcher cannot double up. */
  const seen = new Set()
  /* Prompt ids already put to the room. A permission prompt arrives twice —
     the request, then a notification about it — and the second must not ask
     the same question again. */
  const asked = new Set()

  let watcher = null
  let sweep = null
  let live = false
  let failure = null

  function fail (err) {
    failure = err.message
    stop()
    onError(failure)
  }

  const at = (kind, name) => path.join(kind, name)
  const remove = file => { try { fs.rmSync(file, { force: true }) } catch {} }

  /** Everything the hook might be waiting on, gone. */
  function clear (id) {
    remove(at(requests, `${id}.json`))
    for (const ext of ['ack', 'out', 'err', 'exit', 'done']) remove(at(replies, `${id}.${ext}`))
  }

  /* The hook reads .out, .err and .exit only once .done exists, so writing
     .done last is what makes the four of them one answer. */
  function finish (id, request, said) {
    const reply = replyFor(request, said)
    try {
      fs.writeFileSync(at(replies, `${id}.out`), reply.out)
      fs.writeFileSync(at(replies, `${id}.err`), reply.err)
      fs.writeFileSync(at(replies, `${id}.exit`), String(reply.exit))
      fs.writeFileSync(at(replies, `${id}.done`), '')
    } catch (err) {
      fail(err)
      return null
    }
    return reply
  }

  function close (id) {
    const pending = open.get(id)
    if (pending) {
      clearTimer(pending.timer)
      open.delete(id)
      asked.delete(pending.request.promptId)
    }
    return pending
  }

  function take (file) {
    const id = file.replace(/\.json$/, '')
    if (seen.has(id)) return
    /* An ack already there means this one was taken before — by a previous
       run of this app, whose answer the hook has either had or given up on.
       Reading it again would ask the room a question from another session. */
    if (fs.existsSync(at(replies, `${id}.ack`))) { seen.add(id); return }

    let text
    try {
      text = fs.readFileSync(at(requests, file), 'utf8')
    } catch {
      return            // the hook cleaned up under us; nothing to do
    }
    seen.add(id)

    const parsed = readRequest(text)
    if (!parsed.ok) {
      /* Not a payload. Answered rather than ignored, because a hook is
         blocked behind it either way, and then taken off the disk. */
      fs.writeFileSync(at(replies, `${id}.ack`), '1')
      finish(id, null, null)
      onError(`ignored a request: ${parsed.reason}`)
      return
    }

    const request = parsed.request
    const say = whatToSay(request, { asked })

    // The app is told about it before the hook is, so that a question is on
    // screen by the time anybody could answer it.
    if (say) onRequest({ id, request, say })

    /* Only something that can be answered holds the hook. A notification is
       read out and released at once — the terminal it came from is not
       waiting on the room, and holding it for ninety seconds would be ninety
       seconds of an agent doing nothing for the sake of a sentence. */
    if (!say || !say.answerable) {
      fs.writeFileSync(at(replies, `${id}.ack`), '1')
      finish(id, request, null)
      return
    }

    if (request.promptId) asked.add(request.promptId)
    fs.writeFileSync(at(replies, `${id}.ack`), String(replySeconds))
    open.set(id, {
      request,
      say,
      /* The hook gives up on its own; this is the same clock on this side, so
         a question nobody can still answer comes off the strip. Slightly
         longer, so that the app's own answer always loses the race to the
         hook's rather than the other way about. */
      timer: setTimer(() => {
        const pending = close(id)
        finish(id, request, null)
        if (pending) onExpire({ id, request: pending.request })
      }, replySeconds * 1000 + 500)
    })
  }

  function scan () {
    let files
    try {
      files = fs.readdirSync(requests)
    } catch (err) {
      fail(err)
      return
    }
    for (const file of files) {
      if (!REQUEST.test(file)) continue
      try {
        take(file)
      } catch (err) {
        fail(err)
        return
      }
    }
  }

  /* Debris, not requests. A hook removes its own files even when it is
     killed, so what is left this long afterwards belongs to something that
     died without getting the chance — and the id is forgotten too, or `seen`
     would grow for as long as the app runs. */
  function forgetStale () {
    for (const kind of [requests, replies]) {
      let files
      try {
        files = fs.readdirSync(kind)
      } catch {
        continue
      }
      for (const file of files) {
        const full = path.join(kind, file)
        let age
        try {
          age = now() - fs.statSync(full).mtimeMs
        } catch {
          continue
        }
        if (age < staleMs) continue
        const id = file.replace(/\.[a-z]+$/, '')
        if (open.has(id)) continue
        seen.delete(id)
        remove(full)
      }
    }
  }

  function start () {
    if (live) return true
    try {
      fs.mkdirSync(requests, { recursive: true })
      fs.mkdirSync(replies, { recursive: true })
      fs.mkdirSync(path.join(root, 'off'), { recursive: true })
      live = true
      failure = null

      /* Anything already there is from before this run: either a hook that is
         still waiting, which is answered as usual, or debris. Swept first so
         that a directory full of old files cannot be mistaken for a room full
         of questions. */
      forgetStale()
      scan()

      watcher = fs.watch(requests, () => {
        try {
          scan()
        } catch (err) { fail(err) }
      })
      watcher.on('error', fail)
      sweep = setInterval(() => {
        scan()
        forgetStale()
      }, sweepMs)
      if (sweep.unref) sweep.unref()

      /* Last, and this is the order that matters: the flag says "watching",
         and it must not be true a moment before it is. */
      fs.writeFileSync(flag, String(process.pid))
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  function stop () {
    /* First, so that nothing new arrives while the open ones are being let
       go, and so an app on its way out stops claiming to listen. */
    remove(flag)
    live = false
    if (watcher) { try { watcher.close() } catch {} watcher = null }
    if (sweep) { clearInterval(sweep); sweep = null }

    /* Everything still waiting is released rather than abandoned. A hook
       whose app quits should find out now, not in ninety seconds. */
    for (const id of [...open.keys()]) {
      const pending = close(id)
      if (pending) finish(id, pending.request, null)
    }
    seen.clear()
    asked.clear()
  }

  return {
    start,
    stop,
    /**
     * What was said, back to the session that asked.
     * @param {string} id
     * @param {string|null} said null declines: the turn ends, a permission abstains
     */
    answer (id, said) {
      const pending = close(id)
      if (!pending) return false
      return !!finish(id, pending.request, said)
    },
    decline (id) { return this.answer(id, null) },
    /** For the sweep's sake in tests, and for a settings panel that wants to
        show whether this is actually running. */
    get listening () { return live },
    get failure () { return failure },
    get open () { return open.size },
    get status () {
      return { listening: live, open: open.size, error: failure, directory: root }
    }
  }
}
