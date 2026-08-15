import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { combatActionsFor } from '../server/combat-actions.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `combat-action-roll-${++id}`, now: () => '2026-07-13T12:00:00.000Z' })
}

function combatState() {
  const cells = Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ACTIONS-1',
    players: [
      { id: 'fighter', character: 'Бранн', role: 'Воин · ур. 3', characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 3, hp: 20, maxHp: 30, armor: 17, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [{ id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }], x: 1, y: 1 },
      { id: 'ally', character: 'Лира', role: 'Следопыт · ур. 3', level: 3, hp: 18, maxHp: 18, armor: 15, speed: 30, proficiency: 2, abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, inventory: [], x: 0, y: 1 },
    ],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'fighter', total: 18 }, { actor_id: 'goblin', total: 12 }], active_index: 0, action_economy: { fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

test('нормализация выдаёт воину классовые действия и их серверные ресурсы', () => {
  const state = combatState()
  const ids = state.players[0].combatActions.map((action) => action.id)
  const actions = state.players[0].combatActions
  assert.ok(actions.every((action) => ['verified', 'partial', 'heuristic', 'ruling-only'].includes(action.mechanicsSupport)))
  assert.equal(actions.find((action) => action.id === 'dash')?.mechanicsSupport, 'verified')
  assert.equal(actions.find((action) => action.id === 'ready')?.mechanicsSupport, 'partial')
  assert.equal(actions.find((action) => action.id === 'use-object')?.mechanicsSupport, 'ruling-only')
  const countercharm = combatActionsFor({ characterClass: 'bard', level: 6 }).find((action) => action.id === 'countercharm')
  assert.equal(countercharm?.mechanicsSupport, 'partial')
  assert.ok(ids.includes('dash'))
  assert.ok(ids.includes('second-wind'))
  assert.ok(ids.includes('action-surge'))
  assert.ok(ids.includes('trip-attack'))
  assert.deepEqual(state.mechanics.resources.fighter.second_wind, { current: 1, max: 1 })
  assert.deepEqual(state.mechanics.resources.fighter.superiority_dice, { current: 4, max: 4 })
})

test('эвристические и ruling-only действия отклоняются без изменения состояния', () => {
  const initial = combatState()
  const before = structuredClone(initial)
  assert.throws(
    () => resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'use-object', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } }),
    (error) => error.code === 'RULING_REQUIRED',
  )
  assert.throws(
    () => resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'fighter-varianty-priemov', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } }),
    (error) => error.code === 'MECHANICS_NOT_VERIFIED',
  )
  assert.deepEqual(initial, before)
})

test('Рывок тратит действие и реально увеличивает серверный лимит перемещения', () => {
  const initial = combatState()
  const dash = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'dash', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterDash = applyAll(initial, dash.events)
  assert.equal(afterDash.mechanics.combat.action_economy.fighter.action, false)
  assert.equal(afterDash.mechanics.combat.action_economy.fighter.movement_bonus, 30)

  const move = resolveCommand({ command_type: 'MoveActor', actor_id: 'fighter', to: { x: 7, y: 1 }, server_authoritative: true }, afterDash, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const afterMove = applyAll(afterDash, move.events)
  assert.equal(afterMove.players[0].x, 7)
  assert.equal(afterMove.mechanics.combat.action_economy.fighter.movement_spent, 40)
})

test('Подсекающая атака наносит дополнительный урон, тратит кость и сбивает цель', () => {
  const initial = combatState()
  const result = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'trip-attack', target_id: 'goblin', item_id: 'sword', server_authoritative: true }, initial, { diceService: dice([18, 1, 4, 2]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.equal(after.enemies[0].hp, 12)
  assert.equal(after.mechanics.resources.fighter.superiority_dice.current, 3)
  assert.ok(after.mechanics.conditions.goblin.some((condition) => condition.id === 'prone'))
  assert.equal(after.mechanics.combat.action_economy.fighter.action, false)
})

test('Второе дыхание использует бонусное действие, а Всплеск возвращает действие', () => {
  const initial = combatState()
  const wind = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'second-wind', server_authoritative: true }, initial, { diceService: dice([5]), context: { serverAuthoritativeCombat: true } })
  const afterWind = applyAll(initial, wind.events)
  assert.equal(afterWind.players[0].hp, 28)
  assert.equal(afterWind.mechanics.combat.action_economy.fighter.bonus_action, false)
  assert.equal(afterWind.mechanics.resources.fighter.second_wind.current, 0)

  afterWind.mechanics.combat.action_economy.fighter.action = false
  const surge = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'action-surge', server_authoritative: true }, afterWind, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterSurge = applyAll(afterWind, surge.events)
  assert.equal(afterSurge.mechanics.combat.action_economy.fighter.action, true)
  assert.equal(afterSurge.mechanics.combat.action_economy.fighter.surged_action_only, true)
  assert.equal(afterSurge.mechanics.resources.fighter.action_surge.current, 0)
})

