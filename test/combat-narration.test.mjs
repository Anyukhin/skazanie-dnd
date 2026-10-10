// Боевой текст ленты. Жил в `server/index.mjs` и был непроверяем: функция не
// экспортировалась, а импорт файла поднимает HTTP-слушателя. Из-за этого ветка
// про концентрацию печатала модификаторы врага без проверки на сторону, и
// расхождение приходилось держать в `docs/known-limitations.md`.
//
// Здесь он под тестом впервые.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { COMBAT_NARRATION_EVENT_TYPES, accusativeName, combatJournalVoice, combatNarration, encounterEndText, combatNarrator, hasCombatNarrationEvent } from '../server/combat-narration.mjs'
import { confidentAccusative } from '../server/combat-phrases.mjs'
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

// Браузерный плейтест 2026-10-07: паутина паука «попадала» без урона, а
// «Высвободиться» не говорило, вырвался ли герой.
test('опутывание ударом чудовища и исход «Высвободиться» видны в хронике', () => {
  const webbed = combatNarration([
    { event_type: 'AttackResolved', actor_id: 'wolf', target_ids: ['hero'], payload: { target_id: 'hero', total: 14, armor_class: 12, hit: true, action_id: 'web' } },
    { event_type: 'ConditionAdded', actor_id: 'wolf', target_ids: ['hero'], payload: { condition: 'restrained', action_id: 'web', escape_dc: 12 } },
    { event_type: 'ConditionAdded', actor_id: 'wolf', target_ids: ['wolf'], payload: { condition: 'monster-action-used:web' } },
  ], state)
  assert.match(webbed, /Лира — состояние «Опутанный»/)
  assert.doesNotMatch(webbed, /monster-action-used/)
  assert.match(combatNarration([event('CombatActionUsed', { action_id: 'break-free', name: 'Высвободиться', action_type: 'action', success: true })], state), /Лира вырывается/)
  assert.match(combatNarration([event('CombatActionUsed', { action_id: 'break-free', name: 'Высвободиться', action_type: 'action', success: false })], state), /Лира рвётся из пут, но они держат/)
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
  // Заклинание называется одной строкой каста, у каждого луча — своя строка
  // атаки с целью (формулировки разные, цель одна).
  assert.equal((text.match(/«Палящий луч»/gu) ?? []).length, 1)
  assert.equal((text.match(/Волк/gu) ?? []).length, 3)
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
  assert.equal((text.match(/«Палящий луч»/gu) ?? []).length, 1)
})

test('бой, открытый ударом из исследования, говорит, состоялся ли удар', () => {
  const opened = (status, first) => combatNarration([
    event('CombatStarted', { opening_action: { actor_id: 'hero', command_type: 'MakeAttack', status, first_actor_id: first } }, ['hero', 'wolf']),
  ], state)
  // Без рода: «первым» у Лиры звучало мужским (плейтест 2026-10-10).
  assert.match(opened('resolved', 'hero'), /Лира нападает и открывает бой/u)
  assert.match(opened('deferred', 'wolf'), /Лира нападает, но Волк успевает раньше: удар придётся повторить в свой ход/u)
  assert.doesNotMatch(opened('resolved', 'hero'), /первым/u)
  const free = combatNarration([
    event('CombatStarted', { opening_action: { actor_id: 'hero', command_type: 'MakeAttack', status: 'resolved', free_strike: true, npc_id: 'wolf', first_actor_id: 'wolf' } }, ['hero', 'wolf']),
  ], state)
  assert.match(free, /Лира нападает на Волка вне очереди/u, 'домашнее правило BG3 называет удар вне очереди')
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
  // «от заклинания «…»»: название в кавычках не склоняется (плейтест 2026-10-10).
  assert.match(saved, /^Волк [^.]*спасбросок от заклинания «Священное пламя»[^.]*\.$/u)
  assert.match(saved, /успешн/u)
  assert.doesNotMatch(saved, /от «/u)
  assert.doesNotMatch(saved, /21|13|\b2\b|sacred-flame/u)

  const failed = combatNarration([
    event('SpellSavingThrowResolved', { spell_id: 'sacred-flame', total: 8, difficulty: 13, modifier: 2, saved: false }, ['wolf']),
  ], state)
  assert.match(failed, /^Волк [^.]*спасбросок от заклинания «Священное пламя»[^.]*\.$/u)
  assert.match(failed, /провал/u)
  assert.doesNotMatch(failed, /13|\b2\b|sacred-flame/u)
})

