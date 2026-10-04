// Боевой текст ленты. Жил в `server/index.mjs` и был непроверяем: функция не
// экспортировалась, а импорт файла поднимает HTTP-слушателя. Из-за этого ветка
// про концентрацию печатала модификаторы врага без проверки на сторону, и
// расхождение приходилось держать в `docs/known-limitations.md`.
//
// Здесь он под тестом впервые.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { COMBAT_NARRATION_EVENT_TYPES, accusativeName, combatNarration, encounterEndText, combatNarrator, hasCombatNarrationEvent } from '../server/combat-narration.mjs'
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

test('лечение называет, сколько вернулось герою, и не выдаёт ОЗ врага', () => {
  // Живой прогон 2026-10-02: после «Лечащего слова» хроника писала только
  // «творит заклинание», и сколько вернулось, приходилось искать в листе.
  const healed = combatNarration([
    event('SpellCast', { spell_id: 'healing-word', name: 'Лечащее слово' }, ['hero']),
    event('HealingApplied', { applied_amount: 9, hp_before: 2, hp_after: 11 }, ['hero']),
  ], state)
  assert.match(healed, /Лира восстанавливает 9 ОЗ; ОЗ 2 → 11/u)
  const enemy = combatNarration([event('HealingApplied', { applied_amount: 5, hp_before: 3, hp_after: 8 }, ['wolf'])], state)
  assert.match(enemy, /Волк восстанавливает силы/u)
  assert.doesNotMatch(enemy, /\d/u, 'ОЗ врага в тексте быть не должно')
})

test('пропуск хода по часам виден в хронике, а обычное завершение остаётся служебным', () => {
  const skipped = combatNarration([event('TurnEnded', { round: 2, auto_skipped: true, auto_skip_reason: 'turn-timeout' })], state)
  assert.match(skipped, /Лира: время хода вышло, ход пропущен/u)
  const withAttack = combatNarration([
    event('TurnEnded', { round: 2, auto_skipped: true, auto_skip_reason: 'turn-timeout' }),
    event('DamageApplied', { applied_amount: 9, hp_before: 11, hp_after: 2 }, ['hero']),
  ], state)
  assert.match(withAttack, /время хода вышло/u, 'пропуск не вытесняется уроном')
  assert.match(withAttack, /9 урона/u)
})

test('залп из нескольких лучей называет заклинание один раз и сохраняет все атаки', () => {
  const spellCast = (commandId, economyConsumed = undefined) => ({
    ...event('SpellCast', {
      spell_id: 'scorching-ray',
      name: 'Палящий луч',
      ...(economyConsumed === undefined ? {} : { economy_consumed: economyConsumed }),
    }, ['wolf']),
    command_id: commandId,
  })
  const attack = (commandId) => ({
    ...event('AttackResolved', { target_id: 'wolf', hit: true, total: 20, armor_class: 10 }, ['wolf']),
    command_id: commandId,
  })
  const text = combatNarration([
    spellCast('rays'),
    attack('rays'),
    spellCast('rays:beam:2', false),
    attack('rays:beam:2'),
    spellCast('rays:beam:3', false),
    attack('rays:beam:3'),
  ], state)
  assert.equal((text.match(/творит заклинание «Палящий луч»/gu) ?? []).length, 1)
  assert.equal((text.match(/атакует Волка/gu) ?? []).length, 3)
})