test('попадание открывает прерывающее окно Парирования и реакция уменьшает уже нанесённый урон', () => {
  const initial = combatState()
  initial.mechanics.combat.active_index = 1
  initial.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, initial, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(initial, attack.events)
  assert.equal(afterAttack.mechanics.combat.reaction_window.actor_id, 'fighter')
  assert.ok(afterAttack.mechanics.combat.reaction_window.action_ids.includes('parry'))
  const damagedHp = afterAttack.players[0].hp

  const parry = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'parry', server_authoritative: true }, afterAttack, { diceService: dice([4]), context: { serverAuthoritativeCombat: true } })
  const afterParry = applyAll(afterAttack, parry.events)
  assert.equal(afterParry.mechanics.combat.reaction_window, null)
  assert.equal(afterParry.mechanics.combat.action_economy.fighter.reaction, false)
  assert.ok(afterParry.players[0].hp > damagedHp)
  assert.equal(afterParry.mechanics.resources.fighter.superiority_dice.current, 3)
})

test('от реакции можно отказаться, не расходуя её', () => {
  const initial = combatState()
  initial.mechanics.combat.active_index = 1
  initial.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, initial, { diceService: dice([18, 3]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(initial, attack.events)
  const decline = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'decline-reaction', server_authoritative: true }, afterAttack, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterDecline = applyAll(afterAttack, decline.events)
  assert.equal(afterDecline.mechanics.combat.reaction_window, null)
  assert.equal(afterDecline.mechanics.combat.action_economy.fighter.reaction, true)
})

test('Ответный удар выполняет внеочередную атаку, тратит реакцию, но не действие', () => {
  const initial = combatState()
  initial.mechanics.combat.active_index = 1
  initial.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const miss = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, initial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const afterMiss = applyAll(initial, miss.events)
  assert.ok(afterMiss.mechanics.combat.reaction_window.action_ids.includes('riposte'))
  const riposte = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'riposte', server_authoritative: true }, afterMiss, { diceService: dice([18, 4]), context: { serverAuthoritativeCombat: true } })
  const afterRiposte = applyAll(afterMiss, riposte.events)
  assert.equal(afterRiposte.mechanics.combat.reaction_window, null)
  assert.equal(afterRiposte.mechanics.combat.action_economy.fighter.reaction, false)
  assert.equal(afterRiposte.mechanics.combat.action_economy.fighter.action, true)
  assert.ok(afterRiposte.enemies[0].hp < 20)
})

test('реакционное заклинание Щит появляется только при подходящем попадании и отменяет урон', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 } }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const hpBefore = normalized.players[0].hp
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)
  assert.ok(afterAttack.mechanics.combat.reaction_window.action_ids.includes('cast:shield'))
  const shield = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:shield', server_authoritative: true }, afterAttack, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterShield = applyAll(afterAttack, shield.events)
  assert.equal(afterShield.players[0].hp, hpBefore)
  assert.equal(afterShield.mechanics.combat.action_economy.fighter.reaction, false)
  assert.equal(afterShield.mechanics.resources.fighter.spell_slots_1.current, 3)
  assert.ok(afterShield.mechanics.conditions.fighter.some((condition) => condition.id === 'shielded'))
})

test('Щит восстанавливает временные хиты, поглощённые отменённой атакой', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 } }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.temporary_hp.fighter = 5
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)
  assert.equal(afterAttack.mechanics.temporary_hp.fighter, 0)
  assert.equal(afterAttack.players[0].hp, 20)
  const shield = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:shield', server_authoritative: true }, afterAttack, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterShield = applyAll(afterAttack, shield.events)
  assert.equal(afterShield.mechanics.temporary_hp.fighter, 5)
  assert.equal(afterShield.players[0].hp, 20)
})