test('окно реакции и UseCombatAction получают безопасный русский текст', () => {
  const text = combatNarration([
    { ...event('ReactionWindowOpened', { source_actor_id: 'wolf', action_ids: ['opportunity-attack'], action_options: [{ id: 'opportunity-attack', name: 'Атака по возможности' }], trigger: 'enemy-left-reach' }, ['hero']), actor_id: 'wolf' },
    event('ReactionWindowClosed', { accepted: true, action_id: 'opportunity-attack' }, ['hero']),
    event('CombatActionUsed', { action_type: 'reaction', action_id: 'opportunity-attack', reaction_window_id: 'reaction:opportunity' }, ['hero']),
  ], state)
  assert.match(text, /Волк выходит из досягаемости — Лира может ответить реакцией «Атака по возможности»/u)
  // Подтверждение окна и сама реакция — одна новость, а не две строки подряд.
  assert.match(text, /Лира (?:использует реакцию|отвечает реакцией) «Атака по возможности»\./u)
  assert.equal((text.match(/«Атака по возможности»/gu) ?? []).length, 2)
  assert.doesNotMatch(text, /ReactionWindow|CombatActionUsed|opportunity-attack/u)

  const unknown = combatNarration([
    { ...event('ReactionWindowOpened', { source_actor_id: 'wolf', action_ids: ['custom-reaction'], trigger: 'spell-cast' }, ['hero']), actor_id: 'wolf' },
    event('ReactionWindowClosed', { accepted: true, action_id: 'custom-reaction' }, ['hero']),
  ], state)
  // Раньше: «реакцию против Волк» — без падежа. Теперь имя стоит подлежащим.
  assert.match(unknown, /Лира может ответить реакцией\./u)
  assert.doesNotMatch(unknown, /против Волк/u)
  assert.doesNotMatch(unknown, /Атака по возможности|custom-reaction/u)

  const named = combatNarration([
    event('CombatActionUsed', { action_type: 'action', action_id: 'dash', name: 'Рывок' }, ['hero']),
  ], state)
  assert.match(named, /^Лира [^.]*«Рывок»/u)
  assert.doesNotMatch(named, /dash/u)
})

test('причина использования Resistance локализуется в боевой ленте', () => {
  const text = combatNarration([
    event('ConcentrationEnded', { reason: 'resistance-used' }, ['hero']),
  ], state)
  // «Концентрация Лира» было без падежа; имя теперь подлежащее.
  assert.equal(text, 'Лира теряет концентрацию (бонус спасброска использован).')
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
  assert.match(text, /^(?:Столкновение завершено|Бой стихает|Всё кончено): противники повержены\./u)
  assert.doesNotMatch(text, /[a-z]_[a-z]/u)
})

// Плейтест 2026-10-04, MC-03: после победы «Продолжим» по политике
// `post_encounter_recovery` проматывал 8 часов долгого отдыха, а игрок узнавал
// об этом задним числом. Политика та же — строка победы называет её заранее.
const party = {
  partyMemberIds: ['hero', 'ally'],
  players: [{ id: 'hero', character: 'Лира', hp: 9, maxHp: 24 }, { id: 'ally', character: 'Бор', hp: 6, maxHp: 12 }],
  enemies: [{ id: 'wolf', name: 'Волк', hp: 0, maxHp: 11 }],
  actors: [],
  mechanics: { death: { heroes: {} } },
}
const victory = { event_type: 'EncounterEnded', payload: { reason: 'enemies_defeated', outcome: 'enemies_defeated' } }

