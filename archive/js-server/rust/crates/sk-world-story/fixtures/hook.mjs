// Перехват настоящих вызовов модулей sk-world-story внутри серверного конвейера.
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
  'server/autonomous-campaign.mjs': ['normalizeDirectorIntent', 'normalizeAutonomyState', 'serverReputationDelta', 'ensureAvailableHook', 'applyAutonomyEvent'],
}

const TRANSFORMS = {}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    for (const [from, to] of TRANSFORMS[target] ?? []) {
      if (!source.includes(from)) throw new Error(`hook: в ${target} нет «${from}»`)
      source = source.replace(from, to)
    }
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__worldStoryWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const depth = new Map()

globalThis.__worldStoryWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__worldStoryRecorder
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
  globalThis.__worldStoryRecorder = capture
  return () => {
    globalThis.__worldStoryRecorder = undefined
  }
}

/** Выполнить `fn` без записи (вызовы экспортов внутри не перехватываются). */
export function quietly(fn) {
  const saved = globalThis.__worldStoryRecorder
  globalThis.__worldStoryRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__worldStoryRecorder = saved
  }
}
