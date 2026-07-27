// Раскрытие характеристик врага: команда → правило → серверный бросок →
// событие → reducer → проекция.
//
// До 2026-07-27 реестр `enemy_knowledge` только читался: проекция умела
// показывать точные значения после факта раскрытия, а записывать этот факт было
// нечему. Продуктовые принципы обещают обе половины — «скрыто по умолчанию» и
// «появляется после отдельного серверного факта раскрытия»; здесь появляется
// вторая.
//
// Правила заданы владельцем 2026-07-27: действие на проверку знаний, навык по
// виду существа, СЛ из уровня опасности серверной таблицей, успех открывает
// точные ОЗ и КД всему отряду до конца кампании.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RulesEngine, RulesValidationError, applyGameEvent, enemyLoreCheckFor, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }

const SECRET_MAX_HP = 37
const SECRET_ARMOR = 19

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function campaign({ inCombat = true } = {}) {
  return normalizeCampaignState({
    sessionCode: 'IDENTIFY',
    campaign_id: 'IDENTIFY',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'wizard', level: 3, proficiency: 2,
      hp: 24, maxHp: 24, armor: 12, speed: 30,
      abilities: { str: 10, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
      classSkillProficiencies: ['arcana', 'religion'],
      x: 1, y: 1, inventory: [],
    }],
    enemies: [
      {
        id: 'wolf', name: 'Волк', hp: 20, maxHp: SECRET_MAX_HP, armor: SECRET_ARMOR, speed: 45,
        creature_type: 'beast', provenance: { challenge_rating: '1/4' },
        abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 3, y: 1, alive: true,
      },
      {
        id: 'golem', name: 'Голем', hp: 40, maxHp: 40, armor: 17, speed: 30,
        creature_type: 'construct', provenance: { challenge_rating: '3' },
        abilities: { str: 18, dex: 9, con: 18, int: 3, wis: 8, cha: 1 }, x: 5, y: 1, alive: true,
      },
    ],
    scene: { turn: 1, location: 'Склеп', title: 'Склеп', cells: cells() },
    mechanics: {
      combat: inCombat
        ? {
          active: true, round: 1, active_index: 0,
          initiative: [{ actor_id: 'hero', total: 21 }, { actor_id: 'wolf', total: 11 }],
          action_economy: {
            hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
            wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          },
        }
        : { active: false, round: 0, initiative: [], active_index: -1, action_economy: {} },
    },
  })
}

function engineWith(rolls) {
  let id = 0
  return new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng(rolls), idFactory: () => `identify-${++id}`, now: () => '2026-07-27T00:00:00.000Z',
    }),
  })
}

function identify(state, { rolls = [18], actorId = 'hero', targetId = 'wolf' } = {}) {
  return engineWith(rolls).resolvePlan(
    { commands: [{ command_type: 'IdentifyEnemy', actor_id: actorId, target_id: targetId }] },
    state,
    { isAdmin: true, serverAuthoritativeCombat: true },
  )
}

const enemyFor = (state, id) => campaignStateForViewer(state, user, 'hero').enemies.find((enemy) => enemy.id === id)

test('навык и СЛ выбирает серверная таблица по виду существа и уровню опасности', () => {
  assert.deepEqual(enemyLoreCheckFor({ creature_type: 'beast', provenance: { challenge_rating: '1/4' } }), {
    skill: 'nature', difficulty_category: 'easy', difficulty: 10, challenge_rating: 0.25,
  })
  assert.deepEqual(enemyLoreCheckFor({ creature_type: 'construct', provenance: { challenge_rating: '3' } }), {
    skill: 'arcana', difficulty_category: 'medium', difficulty: 15, challenge_rating: 3,
  })
  assert.deepEqual(enemyLoreCheckFor({ creature_type: 'undead', provenance: { challenge_rating: '21' } }), {
    skill: 'religion', difficulty_category: 'hard', difficulty: 20, challenge_rating: 21,
  })
  // Существо без данных не должно ломать ход: слабый противник и общий навык.
  assert.deepEqual(enemyLoreCheckFor({}), {
    skill: 'arcana', difficulty_category: 'easy', difficulty: 10, challenge_rating: 0,
  })
})

test('успешное опознание открывает отряду точные ОЗ и КД именно этого врага', () => {
  const result = identify(campaign())
  const types = result.events.map((event) => event.event_type)
  assert.deepEqual(types, ['CombatActionUsed', 'AbilityCheckResolved', 'EnemyKnowledgeRevealed'])

  const reveal = result.events[2].payload
  assert.equal(reveal.enemy_id, 'wolf')
  assert.equal(reveal.scope, 'party')
  assert.deepEqual(reveal.facts, { health: 'exact', armor_class: 'exact' })
  assert.deepEqual(result.state.mechanics.enemy_knowledge, {
    party: { wolf: { health: 'exact', armor_class: 'exact' } },
  })

  const wolf = enemyFor(result.state, 'wolf')
  assert.equal(wolf.healthKnown, 'exact')
  assert.equal(wolf.maxHp, SECRET_MAX_HP)
  assert.equal(wolf.armor, SECRET_ARMOR)

  // Опознан один враг, а не все сразу.
  const golem = enemyFor(result.state, 'golem')
  assert.equal(golem.healthKnown, 'banded')
  assert.equal(golem.maxHp, undefined)
  assert.equal(golem.armor, undefined)
})

