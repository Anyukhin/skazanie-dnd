// Запись вызова: функция повторно вызывается на JSON-копии аргументов (то,
// что получит Rust), итог — `{ ok }`, `{ err: [code, message] }` или `{ fault }`.
export const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

export function outcome(run) {
  try {
    const value = run()
    if (value && typeof value.then === 'function') {
      return value.then((resolved) => ({ ok: clone(resolved) }), failure)
    }
    return { ok: clone(value) }
  } catch (error) {
    return failure(error)
  }
}

function failure(error) {
  if (error?.name === 'RulesValidationError') return { err: [error.code, error.message] }
  return { fault: String(error?.name ?? 'Error') }
}

export function record(entry) {
  const list = globalThis.__T2_RECORD__
  if (Array.isArray(list)) list.push(entry)
}
