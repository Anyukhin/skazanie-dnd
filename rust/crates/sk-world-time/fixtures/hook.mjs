// Перехват настоящих вызовов модулей sk-world-time внутри серверного конвейера.
//
// Хук загрузки (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой — привязка `export function` изменяема,
// и импортёры (Rules Engine, проекция, соседние модули) видят обёртку.
// Исходники `server/` на диске не меняются. Как в
// `rust/crates/sk-map-core/fixtures/recorder.mjs`.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, а серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

export const TARGETS = {
  'server/world-deeds.mjs': [
    'normalizeWorldDeedsState', 'deedFromEvent', 'applyWorldDeedEvent', 'worldDeedsFeed', 'worldNodeIdFor',
    'worldHopDistances', 'rumorClaimId', 'rumorWording', 'rumorSpreadTargets', 'planWorldRumorTick',
    'rumorReputationDelta', 'planWorldRumorReputation',
  ],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__worldTimeWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const depth = new Map()

globalThis.__worldTimeWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__worldTimeRecorder
  if (!recorder || (depth.get(module) ?? 0) > 0) return fn(...args)
  depth.set(module, (depth.get(module) ?? 0) + 1)
  try {
    recorder(module, name, args)
    return fn(...args)
  } finally {
    depth.set(module, depth.get(module) - 1)
  }
}

/**
 * Начать запись: `capture(module, name, args)` получает аргументы верхних
 * вызовов модуля (внутренние вызовы модуля самого себя не пишутся). Пока
 * идёт запись, вызов экспорта модуля из `capture` исполняется без записи.
 */
export function startCapture(capture) {
  globalThis.__worldTimeRecorder = capture
  return () => {
    globalThis.__worldTimeRecorder = undefined
  }
}

/** Выполнить `fn` без записи (вызовы экспортов внутри не перехватываются). */
export function quietly(fn) {
  const saved = globalThis.__worldTimeRecorder
  globalThis.__worldTimeRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__worldTimeRecorder = saved
  }
}
