import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { ENEMY_LOADOUT_TEMPLATE_IDS, enemyLoadoutFor } from '../server/enemy-loadouts.mjs'
import { catalogItem } from '../server/item-catalog.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import {
  NPC_ATTACK_FORMULA_DEVIATIONS,
  NPC_HEALING_POTION_HP_PERCENT,
  NPC_ITEM_TACTICS,
  NPC_ITEM_TACTIC_IDS,
  npcAttackFormulaDeviationKey,
  npcNeedsHealingPotion,
  npcUsableItems,
  npcWeaponBindings,
} from '../server/npc-equipment.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand, validateCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer, turnExplanationForViewer } from '../server/viewer-projection.mjs'

const NPC_CONTEXT = { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true }

/** Максимальный бросок: детерминированный и не требует счёта костей в каждом тесте. */
class MaximumRng {
  randint(_minimum, maximum) { return maximum }
}

/**
 * Минимальный бросок: атака промахивается. Нужен там, где проверяется расход
 * снаряжения за несколько ходов подряд, — иначе максимальный урон добивает
 * героя, кампания закрывается и следующая команда падает на `CAMPAIGN_READ_ONLY`
 * вместо проверяемой ветки.
 */
class MinimumRng {
  randint(minimum) { return minimum }
}

function dice(rng = new MaximumRng()) {
  let counter = 0
  return new DiceService({ rng, idFactory: () => `roll-${++counter}`, now: () => '2026-08-14T12:00:00.000Z' })
}

function cells(width = 14, height = 3) {
  return Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
}

/** Первый сид, при котором шаблон выдал именно эту вещь. */
function seedWith(statBlockId, catalogId) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  for (let index = 0; index < 400; index += 1) {
    const seed = `seed-${index}`
    if (enemyLoadoutFor({ statBlockId, block, ownerId: 'foe', seed }).items.some((item) => item.catalog_id === catalogId)) {
      return seed
    }
  }
  throw new Error(`шаблон ${statBlockId} ни разу не выдал ${catalogId}`)
}

function foe(statBlockId, { hp = null, x = 6, y = 0, seed = 'npc-equipment' } = {}) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return {
    id: 'foe',
    name: block.name,
    creature_type: block.creature_type,
    hp: hp ?? block.hp,
    maxHp: block.hp,
    armor: block.armor,
    speed: block.speed,
    abilities: { ...block.abilities },
    x,
    y,
    alive: true,
    stat_block_id: statBlockId,
    action_profiles: block.action_profiles,
    traits: block.traits ?? [],
    loadout: enemyLoadoutFor({ statBlockId, block, ownerId: 'foe', seed }),
  }
}

/**
 * Класс героя вынесен параметром не для красоты: у воина после попадания нет ни
 * одной доступной реакции, поэтому окно реакции не открывается вовсе, и всё,
 * что через это окно уезжает столу, остаётся непроверенным. Плуту 5 уровня
 * доступно «Невероятное уклонение» — обычная реакция ровно после попадания.
 */
function battleState(enemy, { heroX = 0, heroArmor = 10, heroClass = 'fighter' } = {}) {
  return normalizeCampaignState({
    sessionCode: 'A2EQ',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', characterClass: heroClass, level: 5, hp: 40, maxHp: 40,
      armor: heroArmor, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [], x: heroX, y: 0,
    }],
    enemies: [enemy],
    scene: { title: 'Тракт', location: 'Тракт', turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function itemOf(enemy, catalogId) {
  const item = enemy.loadout.items.find((candidate) => candidate.catalog_id === catalogId)
  assert.ok(item, `в инвентаре нет ${catalogId}`)
  return item
}

function commit(state, command, { rng = new MaximumRng(), context = NPC_CONTEXT } = {}) {
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: `${command.command_type}-${Math.random().toString(36).slice(2, 8)}`, server_authoritative: true, ...command },
    state,
    { diceService: dice(rng), context },
  )
  return { events: result.events, rolls: result.rolls ?? [], state: result.events.reduce(applyGameEvent, state) }
}

/**
 * Следующий ход того же существа: экономика хода обнуляется, всё остальное
 * остаётся. Нужен там, где проверяется исчерпание запаса, — иначе отказ придёт
 * от потраченного действия, а не от пустого кармана.
 */
