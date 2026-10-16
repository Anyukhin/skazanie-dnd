// Перехват настоящих вызовов модулей sk-world-story внутри серверного
// конвейера (как `rust/crates/sk-world-life/fixtures/hook.mjs`).
//
// Хук загрузки (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой: привязка `export function` изменяема, и
// импортёры (Rules Engine, бутстрап, разбор намерения) видят обёртку. Исходники
// `server/` на диске не меняются.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

export const TARGETS = {
  'server/scenario-knight.mjs': [
    'scenarioNightVisitorIds', 'scenarioKnightStartingInventory', 'minuteInWindow', 'scenarioKnightShouldBePresent',
    'scenarioKnightPresencePlan', 'normalizeScenarioKnightState', 'scenarioNightIndex', 'applyScenarioKnightEvent',
    'scenarioKnightState', 'scenarioKnightRiddleSolved', 'scenarioKnightPresent', 'scenarioKnightWard',
    'scenarioKnightDreadFor', 'scenarioKnightRules', 'scenarioKnightActionFromText',
  ],
  'server/scene-canon.mjs': [
    'sceneCanonFor', 'sceneCanonFromEnvironment', 'requestedOpeningCanon', 'campaignStartCanon',
    'sensoryAnchorConflicts', 'sceneCanonContradictions',
  ],
  'server/offscreen-world.mjs': [
    // `offscreenCampaignDay` — `export const`, переприсвоить нельзя; он пишется напрямую.
    'normalizeOffscreenWorldState', 'antagonistFactionFor', 'planOffscreenWorldStep',
    'offscreenLinesFor', 'applyOffscreenWorldEvent', 'offscreenWorldFeed', 'offscreenChronicleEntry',
  ],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
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

/** Начать запись: `capture(module, name, args)` получает аргументы верхних вызовов модуля. */
export function startCapture(capture) {
  globalThis.__worldStoryRecorder = capture
  return () => {
    globalThis.__worldStoryRecorder = undefined
  }
}

/** Выполнить `fn` без записи. */
export function quietly(fn) {
  const saved = globalThis.__worldStoryRecorder
  globalThis.__worldStoryRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__worldStoryRecorder = saved
  }
}
