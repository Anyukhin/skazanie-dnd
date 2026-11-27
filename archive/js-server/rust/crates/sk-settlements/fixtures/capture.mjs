// Перехват вызовов генераторов из настоящего конвейера сцены
// (`generateSceneGeometry` → `buildThemedScene`): входы, с которыми сервер
// зовёт `buildSceneFromGraph` и `buildSettlementScene`, и карта, которую они
// вернули, — до того как конвейер её достроит (петли, тонкие стены,
// реквизит).
//
// Импортировать ДО любого модуля `server/` и подключать модули сервера
// динамически (`await import`): статические импорты разрешаются раньше, чем
// этот модуль успеет поставить перехватчик.
import { registerHooks } from 'node:module'

const server = new URL('../../../../server/', import.meta.url)
const wrappers = new Map([
  [new URL('graph-layout.mjs', server).href, new URL('./capture-graph-layout.mjs', import.meta.url).href],
  [new URL('settlement-generator.mjs', server).href, new URL('./capture-settlement-generator.mjs', import.meta.url).href],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    // Обёртка сама берёт настоящий модуль с `?real` — тот мимо перехвата.
    const wrapper = wrappers.get(resolved.url)
    return wrapper ? { ...resolved, url: wrapper } : resolved
  },
})

/** Пойманные вызовы: `{ graphLayout: [...], settlement: [...] }`. */
export const captured = (globalThis.__skSettlementsCaptured ??= { graphLayout: [], settlement: [] })