function nextTurn(state) {
  return {
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        turn_completed: [],
        action_economy: {
          ...state.mechanics.combat.action_economy,
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function rejects(state, command, code, context = NPC_CONTEXT) {
  assert.throws(
    () => validateCommand({ campaign_id: 'campaign-1', server_authoritative: true, ...command }, state, context),
    (error) => error.code === code,
    `${command.command_type}/${command.npc_tactic ?? command.action_id ?? ''} ожидал ${code}`,
  )
}

// ---------------------------------------------------------------------------
// Инвариант-сторож привязки: формула действия обязана совпасть с каталожной

test('каждая привязка оружия либо совпадает с каталогом, либо объявлена расхождением, и лишних объявлений нет', () => {
  const seen = new Set()
  for (const statBlockId of ENEMY_LOADOUT_TEMPLATE_IDS) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    const enemy = foe(statBlockId, { seed: 'binding-sweep' })
    const bindings = npcWeaponBindings(enemy)
    for (const binding of bindings) {
      const profile = block.action_profiles.find((action) => String(action.id) === binding.action_id)
      assert.ok(profile, `${statBlockId}: привязка без действия ${binding.action_id}`)
      const entry = catalogItem(binding.catalog_id)
      assert.ok(entry?.combat, `${statBlockId}: ${binding.catalog_id} не боевая запись каталога`)
      if (!binding.deviation) continue
      const declared = NPC_ATTACK_FORMULA_DEVIATIONS[binding.deviation]
      assert.ok(declared, `${statBlockId}: расхождение ${binding.deviation} не объявлено`)
      // Обе формулы записаны целиком, поэтому объявление стареет громко.
      assert.equal(declared.profile_damage, profile.damage_expression, binding.deviation)
      assert.equal(declared.catalog_id, binding.catalog_id, binding.deviation)
      assert.ok(String(declared.reason).length > 20, `${binding.deviation}: расхождение без объяснения`)
      seen.add(binding.deviation)
    }
    // Действие с каталожным оружием обязано получить привязку: пропущенная
    // привязка — это не «ничего не сломалось», а молча отключённый расход.
    for (const profile of block.action_profiles) {
      const boundName = String(profile.id).replace(/-(melee|ranged)$/u, '')
      const item = enemy.loadout.items.find((candidate) => candidate.catalog_id.endsWith(`:${boundName}`))
      if (!item) continue
      assert.ok(
        bindings.some((binding) => binding.action_id === String(profile.id)),
        `${statBlockId}: действие ${profile.id} осталось без привязки к ${item.catalog_id}`,
      )
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    Object.keys(NPC_ATTACK_FORMULA_DEVIATIONS).sort(),
    'объявлено расхождение, которого нет ни у одного шаблона',
  )
})

test('расхождение формулы без объявления привязку не создаёт, а протухшее объявление её отзывает', () => {
  const statBlockId = 'srd_5_2_1:goblin-warrior'
  const enemy = foe(statBlockId, { seed: 'binding-sweep' })
  assert.ok(npcWeaponBindings(enemy).some((binding) => binding.action_id === 'scimitar'))

  // Тихая правка стат-блока: скимитар вдруг бьёт костью секиры.
  const drifted = {
    ...enemy,
    action_profiles: enemy.action_profiles.map((profile) => profile.id === 'scimitar'
      ? { ...profile, damage_expression: '1d12+2' }
      : profile),
  }
  assert.equal(npcWeaponBindings(drifted).some((binding) => binding.action_id === 'scimitar'), false)

  // Объявленное расхождение описывает **своё** расхождение: подставленная
  // чужая формула его не оправдывает.
  const declared = NPC_ATTACK_FORMULA_DEVIATIONS[npcAttackFormulaDeviationKey('srd_5_2_1:bugbear', 'morningstar')]
  assert.ok(declared)
  const bugbear = foe('srd_5_2_1:bugbear', { seed: 'binding-sweep' })
  assert.ok(npcWeaponBindings(bugbear).some((binding) => binding.action_id === 'morningstar'))
  const staleBugbear = {
    ...bugbear,
    action_profiles: bugbear.action_profiles.map((profile) => profile.id === 'morningstar'
      ? { ...profile, damage_expression: '4d8+2' }
      : profile),
  }
  assert.equal(npcWeaponBindings(staleBugbear).some((binding) => binding.action_id === 'morningstar'), false)
})

test('закрытый список тактик сверен с каталогом: вид применения, цена хода и статус механики', () => {
  assert.deepEqual([...new Set(Object.values(NPC_ITEM_TACTICS).map((tactic) => tactic.tactic))].sort(), [...NPC_ITEM_TACTIC_IDS].sort())
  for (const [catalogId, tactic] of Object.entries(NPC_ITEM_TACTICS)) {
    const entry = catalogItem(catalogId)
    assert.ok(entry, catalogId)
    assert.equal(entry.mechanics_status, 'verified', catalogId)
    assert.equal(entry.use.kind, tactic.use_kind, catalogId)
    assert.equal(entry.use.combat_action, tactic.combat_action, catalogId)
    assert.equal(entry.enemy_loadout_eligible, true, catalogId)
    assert.ok(tactic.label.length > 5, catalogId)
  }
  // Расхождение цены хода закрывает вещь целиком, а не меняет её молча.
  const enemy = foe('srd_5_2_1:berserker', { seed: seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing') })
  assert.equal(npcUsableItems(enemy).length, 1)
  const original = catalogItem('srd_5_2_1:potion-of-healing').use.combat_action
  assert.equal(original, 'bonus_action')
})

// ---------------------------------------------------------------------------
// Дверь: инвентарём противника распоряжается только планировщик

test('игрок и администратор не командуют инвентарём противника', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const enemy = foe('srd_5_2_1:berserker', { hp: 10, x: 1, seed })
  const state = battleState(enemy)
  const potion = itemOf(enemy, 'srd_5_2_1:potion-of-healing')
  const command = { command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'heal' }
  rejects(state, command, 'NPC_ITEM_USE_FORBIDDEN', { allowedActorIds: ['hero'] })
  rejects(state, command, 'NPC_ITEM_USE_FORBIDDEN', { isAdmin: true })
  rejects(state, command, 'NPC_ITEM_USE_FORBIDDEN', {})
  // А доверенному контуру — можно.
  assert.ok(validateCommand({ campaign_id: 'campaign-1', ...command }, state, NPC_CONTEXT).npc_item)
})

test('команда предмета противника не принимает лишних полей и чужих тактик', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const enemy = foe('srd_5_2_1:berserker', { hp: 10, x: 1, seed })
  const state = battleState(enemy)
  const potion = itemOf(enemy, 'srd_5_2_1:potion-of-healing')
  rejects(state, {
    command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'heal', use_profile: { kind: 'healing', expression: '99d99' },
  }, 'ITEM_COMMAND_UNKNOWN_FIELD')
  rejects(state, { command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'flask' }, 'NPC_ITEM_TACTIC_MISMATCH')
  rejects(state, { command_type: 'UseItem', actor_id: 'foe', item_id: 'нет-такого', npc_tactic: 'heal' }, 'NPC_ITEM_NOT_USABLE')
  // Секира лежит в том же инвентаре, но тактики у неё нет.
  rejects(state, { command_type: 'UseItem', actor_id: 'foe', item_id: itemOf(enemy, 'srd_5_2_1:greataxe').item_instance_id, npc_tactic: 'heal' }, 'NPC_ITEM_NOT_USABLE')
})

// ---------------------------------------------------------------------------
// Зелье

test('зелье лечения: только на последних хитах, один раз за бой и с реальным расходом', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const maximum = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:berserker'].hp
  const healthy = foe('srd_5_2_1:berserker', { hp: maximum, x: 1, seed })
  const potionId = itemOf(healthy, 'srd_5_2_1:potion-of-healing').item_instance_id
  assert.equal(npcNeedsHealingPotion(healthy), false)
  rejects(battleState(healthy), { command_type: 'UseItem', actor_id: 'foe', item_id: potionId, npc_tactic: 'heal' }, 'NPC_ITEM_TACTIC_NOT_APPLICABLE')

  // Ровно порог — уже пора: сравнение целыми, а не долей.
  const threshold = Math.floor(maximum * NPC_HEALING_POTION_HP_PERCENT / 100)
  const wounded = foe('srd_5_2_1:berserker', { hp: threshold, x: 1, seed })
  assert.equal(npcNeedsHealingPotion(wounded), true)
  const state = battleState(wounded)
  const { events, state: after } = commit(state, { command_type: 'UseItem', actor_id: 'foe', item_id: potionId, npc_tactic: 'heal' })
  assert.deepEqual(events.map((event) => event.event_type), ['NpcItemUsed', 'DieRolled', 'HealingApplied', 'ConditionAdded', 'NpcEquipmentSpent'])
  const healing = events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.payload.applied_amount, 10, 'зелье лечит 2к4 + 2, максимум десять')
  assert.equal(after.enemies[0].hp, threshold + 10)
  // Вещь исчезла из кармана, а не осталась нулём.
  assert.equal(after.enemies[0].loadout.items.some((item) => item.item_instance_id === potionId), false)
  // Бонусное действие потрачено, и второе зелье уже не пройдёт.
  assert.equal(after.mechanics.combat.action_economy.foe.bonus_action, false)
  rejects(after, { command_type: 'UseItem', actor_id: 'foe', item_id: potionId, npc_tactic: 'heal' }, 'NPC_ITEM_NOT_USABLE')

  // Маркер «за бой один раз» держится даже там, где вещь вернули в карман.
  const restocked = {
    ...after,
    enemies: [{ ...after.enemies[0], loadout: wounded.loadout }],
    mechanics: {
      ...after.mechanics,
      combat: { ...after.mechanics.combat, action_economy: { ...after.mechanics.combat.action_economy, foe: { ...after.mechanics.combat.action_economy.foe, bonus_action: true } } },
    },
  }
  rejects(restocked, { command_type: 'UseItem', actor_id: 'foe', item_id: potionId, npc_tactic: 'heal' }, 'NPC_ITEM_TACTIC_SPENT')
})

test('расход снаряжения идемпотентен: повтор события не тратит вещь дважды', () => {
  const seed = seedWith('srd_5_2_1:tough-boss', 'srd_5_2_1:alchemists-fire')
  const enemy = foe('srd_5_2_1:tough-boss', { x: 2, seed })
  const flaskId = itemOf(enemy, 'srd_5_2_1:alchemists-fire').item_instance_id
  const state = battleState(enemy, { heroX: 0 })
  const { events, state: after } = commit(state, { command_type: 'UseItem', actor_id: 'foe', target_id: 'hero', item_id: flaskId, npc_tactic: 'flask' })
  const spent = events.find((event) => event.event_type === 'NpcEquipmentSpent')
  assert.ok(spent)
  const itemsAfter = after.enemies[0].loadout.items.map((item) => `${item.catalog_id}:${item.quantity}`)
  const replayed = applyGameEvent(applyGameEvent(after, spent), spent)
  assert.deepEqual(replayed.enemies[0].loadout.items.map((item) => `${item.catalog_id}:${item.quantity}`), itemsAfter)

  // Расход боеприпасов — тот же приём, но остаток считается выстрелами.
  const scout = foe('srd_5_2_1:scout', { x: 10 })
  const arrows = itemOf(scout, 'srd_5_2_1:arrows-20')
  const shot = commit(battleState(scout), { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'longbow' })
  const ammunition = shot.events.find((event) => event.event_type === 'NpcEquipmentSpent')
  assert.equal(ammunition.payload.reason, 'ammunition')
  assert.equal(ammunition.payload.shots_before, arrows.quantity * 20)
  assert.equal(ammunition.payload.shots_after, arrows.quantity * 20 - 1)
  const afterShot = shot.state.enemies[0].loadout.items.find((item) => item.item_instance_id === arrows.item_instance_id)
  assert.equal(afterShot.charges.current, arrows.quantity * 20 - 1)
  // Оба числа редьюсер берёт из события, а не досчитывает по состоянию: пачек
  // с одного выстрела не убыло, и пересчёт «сколько было минус один» тихо
  // снимал бы колчан — при первом же применении, а на повторе уводил бы в
  // минус. Для `charges` это уже проверено выше, для `quantity` — здесь.
  assert.equal(afterShot.quantity, arrows.quantity, 'колчан пересчитали по состоянию вместо payload')
  const twice = applyGameEvent(shot.state, ammunition)
  const replayedArrows = twice.enemies[0].loadout.items.find((item) => item.item_instance_id === arrows.item_instance_id)
  assert.equal(replayedArrows.charges.current, arrows.quantity * 20 - 1)
  assert.equal(replayedArrows.quantity, arrows.quantity)
})

// ---------------------------------------------------------------------------
// Склянка

test('склянка летит только в живого героя в пределах дальности', () => {
  const seed = seedWith('srd_5_2_1:tough-boss', 'srd_5_2_1:alchemists-fire')
  const far = foe('srd_5_2_1:tough-boss', { x: 12, seed })
  const flaskId = itemOf(far, 'srd_5_2_1:alchemists-fire').item_instance_id
  rejects(battleState(far, { heroX: 0 }), { command_type: 'UseItem', actor_id: 'foe', target_id: 'hero', item_id: flaskId, npc_tactic: 'flask' }, 'ITEM_TARGET_OUT_OF_RANGE')
  // В себя склянку не мечут, и в союзника-противника тоже.
  rejects(battleState(far), { command_type: 'UseItem', actor_id: 'foe', target_id: 'foe', item_id: flaskId, npc_tactic: 'flask' }, 'INVALID_ITEM_TARGET')

  const near = foe('srd_5_2_1:tough-boss', { x: 2, seed })
  const state = battleState(near, { heroX: 0 })
  // Провал спасброска: минимальный бросок кости.
  const { events, state: after } = commit(state, {
    command_type: 'UseItem', actor_id: 'foe', target_id: 'hero', item_id: flaskId, npc_tactic: 'flask',
  }, { rng: new SequenceDiceRng([1, 4]) })
  assert.deepEqual(events.map((event) => event.event_type), [
    'NpcItemUsed', 'SavingThrowResolved', 'DieRolled', 'DamageApplied', 'ConditionAdded', 'NpcEquipmentSpent',
  ])
  assert.equal(events.find((event) => event.event_type === 'DamageApplied').payload.damage_type, 'fire')
  assert.ok(after.players[0].hp < 40, 'герой получил урон от склянки')
  assert.equal(after.enemies[0].loadout.items.some((item) => item.item_instance_id === flaskId), false)
  assert.equal(after.mechanics.combat.action_economy.foe.action, false)
  // Действие потрачено — второй склянки в этом ходу не будет.
  const restocked = { ...after, enemies: [{ ...after.enemies[0], loadout: near.loadout }] }
  rejects(restocked, { command_type: 'UseItem', actor_id: 'foe', target_id: 'hero', item_id: flaskId, npc_tactic: 'flask' }, 'ACTION_SPENT')
})

// ---------------------------------------------------------------------------
// Яд

test('яд наносится на связанное ближнее оружие до первого удара и добавляет урон первому попаданию', () => {
  const seed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const enemy = foe('srd_5_2_1:spy', { x: 1, seed })
  const poisonId = itemOf(enemy, 'srd_5_2_1:poison-basic').item_instance_id
  const swordId = itemOf(enemy, 'srd_5_2_1:shortsword').item_instance_id
  const crossbowId = itemOf(enemy, 'srd_5_2_1:hand-crossbow').item_instance_id
  const state = battleState(enemy, { heroX: 0, heroArmor: 5 })

  rejects(state, { command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: crossbowId }, 'INVALID_WEAPON')
  rejects(state, { command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: 'нет-такого' }, 'INVALID_WEAPON')

  const coated = commit(state, { command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: swordId })
  assert.deepEqual(coated.events.map((event) => event.event_type), ['NpcItemUsed', 'ConditionAdded', 'ConditionAdded', 'NpcEquipmentSpent'])
  const conditions = (coated.state.mechanics.conditions.foe ?? []).map((condition) => condition.id)
  assert.ok(conditions.includes(`weapon-coated:${swordId}`))
  assert.ok(conditions.includes('npc-tactic-used:coat'))

  const hit = commit(coated.state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'shortsword' })
  const riders = hit.events.filter((event) => event.event_type === 'DamageApplied')
  assert.ok(riders.some((event) => event.payload.damage_type === 'poison'), 'яд добавился к попаданию')
  assert.ok(hit.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === `weapon-coated:${swordId}`), 'доза израсходована первым попаданием')

  // После первого удара мазать поздно, и второй дозы у существа всё равно нет.
  const restocked = { ...hit.state, enemies: [{ ...hit.state.enemies[0], loadout: enemy.loadout }] }
  rejects(restocked, { command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: swordId }, 'NPC_ITEM_TACTIC_SPENT')
})

