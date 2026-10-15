import '../../../fixtures-env.mjs'
// Эталоны общих блоков `validateCommand` (задача Р0) и разрыва перемирия из
// подготовки `resolveCommandInternal`. Блоки встроены в большие функции,
// поэтому их строки исполняются в области имён открытой копии
// (`blockFunction`): G1 — тип, версия, ожидающее окно (6135–6151); G2 —
// недособранный герой и статус кампании (6777–6809); G3 — погибший герой
// (6981–6984); G4 — провенанс и количества (7819–7832); truce — вероломство
// (13100–13117). Команды — `normalizeCommand` мусорных входов.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-validate-common.mjs
import { writeFileSync } from 'node:fs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

let seed = 0x7a11da7e
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p

const groups = {
  g1: await blockFunction([[6135, 6151]], ['if (!ALLOWED_COMMAND_TYPES'], ['state', 'command', 'context']),
  g2: await blockFunction([[6777, 6809]], ['const setupActor'], ['state', 'command', 'context']),
  g3: await blockFunction([[6981, 6984]], ['const actorFate'], ['state', 'command', 'context'], 'return actorFate ?? null'),
  g4: await blockFunction([[7819, 7832]], ['if (!command.source_rule_ids.length'], ['state', 'command', 'context']),
}
const truce = await blockFunction([[13100, 13117]], ['const truceBeforeCommand'], ['state', 'command', 'targetId', 'events'], 'return events')

const windows = [
  null, { id: 'w', pending_command: { command_type: 'MakeAttack' }, action_ids: ['cast:shield', 'decline-reaction'] },
  { id: 'w', pending_spell_command: { spell_id: 'x' }, action_ids: 'cast:shield-and-more' }, { id: 'w', pending_command: null, action_ids: ['x'] },
  { id: 'w', pending_command: { a: 1 }, action_ids: { a: 1 } }, { id: 'w', pending_command: { a: 1 } }, 'строка',
]
function randomState() {
  const heroes = [
    { id: 'hero', hp: 10 }, { id: 'setup', characterSetupRequired: true, characterSetupStage: pick(['leveling', 'abilities', undefined]) },
    { id: 'novice', characterSetupRequired: pick([1, '', 'yes']) },
  ]
  const leader = pick(['goblin-boss', 'hero', ''])
  return json({
    state_version: pick([0, 3, 7, '3']),
    ruleset_id: pick(['srd_5_2_1', 'dnd_5e_2014']),
    players: heroes,
    enemies: [{ id: 'goblin' }, { id: 'goblin-boss' }],
    actors: [{ id: 'wolf' }],
    mechanics: {
      combat: {
        active: pick([true, false]), round: pick([1, 2, '3']),
        reaction_window: pick(windows),
        ...(chance(0.6) ? { truce: { leader_id: leader, leader_name: pick(['Вожак', '']), hero_id: 'hero', round: 2, outcomes: ['withdraw'] } } : {}),
      },
      campaign_lifecycle: { status: pick(['active', 'active', 'paused', 'completed', 'failed', 'archived', undefined]) },
      death: { heroes: { hero: pick([{ status: 'dead' }, { status: 'alive' }, undefined]), setup: { status: 'dead' }, constructor: { status: 'dead' } } },
      conditions: {},
      world_time: pick([{ elapsed_minutes: 90 }, { amount: 2, unit: 'hour' }, {}]),
    },
  })
}
const types = [...E.ALLOWED_COMMAND_TYPES, 'Unknown', '']
function randomCommand(state) {
  const type = pick([...types, 'UseCombatAction', 'UseCombatAction', 'EndTurn', 'EndCombat', 'MakeAttack', 'ApplyDamage', 'SpendResource', 'AddCondition', 'CastSpell', 'ApplyHealing'])
  const input = { command_type: type, command_id: `cmd-${Math.floor(random() * 1000)}` }
  if (chance(0.8)) input.actor_id = pick(['hero', 'setup', 'novice', 'goblin', 'ghost', null, 'constructor'])
  if (chance(0.5)) input.target_id = pick(['goblin', 'goblin-boss', 'hero', 'wolf', ''])
  if (chance(0.4)) input.action_id = pick(['decline-reaction', 'cast:shield', 'shield', 'dodge'])
  if (chance(0.5)) input.expected_state_version = pick([state.state_version, 0, 3, 7, '3'])
  if (chance(0.3)) input.server_authoritative = pick([true, 'yes'])
  if (chance(0.3)) input.auto_skip_reason = pick(['turn-timeout', 'other'])
  if (chance(0.4)) input.amount = pick([5, 0, -1, '7', 'x', null, 1.5, 1e400 === Infinity ? 'Infinity' : 1])
  if (chance(0.3)) input.expression = pick(['1d6', '', 0])
  if (chance(0.4)) input.resource = pick(['ki', ' ', '', null, 0])
  if (chance(0.4)) input.condition = pick(['prone', ' ', '', null])
  if (chance(0.3)) input.house_rule_id = pick(['house:x', '', null])
  if (chance(0.2)) input.ruling_id = pick(['r-1', ''])
  if (chance(0.3)) input.source_rule_ids = pick([[], ['srd_5_2_1:combat:damage']])
  return E.normalizeCommand(json(input), state)
}
const contexts = [{}, { __resolve_depth: 1 }, { __resolve_depth: 2 }, { isAdmin: true, serverAuthoritativeCombat: true }, { isAdmin: true, serverAuthoritativeCombat: true, isNpcScheduler: true }, { __resolve_depth: '3', isAdmin: 1 }]

const inputs = []
const cases = []
for (let index = 0; index < 700; index += 1) {
  const state = randomState()
  let command
  try { command = randomCommand(state) } catch { continue }
  const context = pick(contexts)
  const input = inputs.push({ state, command, context }) - 1
  for (const [group, run] of Object.entries(groups)) {
    const copy = structuredClone(command)
    try {
      const value = run(state, copy, context)
      cases.push({ group, input, ok: true, ...(group === 'g3' ? { actor_fate: json(value) } : {}) })
    } catch (error) {
      cases.push({ group, input, error: { name: error.name, code: error.code ?? null, message: error.message } })
    }
  }
}

const truceCases = []
for (let index = 0; index < 200; index += 1) {
  const state = randomState()
  state.mechanics.combat.active = chance(0.8)
  let command
  try { command = randomCommand(state) } catch { continue }
  command.command_type = pick(['MakeAttack', 'MakeAreaAttack', 'CastSpell', 'ApplyDamage', 'ApplyHealing', 'EndTurn'])
  if (chance(0.5)) command.actor_id = pick(['hero', 'goblin', 'goblin-boss', null])
  const targetId = E.targetFor(command) ?? null
  const events = truce(state, command, targetId, [])
  truceCases.push({ state, command, target_id: targetId, truce: E.truceFor(state) ?? null, events: json(events) })
}

const out = { source_sha256: sourceSha256(), inputs, cases, truce: truceCases }
writeFileSync(new URL('validate-common.json', import.meta.url), `${JSON.stringify(out)}\n`)
console.log('validate-common.json:', cases.length, 'блоков,', truceCases.length, 'перемирий;', 'ошибок', cases.filter((entry) => entry.error).length)
