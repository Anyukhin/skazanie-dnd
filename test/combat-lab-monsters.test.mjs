import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { monsterCombatSpellFor, monsterSpellcastingFor } from '../server/combat-spells.mjs'
import { enemyFrom2014, monsterCatalogEntry } from '../server/combat-lab-monsters.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const record = (slug) => records.find((candidate) => candidate.id.endsWith(`:${slug}`))
const NPC_CONTEXT = Object.freeze({ isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true })

function cells(width = 12, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function hero(id = 'hero', x = 0, y = 0) {
  return {
    id,
    name: id,
    hp: 500,
    maxHp: 500,
    armor: 1,
    speed: 30,
    proficiency: 2,
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    x,
    y,
    alive: true,
  }
}

function arenaState(enemy, heroes = [hero()], { enemyFirst = false } = {}) {
  const order = enemyFirst
    ? [{ actor_id: enemy.id, total: 20 }, ...heroes.map((candidate, index) => ({ actor_id: candidate.id, total: 10 - index }))]
    : [...heroes.map((candidate, index) => ({ actor_id: candidate.id, total: 20 - index })), { actor_id: enemy.id, total: 10 }]
  return normalizeCampaignState({
    sessionCode: 'COMBAT-LAB-MONSTERS',
    campaign_id: 'COMBAT-LAB-MONSTERS',
    partyMemberIds: heroes.map((candidate) => candidate.id),
    players: heroes,
    enemies: [enemy],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: enemyFirst ? 0 : order.length - 1,
        initiative: order,
        action_economy: Object.fromEntries(order.map((entry) => [entry.actor_id, {
          action: true,
          bonus_action: true,
          reaction: true,
          movement: true,
          movement_spent: 0,
        }])),
      },
    },
  })
}

function maximumDice() {
  let id = 0
  return new DiceService({
    rng: { randint: (_minimum, maximum) => maximum },
    idFactory: () => `combat-lab-monster-${++id}`,
    now: () => '2026-09-07T00:00:00.000Z',
  })
}

function commit(state, command) {
  const result = resolveCommand({
    campaign_id: 'COMBAT-LAB-MONSTERS',
    command_id: `combat-lab:${command.command_type}:${command.action_id ?? 'none'}`,
    server_authoritative: true,
    ...command,
  }, state, { diceService: maximumDice(), context: NPC_CONTEXT })
  return result.events.reduce(applyGameEvent, state)
}

test('каталог монстров отдаёт только настройки выбора и источник 2014', () => {
  assert.deepEqual(monsterCatalogEntry(record('goblin')), {
    id: 'dnd_5e_2014:monster:goblin',
    name: 'Гоблин',
    cr: '1/4',
    hp: 7,
    sourceUrl: 'https://dnd.su/bestiary/4-goblin/',
  })
})

test('оружейные режимы сохраняют дальность, кубы и метание без выдуманного урона', () => {
  const goblin = enemyFrom2014(record('goblin'), { x: 5, y: 2 }, 0)
  const bow = goblin.action_profiles.find((profile) => profile.id === 'shortbow')
  assert.equal(bow.kind, 'ranged')
  assert.equal(bow.mode, 'ranged')
  assert.equal(bow.damage_expression, '1d6+2')
  assert.equal(bow.normal_range_feet, 80)
  assert.equal(bow.range_feet, 320)

  const guard = enemyFrom2014(record('guard'), { x: 5, y: 2 }, 0)
  const spear = guard.action_profiles.find((profile) => profile.id === 'spear')
  const thrown = guard.action_profiles.find((profile) => profile.id === 'spear:thrown')
  assert.equal(spear.kind, 'melee')
  assert.equal(spear.range_feet, 5)
  assert.equal(thrown.kind, 'ranged')
  assert.equal(thrown.mode, 'thrown')
  assert.equal(thrown.thrown, true)
  assert.equal(thrown.damage_expression, '1d6+1')
  assert.equal(thrown.range_feet, 60)

  const web = enemyFrom2014(record('giant-spider'), { x: 5, y: 2 }, 0).action_profiles.find((profile) => profile.id === 'web')
  assert.equal(web.damage_expression, undefined)
  assert.equal(web.damage_amount, 0)
  assert.equal(web.recharge, 5)
})