// ---------------------------------------------------------------------------
// Потерянное оружие и пустой колчан

test('пустой колчан и выбитое оружие закрывают действие стат-блока', () => {
  const scout = foe('srd_5_2_1:scout', { x: 10 })
  const arrows = itemOf(scout, 'srd_5_2_1:arrows-20')
  const emptyQuiver = {
    ...scout,
    loadout: {
      ...scout.loadout,
      items: scout.loadout.items.map((item) => item.item_instance_id === arrows.item_instance_id
        ? { ...item, quantity: 1, charges: { current: 1, max: 20 } }
        : item),
    },
  }
  const state = battleState(emptyQuiver)
  // Последняя стрела ещё стреляет.
  const shot = commit(state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'longbow' })
  assert.equal(shot.events.find((event) => event.event_type === 'NpcEquipmentSpent').payload.shots_after, 0)
  assert.equal(shot.state.enemies[0].loadout.items.some((item) => item.catalog_id === 'srd_5_2_1:arrows-20'), false)
  // Следующего выстрела нет — ни у движка, ни в плане. Ход обновляется, иначе
  // отказ пришёл бы от общей экономики, а не от пустого колчана.
  const nextTurn = {
    ...shot.state,
    mechanics: {
      ...shot.state.mechanics,
      combat: {
        ...shot.state.mechanics.combat,
        turn_completed: [],
        action_economy: { ...shot.state.mechanics.combat.action_economy, foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  }
  rejects(nextTurn, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'longbow' }, 'NPC_AMMUNITION_SPENT')
  assert.equal(planNpcTurn(nextTurn, 'foe').some((command) => command.action_id === 'longbow'), false)

  // Потерянный меч закрывает ближнее действие тем же путём.
  const disarmed = {
    ...nextTurn,
    enemies: [{
      ...nextTurn.enemies[0],
      loadout: {
        ...nextTurn.enemies[0].loadout,
        items: nextTurn.enemies[0].loadout.items.filter((item) => item.catalog_id !== 'srd_5_2_1:shortsword'),
      },
    }],
  }
  rejects(disarmed, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'shortsword' }, 'NPC_WEAPON_UNAVAILABLE')

  // У волка инвентаря нет вовсе — его укус не должен закрыться этой веткой.
  const wolf = normalizeCampaignState({
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 40, maxHp: 40, armor: 10, speed: 30, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, x: 0, y: 0 }],
    enemies: [{
      id: 'foe', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, alive: true,
      stat_block_id: 'srd_5_2_1:wolf', abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 }, x: 1, y: 0,
      action_profiles: SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wolf'].action_profiles,
    }],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: { foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  assert.deepEqual(npcWeaponBindings(wolf.enemies[0]), [])
  assert.ok(validateCommand({ campaign_id: 'campaign-1', command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', server_authoritative: true }, wolf, NPC_CONTEXT))
})

test('единственное надетое метательное оружие ход не выбрасывает, а пучок дротиков расходуется до отказа', () => {
  // Копьё гладиатора одно и надето: брошенное, оно остаётся в инвентаре —
  // иначе планировщик разоружал бы существо его же ходом. Это объявленная
  // граница `expenditureFor`, и держит её этот тест, а не докстринг.
  const gladiator = foe('srd_5_2_1:gladiator', { x: 4 })
  const spear = itemOf(gladiator, 'srd_5_2_1:spear')
  assert.equal(spear.equipped, true)
  assert.equal(spear.quantity, 1)
  assert.equal(npcWeaponBindings(gladiator).find((binding) => binding.action_id === 'spear-ranged').expends, null)
  const thrownSpear = commit(battleState(gladiator, { heroX: 0 }), {
    command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'spear-ranged',
  }, { rng: new MinimumRng() })
  assert.equal(thrownSpear.events.some((event) => event.event_type === 'NpcEquipmentSpent'), false, 'надетое копьё улетело из инвентаря')
  assert.equal(thrownSpear.state.enemies[0].loadout.items.find((item) => item.catalog_id === 'srd_5_2_1:spear').quantity, 1)

  // Дротики капитана стражи лежат пучком и не надеты: каждый бросок уносит
  // один, а опустевший пучок закрывает **оба** его действия — и метание, и
  // удар тем же дротиком в ближнем бою.
  const captain = foe('srd_5_2_1:guard-captain', { x: 1 })
  const javelins = itemOf(captain, 'srd_5_2_1:javelin')
  assert.equal(javelins.equipped, false)
  assert.ok(javelins.quantity >= 2, 'пучок дротиков собран поштучно')
  assert.equal(npcWeaponBindings(captain).find((binding) => binding.action_id === 'javelin-ranged').expends, 'thrown')
  let state = battleState(captain, { heroX: 0 })
  for (let left = javelins.quantity; left > 0; left -= 1) {
    const shot = commit(state, {
      command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'javelin-ranged',
    }, { rng: new MinimumRng() })
    const spent = shot.events.find((event) => event.event_type === 'NpcEquipmentSpent')
    assert.ok(spent, `дротик ${left}: расхода нет`)
    assert.equal(spent.payload.reason, 'thrown')
    assert.equal(spent.payload.quantity_before, left)
    assert.equal(spent.payload.quantity_after, left - 1)
    state = nextTurn(shot.state)
  }
  assert.equal(state.enemies[0].loadout.items.some((item) => item.catalog_id === 'srd_5_2_1:javelin'), false)
  rejects(state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'javelin-ranged' }, 'NPC_WEAPON_UNAVAILABLE')
  rejects(state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'javelin-melee' }, 'NPC_WEAPON_UNAVAILABLE')
  // Закрылось действие вещи, а не ход: длинный меч в той же руке остался.
  assert.ok(validateCommand({
    campaign_id: 'campaign-1', server_authoritative: true, command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'longsword',
  }, state, NPC_CONTEXT))
})

test('яд наносят до первого удара: после удара тактика отказывается, а не молчит', () => {
  const seed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const spy = foe('srd_5_2_1:spy', { x: 1, seed })
  const poisonId = itemOf(spy, 'srd_5_2_1:poison-basic').item_instance_id
  const swordId = itemOf(spy, 'srd_5_2_1:shortsword').item_instance_id
  const coat = { command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: swordId }
  const state = battleState(spy, { heroX: 0, heroArmor: 5 })
  assert.ok(validateCommand({ campaign_id: 'campaign-1', server_authoritative: true, ...coat }, state, NPC_CONTEXT), 'до удара мазать можно')

  const struck = commit(state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'shortsword' })
  assert.equal(struck.state.mechanics.combat.action_economy.foe.attacks_used, 1)
  // Отказ обязан прийти именно от «поздно»: доза цела, маркер тактики не
  // поставлен, бонусное действие не потрачено — все соседние ветки открыты.
  assert.ok(struck.state.enemies[0].loadout.items.some((item) => item.item_instance_id === poisonId))
  assert.equal((struck.state.mechanics.conditions.foe ?? []).some((condition) => condition.id === 'npc-tactic-used:coat'), false)
  assert.equal(struck.state.mechanics.combat.action_economy.foe.bonus_action, true)
  rejects(struck.state, coat, 'NPC_ITEM_TACTIC_NOT_APPLICABLE')
  assert.equal(planNpcTurn(struck.state, 'foe').some((command) => command.npc_tactic === 'coat'), false)
})

