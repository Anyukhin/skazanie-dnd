import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor, combatSpellsFor, spellCatalogInfo } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `cantrip-roll-${++id}`, now: () => '2026-07-13T12:00:00.000Z' })
}

function stateFor(characterClass = 'wizard', level = 1, rulesetId = 'srd_5_2_1') {
  const cells = Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CANTRIPS-1',
    ruleset_id: rulesetId,
    ruleset_version: rulesetId === 'dnd_5e_2014' ? '2014.1.0' : '5.2.1',
    players: [
      { id: 'caster', character: 'Маг', characterClass, level, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: level >= 5 ? 3 : 2, abilities: { str: 14, dex: 14, con: 12, int: 16, wis: 16, cha: 16 }, inventory: [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }, ...(rulesetId === 'dnd_5e_2014' ? [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch', quantity: 1 })] : [])], x: 1, y: 1 },
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
    'acid-splash': { kind: 'save', target: 'creature', damageType: 'acid', healing: null, conditions: [] },
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

test('Брызги кислоты выбирают двух соседних существ с общим уроном и отдельными спасбросками', () => {
  const initial = stateFor('wizard')
  const second = { ...initial.enemies[0], id: 'second', x: 3 }
  initial.enemies.push(second)
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'acid-splash',
    target_ids: ['enemy', 'second'], server_authoritative: true }, initial,
  { diceService: dice([6, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const saves = result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.deepEqual(saves.map((event) => [event.target_ids[0], event.payload.saved]), [['enemy', false], ['second', true]])
  assert.equal(result.events.filter((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell_damage:acid-splash').length, 1)
  const after = applyAll(initial, result.events)
  assert.equal(after.enemies.find((actor) => actor.id === 'enemy').hp, 24)
  assert.equal(after.enemies.find((actor) => actor.id === 'second').hp, 30)
  assert.equal(after.mechanics.combat.action_economy.caster.action, false)
  assert.deepEqual(applyAll(initial, JSON.parse(JSON.stringify(result.events))), after)
})

test('Брызги кислоты допускают одну цель и явно выбранного союзника, но не повторяют урон по дубликату', () => {
  for (const targets of [['enemy'], ['ally', 'ally'], ['enemy', 'ally']]) {
    const initial = stateFor('wizard')
    const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'acid-splash',
      target_ids: targets, server_authoritative: true }, initial,
    { diceService: dice([4, 1, 1]), context: { serverAuthoritativeCombat: true } })
    assert.equal(result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, new Set(targets).size)
  }
})

test('недопустимая пара Брызг кислоты отвергается до расхода действия, клиент не увеличивает радиус между целями', () => {
  const initial = stateFor('wizard')
  initial.enemies.push({ ...initial.enemies[0], id: 'far', x: 5 })
  const before = structuredClone(initial)
  for (const target_ids of [['enemy', 'far'], ['enemy', 'ally', 'far']]) {
    assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'acid-splash',
      target_ids, maxTargetSeparationFeet: 1000, maxTargets: 99, server_authoritative: true }, initial,
    { diceService: dice(), context: { serverAuthoritativeCombat: true } }),
    (error) => error.code === (target_ids.length > 2 ? 'TOO_MANY_SPELL_TARGETS' : 'SPELL_TARGETS_TOO_FAR_APART'))
    assert.deepEqual(initial, before)
  }
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
  assert.equal(save.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 12, 'd20 10 + CON 0 + владение воина 2; заговор 2024 бонуса не даёт')

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

test('Сопротивление 2014 открывает выбор перед спасброском и расходует концентрацию только после согласия', () => {
  const initial = stateFor('cleric', 1, 'dnd_5e_2014')
  const profile = combatSpellFor(initial.players[0], 'resistance', { rulesetId: 'dnd_5e_2014' })
  assert.deepEqual(profile.spellOptions, [])
  assert.equal(profile.concentration, true)
  assert.equal(profile.resistanceSavingThrow, true)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'resistance', target_id: 'ally', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const castState = applyAll(initial, cast.events)
  const resistance = castState.mechanics.conditions.ally.find((condition) => condition.id === 'resistance-d4')
  assert.ok(resistance)
  assert.equal(castState.mechanics.concentration.caster.effect_id, resistance.effect_id)
  assert.equal(castState.mechanics.concentration.caster.effect_id, 'resistance:' + cast.command.command_id)

  const paused = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'con', difficulty: 10 }, castState, {
    diceService: dice([3, 10]), context: { serverAuthoritativeCombat: true },
  })
  const window = paused.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(paused.rolls.length, 0)
  assert.equal(window.payload.trigger, 'saving-throw-bonus-choice')
  assert.equal(window.payload.free_choice, true)
  assert.deepEqual(window.payload.action_options.map((option) => option.name), ['Использовать Сопротивление', 'Сначала бросить', 'Без бонуса'])

  const waiting = applyAll(castState, paused.events)
  const accepted = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'ally', action_id: 'use-resistance', server_authoritative: true }, waiting, {
    diceService: dice([3, 10]), context: { serverAuthoritativeCombat: true },
  })
  const resolved = accepted.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(resolved.payload.total, 15, 'd20 10 + CON 0 + владение воина 2 + Resistance 3')
  assert.equal(accepted.rolls.filter((roll) => roll.expression === '1d4').length, 1)
  assert.equal(accepted.events.find((event) => event.event_type === 'ConcentrationEnded').payload.effect_id, resistance.effect_id)
  const afterAccepted = applyAll(waiting, accepted.events)
  assert.equal(afterAccepted.mechanics.concentration.caster, undefined)
  assert.equal(afterAccepted.mechanics.conditions.ally?.some((condition) => condition.id === 'resistance-d4'), false)

  const second = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'con', difficulty: 10 }, afterAccepted, {
    diceService: dice([10]), context: { serverAuthoritativeCombat: true },
  })
  assert.equal(second.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(second.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 12, 'после расхода Resistance остаётся владение спасброском')

  const damage = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount: 10, damage_type: 'fire' }, castState, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const damagePayload = damage.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(damagePayload.resistance_cantrip_reduction, undefined)
  assert.equal(damagePayload.applied_amount, 10)
})

test('Отказ от Resistance 2014 сохраняет концентрацию и позволяет выбрать следующий спасбросок', () => {
  const initial = stateFor('cleric', 1, 'dnd_5e_2014')
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'resistance', target_id: 'ally', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const castState = applyAll(initial, cast.events)
  const paused = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'con', difficulty: 10 }, castState, {
    diceService: dice([10]), context: { serverAuthoritativeCombat: true },
  })
  const waiting = applyAll(castState, paused.events)
  const declined = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'ally', action_id: 'skip-resistance', server_authoritative: true }, waiting, {
    diceService: dice([10]), context: { serverAuthoritativeCombat: true },
  })
  const declinedState = applyAll(waiting, declined.events)
  assert.ok(declinedState.mechanics.concentration.caster)
  assert.ok(declinedState.mechanics.conditions.ally?.some((condition) => condition.id === 'resistance-d4'))
  assert.equal(declined.events.filter((event) => event.event_type === 'DieRolled' && event.payload.modifier_source === 'resistance').length, 0)
  assert.equal(declined.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 12, 'd20 10 + владение 2, без Resistance')
})

test('NPC применяет Resistance 2014 по детерминированной политике без окна игрока', () => {
  const initial = stateFor('cleric', 1, 'dnd_5e_2014')
  initial.mechanics.conditions.enemy = [{ id: 'resistance-d4', effect_id: 'npc-resistance', source_actor: 'enemy', spell_id: 'resistance' }]
  initial.mechanics.concentration.enemy = { effect_id: 'npc-resistance' }
  const result = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'enemy', ability: 'dex', difficulty: 10 }, initial, {
    diceService: dice([3, 10]), context: { isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(result.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 13)
  assert.equal(applyAll(initial, result.events).mechanics.concentration.enemy, undefined)
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
