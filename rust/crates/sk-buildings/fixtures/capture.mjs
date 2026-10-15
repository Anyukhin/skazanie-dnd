// Перехват вызовов генератора зданий из настоящего конвейера сцены
// (`generateSceneGeometry` → `buildThemedScene`, `createSceneTransition`):
// входы, с которыми сервер зовёт `buildBuildingScene`,
// `buildAresFortressScene` и `ensureDeclaredTransitions`, и карта, которую
// они вернули, — до того как конвейер её достроит (виньетки, программа сцены).
//
// Хук загрузки модулей (`module.registerHooks`) дописывает в конец
// `server/building-generator.mjs` переприсваивание экспортов обёрткой:
// привязка функции в модуле изменяема, и импортёры видят обёртку. Исходник
// на диске не меняется. Вложенные вызовы (сборка зовёт `generateBuildingScene`
// и `ensureDeclaredTransitions` сама) не записываются — только внешние.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, а серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

const TARGET = '/server/building-generator.mjs'
const WRAPPED = ['buildBuildingScene', 'buildAresFortressScene', 'ensureDeclaredTransitions', 'generateBuildingScene', 'generateAresFortressScene', 'safeRoom']

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(TARGET)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = WRAPPED.map((name) => `${name} = globalThis.__skBuildingsWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

let depth = 0
/** Записывающий перехватчик внешних вызовов; `null` — пропускать. */
let recorder = null

globalThis.__skBuildingsWrap = (name, fn) => function wrapped(...args) {
  if (depth > 0 || !recorder) return fn(...args)
  depth += 1
  try {
    return recorder(name, fn, args)
  } finally {
    depth -= 1
  }
}

/** Включить запись: `record(name, fn, args)` сам зовёт `fn` и возвращает её ответ. */
export function startRecording(record) {
  recorder = record
}

export function stopRecording() {
  recorder = null
}
