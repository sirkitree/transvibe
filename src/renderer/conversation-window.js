// The follow-up window measures time available to the user, not time spent
// listening to the app. Speech may overlap (previews, confirmations), so only
// the last completion starts the countdown. Clearing while speaking must not
// let a late completion reopen a conversation.
export function createConversationWindow (now = Date.now) {
  let duration = 0
  let until = 0
  let speakers = 0
  const isOpen = () => duration > 0 && (speakers > 0 || until > now())

  return {
    isOpen,
    remainingMs: () => isOpen() ? (speakers > 0 ? duration : Math.max(0, until - now())) : 0,
    open (ms) {
      duration = Number.isFinite(ms) ? Math.max(0, ms) : 0
      until = now() + duration
    },
    clear () {
      duration = 0
      until = 0
    },
    pause () {
      // Unrelated speech after expiration must not resurrect the old thread.
      if (!isOpen()) duration = 0
      speakers++
    },
    resume () {
      if (speakers === 0) return
      speakers--
      if (speakers === 0 && duration > 0) until = now() + duration
    }
  }
}