// ---------------------------------------------------------------------------
// Планировщик

test('планировщик ставит зелье и яд перед атакой, а склянку — только когда ударить нечем', () => {
  // Зелье: раненое существо пьёт до удара.
  const potionSeed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const wounded = foe('srd_5_2_1:berserker', { hp: 8, x: 1, seed: potionSeed })
  const potionPlan = planNpcTurn(battleState(wounded), 'foe')
  assert.equal(potionPlan[0].command_type, 'UseItem')
  assert.equal(potionPlan[0].npc_tactic, 'heal')
  assert.equal(potionPlan[0].item_id, itemOf(wounded, 'srd_5_2_1:potion-of-healing').item_instance_id)
  assert.ok(potionPlan.some((command) => command.command_type === 'MakeAttack'))
  // Здоровое существо к склянке не тянется.
  assert.equal(planNpcTurn(battleState(foe('srd_5_2_1:berserker', { x: 1, seed: potionSeed })), 'foe').some((command) => command.command_type === 'UseItem'), false)

  // Яд: до первого удара и на то оружие, которым существо собралось бить.
  const poisonSeed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const spy = foe('srd_5_2_1:spy', { x: 1, seed: poisonSeed })
  const poisonPlan = planNpcTurn(battleState(spy), 'foe')
  assert.equal(poisonPlan[0].npc_tactic, 'coat')
  assert.equal(poisonPlan[0].weapon_id, itemOf(spy, 'srd_5_2_1:shortsword').item_instance_id)
  assert.equal(poisonPlan[1].command_type, 'MakeAttack')

  // Склянка: подойти нечем (скорость потрачена), ударить нечем — но двадцать
  // футов есть.
  const flaskSeed = seedWith('srd_5_2_1:tough-boss', 'srd_5_2_1:alchemists-fire')
  const boss = foe('srd_5_2_1:tough-boss', { x: 3, seed: flaskSeed })
  boss.loadout = { ...boss.loadout, items: boss.loadout.items.filter((item) => !['srd_5_2_1:heavy-crossbow', 'srd_5_2_1:bolts-20'].includes(item.catalog_id)) }
  const stuck = battleState(boss, { heroX: 0 })
  stuck.mechanics.combat.action_economy.foe.movement_spent = 30
  const flaskPlan = planNpcTurn(stuck, 'foe')
  assert.equal(flaskPlan[0].command_type, 'UseItem')
  assert.equal(flaskPlan[0].npc_tactic, 'flask')
  assert.equal(flaskPlan[0].target_id, 'hero')
  // А пока удар выходит, действие тратится на удар, а не на дорогую вещь.
  const reachable = battleState(boss, { heroX: 0 })
  assert.equal(planNpcTurn(reachable, 'foe').some((command) => command.command_type === 'UseItem'), false)
})

