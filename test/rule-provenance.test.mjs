// Ось «честность механики»: «Каждое механическое решение ссылается на
// `rule_id`, `house_rule_id` или `ruling_id`. Ссылочная целостность —
// docs/rules-coverage.md».
//
// Провенанс проверяется точечно во многих тестах — по одному правилу за раз, в
// тесте про это правило. Сквозного сторожа не было ни одного, а нужны обе
// половины сразу:
//
//   1. ссылки движка обязаны существовать в rule pack;
//   2. события настоящего боя обязаны эти ссылки нести.
//
// Первая половина ловит переименование в `data/`, вторая — новый обработчик,
// который забыл сослаться на правило.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RULE_IDS, RulesEngine, normalizeCampaignState } from '../server/rules-engine.mjs'
import { loadRulePack } from '../server/rule-pack.mjs'

const RULESET_ID = 'srd_5_2_1'

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'PROVENANCE',
    campaign_id: 'PROVENANCE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'cleric', level: 3, proficiency: 2,
      hp: 24, maxHp: 24, armor: 12, speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 16, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 1, y: 1,
      preparedSpellIds: ['sacred-flame'], inventory: [],
    }],
    enemies: [{
      id: 'wolf', name: 'Волк', hp: 20, maxHp: 20, armor: 11, speed: 40, attackBonus: 4,
      damageDice: 4, damageBonus: 1,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, location: 'Тракт', title: 'Тракт', cells: cells() },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 21 }, { actor_id: 'wolf', total: 11 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

/** Перемещение, атака, круг ходов, заклинание со спасброском, состояние, время. */
function mechanicalEvents() {
  let id = 0
  const engine = new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng(Array.from({ length: 300 }, (_, index) => index % 3 === 0 ? 18 : 4)),
      idFactory: () => `provenance-${++id}`,
      now: () => '2026-07-27T00:00:00.000Z',
    }),
  })
  const plans = [
    [{ command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 0 }, server_authoritative: true }],
    [{ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true }],
    [{ command_type: 'EndTurn', actor_id: 'hero', server_authoritative: true },
      { command_type: 'EndTurn', actor_id: 'wolf', server_authoritative: true }],
    [{ command_type: 'CastSpell', actor_id: 'hero', target_id: 'wolf', spell_id: 'sacred-flame', server_authoritative: true }],
    [{ command_type: 'AddCondition', actor_id: 'hero', target_id: 'wolf', condition: 'prone' }],
    [{ command_type: 'AdvanceTime', amount: 30, unit: 'minute' }],
  ]
  let state = campaign()
  const events = []
  for (const commands of plans) {
    const result = engine.resolvePlan({ commands }, state, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })
    events.push(...result.events)
    state = result.state
  }
  return events
}

/** Любая из трёх ссылок годится: решение обязано быть на что-то опёрто. */
function provenanceOf(event) {
  return [
    ...ruleIdsOf(event),
    ...(event.house_rule_id ? [String(event.house_rule_id)] : []),
    ...(event.ruling_id ? [String(event.ruling_id)] : []),
  ].filter(Boolean)
}

/**
 * В паке ищутся только `source_rule_ids`. Домашние правила и разовые ruling —
 * другое пространство имён: они по определению не из закреплённой редакции, и
 * искать их среди её правил было бы ошибкой самой проверки.
 */
function ruleIdsOf(event) {
  return (Array.isArray(event.source_rule_ids) ? event.source_rule_ids : []).map(String).filter(Boolean)
}

test('каждая ссылка движка на правило существует в rule pack', async () => {
  const pack = await loadRulePack(RULESET_ID)
  const packIds = new Set(pack.rules.map((rule) => String(rule.id)))
  assert.ok(packIds.size > 0, 'rule pack не загрузился — проверять нечего')

  const referenced = [...new Set(Object.values(RULE_IDS))].sort()
  assert.ok(referenced.length >= 20, 'таблица ссылок подозрительно мала')
  assert.deepEqual(referenced.filter((id) => !packIds.has(id)), [], 'движок ссылается на правило, которого нет в паке')
})

test('каждое событие боя несёт провенанс, и этот провенанс разрешается в паке', async () => {
  const pack = await loadRulePack(RULESET_ID)
  const packIds = new Set(pack.rules.map((rule) => String(rule.id)))
  const events = mechanicalEvents()

  // Без этого проверка зеленела бы на пустом или вырожденном потоке.
  const types = new Set(events.map((event) => event.event_type))
  assert.ok(events.length >= 12, `поток слишком короткий: ${events.length}`)
  for (const expected of ['ActorMoved', 'AttackResolved', 'DamageApplied', 'SpellCast', 'SpellSavingThrowResolved', 'ConditionAdded', 'TurnEnded', 'TimeAdvanced']) {
    assert.ok(types.has(expected), `в потоке нет события ${expected} — проверка потеряла покрытие`)
  }

  const withoutProvenance = [...new Set(events.filter((event) => !provenanceOf(event).length).map((event) => event.event_type))]
  assert.deepEqual(withoutProvenance.sort(), [], 'событие без rule_id, house_rule_id и ruling_id')

  const unresolved = [...new Set(events.flatMap(ruleIdsOf))]
    .filter((id) => !packIds.has(id))
    .sort()
  assert.deepEqual(unresolved, [], 'событие ссылается на правило, которого нет в паке')
})
