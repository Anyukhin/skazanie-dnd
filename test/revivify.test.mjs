// «Возрождение» (PHB 2014, 3-й круг): погибший герой отряда возвращается с
// 1 хитом, если с гибели прошло не больше минуты; бриллианты на 300 зм
// расходуются. Аудит боя 2026-10-13: заклинание было ruling-only — движок не
// записывал момент смерти, и против смертельного финала Асстохана жрецу
// нечем было вернуть павшего.
import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

const context = { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] }
const cast = (state, command) => resolveCommand({ ...command, server_authoritative: true }, state, { diceService: fixedDice(10), context })

test('«Возрождение» возвращает погибшего в этом бою союзника с 1 хитом и тратит шесть алмазов', () => {
  const { state, command } = spellRuntimeFixture('revivify')
  const result = cast(state, command)
  const back = result.events.find((event) => event.event_type === 'HeroResurrected')
  assert.equal(back.payload.method, 'revivify')
  assert.deepEqual(back.target_ids, ['ally'])
  const consumed = result.events.find((event) => event.event_type === 'ItemConsumed')
  assert.equal(consumed.payload.quantity, 6, '300 зм — шесть алмазов по 50')
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.players[1].hp, 1)
  assert.equal(after.mechanics.death.heroes.ally.status, 'resolved')
  assert.equal(after.mechanics.death.heroes.ally.resolution, 'resurrected')
  assert.ok(!(after.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'dead'))
  assert.equal(after.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:diamond-50gp')?.quantity ?? 0, 0)
  assert.deepEqual(replayEvents(state, result.events).players[1].hp, 1)
})

test('позже минуты, живому и без алмазов — отказ', () => {
  const late = spellRuntimeFixture('revivify')
  late.state.mechanics.combat.round = 12
  assert.throws(() => cast(late.state, late.command), { code: 'REVIVIFY_TOO_LATE' })
  const afterCombat = spellRuntimeFixture('revivify')
  afterCombat.state.mechanics.combat = { active: false }
  afterCombat.state.mechanics.world_time.elapsed_minutes = 5
  assert.throws(() => cast(afterCombat.state, afterCombat.command), { code: 'REVIVIFY_TOO_LATE' })
  const alive = spellRuntimeFixture('revivify')
  alive.state.players[1].hp = 30
  delete alive.state.mechanics.death.heroes.ally
  alive.state.mechanics.conditions.ally = []
  assert.throws(() => cast(normalizeCampaignState(alive.state), alive.command), { code: 'REVIVIFY_TARGET_NOT_DEAD' })
  const poor = spellRuntimeFixture('revivify')
  poor.state.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:diamond-50gp').quantity = 5
  assert.throws(() => cast(poor.state, poor.command), (error) => /SPELL_MATERIAL/u.test(String(error?.code)))
})

test('смерть героя записывает раунд и минуту гибели — их переживает replay', () => {
  const { state } = spellRuntimeFixture('fire-bolt')
  state.mechanics.combat.round = 3
  const died = { event_id: 'died', command_id: 'died', event_type: 'HeroDied', event_schema_version: 2, actor_id: null, target_ids: ['ally'], visibility: 'public', payload: {} }
  const after = applyGameEvent(state, died)
  assert.equal(after.mechanics.death.heroes.ally.died_round, 3)
  assert.equal(after.mechanics.death.heroes.ally.died_world_minutes, 0)
  assert.equal(normalizeCampaignState(after).mechanics.death.heroes.ally.died_round, 3)
  assert.equal(replayEvents(state, [died]).mechanics.death.heroes.ally.died_round, 3)
})