// ---------------------------------------------------------------------------
// Видимость и нарратив

test('карман противника не уезжает игроку ни событием, ни журналом боя, а поступок — уезжает', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const enemy = foe('srd_5_2_1:berserker', { hp: 8, x: 1, seed })
  const potion = itemOf(enemy, 'srd_5_2_1:potion-of-healing')
  const { events, state: after } = commit(battleState(enemy), {
    command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'heal',
  })
  const viewer = { role: 'player', heroIds: ['hero'] }
  const projected = mechanicsForViewer(events, viewer, 'hero', after)
  const serialized = JSON.stringify(projected)
  assert.equal(serialized.includes('NpcEquipmentSpent'), false, 'списание из кармана игроку не показывают')
  assert.equal(serialized.includes(potion.item_instance_id), false)
  assert.equal(serialized.includes('potion-of-healing'), false)
  assert.equal(serialized.includes('Зелье лечения'), false)
  const used = projected.find((event) => event.event_type === 'NpcItemUsed')
  assert.ok(used, 'сам поступок стол видит')
  assert.equal(used.payload.label, 'прикладывается к склянке')
  assert.equal(used.payload.tactic, 'heal')
  assert.equal(used.payload.item_instance_id, undefined)
  assert.equal(used.payload.catalog_id, undefined)
  assert.equal(used.payload.item_name, undefined)

  const room = campaignStateForViewer(after, viewer, 'hero')
  const entry = room.battleLog.find((record) => record.type === 'npc-item')
  assert.ok(entry)
  assert.equal(entry.label, 'прикладывается к склянке')
  assert.equal(JSON.stringify(room).includes(potion.item_instance_id), false)
  assert.equal(JSON.stringify(room.battleLog).includes('Зелье лечения'), false)
})

test('точная величина чужого лечения не уезжает игроку ни событием, ни броском, ни журналом', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const enemy = foe('srd_5_2_1:berserker', { hp: 8, x: 1, seed })
  const potion = itemOf(enemy, 'srd_5_2_1:potion-of-healing')
  const { events, state: after } = commit(battleState(enemy), {
    command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'heal',
  })
  // Авторитетное событие числа несёт целиком: механика и ведущий их видят.
  assert.equal(events.find((event) => event.event_type === 'HealingApplied').payload.applied_amount, 10)
  assert.equal(events.find((event) => event.event_type === 'DieRolled').visibility, 'gm_only')

  const viewer = { role: 'player', heroIds: ['hero'] }
  const projected = mechanicsForViewer(events, viewer, 'hero', after)
  // Бросок до стола не доезжает вовсе: у `DieRolled` остаётся `total`, и
  // «выпало 10» на зелье 2к4 + 2 называет склянку не хуже её имени.
  assert.equal(projected.some((event) => event.event_type === 'DieRolled'), false)
  const shown = projected.find((event) => event.event_type === 'HealingApplied')
  assert.ok(shown, 'сам факт лечения стол видит')
  for (const key of ['applied_amount', 'requested_amount', 'hp_before', 'hp_after']) {
    assert.equal(shown.payload[key], undefined, key)
  }

  const room = campaignStateForViewer(after, viewer, 'hero')
  const entry = room.battleLog.find((record) => record.type === 'healing')
  assert.ok(entry, 'запись о лечении в журнале остаётся')
  assert.equal(entry.healing, undefined)
  assert.equal(entry.hpAfter, undefined)

  // Закрыт игрок, а не журнал: ведущий видит и число, и бросок.
  const gm = campaignStateForViewer(after, { role: 'admin' }, 'gm')
  assert.equal(gm.battleLog.find((record) => record.type === 'healing').healing, 10)
  assert.equal(mechanicsForViewer(events, { role: 'admin' }, 'gm', after).length, events.length)

  // И граница — именно «здоровье не опознано»: опознанному врагу число видно,
  // потому что оно и так выводится из ОЗ до и после.
  const identified = {
    ...after,
    mechanics: { ...after.mechanics, enemy_knowledge: { party: { foe: { health: 'exact' } } } },
  }
  const known = mechanicsForViewer(events, viewer, 'hero', identified).find((event) => event.event_type === 'HealingApplied')
  assert.equal(known.payload.applied_amount, 10)
  assert.equal(campaignStateForViewer(identified, viewer, 'hero').battleLog.find((record) => record.type === 'healing').healing, 10)
})

test('каталожный ключ склянки не уезжает игроку назначением броска', () => {
  const seed = seedWith('srd_5_2_1:tough-boss', 'srd_5_2_1:alchemists-fire')
  const boss = foe('srd_5_2_1:tough-boss', { x: 2, seed })
  const flaskId = itemOf(boss, 'srd_5_2_1:alchemists-fire').item_instance_id
  const state = battleState(boss, { heroX: 0 })
  const { events, rolls, state: after } = commit(state, {
    command_type: 'UseItem', actor_id: 'foe', target_id: 'hero', item_id: flaskId, npc_tactic: 'flask',
  }, { rng: new SequenceDiceRng([1, 4]) })
  // Оба броска подписаны тактикой, а не каталожной записью: `purpose` не
  // чистит ни проекция событий, ни список бросков хода, поэтому подпись
  // задаётся при выпуске события — тем же приёмом, что и у зелья.
  assert.deepEqual(rolls.map((roll) => roll.purpose), [
    'item_thrown_save:npc-item:flask:dex',
    'item_thrown_damage:npc-item:flask',
  ])

  const viewer = { role: 'player', heroIds: ['hero'] }
  const projected = mechanicsForViewer(events, viewer, 'hero', after)
  // Закрывается каталожный ключ — тот, по которому потом опознаётся добыча с
  // тела. То, что горит именно алхимический огонь, стол и так видит: об этом
  // говорит и подпись поступка, и состояние `alchemists-fire-flames` на герое,
  // которое ему полагается видеть, чтобы его тушить.
  assert.equal(JSON.stringify(projected).includes('srd_5_2_1:alchemists-fire'), false)
  assert.equal(JSON.stringify(projected).includes(flaskId), false)
  const explanation = turnExplanationForViewer({ commands: [], rolls, events }, viewer, 'hero', after)
  assert.equal(JSON.stringify(explanation).includes('srd_5_2_1:alchemists-fire'), false)
  // Спасбросок принадлежит герою, поэтому урезание «бросок противника» на него
  // не распространяется — и именно поэтому подпись обязана быть безопасной.
  assert.equal(explanation.rolls.find((roll) => roll.actor_id === 'hero').purpose, 'item_thrown_save:npc-item:flask:dex')
  // Поступок стол видит, и урон получен по-настоящему.
  assert.equal(projected.find((event) => event.event_type === 'NpcItemUsed').payload.label, 'мечет склянку алхимического огня')
  assert.ok(after.players[0].hp < 40)
})

