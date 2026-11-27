// Таблицы JS-движка в JSON для Rust-версии (`docs/rust-rewrite-plan.md`).
// Rust подключает их через `include_str!`, поэтому значения совпадают с JS
// по построению, а не переписываются руками.
//
//   node tools/export-rust-tables.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONDITION_EFFECTS_TABLE } from '../server/rules-engine.mjs'
import { ITEM_CATALOG, SCENARIO_ITEM_CATALOG } from '../server/item-catalog.mjs'

const out = join(process.cwd(), 'rust', 'data')
mkdirSync(out, { recursive: true })
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 1)}\n`)
write('condition-effects.json', CONDITION_EFFECTS_TABLE)
write('item-catalog.json', { ...ITEM_CATALOG, ...Object.fromEntries(Object.entries(SCENARIO_ITEM_CATALOG).filter(([id]) => !ITEM_CATALOG[id])) })
console.log('таблицы записаны в rust/data')