test('победа заранее называет отдых, который начнётся с продолжением истории — MC-03', () => {
  assert.match(combatNarration([victory], party),
    /противники повержены\. Можно перевести дух: дальше отряд встанет на привал и отдохнёт 8 часов — силы вернутся\./u)
  // Выживший на нуле сначала приходит в себя: политика добавляет 4 часа.
  const wounded = { ...party, players: [party.players[0], { ...party.players[1], hp: 0 }] }
  assert.match(combatNarration([victory], wounded), /отдохнёт 12 часов/u)
  // Нет отдыха — нет обещания: поражение, погибший отряд, герой вне отряда.
  assert.doesNotMatch(combatNarration([{ event_type: 'EncounterEnded', payload: { reason: 'party_defeated', outcome: 'party_defeated' } }], party), /отдохн/u)
  const fallen = { ...party, mechanics: { death: { heroes: { hero: { status: 'dead' }, ally: { status: 'dead' } } } } }
  assert.doesNotMatch(combatNarration([victory], fallen), /отдохн/u)
  assert.doesNotMatch(combatNarration([victory], { ...party, partyMemberIds: [] }), /отдохн/u)
})

test('отдых после победы — одна строка за отряд с длительностью — MC-03', () => {
  const text = combatNarration([
    event('RestStarted', { kind: 'long' }, ['hero']),
    { ...event('RestStarted', { kind: 'long' }, ['ally']), actor_id: 'ally' },
    event('RestCompleted', { kind: 'long', duration_minutes: 480 }, ['hero']),
    { ...event('RestCompleted', { kind: 'long', duration_minutes: 480 }, ['ally']), actor_id: 'ally' },
    { event_type: 'DowntimeResolved', actor_id: null, target_ids: ['ally', 'hero'], payload: {
      kind: 'long_rest', duration_minutes: 480, participant_ids: ['ally', 'hero'], reason: 'post_encounter_recovery',
    } },
  ], party)
  // Одна строка за отряд: без «завершает отдых» по каждому герою.
  assert.match(text, /^[^.]*(?:отдыхает 8 часов|Привал на 8 часов)[^.]*\.$/u)
  assert.doesNotMatch(text, /Лира|Бор/u)
  assert.equal(hasCombatNarrationEvent([event('DowntimeResolved')]), true)
  // После поражения без смертей — не «после победы» (прогон Асстохана, 2026-10-06).
  const defeat = combatNarration([
    { event_type: 'DowntimeResolved', actor_id: null, target_ids: ['ally', 'hero'], payload: {
      kind: 'long_rest', duration_minutes: 720, participant_ids: ['ally', 'hero'], reason: 'post_defeat_recovery',
    } },
  ], party)
  assert.equal(defeat, 'Отряд приходит в себя после поражения: противники ушли, герои отдыхают 12 часов и восстанавливают силы.')
})

test('награда встречи называет вещи, монеты и опыт только из события — MC-05', () => {
  // Плейтест 2026-10-04, MC-05: после победы над волком в инвентаре появились
  // короткий лук и стрелы, а откуда — нигде не говорилось.
  const text = combatNarration([{ event_type: 'EncounterRewardsDistributed', actor_id: null, target_ids: ['hero', 'ally'], payload: {
    allocations: [
      { recipient_id: 'hero', xp: 25, coins_cp: 105, items: [{ id: 'loot-1', name: 'Короткий лук', quantity: 1 }, { id: 'loot-2', name: 'Стрелы, 20 штук', quantity: 1 }] },
      { recipient_id: 'ally', xp: 25, coins_cp: 104, items: [{ id: 'loot-3', name: 'Кинжал', quantity: 1 }, { id: 'loot-4', name: 'Кинжал', quantity: 1 }] },
    ],
    unassigned: { xp: 0, coins_cp: 0, items: [] },
  } }], party)
  assert.match(text, /[Дд]оля отряда за победу: Лира забирает «Короткий лук» и «Стрелы, 20 штук»; Бор — «Кинжал» \(2 шт\.\); монеты поровну — 2 зм 9 мм; опыт поровну — 50\.$/u)
  assert.equal(hasCombatNarrationEvent([event('EncounterRewardsDistributed')]), true)
  // Пустая доля строки не даёт: «награда» без содержимого — шум.
  assert.equal(combatNarration([{ event_type: 'EncounterRewardsDistributed', payload: { allocations: [{ recipient_id: 'hero', xp: 0, coins_cp: 0, items: [] }] } }], party), '')
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
  assert.match(text, /Раунд 4[:.] (?:Теперь )?ходит Лира\./u)
  const alive = combatNarration(wolfTurn, state)
  assert.match(alive, /Волк (?:завершает ход|заканчивает ход|передаёт ход дальше)/u)
})