test('Щит открывается против атакующего заклинания и повышает КД для следующих заклинаний', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 } }
  initial.enemies[0] = { ...initial.enemies[0], characterClass: 'wizard', level: 3, proficiency: 2, abilities: { ...initial.enemies[0].abilities, int: 16 }, knownSpellIds: ['fire-bolt'], preparedSpellIds: [] }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'goblin', spell_id: 'fire-bolt', target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true }, normalized, { diceService: dice([15, 6]), context: { serverAuthoritativeCombat: true } })
  const afterCast = applyAll(normalized, cast.events)
  assert.ok(afterCast.mechanics.combat.reaction_window.action_ids.includes('cast:shield'))
  const shield = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:shield', server_authoritative: true }, afterCast, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterShield = applyAll(afterCast, shield.events)
  const secondCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'goblin', spell_id: 'fire-bolt', target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true }, { ...afterShield, mechanics: { ...afterShield.mechanics, combat: { ...afterShield.mechanics.combat, action_economy: { ...afterShield.mechanics.combat.action_economy, goblin: { ...afterShield.mechanics.combat.action_economy.goblin, action: true } } } } }, { diceService: dice([15]), context: { serverAuthoritativeCombat: true } })
  const secondAttack = secondCast.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(secondAttack.payload.armor_class, 22)
  assert.equal(secondAttack.payload.hit, false)
})

function counterspellState() {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 5', subclass: undefined, level: 5, abilities: { ...initial.players[0].abilities, int: 16 }, knownSpellIds: ['fire-bolt', 'shield', 'counterspell'], preparedSpellIds: ['shield', 'counterspell'] }
  initial.enemies[0] = { ...initial.enemies[0], characterClass: 'wizard', level: 5, proficiency: 3, abilities: { ...initial.enemies[0].abilities, int: 16 }, knownSpellIds: ['fire-bolt', 'chromatic-orb'], preparedSpellIds: ['chromatic-orb'] }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  return normalized
}

test('Контрзаклинание прерывает вражеское заклинание до применения его эффектов', () => {
  const initial = counterspellState()
  const hpBefore = initial.players[0].hp
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'goblin', spell_id: 'chromatic-orb', target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, cast.events)
  assert.equal(waiting.players[0].hp, hpBefore)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger, 'spell-cast')
  assert.deepEqual(waiting.mechanics.combat.reaction_window.action_ids, ['cast:counterspell'])
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:counterspell', server_authoritative: true }, waiting, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(waiting, reaction.events)
  assert.equal(after.players[0].hp, hpBefore)
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.mechanics.resources.fighter.spell_slots_3.current, 1)
  assert.equal(after.mechanics.resources.goblin.spell_slots_1.current, 3)
  assert.equal(after.mechanics.combat.action_economy.fighter.reaction, false)
  assert.equal(after.mechanics.combat.action_economy.goblin.action, false)
  assert.ok(reaction.events.some((event) => event.event_type === 'SpellCountered'))
  assert.ok(!reaction.events.some((event) => event.event_type === 'DamageApplied'))
})

test('отказ от Контрзаклинания возобновляет отложенное вражеское заклинание', () => {
  const initial = counterspellState()
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'goblin', spell_id: 'chromatic-orb', target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, cast.events)
  const decline = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'decline-reaction', server_authoritative: true }, waiting, { diceService: dice([15, 6, 6, 6]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(waiting, decline.events)
  assert.ok(after.players[0].hp < initial.players[0].hp)
  assert.equal(after.mechanics.combat.reaction_window.trigger, 'spell-attack-hit')
  assert.ok(after.mechanics.combat.reaction_window.action_ids.includes('cast:shield'))
  assert.equal(after.mechanics.combat.action_economy.fighter.reaction, true)
  assert.equal(after.mechanics.combat.action_economy.goblin.action, false)
})