test('нанесённый противником яд не называет ни вещь, ни карман — ни в событии, ни в комнате, ни в трассе хода', () => {
  const seed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const spy = foe('srd_5_2_1:spy', { x: 1, seed })
  const poisonId = itemOf(spy, 'srd_5_2_1:poison-basic').item_instance_id
  const swordId = itemOf(spy, 'srd_5_2_1:shortsword').item_instance_id
  const viewer = { role: 'player', heroIds: ['hero'] }
  const coated = commit(battleState(spy, { heroX: 0, heroArmor: 5 }), {
    command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: swordId,
  })
  const hit = commit(coated.state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'shortsword' })

  // Авторитетное состояние точную форму хранит: без неё дозу не найти на
  // конкретном клинке, и добавка к попаданию перестала бы работать.
  assert.ok((coated.state.mechanics.conditions.foe ?? []).some((condition) => condition.id === `weapon-coated:${swordId}`))
  assert.ok(hit.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === `weapon-coated:${swordId}`))

  // Назначение броска добавки — четвёртый носитель того же ключа: `purpose` не
  // чистит ни проекция событий, ни список бросков хода, поэтому подпись
  // задаётся при выпуске броска и называет вид добавки, а не экземпляр.
  assert.equal(hit.rolls.find((roll) => String(roll.purpose).startsWith('item_damage:')).purpose, 'item_damage:weapon-coated')

  // Три поверхности, на которых закрытый инвентарь выходил наружу: событие
  // наложения, состояние комнаты на весь срок действия и трасса хода вместе
  // со снятием дозы.
  const surfaces = {
    'событие наложения': JSON.stringify(mechanicsForViewer(coated.events, viewer, 'hero', coated.state)),
    'состояние комнаты': JSON.stringify(campaignStateForViewer(coated.state, viewer, 'hero')),
    'трасса хода': JSON.stringify(turnExplanationForViewer(
      { commands: [], rolls: [...coated.rolls, ...hit.rolls], events: [...coated.events, ...hit.events] },
      viewer, 'hero', hit.state,
    )),
  }
  for (const [surface, serialized] of Object.entries(surfaces)) {
    assert.equal(serialized.includes(swordId), false, `${surface}: ключ вещи из кармана`)
    assert.equal(serialized.includes(poisonId), false, `${surface}: ключ дозы из кармана`)
    assert.equal(serialized.includes('Простой яд'), false, `${surface}: каталожное имя дозы`)
    assert.equal(serialized.includes('srd_5_2_1:poison-basic'), false, `${surface}: каталожный ключ дозы`)
    assert.equal(serialized.includes('npc-tactic-used'), false, `${surface}: служебный маркер тактики`)
  }

  // Что игрок всё-таки видит: смазанный клинок качественной формой, без ключа.
  const added = mechanicsForViewer(coated.events, viewer, 'hero', coated.state)
    .find((event) => event.event_type === 'ConditionAdded')
  assert.equal(added.payload.condition, 'weapon-coated')
  assert.equal(added.payload.rider_damage, undefined)
  const room = campaignStateForViewer(coated.state, viewer, 'hero')
  assert.deepEqual((room.mechanics.conditions.foe ?? []).map((condition) => condition.id), ['weapon-coated'])
  assert.equal((room.mechanics.conditions.foe ?? [])[0].rider_source_name, undefined)
  const removed = mechanicsForViewer(hit.events, viewer, 'hero', hit.state)
    .find((event) => event.event_type === 'ConditionRemoved')
  assert.equal(removed.payload.condition, 'weapon-coated')
  // Отравленное попадание игрок видит по-настоящему: закрыт источник, а не урон.
  assert.ok(hit.events.some((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'poison'))
  assert.ok(hit.state.players[0].hp < 40)

  // Условия героя проекция не трогает: своё снаряжение игрок знает.
  const heroCoated = {
    ...coated.state,
    mechanics: {
      ...coated.state.mechanics,
      conditions: { ...coated.state.mechanics.conditions, hero: [{ id: 'weapon-coated:hero-blade', rider_source_name: 'Простой яд' }] },
    },
  }
  assert.equal(campaignStateForViewer(heroCoated, viewer, 'hero').mechanics.conditions.hero[0].id, 'weapon-coated:hero-blade')

  // У ведущего форма полная — закрыт игрок, а не журнал.
  const gm = campaignStateForViewer(coated.state, { role: 'admin' }, 'gm')
  const gmCondition = gm.mechanics.conditions.foe.find((condition) => condition.id === `weapon-coated:${swordId}`)
  assert.equal(gmCondition.rider_source_name, 'Простой яд')
  assert.ok(gm.mechanics.conditions.foe.some((condition) => condition.id === 'npc-tactic-used:coat'))
  assert.equal(
    mechanicsForViewer(coated.events, { role: 'admin' }, 'gm', coated.state)
      .find((event) => event.event_type === 'ConditionAdded').payload.condition,
    `weapon-coated:${swordId}`,
  )
})

test('окно реакции не выносит наружу ни ключа вещи противника, ни слагаемого отравленного удара', () => {
  // Пятая поверхность того же ключа, и открывалась она только у героя, которому
  // есть чем ответить: добавка яда кладётся в `damage_components` вместе с
  // `item_id` и `effect_id`, весь массив едет payload-ом `ReactionWindowOpened`
  // и тем же значением стоит в `mechanics.combat.reaction_window`. Прежняя
  // защита проверяла, что цель — противник; здесь цель герой, поэтому не
  // срабатывало ничего. Воин в прочих тестах этого не ловит: реакции после
  // попадания у него нет, и окно не открывается вовсе.
  const seed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const spy = foe('srd_5_2_1:spy', { x: 1, seed })
  const poisonId = itemOf(spy, 'srd_5_2_1:poison-basic').item_instance_id
  const swordId = itemOf(spy, 'srd_5_2_1:shortsword').item_instance_id
  const viewer = { role: 'player', heroIds: ['hero'] }
  const coated = commit(battleState(spy, { heroX: 0, heroArmor: 5, heroClass: 'rogue' }), {
    command_type: 'UseItem', actor_id: 'foe', item_id: poisonId, npc_tactic: 'coat', weapon_id: swordId,
  })
  const hit = commit(coated.state, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'shortsword' })

  // Сторож самой развилки: без открытого окна проверки ниже зелены впустую.
  const authoritative = hit.state.mechanics.combat.reaction_window
  assert.ok(authoritative, 'окно реакции обязано открыться — иначе тест ничего не проверяет')
  assert.ok(authoritative.action_ids.includes('uncanny-dodge'))
  assert.ok(
    authoritative.damage.damage_components.some((component) => component.item_id === swordId),
    'авторитетное состояние обязано хранить точную форму: по ней считается сокращение урона реакцией',
  )

  const room = campaignStateForViewer(hit.state, viewer, 'hero')
  const projectedWindow = room.mechanics.combat.reaction_window
  const openedEvent = mechanicsForViewer(hit.events, viewer, 'hero', hit.state)
    .find((event) => event.event_type === 'ReactionWindowOpened')
  const surfaces = {
    'состояние комнаты': JSON.stringify(room),
    'канал событий': JSON.stringify(openedEvent),
  }
  for (const [surface, serialized] of Object.entries(surfaces)) {
    assert.equal(serialized.includes(swordId), false, `${surface}: ключ вещи из кармана`)
    assert.equal(serialized.includes(poisonId), false, `${surface}: ключ дозы из кармана`)
    assert.equal(serialized.includes(`weapon-coated:${swordId}`), false, `${surface}: точная форма условия`)
    assert.equal(serialized.includes('Простой яд'), false, `${surface}: каталожное имя дозы`)
    assert.equal(serialized.includes('srd_5_2_1:poison-basic'), false, `${surface}: каталожный ключ дозы`)
  }
  // Обе поверхности собирает одна функция — расходиться им теперь нечем.
  assert.deepEqual(openedEvent.payload, projectedWindow)

  // Закрыт источник, а не удар: стол видит и величину, и то, что укусов было
  // два и второй — ядовитый. Иначе игроку нечем решать, тратить ли реакцию.
  assert.ok(projectedWindow.damage.applied_amount > 0)
  assert.deepEqual(
    projectedWindow.damage.damage_components.map((component) => `${component.source}:${component.damage_type}`),
    ['weapon:piercing', 'magic-item:poison', 'secondary:poison'],
  )
  // Белый список слагаемого закреплён поимённо: новое поле не проезжает молча.
  for (const component of projectedWindow.damage.damage_components) {
    assert.deepEqual(Object.keys(component).sort(), [
      'applied_amount', 'damage_type', 'raw_amount', 'source', 'temporary_hp_absorbed',
    ])
  }

  // У ведущего форма полная: закрыт игрок, а не журнал.
  const gmWindow = campaignStateForViewer(hit.state, { role: 'admin' }, 'gm').mechanics.combat.reaction_window
  assert.ok(gmWindow.damage.damage_components.some((component) => component.effect_id === `weapon-coated:${swordId}`))
})

