import '../../../fixtures-env.mjs'
// Перехват вызовов модулей из тестов JS для эталонов Н1: тот же механизм, что
// `sk-tactics/fixtures/capture-modules.mjs`, плюс подмена `dotenv/config`
// пустым модулем (`node_modules` в worktree нет, а `store.mjs` его импортирует).
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

await import('../../sk-tactics/fixtures/capture-modules.mjs')