// --- Голос боя без модели (плейтест 2026-10-10, поток D) -------------------
//
// Бой читался журналом: один шаблон на событие. Реплики теперь выбираются из
// вариантов по идентификатору события — повтор и replay дают ту же строку, а
// соседние удары звучат по-разному.

const battle = {
  players: [
    { id: 'mirel', character: 'Мирель', hp: 0, maxHp: 20 },
    { id: 'borin', character: 'Борин', hp: 30, maxHp: 30 },
  ],
  enemies: [
    { id: 'ogre', name: 'Огр', hp: 52, maxHp: 59 },
    { id: 'wolf', name: 'Лютый волк', hp: 10, maxHp: 37 },
  ],
  actors: [],
}

const withId = (id, type, actor, targets, payload) => ({ event_id: id, command_id: id.split(':')[0], event_type: type, actor_id: actor, target_ids: targets, payload })

function heroHit(seed) {
  return [
    withId(`${seed}:1`, 'AttackResolved', 'borin', ['wolf'], { target_id: 'wolf', total: 19, armor_class: 14, hit: true, attack_kind: 'melee', item_name: 'Боевой топор', damage_type: 'slashing' }),
    withId(`${seed}:2`, 'DamageApplied', 'borin', ['wolf'], { target_id: 'wolf', applied_amount: 9, hp_before: 19, hp_after: 10 }),
  ]
}

test('реплика удара детерминирована по идентификатору события и меняется от события к событию', () => {
  const first = combatNarration(heroHit('cmd-a'), battle)
  assert.equal(combatNarration(heroHit('cmd-a'), battle), first, 'повтор того же события — та же строка')
  const variants = new Set(Array.from({ length: 24 }, (_, index) => combatNarration(heroHit(`cmd-${index}`), battle)))
  assert.ok(variants.size >= 3, `формулировок слишком мало: ${[...variants].join(' | ')}`)
  for (const line of variants) {
    // Урон удара в той же строке, оружие и цель названы, ровно одно предложение.
    assert.match(line, /^Борин [^.]*Лютого волка[^.]*9 урона\.$/u, line)
  }
  assert.ok([...variants].some((line) => /боевым топором/u.test(line)), 'оружие называется творительным падежом')
})

test('числа противника не уходят в реплику ни в одном варианте', () => {
  for (let index = 0; index < 40; index += 1) {
    const text = combatNarration([
      withId(`leak-${index}:1`, 'AttackResolved', 'borin', ['ogre'], { target_id: 'ogre', total: 23, armor_class: 17, hit: index % 3 !== 0, critical: index % 7 === 0, attack_kind: index % 2 ? 'ranged' : 'melee', item_name: index % 2 ? 'Длинный лук' : 'Длинный меч', damage_type: 'piercing' }),
      withId(`leak-${index}:2`, 'DamageApplied', 'borin', ['ogre'], { target_id: 'ogre', applied_amount: 6, hp_before: 58, hp_after: 52 }),
      withId(`leak-${index}:3`, 'ConcentrationSavingThrowResolved', 'borin', ['ogre'], { target_id: 'ogre', kept: 9, modifier: 4, total: 13, difficulty: 11, saved: true }),
    ], battle)
    assert.doesNotMatch(text, /\b(?:17|23|58|52|13|11)\b|КД|ОЗ/u, text)
  }
})

