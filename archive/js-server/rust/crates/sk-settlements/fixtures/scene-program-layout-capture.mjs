// Перехват вызовов `server/scene-program-layout.mjs` внутри настоящего
// конвейера сцены (`generateSceneGeometry` зовёт `programFocusOutdoors` и
// `applyScenePlan`): программа, сид, сериализованная карта до вызова и после.
//
// Импортировать ДО любого модуля `server/` и подключать модули сервера
// динамически (`await import`): статические импорты разрешаются раньше, чем
// этот модуль успеет поставить перехватчик.
import { registerHooks } from 'node:module'

const target = new URL('../../../../server/scene-program-layout.mjs', import.meta.url).href
const wrapper = new URL('./scene-program-layout-wrap.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    // Обёртка сама берёт настоящий модуль с `?real` — тот мимо перехвата.
    return resolved.url === target ? { ...resolved, url: wrapper } : resolved
  },
})

/** Пойманные вызовы: `{ apply: [...], outdoors: [...] }`. */
export const captured = (globalThis.__skSceneProgramCaptured ??= { apply: [], outdoors: [], recording: true })