/** Ключи чужого кармана, которые движок кладёт в урон окна реакции. */
const POCKET_KEYS = {
  source_item_id: 'foe-item-1',
  source_item_name: 'Кинжал ядовитого укуса',
  item_id: 'foe-item-2',
  effect_id: 'weapon-coated:foe-item-2',
  catalog_id: 'srd_5_2_1:poison-basic',
}

/** Окно реакции, набитое всем, что вообще способно приехать в его урон. */
function stuffedWindow({ targetId = 'hero' } = {}) {
  return {
    id: 'reaction-window-1',
    trigger: 'attack-hit',
    actor_id: 'hero',
    source_actor_id: 'foe',
    target_id: targetId,
    action_ids: ['uncanny-dodge'],
    action_options: [{ id: 'uncanny-dodge', name: 'Невероятное уклонение', description: 'Уменьшить урон вдвое.', resource: null, cost: 1 }],
    damage: {
      damage_type: 'piercing',
      raw_amount: 9,
      applied_amount: 6,
      immune: false,
      resistant: true,
      vulnerable: false,
      temporary_hp_before: 3,
      temporary_hp_after: 0,
      temporary_hp_absorbed: 3,
      hp_before: 40,
      hp_after: 34,
      death_ward_triggered: false,
      ...POCKET_KEYS,
      damage_components: [{
        damage_type: 'poison',
        raw_amount: 4,
        applied_amount: 4,
        temporary_hp_absorbed: 2,
        source: 'magic-item',
        ...POCKET_KEYS,
      }],
    },
  }
}

/** Состояние боя с подставленным окном реакции и, по желанию, опознанным врагом. */
function windowState(window, { exactHealth = false } = {}) {
  const base = battleState(foe('srd_5_2_1:spy', { x: 1 }), { heroClass: 'rogue' })
  return {
    ...base,
    mechanics: {
      ...base.mechanics,
      ...(exactHealth ? { enemy_knowledge: { party: { foe: { health: 'exact' } } } } : {}),
      combat: { ...base.mechanics.combat, reaction_window: window },
    },
  }
}

test('белый список урона окна реакции закреплён поимённо и в корне, а не только в слагаемых', () => {
  // Сторож самого списка, а не одного сценария. У корня до этой проверки не
  // было ни одной: сценарий шпиона кладёт ключ вещи только в слагаемое, поэтому
  // дописанные в корневой список `source_item_id`, `source_item_name`,
  // `item_id` или `effect_id` оставляли корпус зелёным — опись чужого кармана
  // уезжала бы столу целым payload-ом окна. Здесь окно набито всеми ключами
  // разом, и набор оставшихся полей сверяется дословно.
  const viewer = { role: 'player', heroIds: ['hero'] }
  const state = windowState(stuffedWindow())
  const damage = campaignStateForViewer(state, viewer, 'hero').mechanics.combat.reaction_window.damage

  assert.deepEqual(Object.keys(damage).sort(), [
    'applied_amount', 'damage_components', 'damage_type', 'death_ward_triggered', 'hp_after', 'hp_before',
    'immune', 'raw_amount', 'resistant', 'temporary_hp_absorbed', 'temporary_hp_after', 'temporary_hp_before',
    'vulnerable',
  ])
  assert.deepEqual(Object.keys(damage.damage_components[0]).sort(), [
    'applied_amount', 'damage_type', 'raw_amount', 'source', 'temporary_hp_absorbed',
  ])
  // Величины закрытыми не становятся: закрыт источник, а не удар.
  assert.equal(damage.applied_amount, 6)
  assert.equal(damage.damage_components[0].source, 'magic-item')

  const serialized = JSON.stringify(campaignStateForViewer(state, viewer, 'hero'))
  for (const [key, value] of Object.entries(POCKET_KEYS)) {
    assert.equal(serialized.includes(value), false, `окно реакции: ${key}`)
  }

  // У ведущего форма полная: закрыт игрок, а не журнал.
  const gmDamage = campaignStateForViewer(state, { role: 'admin' }, 'gm').mechanics.combat.reaction_window.damage
  assert.equal(gmDamage.source_item_id, POCKET_KEYS.source_item_id)
  assert.equal(gmDamage.damage_components[0].effect_id, POCKET_KEYS.effect_id)
})

test('у неопознанного противника в окне реакции закрыты и временные ОЗ, и поглощённое ими', () => {
  // Цель окна реакции не всегда герой: у «покинул досягаемость» и у
  // контрзаклинания там записан тот, на кого реагируют. `temporary_hp_absorbed`
  // — те же временные ОЗ, только записанные разностью: «поглощено 3» называет и
  // то, что у неопознанного противника они были, и сколько их было. Стояло оно
  // рядом с закрытыми `hp_before/after` и уезжало столу и корнем, и слагаемым.
  const viewer = { role: 'player', heroIds: ['hero'] }
  const state = windowState(stuffedWindow({ targetId: 'foe' }))
  const damage = campaignStateForViewer(state, viewer, 'hero').mechanics.combat.reaction_window.damage

  assert.deepEqual(Object.keys(damage).sort(), [
    'applied_amount', 'damage_components', 'damage_type', 'death_ward_triggered', 'immune', 'raw_amount',
    'resistant', 'vulnerable',
  ])
  assert.deepEqual(Object.keys(damage.damage_components[0]).sort(), [
    'applied_amount', 'damage_type', 'raw_amount', 'source',
  ])

  // Граница закрытия — опознание, а не сама цель-противник: разведанному врагу
  // те же поля приезжают полностью, иначе проверка выше была бы зелена и от
  // безусловного удаления.
  const known = campaignStateForViewer(windowState(stuffedWindow({ targetId: 'foe' }), { exactHealth: true }), viewer, 'hero')
    .mechanics.combat.reaction_window.damage
  assert.equal(known.hp_before, 40)
  assert.equal(known.temporary_hp_absorbed, 3)
  assert.equal(known.damage_components[0].temporary_hp_absorbed, 2)

  // Событие и состояние собирает одна функция — расходиться им нечем.
  const opened = mechanicsForViewer([{
    event_id: 'reaction-window', command_id: 'cmd-1', event_type: 'ReactionWindowOpened', actor_id: 'hero',
    target_ids: ['foe'], visibility: 'public', payload: stuffedWindow({ targetId: 'foe' }),
  }], viewer, 'hero', state)[0]
  assert.deepEqual(opened.payload.damage, damage)
})

