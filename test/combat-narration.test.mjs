// Боевой текст ленты. Жил в `server/index.mjs` и был непроверяем: функция не
// экспортировалась, а импорт файла поднимает HTTP-слушателя. Из-за этого ветка
// про концентрацию печатала модификаторы врага без проверки на сторону, и
// расхождение приходилось держать в `docs/known-limitations.md`.
//
// Здесь он под тестом впервые.
import assert from 'node:assert/strict'
import test from 'node:test'

import { COMBAT_NARRATION_EVENT_TYPES, combatNarration, combatNarrator, hasCombatNarrationEvent } from '../server/combat-narration.mjs'
import { assertNarratorContract } from '../server/deterministic-narration.mjs'

const state = {
  players: [{ id: 'hero', character: 'Лира', hp: 24, maxHp: 24 }],
  enemies: [{ id: 'wolf', name: 'Волк', hp: 20, maxHp: 20 }],
  actors: [],
}

const event = (type, payload = {}, targets = []) => ({ event_type: type, actor_id: 'hero', target_ids: targets, payload })

test('рассказчик боя удовлетворяет общему контракту', () => {
  assertNarratorContract(combatNarrator)
  assert.equal(combatNarrator.id, 'combat')
  assert.ok(COMBAT_NARRATION_EVENT_TYPES.size >= 30, 'набор типов подозрительно мал')
  assert.equal(hasCombatNarrationEvent([event('AttackResolved')]), true)
  assert.equal(hasCombatNarrationEvent([event('MerchantPurchaseCompleted')]), false)
  assert.equal(hasCombatNarrationEvent([]), false)
})

test('урон и попадание по врагу не называют его чисел', () => {
  const text = combatNarration([
    event('AttackResolved', { target_id: 'wolf', total: 22, armor_class: 19, hit: true }, ['wolf']),
    event('DamageApplied', { target_id: 'wolf', applied_amount: 7, hp_before: 20, hp_after: 13 }, ['wolf']),
  ], state)
  assert.match(text, /Волк/)
  assert.doesNotMatch(text, /19/, 'КД врага попал в текст')
  assert.doesNotMatch(text, /20\s*→|→\s*13/, 'ОЗ врага попали в текст')
  assert.match(text, /7 урона/, 'нанесённый урон игрок видеть обязан')
})

test('по своему герою те же числа показываются', () => {
  const text = combatNarration([
    event('DamageApplied', { target_id: 'hero', applied_amount: 5, hp_before: 24, hp_after: 19 }, ['hero']),
  ], state)
  assert.match(text, /24 → 19/, 'свои ОЗ герой видит')
})

// Ровно та ветка, ради которой разбирался долг.
test('спасбросок концентрации врага не раскрывает его модификатор', () => {
  const enemy = combatNarration([
    event('ConcentrationSavingThrowResolved', { target_id: 'wolf', kept: 9, modifier: 4, total: 13, difficulty: 12, saved: true }, ['wolf']),
  ], state)
  assert.match(enemy, /Волк/)
  assert.match(enemy, /успех/, 'исход игрок видеть обязан')
  assert.doesNotMatch(enemy, /\b4\b/, 'модификатор врага попал в текст')
  assert.doesNotMatch(enemy, /\b9\b/, 'кость врага попала в текст')

  // У своего героя бросок по-прежнему разобран полностью.
  const own = combatNarration([
    event('ConcentrationSavingThrowResolved', { target_id: 'hero', kept: 9, modifier: 4, total: 13, difficulty: 12, saved: true }, ['hero']),
  ], state)
  assert.match(own, /9 \+ 4 = 13/, 'свой бросок герой видит целиком')
})

test('пустой поток не даёт текста', () => {
  assert.equal(combatNarration([], state), '')
  assert.equal(combatNarrator.narrate([], state), null)
})

test('гибель последнего героя ведёт к эпилогу поражения, а не предлагает продолжить отряд', () => {
  const text = combatNarration([
    event('HeroDied', { hero_name: 'Лира' }, ['hero']),
    event('CampaignFailed', { reason: 'party_final_death', epilogue: 'Отряд пал.' }),
  ], state)
  assert.match(text, /история завершилась поражением/iu)
  assert.doesNotMatch(text, /воскресить|заменить/iu)
})

test('взаимодействие со сценой попадает в летопись только из committed события', () => {
  const hidden = combatNarration([], state)
  const revealed = combatNarration([
    event('SceneObjectOperated', { prop_id: 'prop-rune', kind: 'relic', intent: 'inspect' }),
    event('SceneObjectKnowledgeRevealed', {
      prop_id: 'prop-rune',
      detail_key: 'relic:warning-glyph',
      text: 'Надпись предупреждает не тревожить печать без нужды.',
    }),
  ], state)
  assert.equal(hidden, '')
  assert.match(revealed, /Надпись предупреждает/u)
  assert.doesNotMatch(revealed, /relic:warning-glyph/u)
  assert.equal(hasCombatNarrationEvent([event('SceneObjectKnowledgeRevealed')]), true)
  assert.equal(hasCombatNarrationEvent([event('SceneObjectLootRevealed')]), true)
})
