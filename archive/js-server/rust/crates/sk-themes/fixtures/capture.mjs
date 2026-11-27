// Перехват вызовов `server/scene-themes.mjs` из настоящего конвейера сцены
// (`generateSceneGeometry`, `createSceneTransition`, создание кампании): входы,
// с которыми сервер зовёт `buildThemedScene` и `resolveSceneTheme`, и что они
// вернули — до того как конвейер достроит карту (программа сцены, поворот).
//
// Хук загрузки модулей (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой: привязка функции в модуле изменяема, и
// импортёры видят обёртку. Исходник на диске не меняется. Вложенные вызовы
// (сборка зовёт `themeFor`, `layoutOrganicCave`) не записываются — только
// внешние. Заодно модуль отдаёт `AUTHORED_SCENE_THEMES` (в JS не экспортирован).
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, а серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

const TARGET = '/server/scene-themes.mjs'
const WRAPPED = ['buildThemedScene', 'resolveSceneTheme', 'matchTheme', 'layoutOrganicCave', 'layoutOpenTerrain', 'layoutSettlement']

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(TARGET)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = WRAPPED.map((name) => `${name} = globalThis.__skThemesWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\nglobalThis.__skAuthoredThemes = AUTHORED_SCENE_THEMES\n` }
  },
})

let depth = 0
/** Записывающий перехватчик внешних вызовов; `null` — пропускать. */
let recorder = null

globalThis.__skThemesWrap = (name, fn) => function wrapped(...args) {
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