test('поглощённое временными ОЗ снимается у неопознанного противника и в самом событии урона', () => {
  // Второй канал того же знания. Окно реакции `temporary_hp_absorbed` у
  // неопознанного врага снимало, а `DamageApplied` по нему же вёз ключ игроку:
  // два места одного файла разошлись на одном поле. Величина называет и то,
  // что временные ОЗ у противника были, и сколько их было, — то же самое, что
  // рядом закрывают `temporary_hp_before/after`.
  const viewer = { role: 'player', heroIds: ['hero'] }
  const state = battleState(foe('srd_5_2_1:spy', { x: 1 }))
  const strike = () => ({
    event_id: 'damage-foe', command_id: 'cmd-1', event_type: 'DamageApplied', actor_id: 'hero',
    target_ids: ['foe'], visibility: 'public',
    payload: {
      target_id: 'foe', damage_type: 'slashing', raw_amount: 9, applied_amount: 6,
      temporary_hp_before: 3, temporary_hp_after: 0, temporary_hp_absorbed: 3, hp_before: 40, hp_after: 34,
    },
  })
  const [hidden] = mechanicsForViewer([strike()], viewer, 'hero', state)
  assert.deepEqual(Object.keys(hidden.payload).sort(), ['applied_amount', 'damage_type', 'raw_amount', 'target_id'])

  // Граница та же, что и у окна: опознание, а не сама цель-противник. Иначе
  // проверка выше была бы зелена и от безусловного удаления.
  const scouted = {
    ...state,
    mechanics: { ...state.mechanics, enemy_knowledge: { party: { foe: { health: 'exact' } } } },
  }
  assert.equal(mechanicsForViewer([strike()], viewer, 'hero', scouted)[0].payload.temporary_hp_absorbed, 3)

  // И вторая граница: свои временные ОЗ игрок обязан видеть — «поглощено 3»
  // объясняет, почему удар на 9 снял с него шесть.
  const [own] = mechanicsForViewer([{
    event_id: 'damage-hero', command_id: 'cmd-2', event_type: 'DamageApplied', actor_id: 'foe',
    target_ids: ['hero'], visibility: 'public',
    payload: { target_id: 'hero', damage_type: 'piercing', raw_amount: 9, applied_amount: 6, temporary_hp_absorbed: 3 },
  }], viewer, 'hero', state)
  assert.equal(own.payload.temporary_hp_absorbed, 3)
})

test('ключи добавки снимаются у условия противника целиком — и только у условия', () => {
  const seed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const state = battleState(foe('srd_5_2_1:spy', { x: 1, seed }))
  const viewer = { role: 'player', heroIds: ['hero'] }

  // Список закрытых полей проверяется на форме события, а не на тактике:
  // производителя `source_item_id` со стороны противника сегодня нет (его
  // кладёт антитоксин героя), и четвёртый ключ списка иначе остаётся без
  // единой проверки. Сторож нужен именно здесь: до этой правки тот же список
  // стоял вторым экземпляром в ветке «действует противник», где был мёртв, —
  // удаление той строки не роняло ничего.
  const [added] = mechanicsForViewer([{
    event_id: 'condition-added', command_id: 'cmd-1', event_type: 'ConditionAdded', actor_id: 'foe',
    target_ids: ['foe'], visibility: 'public',
    payload: {
      condition: 'weapon-coated:foe-item-1',
      rider_damage: '1d4',
      rider_damage_type: 'poison',
      rider_source_name: 'Простой яд',
      source_item_id: 'foe-item-2',
    },
  }], viewer, 'hero', state)
  assert.equal(added.payload.condition, 'weapon-coated')
  for (const key of ['rider_damage', 'rider_damage_type', 'rider_source_name', 'source_item_id']) {
    assert.equal(added.payload[key], undefined, `условие противника: ${key}`)
  }

  // И граница списка: область у него условная, а не «любое событие
  // противника». У волшебной палочки героя, бьющей по врагу, `source_item_id`
  // — своя вещь игрока, и общий сторож съел бы её молча.
  const [damage] = mechanicsForViewer([{
    event_id: 'damage', command_id: 'cmd-2', event_type: 'DamageApplied', actor_id: 'hero',
    target_ids: ['foe'], visibility: 'public',
    payload: { damage_type: 'force', applied_amount: 9, source_type: 'magic-item', source_item_id: 'hero-wand' },
  }], viewer, 'hero', state)
  assert.equal(damage.payload.source_item_id, 'hero-wand')
})

test('детерминированные строки боя называют поступок, а не вещь', () => {
  const seed = seedWith('srd_5_2_1:berserker', 'srd_5_2_1:potion-of-healing')
  const enemy = foe('srd_5_2_1:berserker', { hp: 8, x: 1, seed })
  const state = battleState(enemy)
  const potion = itemOf(enemy, 'srd_5_2_1:potion-of-healing')
  const sip = commit(state, { command_type: 'UseItem', actor_id: 'foe', item_id: potion.item_instance_id, npc_tactic: 'heal' })
  const line = combatNarration(sip.events, state)
  assert.ok(line.includes('Берсерк прикладывается к склянке.'), line)
  assert.equal(line.includes('Зелье'), false, line)

  const spySeed = seedWith('srd_5_2_1:spy', 'srd_5_2_1:poison-basic')
  const spy = foe('srd_5_2_1:spy', { x: 1, seed: spySeed })
  const spyState = battleState(spy, { heroArmor: 5 })
  const coated = commit(spyState, {
    command_type: 'UseItem', actor_id: 'foe', item_id: itemOf(spy, 'srd_5_2_1:poison-basic').item_instance_id,
    npc_tactic: 'coat', weapon_id: itemOf(spy, 'srd_5_2_1:shortsword').item_instance_id,
  })
  assert.ok(combatNarration(coated.events, spyState).includes('Шпион смазывает лезвие ядом.'))

  // Опустевший колчан — единственное, что стол узнаёт о чужих боеприпасах.
  const scout = foe('srd_5_2_1:scout', { x: 10 })
  const lastArrow = {
    ...scout,
    loadout: {
      ...scout.loadout,
      items: scout.loadout.items.map((item) => item.catalog_id === 'srd_5_2_1:arrows-20'
        ? { ...item, quantity: 1, charges: { current: 1, max: 20 } }
        : item),
    },
  }
  const scoutState = battleState(lastArrow)
  const shot = commit(scoutState, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'longbow' })
  const scoutLine = combatNarration(shot.events, scoutState)
  assert.ok(scoutLine.includes('находит колчан пустым'), scoutLine)
  assert.equal(/осталось \d+/u.test(scoutLine), false, 'остаток выстрелов не называется')
})