test('Контрзаклинание меньшего уровня делает проверку характеристики и при провале пропускает заклинание', () => {
  const initial = counterspellState()
  initial.players[0].level = 7
  initial.enemies[0].level = 7
  initial.enemies[0].knownSpellIds = ['blight']
  initial.enemies[0].preparedSpellIds = ['blight']
  initial.mechanics.resources.goblin.spell_slots_4 = { current: 1, max: 1 }
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'goblin', spell_id: 'blight', target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, cast.events)
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:counterspell', server_authoritative: true }, waiting, { diceService: dice([1, 8, 8, 8, 8, 8, 8, 8, 8, 1]), context: { serverAuthoritativeCombat: true } })
  const check = reaction.events.find((event) => event.event_type === 'CounterspellCheckResolved')
  assert.equal(check.payload.difficulty, 14)
  assert.equal(check.payload.success, false)
  assert.ok(reaction.events.some((event) => event.event_type === 'DamageApplied'))
  const after = applyAll(waiting, reaction.events)
  assert.equal(after.mechanics.resources.fighter.spell_slots_3.current, 1)
  assert.equal(after.mechanics.resources.goblin.spell_slots_4.current, 0)
})

test('Искусная острота отменяет попадание меньшим перебросом и передаёт преимущество союзнику', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 }, knownSpellIds: ['silvery-barbs'], preparedSpellIds: ['silvery-barbs'] }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const hpBefore = normalized.players[0].hp
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)
  assert.ok(afterAttack.mechanics.combat.reaction_window.action_ids.includes('cast:silvery-barbs'))
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:silvery-barbs', target_id: 'goblin', beneficiary_id: 'ally', server_authoritative: true }, afterAttack, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const afterReaction = applyAll(afterAttack, reaction.events)
  assert.equal(afterReaction.players[0].hp, hpBefore)
  assert.equal(afterReaction.mechanics.resources.fighter.spell_slots_1.current, 3)
  assert.ok(afterReaction.mechanics.conditions.ally.some((condition) => condition.id === 'silvery-fortune'))
  const check = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'ally', ability: 'dex', difficulty: 10 }, afterReaction, { diceService: dice([5, 15]), context: { isAdmin: true } })
  const resolved = check.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(resolved.payload.kept, 15)
  const afterCheck = applyAll(afterReaction, check.events)
  assert.ok(!afterCheck.mechanics.conditions.ally.some((condition) => condition.id === 'silvery-fortune'))
})

test('игрок видит у Искусной остроты выбор получателя преимущества, а не только ведущий', () => {
  // Белый список опций реакции (`publicReactionWindowFor`,
  // `server/viewer-projection.mjs`) ронял `requires_beneficiary`, и окно
  // приезжало игроку без единственного признака, по которому интерфейс
  // показывает список получателей (`ReactionPrompt`, `src/App.tsx`): выбора не
  // было, кнопка уходила без `beneficiary_id`. Ведущий, чья проекция сквозная,
  // поле видел — две стороны стола расходились молча.
  const initial = combatState()
  // «Щит» подготовлен не для красоты: без второй реакции в окне отрицательный
  // сторож в конце теста не выполнялся ни разу. Движок дописывает «Искусную
  // остроту» либо когда своих реакций нет вовсе, либо когда заклинатель сам и
  // есть цель (сборка `ReactionWindowOpened`, `server/rules-engine.mjs`), — и в
  // первом случае опция в окне остаётся единственной.
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 }, knownSpellIds: ['silvery-barbs', 'shield'], preparedSpellIds: ['silvery-barbs', 'shield'] }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)

  const authoritative = afterAttack.mechanics.combat.reaction_window.action_options
    .find((option) => option.id === 'cast:silvery-barbs')
  assert.ok(authoritative?.requires_beneficiary, 'движок обязан объявить получателя — иначе проверка ниже пуста')

  const projected = campaignStateForViewer(afterAttack, { role: 'player', heroIds: ['fighter'] }, 'fighter')
    .mechanics.combat.reaction_window.action_options
    .find((option) => option.id === 'cast:silvery-barbs')
  assert.equal(projected.requires_beneficiary, true)
  assert.equal(projected.slot_level, authoritative.slot_level)
  // Форма опции закреплена поимённо: это своя реакция игрока, и закрывать здесь
  // нечего, но и лишнему полю проезжать незачем.
  assert.deepEqual(Object.keys(projected).sort(), [
    'cost', 'description', 'id', 'name', 'requires_beneficiary', 'resource', 'slot_level',
  ])
  assert.equal(projected.name, authoritative.name)
  assert.equal(projected.cost, 1)

  // Обычной реакции признак не выдумывается: список получателей над «Щитом»
  // был бы ложным выбором — цель у него одна и это сам игрок.
  const projectedOptions = campaignStateForViewer(afterAttack, { role: 'player', heroIds: ['fighter'] }, 'fighter')
    .mechanics.combat.reaction_window.action_options
  assert.deepEqual(projectedOptions.map((option) => option.id), ['cast:shield', 'cast:silvery-barbs'])
  const plain = projectedOptions.find((option) => option.id === 'cast:shield')
  assert.ok(plain, 'в окне обязана быть и вторая, обычная реакция — иначе проверка ниже пуста')
  assert.equal('requires_beneficiary' in plain, false)
  assert.deepEqual(Object.keys(plain).sort(), ['cost', 'description', 'id', 'name', 'resource', 'slot_level'])
})