test('бросок делает сервер: навык, характеристика и модификатор берутся с листа', () => {
  // Волшебнику `nature` по классу не полагается, поэтому владения нет: +4 от
  // Интеллекта и ничего сверх.
  const wolf = identify(campaign()).events.find((event) => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(wolf.skill, 'nature')
  assert.equal(wolf.ability, 'int')
  assert.equal(wolf.modifier, 4)
  assert.equal(wolf.difficulty, 10)

  // `arcana` класс даёт, и владение прибавляется.
  const golem = identify(campaign(), { targetId: 'golem' }).events.find((event) => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(golem.skill, 'arcana')
  assert.equal(golem.modifier, 6)
  assert.equal(golem.difficulty, 15)
})

test('провал тратит действие, но ничего не раскрывает', () => {
  const result = identify(campaign(), { rolls: [2] })
  assert.deepEqual(result.events.map((event) => event.event_type), ['CombatActionUsed', 'AbilityCheckResolved'])
  assert.deepEqual(result.state.mechanics.enemy_knowledge, { party: {} })
  assert.equal(result.state.mechanics.combat.action_economy.hero.action, false)
  assert.equal(enemyFor(result.state, 'wolf').healthKnown, 'banded')
})

test('вне боя опознание не тратит экономию хода, которой нет', () => {
  const result = identify(campaign({ inCombat: false }), { targetId: 'golem' })
  assert.deepEqual(result.events.map((event) => event.event_type), ['AbilityCheckResolved', 'EnemyKnowledgeRevealed'])
  assert.equal(enemyFor(result.state, 'golem').healthKnown, 'exact')
})

test('опознание отвергается без права, без цели и без действия', () => {
  const forbidden = (state, options, code) => assert.throws(
    () => identify(state, options),
    (error) => error instanceof RulesValidationError && error.code === code,
    `ожидался отказ ${code}`,
  )

  forbidden(campaign(), { targetId: 'hero' }, 'INVALID_TARGET')
  forbidden(campaign(), { targetId: 'дракон' }, 'TARGET_NOT_FOUND')

  const dead = campaign()
  dead.enemies[0] = { ...dead.enemies[0], hp: 0, alive: false }
  forbidden(dead, {}, 'INVALID_TARGET')

  const spent = campaign()
  spent.mechanics.combat.action_economy.hero = { ...spent.mechanics.combat.action_economy.hero, action: false }
  forbidden(spent, {}, 'ACTION_SPENT')

  // Противник опознавать не может — это действие отряда.
  const enemyTurn = campaign()
  enemyTurn.mechanics.combat.active_index = 1
  enemyTurn.mechanics.combat.action_economy.wolf = { ...enemyTurn.mechanics.combat.action_economy.wolf, action: true }
  forbidden(enemyTurn, { actorId: 'wolf', targetId: 'golem' }, 'ACTOR_FORBIDDEN')
})

test('уже опознанного врага нельзя опознать второй раз', () => {
  const first = identify(campaign())
  // Ход обновился, действие снова доступно — отказ обязан прийти по знанию,
  // а не по экономии хода.
  const next = normalizeCampaignState({
    ...first.state,
    mechanics: {
      ...first.state.mechanics,
      combat: {
        ...first.state.mechanics.combat,
        action_economy: {
          ...first.state.mechanics.combat.action_economy,
          hero: { ...first.state.mechanics.combat.action_economy.hero, action: true },
        },
      },
    },
  })
  assert.throws(
    () => identify(next),
    (error) => error instanceof RulesValidationError && error.code === 'ENEMY_ALREADY_IDENTIFIED',
  )
})

test('replay событий даёт тот же реестр, а повтор события ничего не удваивает', () => {
  const result = identify(campaign())
  let replayed = campaign()
  for (const event of result.events) replayed = applyGameEvent(replayed, event)
  assert.deepEqual(replayed.mechanics.enemy_knowledge, result.state.mechanics.enemy_knowledge)

  const reveal = result.events.find((event) => event.event_type === 'EnemyKnowledgeRevealed')
  const twice = applyGameEvent(replayed, reveal)
  assert.deepEqual(twice.mechanics.enemy_knowledge, result.state.mechanics.enemy_knowledge)
})

test('реестр переживает нормализацию и не принимает выдуманных фактов', () => {
  const state = normalizeCampaignState({
    ...campaign(),
    mechanics: {
      ...campaign().mechanics,
      enemy_knowledge: {
        party: {
          wolf: { health: 'exact', armor_class: true, weakness: 'exact', speed: 'приблизительно' },
          '': { health: 'exact' },
          golem: { nonsense: 'exact' },
        },
      },
    },
  })
  assert.deepEqual(state.mechanics.enemy_knowledge, {
    party: { wolf: { health: 'exact', armor_class: 'exact' } },
  })
})
