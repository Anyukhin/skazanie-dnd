// Перехват настоящих вызовов модулей sk-story внутри серверного конвейера
// (образец — `rust/crates/sk-world-story/fixtures/story-hook.mjs`).
//
// Хук загрузки (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой: привязка `export function` изменяема, и
// импортёры (Rules Engine, оркестратор, проекция) видят обёртку. Метод
// `IntentParser.prototype.parse` асинхронный, но без единого `await`: хук
// переименовывает тело в синхронный `__parseSync`, а `parse` зовёт его через
// запись. Исходники `server/` на диске не меняются.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

export const TARGETS = {
  'server/campaign-dialogues.mjs': [
    'dialogueActionChecks', 'normalizeDialogues', 'dialogueFor', 'dialogueProgress', 'dialogueFlags', 'dialogueRevealFactId',
    'dialogueGrantedFactIds', 'dialogueOptionUnlocked', 'dialogueOptionsFor', 'normalizeDialogueState', 'applyDialogueEvent',
    'sceneDialoguesForViewer', 'dialogueCheckLine',
  ],
  'server/intent-parser.mjs': [
    'normalizeRequestKind', 'inferRequestKind', 'isSceneObservationRequest', 'waitTargetFromText', 'classifyFreeActionKind',
    'actionSequence', 'sameNameToken', 'resolvePresentSocialActors', 'namedKnownSpell', 'buildRuleQueries',
  ],
}

const PARSE_HEAD = '  async parse({ message, playerId, visibleState }) {'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv' || specifier === 'dotenv/config') return { url: 'data:text/javascript,export default { config() { return {} } }; export const config = () => ({})', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    if (target === 'server/intent-parser.mjs') {
      if (!source.includes(PARSE_HEAD)) throw new Error('capture-hook: заголовок IntentParser.parse изменился')
      source = source.replace(PARSE_HEAD, `  async parse(input) { return globalThis.__storyWrap(${JSON.stringify(target)}, 'IntentParser.parse', (value) => this.__parseSync(value))(input) }\n  __parseSync({ message, playerId, visibleState }) {`)
    }
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__storyWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const depth = new Map()

globalThis.__storyWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__storyRecorder
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
  globalThis.__storyRecorder = capture
  return () => {
    globalThis.__storyRecorder = undefined
  }
}

/** Выполнить `fn` без записи. */
export function quietly(fn) {
  const saved = globalThis.__storyRecorder
  globalThis.__storyRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__storyRecorder = saved
  }
}
