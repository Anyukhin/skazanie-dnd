// Реакции союзника на атаку врага по герою (PHB 2014): «Острое словцо» барда
// Знаний — после броска и до исхода, «Оборона» со щитом — помеха до броска.
// Аудит боя 2026-10-13: обе были каталожными особыми эффектами без
// исполнителя, окно защитной реакции открывалось только цели удара.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { planHeroReaction } from '../server/party-tactics.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const shield = { id: 'shield', catalog_id: 'srd_5_2_1:shield', type: 'armor', quantity: 1, equipped: true }
const longsword = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', quantity: 1, equipped: true }

function battle({ bard = true, protector = false, protectorStyle = 'fighting-style-protection', protectorShield = true } = {}) {
  const players = [{ id: 'mage', character: 'Маг', characterClass: 'wizard', level: 7, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 3,
    abilities: { str: 10, dex: 10, con: 12, int: 16, wis: 10, cha: 10 }, inventory: [], x: 1, y: 1 }]
  if (bard) players.push({ id: 'bard', character: 'Лютня', characterClass: 'bard', subclass: 'Коллегия знаний', level: 7, hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 3,
    abilities: { str: 8, dex: 14, con: 12, int: 10, wis: 10, cha: 18 }, inventory: [], x: 4, y: 3 })
  if (protector) players.push({ id: 'knight', character: 'Брен', characterClass: 'fighter', level: 7, hp: 60, maxHp: 60, armor: 18, speed: 30, proficiency: 3,
    abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 }, selectedFeatureIds: [protectorStyle],
    inventory: protectorShield ? [longsword, shield] : [longsword], x: 0, y: 1 })
  return normalizeCampaignState({
    sessionCode: 'ALLY-REACTIONS', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: players.map((hero) => hero.id),
    players,
    enemies: [{ id: 'enemy', name: 'Разбойник', hp: 30, maxHp: 30, armor: 12, speed: 30,
      attack_profile: { name: 'Удар', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'slashing', range_feet: 5 },
      abilities: { str: 14, dex: 10, con: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 30 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'enemy', total: 20 }, ...players.map((hero, index) => ({ actor_id: hero.id, total: 10 - index }))],
      action_economy: Object.fromEntries([['enemy', { action: true, reaction: true, movement: true }], ...players.map((hero) => [hero.id, { action: true, bonus_action: true, reaction: true, movement: true }])]),
    } },
  })
}
let rollIds = 0
const options = (values) => ({ diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ally-${++rollIds}` }), context: { serverAuthoritativeCombat: true } })
const swing = (state, values, id = 'swing') => resolveCommand({ command_type: 'MakeAttack', command_id: id, actor_id: 'enemy', target_id: 'mage', server_authoritative: true }, state, options(values))
const answer = (state, actorId, actionId, values) => resolveCommand({ command_type: 'UseCombatAction', command_id: `answer-${actionId}-${actorId}`, actor_id: actorId, action_id: actionId, server_authoritative: true }, state, options(values))

test('Острое словцо: окно барду, кость вычитается, попадание срывается; replay сходится', () => {
  const start = battle()
  // d20 = 10: 10 + 5 = 15 против КД 14 — попадание, к8 барда может его сорвать.
  const attack = swing(start, [10])
  const paused = replayEvents(start, attack.events)
  const window = paused.mechanics.combat.reaction_window
  assert.equal(window?.trigger, 'attack-cutting-words-choice')
  assert.equal(window.actor_id, 'bard', 'отвечает бард, а не цель')
  assert.deepEqual(window.action_ids, ['bard-kollegiya-znaniy-ostroe-slovtso'])
  assert.equal(planHeroReaction(paused).rule, 'bard-kollegiya-znaniy-ostroe-slovtso', 'автономный бард отвечает словцом')
  // Кость барда 7-го уровня — к8: выпало 4, 15 − 4 = 11 < 14.
  const used = answer(paused, 'bard', 'bard-kollegiya-znaniy-ostroe-slovtso', [4])
  const final = replayEvents(paused, used.events)
  const resolved = used.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.hit, false)
  assert.equal(resolved.payload.cutting_words, 4)
  assert.equal(final.players[0].hp, 40)
  assert.equal(final.mechanics.resources.bard.bardic_inspiration.current, paused.mechanics.resources.bard.bardic_inspiration.current - 1)
  assert.equal(final.mechanics.combat.action_economy.bard.reaction, false)
  assert.equal(final.mechanics.combat.reaction_window ?? null, null)
  assert.equal(replayEvents(start, [...attack.events, ...used.events]).players[0].hp, 40)
})

test('Острое словцо: отказ оставляет попадание; удар, который не сорвать, не спрашивает', () => {
  const paused = replayEvents(battle(), swing(battle(), [10]).events)
  const declined = answer(paused, 'bard', 'decline-reaction', [])
  // Отказ барда передаёт ход цели: у мага свой Щит.
  const shieldAsked = replayEvents(paused, declined.events)
  assert.equal(shieldAsked.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice')
  assert.equal(shieldAsked.mechanics.combat.reaction_window.actor_id, 'mage')
  const final = replayEvents(shieldAsked, answer(shieldAsked, 'mage', 'decline-reaction', [4]).events)
  assert.equal(final.players[0].hp, 40 - 7)
  assert.equal(final.mechanics.resources.bard.bardic_inspiration.current, paused.mechanics.resources.bard.bardic_inspiration.current)
  assert.notEqual(final.mechanics.combat.action_economy.bard.reaction, false, 'реакция барда цела')
  // d20 = 18: 23 против 14 — к8 не сорвёт, окна нет.
  const sure = swing(battle(), [18, 4], 'sure-hit')
  assert.ok(!sure.events.some((event) => event.event_type === 'ReactionWindowOpened' && event.payload.trigger === 'attack-cutting-words-choice'))
  // Натуральная 20 — критический удар словцом не отменить.
  const crit = swing(battle(), [20, 4, 4], 'crit-hit')
  assert.ok(!crit.events.some((event) => event.event_type === 'ReactionWindowOpened' && event.payload.trigger === 'attack-cutting-words-choice'))
})

test('Оборона: окно защитнику со щитом до броска, атака с помехой', () => {
  const start = battle({ bard: false, protector: true })
  assert.ok(combatActionsFor(start.players[1]).some((entry) => entry.id === 'fighter-zaschita' && entry.name === 'Оборона'))
  const attack = swing(start, [])
  assert.ok(!attack.events.some((event) => event.event_type === 'AttackResolved'), 'до броска')
  const paused = replayEvents(start, attack.events)
  assert.equal(paused.mechanics.combat.reaction_window?.trigger, 'attack-protection-choice')
  assert.equal(paused.mechanics.combat.reaction_window.actor_id, 'knight')
  const used = answer(paused, 'knight', 'fighter-zaschita', [18, 3])
  const resolved = used.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.protected_by, 'knight')
  assert.equal(resolved.payload.mode, 'disadvantage')
  assert.equal(resolved.payload.kept, 3)
  assert.equal(resolved.payload.hit, false)
  assert.equal(replayEvents(paused, used.events).mechanics.combat.action_economy.knight.reaction, false)
})

test('Оборона: без щита, без стиля или вне 5 футов — окна нет; вне окна действие не исполняется', () => {
  for (const setup of [{ protectorShield: false }, { protectorStyle: 'fighting-style-defense' }]) {
    const attack = swing(battle({ bard: false, protector: true, ...setup }), [18, 3], `no-protection-${JSON.stringify(setup)}`)
    assert.ok(attack.events.some((event) => event.event_type === 'AttackResolved'), JSON.stringify(setup))
  }
  const far = battle({ bard: false, protector: true })
  far.mechanics.positions.knight = { x: 5, y: 4 }
  assert.ok(swing(normalizeCampaignState(far), [18, 3], 'far').events.some((event) => event.event_type === 'AttackResolved'))
  assert.throws(() => answer(battle({ bard: false, protector: true }), 'knight', 'fighter-zaschita', []), { code: /REACTION_TRIGGER_REQUIRED|OUT_OF_TURN/u })
})
