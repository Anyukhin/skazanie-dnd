import '../../../fixtures-env.mjs'
// Подключается к прогону тестов JS (`node --import <этот файл> test/x.test.mjs`):
// каждый импорт `server/narrator.mjs` получает записывающую обёртку
// `narrator-recording.mjs`; журнал пишется в `A5_RECORD_FILE` при выходе.
// `dotenv/config` подменён пустым модулем — `.env` для эталона не нужен.
import { registerHooks } from 'node:module'

const WRAPPER = new URL('./narrator-recording.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    const resolved = nextResolve(specifier, context)
    if (resolved.url.endsWith('/server/narrator.mjs') && context.parentURL !== WRAPPER) {
      return { ...resolved, url: WRAPPER, shortCircuit: true }
    }
    return resolved
  },
})
