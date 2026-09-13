// Superseding or canceling a turn invalidates every continuation, including a
// local result that has not yet tried to start its remote fallback.
export function createLatestRequest () {
  let generation = 0
  return {
    cancel () { generation++ },
    begin () {
      const id = ++generation
      const check = () => {
        if (id !== generation) throw Object.assign(new Error('cancelled'), { code: 'TURN_CANCELLED' })
      }
      return {
        check,
        async wait (promise) {
          check()
          const result = await promise
          check()
          return result
        }
      }
    }
  }
}