test('на нуле герой бросает спасброски от смерти, а чудовище просто выбывает', () => {
  for (let index = 0; index < 12; index += 1) {
    const hero = combatNarration([withId(`down-${index}:1`, 'HitPointsReducedToZero', 'ogre', ['mirel'], { condition: 'unconscious' })], battle)
    assert.match(hero, /^Мирель [^.]*сознани[^]*спасброски от смерти\.$/u, hero)
    const monster = combatNarration([withId(`down-${index}:2`, 'HitPointsReducedToZero', 'borin', ['ogre'], { condition: 'unconscious' })], battle)
    // Плейтест 2026-10-10: огр «начинал делать спасброски от смерти».
    assert.match(monster, /^Огр /u, monster)
    assert.doesNotMatch(monster, /спасброс|погиб|умер|мёртв/u, monster)
  }
})

test('стабилизация и подъём героя звучат без рода', () => {
  for (let index = 0; index < 8; index += 1) {
    const text = combatNarration([
      withId(`stab-${index}:1`, 'HeroStabilized', 'borin', ['mirel'], {}),
      withId(`stab-${index}:2`, 'StableRecoveryScheduled', 'borin', ['mirel'], { recovery_hours: 2 }),
    ], battle)
    assert.match(text, /Мирель/u)
    assert.match(text, /[Кк]ровь остановлена/u)
    assert.match(text, /через 2 часа/u)
    assert.doesNotMatch(text, /стабилизирован|стабилен|упал|упала/u, text)
  }
})

test('атака по возможности — одна строка «вдогонку» с уроном, затем падение героя', () => {
  const text = combatNarration([
    withId('oa:1', 'CombatActionUsed', 'ogre', ['mirel'], { action_id: 'opportunity-attack', name: 'Атака по возможности', action_type: 'reaction', target_id: 'mirel' }),
    withId('oa:2', 'AttackResolved', 'ogre', ['mirel'], { target_id: 'mirel', total: 17, armor_class: 13, hit: true, attack_kind: 'melee', action_name: 'Палица', damage_type: 'bludgeoning', reaction_attack: true }),
    withId('oa:3', 'DamageApplied', 'ogre', ['mirel'], { target_id: 'mirel', applied_amount: 13, hp_before: 9, hp_after: 0 }),
    withId('oa:4', 'HitPointsReducedToZero', 'ogre', ['mirel'], { condition: 'unconscious' }),
  ], battle)
  assert.doesNotMatch(text, /использует реакцию/u, 'строка реакции слита с ударом')
  assert.match(text, /Огр [^.]*: 17 против КД 13 — попадание, 13 урона; ОЗ 9 → 0\./u, 'свои числа отряд видит, как и раньше')
  assert.match(text, /вдогонку|Отступая|на отходе/u)
  assert.ok(text.indexOf('13 урона') < text.indexOf('сознани'), text)
})

test('публичная тактика существа окрашивает его перемещение и первую атаку', () => {
  const events = [
    withId('pack:1', 'ActorMoved', 'wolf', ['wolf'], { distance: 30 }),
    withId('pack:2', 'AttackResolved', 'wolf', ['borin'], { target_id: 'borin', total: 15, armor_class: 16, hit: false, attack_kind: 'melee', action_name: 'Укус', damage_type: 'piercing' }),
  ]
  const closing = combatNarration(events, battle, { npcTurns: [{ actor_id: 'wolf', tactic: 'сокращает дистанцию' }] })
  assert.match(closing, /Лютый волк (?:сокращает дистанцию|рвётся вперёд)/u, closing)
  const pack = combatNarration(events, battle, { npcTurns: [{ actor_id: 'wolf', tactic: 'тактика стаи' }] })
  assert.match(pack, /Пользуясь поддержкой стаи, Лютый волк (?:кусает|вцепляется зубами в) Борина/u, pack)
  assert.match(pack, /15 против КД 16 — промах/u)
})

