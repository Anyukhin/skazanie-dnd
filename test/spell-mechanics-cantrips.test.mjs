import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor, combatSpellsFor, spellCatalogInfo } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `cantrip-roll-${++id}`, now: () => '2026-07-13T12:00:00.000Z' })
}

function stateFor(characterClass = 'wizard', level = 1) {
  const cells = Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CANTRIPS-1',
    players: [
      { id: 'caster', character: 'Маг', characterClass, level, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: level >= 5 ? 3 : 2, abilities: { str: 14, dex: 14, con: 12, int: 16, wis: 16, cha: 16 }, inventory: [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }], x: 1, y: 1 },
      { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 13, speed: 30, proficiency: 2, abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 2 },
    ],
    enemies: [{ id: 'enemy', name: 'Враг', hp: 30, maxHp: 30, armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'enemy', total: 12 }], active_index: 0, action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

test('проверенные параметры каталога исполняются как честно ограниченная partial-механика', () => {
  const state = stateFor('wizard')
  const caster = state.players[0]
  assert.equal(spellCatalogInfo().verifiedMechanics, 0)
  assert.ok(spellCatalogInfo().partialMechanics >= 35)
  const classForSpell = { 'acid-splash': 'wizard', 'chill-touch': 'wizard', 'thorn-whip': 'druid', shield: 'wizard' }
  assert.deepEqual(Object.fromEntries(['acid-splash', 'chill-touch', 'thorn-whip', 'shield'].map((id) => {
    const spell = combatSpellFor(stateFor(classForSpell[id]).players[0], id)
    return [id, { kind: spell?.kind, target: spell?.target, damageType: spell?.damageType, healing: spell?.healing ?? null, conditions: spell?.conditions }]
  })), {
    'acid-splash': { kind: 'save', target: 'enemy', damageType: 'acid', healing: null, conditions: [] },
    'chill-touch': { kind: 'attack', target: 'enemy', damageType: 'necrotic', healing: null, conditions: ['healing-blocked'] },
    'thorn-whip': { kind: 'attack', target: 'enemy', damageType: 'piercing', healing: null, conditions: ['pulled-10'] },
    shield: { kind: 'buff', target: 'self', damageType: null, healing: null, conditions: [] },
  })
  assert.equal(combatSpellsFor(caster).find((spell) => spell.id === 'shield')?.mechanicsAccuracy, 'verified-dndsu')
})

test('Священное пламя разрешается спасброском Ловкости, а не автоматическим уроном', () => {
  const initial = stateFor('cleric')
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'sacred-flame', target_id: 'enemy', target_ids: ['enemy'], server_authoritative: true }, initial, { diceService: dice([6, 1]), context: { serverAuthoritativeCombat: true } })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'dex')
  assert.equal(save.payload.saved, false)
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'radiant'))
})

test('Вспышка мечей поражает всех остальных существ вокруг заклинателя', () => {
  const initial = stateFor('wizard')
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'sword-burst', server_authoritative: true }, initial, { diceService: dice([5, 1, 1]), context: { serverAuthoritativeCombat: true } })
  const damaged = result.events.filter((event) => event.event_type === 'DamageApplied').flatMap((event) => event.target_ids).sort()
  assert.deepEqual(damaged, ['ally', 'enemy'])
  const after = applyAll(initial, result.events)
  assert.equal(after.players[0].hp, 20)
  assert.equal(after.players[1].hp, 15)
  assert.equal(after.enemies[0].hp, 25)
})

test('Осколок разума накладывает одноразовый штраф 1к4 к следующему спасброску', () => {
  const initial = stateFor('wizard')
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'mind-sliver', target_id: 'enemy', target_ids: ['enemy'], server_authoritative: true }, initial, { diceService: dice([3, 1]), context: { serverAuthoritativeCombat: true } })
  const affected = applyAll(initial, cast.events)
  assert.ok(affected.mechanics.conditions.enemy.some((condition) => condition.id === 'next-save-minus-d4'))
  const save = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'enemy', ability: 'con', difficulty: 10 }, affected, { diceService: dice([4, 10]), context: { isAdmin: true } })
  const resolved = save.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(resolved.payload.total, 6)
  const after = applyAll(affected, save.events)
  assert.ok(!after.mechanics.conditions.enemy.some((condition) => condition.id === 'next-save-minus-d4'))
})