test('persisted beam events use canonical event_id while command_id is shared', () => {
  const cast = (eventId, economyConsumed = undefined) => ({
    ...event('SpellCast', {
      spell_id: 'scorching-ray',
      name: 'Палящий луч',
      ...(economyConsumed === undefined ? {} : { economy_consumed: economyConsumed }),
    }, ['wolf']),
    event_id: eventId,
    command_id: '367e138e-3230-4a5b-94d6-cf3fec35d7ea',
  })
  const text = combatNarration([
    cast('spell-cast:367e138e-3230-4a5b-94d6-cf3fec35d7ea:1'),
    cast('spell-cast:367e138e-3230-4a5b-94d6-cf3fec35d7ea:1:beam:2', false),
    cast('spell-cast:367e138e-3230-4a5b-94d6-cf3fec35d7ea:1:beam:3', false),
  ], state)
  assert.equal((text.match(/творит заклинание «Палящий луч»/gu) ?? []).length, 1)
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

test('спасбросок заклинания сообщает исход без КД и модификатора цели', () => {
  const saved = combatNarration([
    event('SpellSavingThrowResolved', { spell_id: 'sacred-flame', total: 21, difficulty: 13, modifier: 2, saved: true }, ['wolf']),
  ], state)
  assert.match(saved, /Волк успешно проходит спасбросок от «Священное пламя»/u)
  assert.doesNotMatch(saved, /21|13|\b2\b|sacred-flame/u)

  const failed = combatNarration([
    event('SpellSavingThrowResolved', { spell_id: 'sacred-flame', total: 8, difficulty: 13, modifier: 2, saved: false }, ['wolf']),
  ], state)
  assert.match(failed, /Волк проваливает спасбросок от «Священное пламя»/u)
  assert.doesNotMatch(failed, /13|\b2\b|sacred-flame/u)
})

test('окно реакции и UseCombatAction получают безопасный русский текст', () => {
  const text = combatNarration([
    { ...event('ReactionWindowOpened', { source_actor_id: 'wolf', action_ids: ['opportunity-attack'], action_options: [{ id: 'opportunity-attack', name: 'Атака по возможности' }], trigger: 'enemy-left-reach' }, ['hero']), actor_id: 'wolf' },
    event('ReactionWindowClosed', { accepted: true, action_id: 'opportunity-attack' }, ['hero']),
    event('CombatActionUsed', { action_type: 'reaction', action_id: 'opportunity-attack', reaction_window_id: 'reaction:opportunity' }, ['hero']),
  ], state)
  assert.match(text, /получает возможность использовать реакцию «Атака по возможности»/u)
  assert.match(text, /подтверждает реакцию «Атака по возможности»/u)
  assert.match(text, /использует реакцию «Атака по возможности»/u)
  assert.doesNotMatch(text, /ReactionWindow|CombatActionUsed|opportunity-attack/u)

  const unknown = combatNarration([
    { ...event('ReactionWindowOpened', { source_actor_id: 'wolf', action_ids: ['custom-reaction'], trigger: 'spell-cast' }, ['hero']), actor_id: 'wolf' },
    event('ReactionWindowClosed', { accepted: true, action_id: 'custom-reaction' }, ['hero']),
  ], state)
  assert.match(unknown, /получает возможность использовать реакцию против Волк/u)
  assert.doesNotMatch(unknown, /Атака по возможности|custom-reaction/u)

  const named = combatNarration([
    event('CombatActionUsed', { action_type: 'action', action_id: 'dash', name: 'Рывок' }, ['hero']),
  ], state)
  assert.match(named, /Лира использует «Рывок»/u)
  assert.doesNotMatch(named, /dash/u)
})

test('причина использования Resistance локализуется в боевой ленте', () => {
  const text = combatNarration([
    event('ConcentrationEnded', { reason: 'resistance-used' }, ['hero']),
  ], state)
  assert.equal(text, 'Концентрация Лира прекращается (бонус спасброска использован).')
  assert.doesNotMatch(text, /resistance-used/u)
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

test('обычный короткий отдых попадает в летопись из RestStarted', () => {
  const text = combatNarration([
    event('RestStarted', { kind: 'short', minimum_duration_minutes: 60 }, ['hero']),
    event('TimeAdvanced', { amount: 60, unit: 'minute', elapsed_minutes: 60 }),
  ], state)
  assert.match(text, /Лира начинает короткий отдых/u)
  assert.doesNotMatch(text, /Взаимодействие с объектом завершено/u)
  assert.equal(hasCombatNarrationEvent([event('RestStarted')]), true)
})

test('обычный долгий отдых попадает в летопись из RestCompleted', () => {
  const text = combatNarration([
    event('RestStarted', { kind: 'long', minimum_duration_minutes: 480 }, ['hero']),
    event('RestCompleted', { kind: 'long', duration_minutes: 480 }, ['hero']),
  ], state)
  assert.match(text, /Лира завершает продолжительный отдых/u)
  assert.doesNotMatch(text, /Взаимодействие с объектом завершено/u)
})

test('поднятый максимум ОЗ получает свою строку и держит ту же границу, что и снижение', () => {
  // «Подмога» пишет `HitPointMaximumIncreased`, а рассказчик его не знал — ход
  // с поднятым пределом уходил в ленту без единой строки про то, что случилось.
  assert.equal(COMBAT_NARRATION_EVENT_TYPES.has('HitPointMaximumIncreased'), true)
  assert.equal(hasCombatNarrationEvent([event('HitPointMaximumIncreased')]), true)

  const own = combatNarration([
    event('HitPointMaximumIncreased', { spell_id: 'aid', maximum_hp_before: 24, maximum_hp_after: 29, hp_before: 24, hp_after: 29 }, ['hero']),
  ], state)
  assert.match(own, /Максимум ОЗ Лира поднимается: 24 → 29\./u)

  const enemy = combatNarration([
    event('HitPointMaximumIncreased', { spell_id: 'aid', maximum_hp_before: 20, maximum_hp_after: 25, hp_before: 20, hp_after: 25 }, ['wolf']),
  ], state)
  assert.match(enemy, /Волк/u)
  assert.doesNotMatch(enemy, /20|25/u, 'числа чужого листа за столом не называют')
})

test('цель атаки склоняется, только когда окончание однозначно', () => {
  // Плейтест 2026-10-02: «Фарн Оникс атакует Разбойник 1».
  assert.equal(accusativeName('Разбойник 1'), 'Разбойника 1')
  assert.equal(accusativeName('Гоблин-воин'), 'Гоблина-воина')
  assert.equal(accusativeName('Гиена'), 'Гиену')
  assert.equal(accusativeName('Гарпия'), 'Гарпию')
  for (const name of ['Тень', 'Зомби', 'Брам Тихий Молот', 'Торн «Без Весла»']) assert.equal(accusativeName(name), name, name)
  // Клиентская строка боя держит то же правило отдельной копией.
  const client = readFileSync(new URL('../src/app-shared.tsx', import.meta.url), 'utf8')
  assert.match(client, /export function accusativeName/u)
  assert.ok(client.includes('/[бвгджзклмнпрстфхцчшщ]$/u.test(lower)'), 'правило мужского рода совпадает с серверным')
})

test('конец боя называется по-русски, служебный код игроку не печатается', () => {
  // Плейтест 2026-10-03: «Столкновение завершено: resolved», а в обычной
  // победе — «enemies_defeated».
  assert.equal(encounterEndText('enemies_defeated'), 'противники повержены')
  assert.equal(encounterEndText('party_defeated'), 'отряд пал')
  assert.equal(encounterEndText('resolved'), 'исход подтверждён')
  assert.equal(encounterEndText(undefined), 'исход подтверждён')
  assert.equal(encounterEndText('some_new_code'), 'исход подтверждён')
  assert.equal(encounterEndText('стража разняла драку'), 'стража разняла драку')
  const text = combatNarration([{ event_type: 'EncounterEnded', payload: { reason: 'enemies_defeated', outcome: 'enemies_defeated' } }], {})
  assert.match(text, /Столкновение завершено: противники повержены\./u)
  assert.doesNotMatch(text, /[a-z]_[a-z]/u)
})

test('ход выбывшего противника в хронику не попадает, ход упавшего героя — попадает', () => {
  // Плейтест 2026-10-03: убитый хобгоблин каждый раунд «завершал ход», и
  // между ходами героев в ленте стояли строки о мёртвом.
  const fallen = { ...state, players: [{ id: 'hero', character: 'Лира', hp: 0, maxHp: 24 }], enemies: [{ id: 'wolf', name: 'Волк', hp: 0, maxHp: 20 }] }
  const wolfTurn = [
    { event_type: 'TurnEnded', actor_id: 'wolf', target_ids: ['wolf'], payload: { round: 3 } },
    { event_type: 'TurnStarted', actor_id: 'wolf', target_ids: ['hero'], payload: { round: 4 } },
  ]
  const text = combatNarration(wolfTurn, fallen)
  assert.doesNotMatch(text, /Волк/u)
  assert.match(text, /Начинается ход Лира, раунд 4/u)
  const alive = combatNarration(wolfTurn, state)
  assert.match(alive, /Волк завершает ход/u)
})
