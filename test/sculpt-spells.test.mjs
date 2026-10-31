// Лепка заклинаний волшебника Школы Воплощения (PHB 2014, 2-й уровень): от
// своего заклинания школы Воплощения союзники числом 1 + круг спасаются
// автоматически и не получают урона. Аудит боя 2026-10-13: умения не было, и
// бот стенда берёг союзников, не бросая «Огненный шар».
import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function fireball(subclass) {
  const { state, command } = spellRuntimeFixture('fireball')
  Object.assign(state.players[0], { characterClass: 'wizard', subclass, level: 7 })
  // Союзник-воин 7-го уровня: у 12-го провал спасброска открыл бы окно «Несгибаемого».
  state.players[1].level = 7
  const normalized = normalizeCampaignState(state)
  return resolveCommand({ ...command, to: { x: 3, y: 2 }, slot_level: 3, server_authoritative: true }, normalized,
    { diceService: fixedDice(2), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
}
const damageTo = (result, id) => result.events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids[0] === id)
  .reduce((sum, event) => sum + Number(event.payload.applied_amount ?? 0), 0)

test('воплотитель выводит союзника из-под Огненного шара: автоматический успех и ни единицы урона', () => {
  const result = fireball('Школа Воплощения')
  const allySave = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids[0] === 'ally')
  assert.equal(allySave?.payload.saved, true)
  assert.equal(damageTo(result, 'ally'), 0)
  assert.ok(damageTo(result, 'enemy') > 0, 'противник горит как обычно')
})

test('волшебник другой школы союзника не бережёт', () => {
  const result = fireball('Школа Ограждения')
  assert.ok(damageTo(result, 'ally') > 0)
})
