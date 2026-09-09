import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { monsterCombatSpellFor, monsterSpellcastingFor } from '../server/combat-spells.mjs'
import { DND_2014_MONSTER_IMAGES, enemyFrom2014, monsterAttackModesFor, monsterCatalogEntry, monsterRolesFor } from '../server/combat-lab-monsters.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

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
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
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

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'ожидался PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('каждая запись 2014 имеет явный локальный уникальный портрет 512×512', () => {
  const imageRecords = records.filter((candidate) => DND_2014_MONSTER_IMAGES[candidate.id])
  assert.equal(imageRecords.length, records.length)
  assert.deepEqual(Object.keys(DND_2014_MONSTER_IMAGES).sort(), imageRecords.map((candidate) => candidate.id).sort())

  const hashes = new Set()
  for (const candidate of imageRecords) {
    const image = DND_2014_MONSTER_IMAGES[candidate.id]
    assert.match(image, /^\/assets\/enemies\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\.png$/u, candidate.id)
    const file = new URL(`../public${image}`, import.meta.url)
    assert.equal(existsSync(file), true, `${candidate.id}: отсутствует ${image}`)
    const bytes = readFileSync(file)
    assert.deepEqual(pngDimensions(bytes), { width: 512, height: 512 }, candidate.id)
    assert.ok(bytes.length >= 20_000, `${candidate.id}: портрет подозрительно мал`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashes.has(hash), false, `${candidate.id}: портрет дублирует другую запись`)
    hashes.add(hash)
  }
})

test('условное сопротивление элементаля не превращается в защиту от любых атак', () => {
  const candidate = record('fire-elemental')
  assert.deepEqual(candidate.damage_resistances, [{ types: ['bludgeoning', 'piercing', 'slashing'], condition: 'nonmagical-attacks' }])
  const enemy = enemyFrom2014(candidate, { x: 1, y: 1 })
  assert.deepEqual(enemy.damage_resistances, [])
  assert.ok(enemy.limitations.some((text) => text.includes('Защиты с особыми условиями')))
})

test('mapper сохраняет характеристики и объявляет только оставшиеся ограничения', () => {
  const expected = [
    ['goblin', 'скрытность бонусным действием'],
    ['bandit-captain', 'Реакция «Парирование»'],
  ]
  for (const [slug, text] of expected) {
    const enemy = enemyFrom2014(record(slug), { x: 5, y: 2 }, 0)
    assert.equal(enemy.mechanics_status, 'partial', slug)
    assert.ok(enemy.limitations.some((limitation) => limitation.includes(text)), `${slug}: ${text}`)
  }

  for (const candidate of records) {
    const enemy = enemyFrom2014(candidate, { x: 5, y: 2 }, 0)
    assert.deepEqual(enemy.skills, candidate.skills, candidate.id)
    assert.deepEqual(enemy.saving_throws, candidate.saving_throws, candidate.id)
    assert.deepEqual(enemy.bonus_actions, candidate.bonus_actions, candidate.id)
    assert.deepEqual(enemy.reactions, candidate.reactions, candidate.id)
    assert.equal(enemy.provenance.stat_block_id, candidate.id)
  }
})

test('тактические роли выводятся из MM14-профиля и переходят в runtime-врага', () => {
  assert.deepEqual(monsterRolesFor(record('kobold')), ['artillery', 'frontliner', 'skirmisher', 'minion'])
  assert.deepEqual(monsterRolesFor(record('acolyte')), ['caster', 'support', 'frontliner', 'minion'])
  assert.deepEqual(monsterRolesFor(record('young-red-dragon')), ['controller', 'frontliner', 'multiattack', 'flying', 'skirmisher', 'brute', 'solo'])
  assert.deepEqual(monsterAttackModesFor(record('giant-spider')), ['melee', 'ranged'])

  const dragon = enemyFrom2014(record('young-red-dragon'), { x: 5, y: 2 }, 0)
  assert.deepEqual(dragon.roles, monsterRolesFor(record('young-red-dragon')))
  assert.deepEqual(dragon.attack_modes, ['melee'])
  assert.deepEqual(dragon.habitats, ['mountain', 'hill'])
  assert.deepEqual(dragon.speed_ft, { walk: 40, fly: 80, climb: 40 })
  assert.ok(dragon.limitations.some((limitation) => limitation.includes('Дополнительная скорость')))
})

