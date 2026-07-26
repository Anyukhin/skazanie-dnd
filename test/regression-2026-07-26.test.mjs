// Сторожа для дефектов, найденных прогоном кампании 2026-07-26.
// Каждый тест воспроизводит конкретный сбой из отчёта, а не «похожий случай».
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHARACTER_IMPORT_SCHEMA,
  CHARACTER_IMPORT_SCHEMA_VERSION,
  characterCreationCatalog,
  parseCharacterImport,
} from '../server/character-lifecycle.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { actorNameResolver, attackForecast, eventSummary, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'

function rogueDocument(classSkillProficiencies, characterClass = 'rogue') {
  const baseScores = { str: 12, dex: 15, con: 13, int: 14, wis: 10, cha: 8 }
  return {
    schema: CHARACTER_IMPORT_SCHEMA,
    schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
    character: {
      character: 'Сурья', characterClass, level: 1, experience: 0,
      species: 'Человек',
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      classSkillProficiencies,
      selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: [],
    },
  }
}

test('навык с подчёркиванием в идентификаторе импортируется, а не роняет лист', () => {
  // `cleanIdentifier` требовал [a-z0-9-], а каталог отдаёт snake_case: плут,
  // взявший «Ловкость рук», получал 400 INVALID_IDENTIFIER.
  const result = parseCharacterImport(rogueDocument(['stealth', 'sleight_of_hand', 'perception', 'deception']))
  assert.deepEqual(
    [...result.patch.classSkillProficiencies].sort(),
    ['deception', 'perception', 'sleight_of_hand', 'stealth'],
  )
})

test('каталог создания персонажа не предлагает идентификаторов, которые сам же отвергает', () => {
  // Проверяем только классы без выбора особенностей и заклинаний: там отказ
  // может прийти лишь от алфавита идентификаторов, а не от других правил.
  const catalog = characterCreationCatalog()
  const simple = catalog.classes.filter((entry) => !entry.spell_selection && !(entry.feature_choice_groups ?? []).length)
  assert.ok(simple.some((entry) => (entry.class_skills?.options ?? []).some((option) => option.id.includes('_'))),
    'в выборке не осталось навыка с подчёркиванием — тест перестал стеречь исходный дефект')
  for (const entry of simple) {
    const options = entry.class_skills?.options ?? []
    const take = entry.class_skills?.choice_count ?? 0
    for (let offset = 0; offset + take <= options.length; offset += 1) {
      const ids = options.slice(offset, offset + take).map((option) => option.id)
      assert.doesNotThrow(
        () => parseCharacterImport(rogueDocument(ids, entry.id)),
        `каталог класса ${entry.id} предлагает навыки ${ids.join(', ')}, которые импорт не принимает`,
      )
    }
  }
})

test('осмотр не подменяется проверкой Силы из-за подстроки в другом слове', async () => {
  const parser = new IntentParser()
  const examine = await parser.parse({
    message: 'Осматриваю пятно на дне и сломанные вёсла — ищу следы.',
    playerId: 'hero-slot-1',
    visibleState: {},
  })
  assert.equal(examine.intent, 'ability_check')
  assert.equal(examine.approach, 'perception', 'сломанные → лома → Сила')

  const walk = await parser.parse({ message: 'Долго иду вдоль причала', playerId: 'hero-slot-1', visibleState: {} })
  assert.notEqual(walk.intent, 'rest', 'долго → долг → отдых')

  const shove = await parser.parse({ message: 'Ломаю дверь плечом', playerId: 'hero-slot-1', visibleState: {} })
  assert.equal(shove.approach, 'strength', 'настоящий силовой глагол должен остаться Силой')
})

test('сводка события называет участников по именам, а не по внутренним id', () => {
  const state = {
    players: [{ id: 'hero-slot-4', character: 'Мара Огонёк' }],
    enemies: [{ id: 'encounter-abc-bugbear-1', name: 'Багбир 1' }],
  }
  const resolve = actorNameResolver(state)
  assert.equal(eventSummary({ event_type: 'TurnEnded', actor_id: 'hero-slot-4' }, resolve), 'Мара Огонёк завершает ход')
  assert.equal(
    eventSummary({ event_type: 'TurnStarted', target_ids: ['encounter-abc-bugbear-1'], payload: { round: 1 } }, resolve),
    'Начинается ход Багбир 1, раунд 1',
  )
  assert.equal(
    eventSummary({ event_type: 'CharacterImported', payload: { character: { character: 'Иллеан' } } }, resolve),
    'Иллеан присоединяется к отряду',
  )
})

