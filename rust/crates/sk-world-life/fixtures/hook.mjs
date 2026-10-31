// Перехват настоящих вызовов модулей sk-world-life внутри серверного конвейера.
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
  'server/captives.mjs': [
    'captiveBandId', 'captivePersona', 'normalizeCaptivesState', 'captiveList', 'captiveFor', 'heldCaptiveForNpc',
    'heldCaptives', 'captiveIdFor', 'captiveOriginFor', 'capturableEnemies', 'captiveKnowledgeDrafts',
    'planCaptureDrafts', 'planCaptiveRelocationDrafts', 'captiveInterrogationPolicy', 'captiveSparedDisposition',
    'captiveBountyCp', 'captiveSettlementFor', 'localFactionIds', 'planCaptiveNeglectCommands',
    'captiveNeglectedPayload', 'planCaptiveNeglectDrafts', 'captiveForViewer', 'captivesForViewer', 'applyCaptiveEvent',
  ],
  'server/courier-letters.mjs': [
    'normalizeCourierLetterState', 'applyCourierLetterEvent', 'worldLeaguesBetween', 'courierToneFor',
    'courierAddresseeFor', 'courierLetterAddressees', 'courierLettersFor', 'openCourierLettersFor',
    'courierLetterPromiseFrom', 'courierLetterReplyBase', 'courierLetterReplyFor', 'planCourierLetter',
    'planCourierLetterTicks', 'courierLetterForViewer', 'courierLettersForViewer', 'courierLetterChronicleEntry',
  ],
  'server/world-offices.mjs': [
    'validateOfficeConfiguration', 'normalizeWorldOfficesState', 'planOfficeVacancyDrafts', 'planOfficeSuccessionDrafts',
    'applyWorldOfficeEvent', 'officesForViewer', 'officeChronicleEntry',
  ],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__worldLifeWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const depth = new Map()

globalThis.__worldLifeWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__worldLifeRecorder
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
  globalThis.__worldLifeRecorder = capture
  return () => {
    globalThis.__worldLifeRecorder = undefined
  }
}

/** Выполнить `fn` без записи (вызовы экспортов внутри не перехватываются). */
export function quietly(fn) {
  const saved = globalThis.__worldLifeRecorder
  globalThis.__worldLifeRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__worldLifeRecorder = saved
  }
}