test('Поглощение стихий даёт сопротивление подходящему урону и сохраняет его до следующего хода', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'wizard', role: 'Волшебник · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, int: 16 } }
  initial.enemies[0].attack_profile = { name: 'Огненный коготь', attack_modifier: 5, damage_expression: '1d8', damage_type: 'fire', range_feet: 5 }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 8]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)
  assert.ok(afterAttack.mechanics.combat.reaction_window.action_ids.includes('cast:absorb-elements'))
  const damagedHp = afterAttack.players[0].hp
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:absorb-elements', server_authoritative: true }, afterAttack, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterReaction = applyAll(afterAttack, reaction.events)
  assert.equal(afterReaction.players[0].hp, damagedHp + 4)
  assert.ok(afterReaction.mechanics.conditions.fighter.some((condition) => condition.id === 'absorbing-element:fire'))
})

test('Адское возмездие срабатывает после полученного урона и наносит ответный огненный урон', () => {
  const initial = combatState()
  initial.players[0] = { ...initial.players[0], characterClass: 'warlock', role: 'Колдун · ур. 3', subclass: undefined, level: 3, abilities: { ...initial.players[0].abilities, cha: 16 } }
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 1
  normalized.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, normalized, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const afterAttack = applyAll(normalized, attack.events)
  assert.ok(afterAttack.mechanics.combat.reaction_window.action_ids.includes('cast:hellish-rebuke'))
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:hellish-rebuke', server_authoritative: true }, afterAttack, { diceService: dice([1, 7, 8]), context: { serverAuthoritativeCombat: true } })
  const afterReaction = applyAll(afterAttack, reaction.events)
  assert.equal(afterReaction.enemies[0].hp, 5)
  assert.equal(afterReaction.mechanics.resources.fighter.pact_slots.current, 1)
  assert.equal(afterReaction.mechanics.combat.action_economy.fighter.reaction, false)
})

test('враг, покидающий досягаемость, открывает окно атаки по возможности', () => {
  const initial = combatState()
  initial.mechanics.combat.active_index = 1
  initial.mechanics.combat.action_economy.goblin = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const move = resolveCommand({ command_type: 'MoveActor', actor_id: 'goblin', to: { x: 5, y: 1 }, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterMove = applyAll(initial, move.events)
  assert.equal(afterMove.mechanics.combat.reaction_window.actor_id, 'fighter')
  assert.deepEqual(afterMove.mechanics.combat.reaction_window.action_ids, ['opportunity-attack'])
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'opportunity-attack', server_authoritative: true }, afterMove, { diceService: dice([18, 4]), context: { serverAuthoritativeCombat: true } })
  const afterReaction = applyAll(afterMove, reaction.events)
  assert.ok(afterReaction.enemies[0].hp < 20)
  assert.equal(afterReaction.mechanics.combat.action_economy.fighter.action, true)
  assert.equal(afterReaction.mechanics.combat.action_economy.fighter.reaction, false)
})

test('Отход врага не открывает игроку окно атаки по возможности', () => {
  const initial = combatState()
  initial.mechanics.combat.active_index = 1
  initial.mechanics.combat.action_economy.goblin = { action: false, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  initial.mechanics.conditions.goblin = [{ id: 'disengaged', duration: 'until-next-turn' }]
  const move = resolveCommand({ command_type: 'MoveActor', actor_id: 'goblin', to: { x: 5, y: 1 }, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterMove = applyAll(initial, move.events)
  assert.equal(afterMove.mechanics.combat.reaction_window, null)
  assert.equal(afterMove.enemies[0].x, 5)
  assert.equal(afterMove.mechanics.combat.action_economy.fighter.reaction, true)
})