test('Громовой клинок использует атаку оружием и срабатывает при добровольном движении цели', () => {
  const initial = stateFor('wizard')
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'booming-blade', target_id: 'enemy', target_ids: ['enemy'], server_authoritative: true }, initial, { diceService: dice([18, 5]), context: { serverAuthoritativeCombat: true } })
  const struck = applyAll(initial, cast.events)
  assert.equal(struck.enemies[0].hp, 23)
  assert.ok(struck.mechanics.conditions.enemy.some((condition) => condition.id.startsWith('booming-blade-move:')))
  struck.mechanics.combat.active_index = 1
  struck.mechanics.conditions.enemy.push({ id: 'disengaged', duration: 'until-next-turn' })
  const move = resolveCommand({ command_type: 'MoveActor', actor_id: 'enemy', to: { x: 4, y: 1 }, server_authoritative: true }, struck, { diceService: dice([6]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(struck, move.events)
  assert.equal(after.enemies[0].hp, 17)
  assert.ok(!after.mechanics.conditions.enemy.some((condition) => condition.id.startsWith('booming-blade-move:')))
})

test('Луч холода действительно уменьшает доступную скорость цели на 10 футов', () => {
  const initial = stateFor('wizard')
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ray-of-frost', target_id: 'enemy', target_ids: ['enemy'], server_authoritative: true }, initial, { diceService: dice([18, 4]), context: { serverAuthoritativeCombat: true } })
  const affected = applyAll(initial, cast.events)
  affected.mechanics.combat.active_index = 1
  assert.throws(() => resolveCommand({ command_type: 'MoveActor', actor_id: 'enemy', to: { x: 7, y: 1 }, server_authoritative: true }, affected, { diceService: dice(), context: { serverAuthoritativeCombat: true } }), (error) => error?.code === 'SPEED_EXCEEDED')
})

test('Сопротивление редакции 2024 уменьшает выбранный урон на 1к4 один раз за ход', () => {
  const initial = stateFor('cleric')
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'resistance', target_id: 'ally', spell_option: 'fire', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const protectedState = applyAll(initial, cast.events)
  assert.ok(protectedState.mechanics.conditions.ally.some((condition) => condition.id === 'resistance-damage:fire'))

  const save = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'con', difficulty: 10 }, protectedState, { diceService: dice([10]), context: { isAdmin: true } })
  assert.equal(save.events.filter((event) => event.event_type === 'DieRolled').length, 0)
  assert.equal(save.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 10)

  const first = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 10, damage_type: 'fire' }, protectedState, { diceService: dice([3]) })
  assert.deepEqual(first.events.map((event) => event.event_type), ['DieRolled', 'DamageApplied'])
  const firstDamage = first.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(firstDamage.payload.resistance_cantrip_reduction, 3)
  assert.equal(firstDamage.payload.applied_amount, 7)
  let after = applyAll(protectedState, first.events)
  assert.equal(after.players.find((hero) => hero.id === 'ally').hp, 13)

  const sameTurn = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 4, damage_type: 'fire' }, after, { diceService: dice() })
  assert.deepEqual(sameTurn.events.map((event) => event.event_type), ['DamageApplied'])
  after = applyAll(after, sameTurn.events)
  assert.equal(after.players.find((hero) => hero.id === 'ally').hp, 9)
  assert.ok(after.mechanics.conditions.ally.some((condition) => condition.id === 'resistance-damage:fire'))

  after.mechanics.combat.active_index = 1
  const nextTurn = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 4, damage_type: 'fire' }, after, { diceService: dice([2]) })
  assert.equal(nextTurn.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 2)
  assert.equal(applyAll(after, nextTurn.events).players.find((hero) => hero.id === 'ally').hp, 7)
})

test('1к4 Сопротивления вычитается до половины: порядок модификаторов по SRD 5.2.1', () => {
  const initial = stateFor('cleric')
  // Цель сопротивляется огню сама по себе. Заговор при этом остаётся обычным
  // модификатором урона, а не вторым сопротивлением.
  initial.mechanics.defenses = { ally: { resistances: ['fire'] } }
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'resistance', target_id: 'ally', spell_option: 'fire', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const protectedState = applyAll(initial, cast.events)

  const hit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 9, damage_type: 'fire' }, protectedState, { diceService: dice([3]) })
  const payload = hit.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(payload.resistant, true)
  assert.equal(payload.resistance_cantrip_reduction, 3)
  // (9 − 3) ÷ 2 = 3. Прежний порядок считал ⌊9 ÷ 2⌋ − 3 = 1 и снимал с цели
  // втрое меньше положенного.
  assert.equal(payload.applied_amount, 3)
  assert.equal(applyAll(protectedState, hit.events).players.find((hero) => hero.id === 'ally').hp, 17)

  // Уязвимость идёт тем же порядком и с той же стороны: сначала 1к4, потом ×2.
  const vulnerableState = applyAll(initial, cast.events)
  vulnerableState.mechanics.defenses = { ally: { vulnerabilities: ['fire'] } }
  const heavy = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 9, damage_type: 'fire' }, vulnerableState, { diceService: dice([3]) })
  const heavyPayload = heavy.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(heavyPayload.vulnerable, true)
  assert.equal(heavyPayload.applied_amount, 12)
})