test('расширенный набор MM14 сохраняет источник, CR и пригодную базовую атаку', () => {
  const expected = [
    ['gnoll', '1/2', 100, 'longbow'],
    ['harpy', '1', 200, 'claws'],
    ['giant-boar', '2', 450, 'tusk'],
    ['minotaur', '3', 700, 'greataxe'],
    ['veteran', '3', 700, 'longsword'],
    ['manticore', '3', 700, 'bite'],
    ['hill-giant', '5', 1800, 'greatclub'],
    ['fire-elemental', '5', 1800, 'touch'],
    ['displacer-beast', '3', 700, 'tentacle'],
    ['wyvern', '6', 2300, 'bite'],
  ]
  for (const [slug, cr, xp, primaryAction] of expected) {
    const source = record(slug)
    const enemy = enemyFrom2014(source, { x: 5, y: 2 }, 0)
    assert.equal(enemy.challenge_rating, cr, slug)
    assert.equal(enemy.xp, xp, slug)
    assert.equal(enemy.stat_block_id, source.id, slug)
    assert.equal(enemy.source_url, source.source_url, slug)
    assert.ok(enemy.action_profiles.some((profile) => profile.id === primaryAction), `${slug}: ${primaryAction}`)
    assert.ok(enemy.roles.length > 0, `${slug}: role metadata`)
  }
  const wyvern = enemyFrom2014(record('wyvern'), { x: 5, y: 2 }, 0)
  const stinger = wyvern.action_profiles.find((profile) => profile.id === 'stinger')
  assert.equal(stinger.on_hit.save_dc, 15)
  assert.equal(stinger.on_hit.damage_expression, '7d6')
  assert.equal(wyvern.limitations.some((limitation) => limitation.includes('Несколько независимых компонентов')), false)
})

test('неисполняемые эффекты новых профилей явно отражены в ограничениях', () => {
  const fireElemental = enemyFrom2014(record('fire-elemental'), { x: 5, y: 2 }, 0)
  assert.ok(fireElemental.limitations.some((limitation) => limitation.includes('Состояние «burning»')))
  assert.ok(fireElemental.limitations.some((limitation) => limitation.includes('до тушения')))

  const manticore = enemyFrom2014(record('manticore'), { x: 5, y: 2 }, 0)
  assert.equal(manticore.action_profiles.find(profile => profile.id === 'tail-spike').uses, 24)
})

