import assert from 'node:assert/strict'
import test from 'node:test'
import { catalog, probeSpellRuntime, spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Общие инварианты исполнения проверяются поимённо; эти сценарии не являются
// проверкой всех исключений из текста каждой карточки или её визуальной приёмкой.
for (const spell of catalog) test(`каталог 2014: ${spell.id} — исполнение/отказ, оплата, чужой герой и replay`, () => {
  const result = probeSpellRuntime(spell.id)
  assert.notEqual(result.status, 'needs-investigation', JSON.stringify(result.variants))
  assert.equal(result.checks.foreignActorDenied, true)
  assert.equal(result.checks.inputUnchanged, true)
  assert.equal(result.variants.length, 2)
})

function whispers() {
  const { state, command } = spellRuntimeFixture('dissonant-whispers')
  let next = 0
  const diceService = new DiceService({ rng: { randint: min => min }, idFactory: () => `whisper-window-${++next}` })
  const options = { diceService, context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } }
  const result = resolveCommand(command, state, options)
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.action_economy.caster.action, false)
  assert.equal(after.mechanics.combat.reaction_window.actor_id, 'caster')
  return { state: after, options }
}
test('Диссонирующий шёпот: отказ от своей атаки по возможности не требует второго действия и не тратит реакцию', () => {
  const { state, options } = whispers()
  const before = structuredClone(state)
  const result = resolveCommand({ command_type: 'UseCombatAction', command_id: 'decline-whispers', actor_id: 'caster',
    action_id: 'decline-reaction', server_authoritative: true }, state, options)
  assert.deepEqual(state, before)
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.mechanics.combat.action_economy.caster.reaction, true)
  assert.deepEqual(after.mechanics.resources.caster, state.mechanics.resources.caster)
})
test('Диссонирующий шёпот: своя атака по возможности тратит только реакцию после оплаченного заклинания', () => {
  const { state, options } = whispers()
  const result = resolveCommand({ command_type: 'UseCombatAction', command_id: 'accept-whispers', actor_id: 'caster',
    action_id: 'opportunity-attack', server_authoritative: true }, state, options)
  const after = replayEvents(state, result.events)
  assert.ok(result.events.some(event => event.event_type === 'AttackResolved'))
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.mechanics.combat.action_economy.caster.reaction, false)
  assert.equal(after.mechanics.combat.action_economy.caster.action, false)
  assert.deepEqual(after.mechanics.resources.caster, state.mechanics.resources.caster)
  const persisted = value => JSON.parse(JSON.stringify(normalizeCampaignState(value)))
  assert.deepEqual(persisted(after), persisted(replayEvents(state, JSON.parse(JSON.stringify(result.events)))))
})
test('отходивший участник может отказаться от ожидающей реакции', () => {
  const { state, options } = whispers()
  state.mechanics.combat.turn_completed = ['caster']
  const result = resolveCommand({ command_type: 'UseCombatAction', command_id: 'decline-completed-turn', actor_id: 'caster',
    action_id: 'decline-reaction', server_authoritative: true }, state, options)
  assert.equal(replayEvents(state, result.events).mechanics.combat.reaction_window, null)
})
test('парализованный участник не использует ожидающую реакцию, но может закрыть её отказом', () => {
  const { state, options } = whispers()
  state.mechanics.conditions.caster = [{ id: 'paralyzed' }]
  const command = { command_type: 'UseCombatAction', command_id: 'incapacitated-opportunity', actor_id: 'caster',
    action_id: 'opportunity-attack', server_authoritative: true }
  assert.throws(() => resolveCommand(command, state, options), error => error.code === 'ACTOR_INCAPACITATED')
  const declined = resolveCommand({ ...command, action_id: 'decline-reaction' }, state, options)
  assert.equal(replayEvents(state, declined.events).mechanics.combat.reaction_window, null)
})
