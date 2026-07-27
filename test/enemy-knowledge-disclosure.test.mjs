// Сквозная проверка обещания продуктовых принципов: «Точные текущие/максимальные
// HP, КД, скорость, модификаторы и stat block врага скрыты от игроков по
// умолчанию. Они появляются только после отдельного серверного факта раскрытия
// в enemy_knowledge; урон или попадание сами по себе не раскрывают точные
// значения».
//
// Юнит-тесты проекции проверяют отдельные события руками. Здесь проверяется вся
// цепочка на выходе настоящего RulesEngine: команда → события → проекция
// события, бриф Рассказчика, состояние кампании и боевой журнал. Так сторож
// ловит и те поля, которые появятся в payload позже.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { RulesEngine, normalizeCampaignState } from '../server/rules-engine.mjs'
import { buildNarrationBrief } from '../server/security.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

// Числа врага подобраны так, чтобы не совпасть ни с одним числом героя, сцены
// или броска: иначе поиск по проекции даст ложное срабатывание.
const SECRET_MAX_HP = 37
const SECRET_ARMOR = 19
const SECRET_SPEED = 45
const SECRET_DEX = 18            // модификатор +4; в проекцию попадал бы только он
const SECRET_STAT_BLOCK = 'srd:probe-wolf'

const user = { role: 'player', heroIds: ['hero'] }

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function fixture() {
  return normalizeCampaignState({
    sessionCode: 'ENEMY-KNOWLEDGE',
    campaign_id: 'ENEMY-KNOWLEDGE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'cleric', level: 3, proficiency: 2,
      hp: 24, maxHp: 24, armor: 12, speed: 30,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 16, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 1, y: 1,
      preparedSpellIds: ['sacred-flame'],
    }],
    enemies: [{
      id: 'wolf', name: 'Волк', hp: SECRET_MAX_HP, maxHp: SECRET_MAX_HP,
      armor: SECRET_ARMOR, speed: SECRET_SPEED, attackBonus: 6,
      damageDice: 4, damageBonus: 1, stat_block_id: SECRET_STAT_BLOCK,
      abilities: { str: 14, dex: SECRET_DEX, con: 12, int: 4, wis: 12, cha: 6 },
      x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, cells: cells() },
    mechanics: {
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

function dice() {
  let id = 0
  return new DiceService({
    rng: { randint: (minimum, maximum) => maximum === 20 ? 9 : Math.min(maximum, 3) },
    idFactory: () => `disclosure-roll-${++id}`,
    now: () => '2026-07-27T00:00:00.000Z',
  })
}

/** Бьёт и творит заклинание со спасброском: оба пути публикуют числа врага. */
function playOneRound(state) {
  const engine = new RulesEngine({ diceService: dice() })
  const attack = engine.resolvePlan(
    { commands: [{ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true }] },
    state,
    { isAdmin: true, serverAuthoritativeCombat: true },
  )
  // Атака и заклинание — оба действие, поэтому между ними проходит круг ходов.
  const round = engine.resolvePlan(
    {
      commands: [
        { command_type: 'EndTurn', actor_id: 'hero', server_authoritative: true },
        { command_type: 'EndTurn', actor_id: 'wolf', server_authoritative: true },
      ],
    },
    attack.state,
    { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  )
  const spell = engine.resolvePlan(
    { commands: [{ command_type: 'CastSpell', actor_id: 'hero', target_id: 'wolf', spell_id: 'sacred-flame', server_authoritative: true }] },
    round.state,
    { isAdmin: true, serverAuthoritativeCombat: true },
  )
  return { state: spell.state, events: [...attack.events, ...round.events, ...spell.events] }
}

/** Числа ищутся как значения полей, а не подстрокой: «19» внутри «1919» — не находка. */
function numbersLeaked(value, needles) {
  const json = JSON.stringify(value ?? null)
  return needles.filter((needle) => new RegExp(`(?::|\\[|,)\\s*${needle}(?=\\s*[,}\\]])`).test(json))
}

test('свежая кампания не раскрывает точные значения врага ни на одной видимой поверхности', () => {
  const { state, events } = playOneRound(fixture())
  assert.equal(state.mechanics.enemy_knowledge ?? null, null, 'ни одно событие боя не записало факт раскрытия')

  const publicEvents = mechanicsForViewer(events, user, 'hero', state)
  const brief = buildNarrationBrief({
    visible_events: publicEvents,
    visible_state_changes: [],
    known_environment: {},
    permitted_npc_reactions: [],
    viewer: { playerId: 'hero', partyIds: ['hero'], isPartyMember: true },
  })
  const room = campaignStateForViewer(state, user, 'hero')

  // Лист самого героя в поиск не входит: там лежит его каталог заклинаний, и
  // радиусы вроде 20 фт дают ложные срабатывания. Врагу принадлежат только эти
  // ветви проекции.
  const enemySurfaces = {
    enemies: room.enemies, mechanics: room.mechanics, battleLog: room.battleLog, messages: room.messages,
  }
  const secrets = [SECRET_MAX_HP, SECRET_ARMOR, SECRET_SPEED]
  for (const [label, surface] of [['события', publicEvents], ['бриф Рассказчика', brief], ['состояние кампании', enemySurfaces]]) {
    assert.deepEqual(numbersLeaked(surface, secrets), [], `${label}: раскрыты числа врага`)
    assert.doesNotMatch(JSON.stringify(surface), new RegExp(SECRET_STAT_BLOCK), `${label}: раскрыт stat block врага`)
  }

  // Бросок делает враг, а инициирует герой — модификатор спасброска не его дело.
  const save = publicEvents.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.ok(save, 'спасбросок врага должен быть в ленте: игрок видит исход')
  for (const key of ['modifier', 'kept', 'dice', 'expression', 'roll_id']) {
    assert.equal(save.payload[key], undefined, `SpellSavingThrowResolved.${key} раскрывает бросок врага`)
  }
  assert.equal(typeof save.payload.saved, 'boolean')

  const enemy = room.enemies[0]
  assert.equal(enemy.healthKnown, 'banded')
  assert.equal(enemy.hp, undefined)
  assert.equal(enemy.maxHp, undefined)
  assert.equal(enemy.armor, undefined)
  assert.equal(enemy.speed, undefined)
  assert.equal(enemy.stat_block_id, undefined)
  assert.ok(['unharmed', 'wounded', 'bloodied', 'critical'].includes(enemy.healthStatus))
})

// Обратная сторона того же контракта: единственный переключатель — запись в
// enemy_knowledge. Если этот тест позеленеет сам по себе, значит проекция начала
// раскрывать значения без факта раскрытия.
test('запись в enemy_knowledge — единственное, что раскрывает значения врага', () => {
  const { state } = playOneRound(fixture())
  state.mechanics.enemy_knowledge = {
    party: { wolf: { health: 'exact', armor_class: 'exact', speed: 'exact', stat_block: 'exact' } },
  }
  const enemy = campaignStateForViewer(state, user, 'hero').enemies[0]
  assert.equal(enemy.healthKnown, 'exact')
  assert.equal(enemy.maxHp, SECRET_MAX_HP)
  assert.equal(enemy.armor, SECRET_ARMOR)
  assert.equal(enemy.speed, SECRET_SPEED)
  assert.equal(enemy.stat_block_id, SECRET_STAT_BLOCK)
})