test('каталог монстров отдаёт настройки, полную карточку и варианты портрета', () => {
  const { statBlock, images, ...entry } = monsterCatalogEntry(record('goblin'))
  assert.deepEqual(statBlock, record('goblin'))
  assert.deepEqual(images, ['/assets/enemies/goblin.png', '/assets/enemies/goblin-minion.png'])
  assert.deepEqual(entry, {
    id: 'dnd_5e_2014:monster:goblin',
    name: 'Гоблин',
    image: '/assets/enemies/goblin.png',
    cr: '1/4',
    hp: 7,
    ac: 15,
    xp: 50,
    creatureType: 'humanoid',
    size: 'small',
    roles: ['artillery', 'frontliner', 'minion'],
    attackModes: ['melee', 'ranged'],
    habitats: ['forest', 'grassland', 'underdark', 'hill'],
    speed_ft: { walk: 30 },
    sourceUrl: 'https://dnd.su/bestiary/4-goblin/',
    limitations: [
      'Ловкое бегство позволяет отойти бонусным действием; скрытность бонусным действием пока не выбирается автоматически.',
    ],
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
  assert.equal(monsterCombatSpellFor(enemy, 'fireball').monsterSpell.perDay, null)
  assert.equal(monsterCombatSpellFor(enemy, 'fireball').slotResource, 'spell_slots_3')
  assert.equal(monsterCombatSpellFor(enemy, 'fire-bolt').monsterSpell.perDay, null)

  const state = arenaState(enemy, [hero()], { enemyFirst: true })
  const planned = planNpcTurn(state, enemy.id).find((command) => command.command_type === 'CastSpell')
  assert.ok(planned, JSON.stringify(planNpcTurn(state, enemy.id)))
  const after = commit(state, planned)
  assert.equal(after.mechanics.combat.action_economy[enemy.id].action, false)
  assert.equal(after.mechanics.resources[enemy.id].spell_slots_2.current, 2)
})

test('прислужник и фанатик сохраняют 2014 список заклинаний и лимиты блоков', () => {
  for (const slug of ['acolyte', 'cult-fanatic']) {
    const enemy = enemyFrom2014(record(slug), { x: 2, y: 2 }, 0)
    const block = monsterSpellcastingFor(enemy)
    assert.ok(block.spells.length > 0, slug)
    assert.ok(block.spells.some((spell) => spell.id === 'sacred-flame' && spell.perDay === null), slug)
    assert.equal(Boolean(enemy.limitations?.some((limitation) => limitation.includes('ячейки'))), false, slug)
  }
})

test('две разные заклинания 2014 делят один общий пул ячеек', () => {
  const enemy = enemyFrom2014(record('mage'), { x: 5, y: 0 }, 0)
  let state = arenaState(enemy, [hero()], { enemyFirst: true })
  assert.equal(state.mechanics.resources[enemy.id].spell_slots_1.max, 4)
  assert.equal(state.mechanics.resources[enemy.id].spell_slots_3.max, 3)
  state.mechanics.resources[enemy.id].spell_slots_1 = { current: 1, max: 1 }
  for (const level of [2, 3, 4, 5]) state.mechanics.resources[enemy.id][`spell_slots_${level}`] = { current: 0, max: state.mechanics.resources[enemy.id][`spell_slots_${level}`].max }

  const firstCommand = {
    command_type: 'CastSpell',
    actor_id: enemy.id,
    spell_id: 'magic-missile',
    target_id: 'hero',
  }
  const first = resolveCommand({
    campaign_id: 'COMBAT-LAB-MONSTERS',
    command_id: 'shared-slot:first',
    server_authoritative: true,
    ...firstCommand,
  }, state, { diceService: maximumDice(), context: NPC_CONTEXT })
  const afterFirst = first.events.reduce(applyGameEvent, state)
  assert.equal(first.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_1')
  assert.equal(afterFirst.mechanics.resources[enemy.id].spell_slots_1.current, 0)
  assert.deepEqual(replayEvents(state, first.events), afterFirst)

  const refreshed = normalizeCampaignState({
    ...afterFirst,
    mechanics: {
      ...afterFirst.mechanics,
      combat: {
        ...afterFirst.mechanics.combat,
        action_economy: {
          ...afterFirst.mechanics.combat.action_economy,
          [enemy.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  assert.throws(() => resolveCommand({
    campaign_id: 'COMBAT-LAB-MONSTERS',
    command_id: 'shared-slot:second',
    server_authoritative: true,
    command_type: 'CastSpell',
    actor_id: enemy.id,
    spell_id: 'mage-armor',
    target_id: enemy.id,
  }, refreshed, { diceService: maximumDice(), context: NPC_CONTEXT }), (error) => error.code === 'INSUFFICIENT_RESOURCE')
  assert.equal(refreshed.mechanics.resources[enemy.id].spell_slots_1.current, 0)

  const legacy = {
    ...enemy,
    spellcasting: { ability: 'int', save_dc: 14, attack_bonus: 6, spells: [{ id: 'magic-missile', uses: 1 }] },
  }
  assert.equal(monsterCombatSpellFor(legacy, 'magic-missile').slotResource, null)
  assert.equal(monsterCombatSpellFor(legacy, 'magic-missile').monsterSpell.perDay, 1)
})

test('огненное дыхание сохраняет точный профиль и больше не объявляется неисполняемым', () => {
  const dragon = enemyFrom2014(record('young-red-dragon'), { x: 2, y: 2 }, 0)
  assert.equal(dragon.damage_immunities[0], 'fire')
  assert.equal(dragon.special_actions.find((action) => action.id === 'fire-breath').damage[0].expression, '16d6')
  assert.equal(dragon.limitations.some((limitation) => limitation.includes('Огненное дыхание')), false)
})

test('каждый статблок 2014 завершает допустимый ход вблизи и издалека', () => {
  for (const source of records) for (const x of [1, 8]) {
    const enemy = enemyFrom2014(source, { x, y: 0 })
    let state = arenaState(enemy, [hero()], { enemyFirst: true })
    const diceService = maximumDice()
    let ended = false
    for (let step = 0; step < 9; step++) {
      const command = planNpcTurn(state, enemy.id)[0]
      assert.ok(command, `${source.id}: пустой план`)
      const result = resolveCommand({ ...command, command_id: `roster:${source.id}:${x}:${step}`, server_authoritative: true }, state, { diceService, context: NPC_CONTEXT })
      state = result.events.reduce(applyGameEvent, state)
      if (command.command_type === 'EndTurn') { ended = true; break }
    }
    assert.equal(ended, true, `${source.id}: ход не завершился, x=${x}`)
  }
})