test('карточные защиты и эффекты укуса переходят в runtime-профиль', () => {
  const skeleton = enemyFrom2014(record('skeleton'), { x: 5, y: 2 }, 0)
  assert.deepEqual(skeleton.damage_vulnerabilities, ['bludgeoning'])
  assert.deepEqual(skeleton.damage_immunities, ['poison'])
  assert.deepEqual(skeleton.condition_immunities, ['exhaustion', 'poisoned'])

  const zombie = enemyFrom2014(record('zombie'), { x: 5, y: 2 }, 0)
  assert.ok(zombie.traits.some((trait) => trait.id === 'undead-fortitude'))

  const wolf = enemyFrom2014(record('wolf'), { x: 5, y: 2 }, 0)
  const wolfBite = wolf.action_profiles.find((profile) => profile.id === 'bite')
  assert.equal(wolfBite.on_hit.save_ability, 'str')
  assert.equal(wolfBite.on_hit.save_dc, 11)
  assert.equal(wolfBite.on_hit.condition, 'prone')

  const spider = enemyFrom2014(record('giant-spider'), { x: 5, y: 2 }, 0)
  const spiderBite = spider.action_profiles.find((profile) => profile.id === 'bite')
  assert.equal(spiderBite.on_hit.save_ability, 'con')
  assert.equal(spiderBite.on_hit.damage_expression, '2d8')
  assert.equal(spiderBite.on_hit.damage_type, 'poison')
  assert.equal(spiderBite.on_hit.half_on_save, true)
})

test('совомед и тролль исполняют точную последовательность мультиатаки планировщика', () => {
  for (const [slug, expected] of [['owlbear', ['beak', 'claws']], ['troll', ['bite', 'claws', 'claws']]]) {
    const enemy = enemyFrom2014(record(slug), { x: 1, y: 0 }, 0)
    const state = arenaState(enemy, [hero()], { enemyFirst: true })
    const first = planNpcTurn(state, enemy.id).find((command) => command.command_type === 'MakeAttack')
    assert.equal(first.action_id, expected[0], slug)
    assert.equal(first.monster_ability, 'multiattack', slug)
    assert.equal(first.multiattack_count, expected.length, slug)
    let after = commit(state, first)
    for (const actionId of expected.slice(1)) {
      const next = planNpcTurn(after, enemy.id).find((command) => command.command_type === 'MakeAttack')
      assert.equal(next?.action_id, actionId, slug)
      after = commit(after, next)
    }
  }
})

test('гоблин выбирает дальний лук через тот же планировщик, что и NPC игры', () => {
  const enemy = enemyFrom2014(record('goblin'), { x: 5, y: 0 }, 0)
  const state = arenaState(enemy, [hero('hero', 0, 0)], { enemyFirst: true })
  const plan = planNpcTurn(state, enemy.id)
  assert.equal(plan.find((command) => command.command_type === 'MakeAttack')?.action_id, 'shortbow')
})

test('маг получает CastSpell через monsterSpellcastingFor, а не через класс героя', () => {
  const enemy = enemyFrom2014(record('mage'), { x: 5, y: 0 }, 0)
  const block = monsterSpellcastingFor(enemy)
  assert.equal(block.ability, 'int')
  assert.equal(block.saveDc, 14)
  assert.equal(block.attackBonus, 6)
  assert.equal(monsterCombatSpellFor(enemy, 'fireball').monsterSpell.perDay, 3)
  assert.equal(monsterCombatSpellFor(enemy, 'fire-bolt').monsterSpell.perDay, null)

  const state = arenaState(enemy, [hero()], { enemyFirst: true })
  const planned = planNpcTurn(state, enemy.id).find((command) => command.command_type === 'CastSpell')
  assert.ok(planned, JSON.stringify(planNpcTurn(state, enemy.id)))
  const after = commit(state, planned)
  assert.equal(after.mechanics.combat.action_economy[enemy.id].action, false)
})

test('прислужник и фанатик сохраняют 2014 список заклинаний и лимиты блоков', () => {
  for (const slug of ['acolyte', 'cult-fanatic']) {
    const enemy = enemyFrom2014(record(slug), { x: 2, y: 2 }, 0)
    const block = monsterSpellcastingFor(enemy)
    assert.ok(block.spells.length > 0, slug)
    assert.ok(block.spells.some((spell) => spell.id === 'sacred-flame' && spell.perDay === null), slug)
    assert.ok(enemy.limitations.some((limitation) => limitation.includes('ячейки')), slug)
  }
})

test('огненное дыхание остаётся видимым действием с честным ограничением', () => {
  const dragon = enemyFrom2014(record('young-red-dragon'), { x: 2, y: 2 }, 0)
  assert.equal(dragon.damage_immunities[0], 'fire')
  assert.equal(dragon.special_actions.find((action) => action.id === 'fire-breath').damage[0].expression, '16d6')
  assert.ok(dragon.limitations.some((limitation) => limitation.includes('Огненное дыхание')))
})
