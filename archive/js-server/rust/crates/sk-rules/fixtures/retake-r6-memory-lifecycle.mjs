import '../../../fixtures-env.mjs'
// Пересъёмка блоков b9 (память мира) и b33 (жизненный цикл героя) эталона
// `r6.json.gz` текущим JS после #189 и #190 — без перезапуска всего
// `gen-r6.mjs`, чьи диапазоны строк открытой копии `rules-engine.mjs` с тех
// пор устарели. Вход каждого случая (состояние с заплатками, нормализованная
// команда, контекст) не меняется; исход считается тем же кодом, что блок
// движка (`server/rules-engine.mjs:6206` и `:6786`): `Object.assign(command,
// validate…(command, state, context))`, отказ валидатора → `RulesValidationError`.
// Прежние удачные исходы, которые новый JS повторяет, служат проверкой самой
// пересъёмки: `out(command)` обязан совпасть байт в байт.
//
//   node rust/crates/sk-rules/fixtures/retake-r6-memory-lifecycle.mjs
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

import { normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import { WORLD_MEMORY_COMMAND_TYPES, WorldMemoryValidationError, validateWorldMemoryCommand } from '../../../../server/world-memory.mjs'
import {
  CharacterLifecycleValidationError, validateCharacterAbilityRollCommand, validateCharacterImportCommand, validateLevelUpCommand,
} from '../../../../server/character-lifecycle.mjs'

const file = new URL('r6.json.gz', import.meta.url)
const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'
function out(value) {
  if (value === undefined) return U
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 200 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function patched(index, patches) {
  const state = structuredClone(data.states[index])
  for (const [path, value] of patches) {
    let target = state
    for (const key of path.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      target = target[key]
    }
    target[path.at(-1)] = value
  }
  return state
}
function run(block, state, command, context) {
  try {
    if (block === 'b9') {
      if (WORLD_MEMORY_COMMAND_TYPES.has(command.command_type)) {
        try {
          Object.assign(command, validateWorldMemoryCommand(command, state, context))
        } catch (error) {
          if (error instanceof WorldMemoryValidationError) return { err: [error.code, error.message] }
          throw error
        }
      }
    } else {
      try {
        Object.assign(command, command.command_type === 'LevelUp'
          ? validateLevelUpCommand(command, state, context)
          : ['RollCharacterAbilities', 'RollCharacterWealth'].includes(command.command_type) ? validateCharacterAbilityRollCommand(command, state, context)
            : validateCharacterImportCommand(command, state, context))
      } catch (error) {
        if (error instanceof CharacterLifecycleValidationError) return { err: [error.code, error.message] }
        throw error
      }
    }
    return { ok: out(command) }
  } catch (error) {
    return { fault: String(error?.name), code: error?.code ?? null }
  }
}

const normalized = new Map()
let checked = 0
let retaken = 0
let reproduced = 0
const unreproducible = []
for (const [index, entry] of data.blocks.entries()) {
  if (entry.block !== 'b9' && entry.block !== 'b33') continue
  checked += 1
  const key = `${entry.s}:${JSON.stringify(entry.p)}`
  if (!normalized.has(key)) normalized.set(key, normalizeCampaignState(normalizeCampaignState(patched(entry.s, entry.p))))
  const outcome = run(entry.block, structuredClone(normalized.get(key)), structuredClone(entry.command), entry.context)
  const before = JSON.stringify({ ok: entry.ok, err: entry.err, fault: entry.fault, code: entry.code })
  const after = JSON.stringify({ ok: outcome.ok, err: outcome.err, fault: outcome.fault, code: outcome.code })
  if (before === after) {
    if (outcome.ok !== undefined) reproduced += 1
    continue
  }
  // Удачный исход старого JS, который новый JS даёт иначе, но тоже удачно, —
  // признак того, что пересъёмка считает не так, как генератор: не трогаем.
  if (entry.ok !== undefined && outcome.ok !== undefined) {
    unreproducible.push(index)
    continue
  }
  // Отказ старого JS, сменившийся другим отказом — например, ACTOR_FORBIDDEN
  // с новым текстом; удачный исход, ставший отказом, — новые проверки.
  delete entry.ok
  delete entry.err
  delete entry.fault
  delete entry.code
  Object.assign(entry, outcome)
  retaken += 1
  console.log(`#${index} ${entry.block} ${entry.command.command_type}: ${before} → ${after}`)
}
if (unreproducible.length) throw new Error(`пересъёмка не повторяет удачный исход генератора: ${unreproducible.join(', ')}`)
if (!reproduced) throw new Error('ни один удачный исход не совпал — пересъёмка считает не так, как генератор')
writeFileSync(file, gzipSync(JSON.stringify(data), { level: 9 }))
console.log(`блоков b9/b33: ${checked}; удачных исходов повторено ${reproduced}; пересняты ${retaken}`)
