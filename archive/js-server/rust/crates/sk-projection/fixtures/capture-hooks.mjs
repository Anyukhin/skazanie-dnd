import '../../../fixtures-env.mjs'
// Хуки захвата вызовов для эталонов П1: `dotenv/config` подменяется пустым
// модулем (эталон не читает `.env`), затем подключается общий перехват
// `sk-tactics/fixtures/capture-modules.mjs`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

await import('../../sk-tactics/fixtures/capture-modules.mjs')