test('стартовое снаряжение даёт доспех тем классам, которые его носят', () => {
  const cleric = withStarterKit({ id: 'hero-slot-4', characterClass: 'cleric', role: 'Жрец · ур. 1' })
  const catalogIds = cleric.inventory.map((item) => item.catalog_id)
  assert.ok(catalogIds.includes('srd_5_2_1:leather-armor'), 'жрец выходил в бой без доспеха')
  assert.ok(catalogIds.includes('srd_5_2_1:shield'))

  const wizard = withStarterKit({ id: 'hero-slot-1', characterClass: 'wizard', role: 'Волшебник · ур. 1' })
  assert.deepEqual(wizard.inventory.map((item) => item.catalog_id), ['srd_5_2_1:dagger'], 'волшебник доспехом не владеет')

  const imported = withStarterKit({
    id: 'hero-slot-2', characterClass: 'fighter',
    inventory: [{ catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч' }],
  })
  assert.equal(imported.inventory.length, 1, 'готовый лист не дополняется снаряжением')
})

function meleeFixture(overrides = {}) {
  const cells = Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  return normalizeCampaignState({
    players: [{
      id: 'hero', hp: 12, maxHp: 12, armor: 14, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 }, x: 0, y: 0,
      inventory: [{
        id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
        combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
      }],
    }],
    enemies: [{ id: 'goblin', hp: 10, maxHp: 10, armor: 13, alive: true, x: 1, y: 0 }],
    scene: { cells, turn: 1 },
    mechanics: {
      combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { hero: { action: true } } },
      ...overrides.mechanics,
    },
  })
}

test('прогноз попадания считает тем же кодом, что и настоящий бросок', () => {
  const state = meleeFixture()
  const forecast = attackForecast(state, 'hero', 'goblin', { itemId: 'sword' })
  assert.equal(forecast.attack_modifier, 5, 'СИЛ +3 и мастерство +2')
  assert.equal(forecast.armor_class, 13)
  assert.equal(forecast.hit_chance, 65, 'попадание с 8 и выше — 13 исходов из 20')
  assert.equal(forecast.critical_chance, 5)
  assert.equal(forecast.advantage, false)
  assert.equal(forecast.disadvantage, false)

  // Настоящая атака ровно на пороге прогноза обязана попасть, на единицу ниже — промахнуться.
  const hit = resolveCommand(
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'sword', server_authoritative: true },
    state, { diceService: new DiceService({ rng: new SequenceDiceRng([8, 4]) }), context: { serverAuthoritativeCombat: true } },
  ).events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(hit.payload.modifier, forecast.attack_modifier)
  assert.equal(hit.payload.armor_class, forecast.armor_class)
  assert.equal(hit.payload.hit, true)

  const miss = resolveCommand(
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'sword', server_authoritative: true },
    state, { diceService: new DiceService({ rng: new SequenceDiceRng([7, 4]) }), context: { serverAuthoritativeCombat: true } },
  ).events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(miss.payload.hit, false)
})

test('прогноз объясняет преимущество и помеху и считает их вероятность', () => {
  const advantaged = meleeFixture({ mechanics: { conditions: { goblin: [{ id: 'faerie-fire' }] } } })
  const withAdvantage = attackForecast(advantaged, 'hero', 'goblin', { itemId: 'sword' })
  assert.equal(withAdvantage.advantage, true)
  assert.ok(withAdvantage.advantage_sources.includes('огонь фей'))
  assert.equal(withAdvantage.hit_chance, 88, '1 - 0.35^2')

  const hindered = meleeFixture({ mechanics: { conditions: { goblin: [{ id: 'dodging' }] } } })
  const withDisadvantage = attackForecast(hindered, 'hero', 'goblin', { itemId: 'sword' })
  assert.equal(withDisadvantage.disadvantage, true)
  assert.ok(withDisadvantage.disadvantage_sources.includes('цель уклоняется'))
  assert.equal(withDisadvantage.hit_chance, 42, '0.65^2')

  const both = meleeFixture({ mechanics: { conditions: { goblin: [{ id: 'faerie-fire' }, { id: 'dodging' }] } } })
  const cancelled = attackForecast(both, 'hero', 'goblin', { itemId: 'sword' })
  assert.equal(cancelled.hit_chance, 65, 'преимущество и помеха гасят друг друга')
})

test('цель вне досягаемости даёт «не достать», а не выдуманную помеху', () => {
  const cells = Array.from({ length: 6 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    players: [{
      id: 'hero', hp: 12, maxHp: 12, armor: 14, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 }, x: 0, y: 0,
      inventory: [{
        id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
        combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
      }],
    }],
    enemies: [{ id: 'goblin', hp: 10, maxHp: 10, armor: 13, alive: true, x: 3, y: 0 }],
    scene: { cells, turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { hero: { action: true } } } },
  })
  const forecast = attackForecast(state, 'hero', 'goblin', { itemId: 'sword' })
  assert.equal(forecast.in_range, false)
  assert.equal(forecast.hit_chance, null, 'процент для недостижимой цели вводит в заблуждение')
  assert.deepEqual(forecast.disadvantage_sources, [], 'ближнее оружие за пределом досягаемости — это не «дальний диапазон»')
  assert.match(forecast.unreachable_reason, /подойти/)

  // Движок обязан отвергнуть тот же удар — прогноз и правило говорят одно и то же.
  assert.throws(
    () => resolveCommand(
      { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'sword', server_authoritative: true },
      state, { diceService: new DiceService({ rng: new SequenceDiceRng([15, 4]) }), context: { serverAuthoritativeCombat: true } },
    ),
    (error) => error.code === 'TARGET_OUT_OF_RANGE',
  )
})
