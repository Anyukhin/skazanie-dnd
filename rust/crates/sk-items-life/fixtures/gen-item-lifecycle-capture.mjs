import '../../../fixtures-env.mjs'
// Эталон item-lifecycle по настоящим вызовам: прогон тестов модуля и его
// соседей (`test/item-lifecycle.test.mjs`, `test/combat-equipment-interaction.test.mjs`,
// `test/npc-equipment.test.mjs`) в этом процессе с перехватом экспортов
// `server/item-lifecycle.mjs`. Перехват — хук загрузки, дописывающий в конец
// модуля переприсваивание экспортов обёрткой (как в sk-npc-world); исходники
// на диске не меняются. Каждый перехваченный вызов затем повторяется на входе,
// прошедшем JSON, в том же режиме retention, и пишется в эталон.
//
//   node rust/crates/sk-items-life/fixtures/gen-item-lifecycle-capture.mjs
//
// Пишет item-lifecycle-capture.json рядом с собой.
import { registerHooks } from 'node:module'

import { dispatch, errorOf, fixtureWriter, stripArgs, viaJson } from './common.mjs'

const TARGET = 'server/item-lifecycle.mjs'
const NAMES = [
  'itemProfileFor', 'inventoryWeight', 'carryingCapacity', 'inventoryLoadFor', 'activeItemEffectTotals',
  'activeItemMechanicEffects', 'weaponDamageRidersForItem', 'equippedShieldBonus', 'derivedEquipmentArmorClass',
  'validateItemLifecycleCommand', 'itemLifecycleEvents', 'applyItemLifecycleEventToPlayers',
]

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(`/${TARGET}`)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = NAMES.map((name) => `${name} = globalThis.__itemLifecycleWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const captured = []
let depth = 0
let recording = true
let retentionMode = () => 'current'
globalThis.__itemLifecycleWrap = (name, fn) => function recorded(...args) {
  if (!recording || depth > 0) return fn(...args)
  depth += 1
  try {
    captured.push({ name, retention: retentionMode(), args: args.map((arg) => (arg === undefined ? undefined : viaJson(arg))) })
    return fn(...args)
  } finally {
    depth -= 1
  }
}

const retention = await import('../../../../server/retention-context.mjs')
retentionMode = retention.retentionMode
const lifecycle = await import('../../../../server/item-lifecycle.mjs')

for (const file of ['item-lifecycle', 'combat-equipment-interaction', 'npc-equipment']) {
  await import(`../../../../test/${file}.test.mjs`)
}

let written = false
process.on('beforeExit', () => {
  if (written) return
  written = true
  recording = false
  const writer = fixtureWriter()
  const calls = dispatch(lifecycle)
  let differ = 0
  const outcome = (run) => {
    try {
      return JSON.stringify(run())
    } catch (error) {
      return JSON.stringify(errorOf(error))
    }
  }
  for (const entry of captured) {
    const run = (...args) => retention.withRetentionMode(entry.retention, () => calls[entry.name](...args))
    const stripped = stripArgs(entry.name, entry.args)
    // Урезанный вход обязан давать тот же исход (кроме героев в выходе apply).
    if (entry.name !== 'applyItemLifecycleEventToPlayers' && outcome(() => run(...entry.args.map(viaJson))) !== outcome(() => run(...stripped.map(viaJson)))) {
      differ += 1
      writer.call(entry.name, run, entry.args, { retention: entry.retention, cap: 2500 })
      continue
    }
    writer.call(entry.name, run, stripped, { retention: entry.retention, cap: 2500 })
  }
  console.log(`урезанный вход дал другой исход: ${differ}`)
  console.log(`перехвачено вызовов ${captured.length}`)
  writer.write(new URL('item-lifecycle-capture.json', import.meta.url))
})