test('вступление столкновения опирается на обстановку и состав', () => {
  const created = withId('enc:1', 'EncounterCreated', null, [], { encounter: { theme: 'undead', enemies: [{ name: 'Скелет 1' }, { name: 'Скелет 2' }, { name: 'Зомби' }] } })
  const cave = combatNarration([created], { ...battle, scene: { theme: 'cave' } })
  assert.match(cave, /^(?:Из темноты выходят|В глубине прохода шевелятся тени — это|Из мрака показываются) Скелет 1, Скелет 2 и Зомби\.$/u, cave)
  assert.doesNotMatch(cave, /На поле появляются/u)
  const forest = combatNarration([{ ...created, payload: { encounter: { enemies: [{ name: 'Огр' }] } } }], { ...battle, scene: { theme: 'forest' } })
  assert.match(forest, /(?:Из-за деревьев выходит|навстречу выходит) Огр\./u, forest)
})

test('двенадцать часов отдыха — одна строка о времени суток, последняя', () => {
  const text = combatNarration([
    withId('rest:1', 'TimeOfDayChanged', null, [], { phase_before: 'evening', phase_after: 'night' }),
    withId('rest:2', 'TimeOfDayChanged', null, [], { phase_before: 'night', phase_after: 'morning' }),
  ], battle)
  assert.equal(text, 'Светает: над отрядом занимается утро.')
})

test('находка в бочке звучит сценой, а вне боя строку говорит рассказчик', () => {
  const scene = { ...battle, scene: { map: { props: [{ id: 'prop-barrel', assetId: 'barrel' }] } } }
  const events = [
    withId('loot:1', 'SceneObjectOperated', 'borin', [], { prop_id: 'prop-barrel', kind: 'container', intent: 'open' }),
    withId('loot:2', 'SceneObjectStateChanged', 'borin', [], { prop_id: 'prop-barrel', state: 'open', success: true, intent: 'open' }),
    withId('loot:3', 'SceneObjectLootRevealed', 'borin', [], { prop_id: 'prop-barrel', loot: [{ name: 'Боевой посох' }] }),
  ]
  assert.equal(combatNarration(events, scene), 'Под крышкой бочки — боевой посох.')
  assert.deepEqual(combatJournalVoice(events, scene), { speaker: 'narrator', author: 'Рассказчик' })
  assert.deepEqual(combatJournalVoice(events, { ...scene, mechanics: { combat: { active: true } } }), { speaker: 'system', author: 'Система боя' })
  assert.deepEqual(combatJournalVoice(heroHit('voice'), battle), { speaker: 'system', author: 'Система боя' })
  // Предмет без русского имени остаётся прежней строкой, а не пустотой.
  assert.match(combatNarration(events.slice(0, 2), { ...battle, scene: { map: { props: [] } } }), /Объект открыт/u)
})

test('надёжный винительный для имён бестиария и именительный для остальных', () => {
  assert.equal(confidentAccusative('Лютый волк'), 'Лютого волка')
  assert.equal(confidentAccusative('Гигантская крыса 2'), 'Гигантскую крысу 2')
  assert.equal(confidentAccusative('Бурый медведь'), 'Бурого медведя')
  assert.equal(confidentAccusative('Чёрная слизь'), 'Чёрную слизь')
  assert.equal(confidentAccusative('Скелет минотавра'), 'Скелета минотавра')
  assert.equal(confidentAccusative('Зомби'), 'Зомби')
  for (const name of ['Мирель', 'Брам Тихий Молот', 'Торн «Без Весла»', 'Суккуб / Инкуб']) assert.equal(confidentAccusative(name), null, name)
  // Цель без надёжного склонения стоит в именительном: «цель — Мирель».
  const text = combatNarration([withId('nom:1', 'AttackResolved', 'ogre', ['mirel'], { target_id: 'mirel', total: 9, armor_class: 13, hit: false, attack_kind: 'melee' })], battle)
  assert.match(text, /цель — Мирель: 9 против КД 13 — промах\./u, text)
})
