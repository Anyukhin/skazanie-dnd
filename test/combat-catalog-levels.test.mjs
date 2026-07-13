import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { combatActionsFor, combatClassCatalogInfo, combatResourceMaximumsFor, combatSubclassOptionsFor } from '../server/combat-actions.mjs'
import { combatSpellFor, combatSpellsFor, spellCatalogInfo, spellSelectionRulesFor, spellSlotMaximumsFor } from '../server/combat-spells.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const dice = (values = []) => new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let id = 0; return () => `catalog-roll-${++id}` })(), now: () => '2026-07-13T12:00:00.000Z' })

test('каталог dnd.su содержит все 439 заклинаний 0–6 уровней и фильтруется уровнем класса', () => {
  assert.equal(spellCatalogInfo().count, 439)
  const levelOneWizard = combatSpellsFor({ role: 'Волшебник', level: 1 })
  const levelTwelveWizard = combatSpellsFor({ role: 'Волшебник', level: 12 })
  assert.ok(levelOneWizard.every((spell) => spell.level <= 1))
  assert.ok(levelTwelveWizard.some((spell) => spell.level === 6))
  assert.ok(levelTwelveWizard.length > levelOneWizard.length)
  assert.ok(levelTwelveWizard.every((spell) => spell.sourceUrl.startsWith('https://www.dnd.su/spells/')))
})

test('ячейки заклинаний соответствуют прогрессии классов с 1-го по 12-й уровень', () => {
  assert.deepEqual(spellSlotMaximumsFor({ role: 'Волшебник', level: 12 }), { spell_slots_1: 4, spell_slots_2: 3, spell_slots_3: 3, spell_slots_4: 3, spell_slots_5: 2, spell_slots_6: 1 })
  assert.deepEqual(spellSlotMaximumsFor({ role: 'Паладин', level: 12 }), { spell_slots_1: 4, spell_slots_2: 3, spell_slots_3: 3 })
  assert.deepEqual(spellSlotMaximumsFor({ role: 'Колдун', level: 12 }), { pact_slots: 3, mystic_arcanum_6: 1 })
})

test('каждый из 12 базовых классов получает активные действия и ресурсы своего уровня', () => {
  const expectations = [
    ['Варвар', 'rage'], ['Бард', 'bardic-inspiration'], ['Жрец', 'turn-undead'], ['Друид', 'wild-shape'],
    ['Воин', 'action-surge'], ['Монах', 'flurry-of-blows'], ['Паладин', 'lay-on-hands'], ['Следопыт', 'favored-foe'],
    ['Плут', 'sneak-attack'], ['Чародей', 'quickened-spell'], ['Колдун', 'pact-blade'], ['Волшебник', 'arcane-recovery'],
  ]
  for (const [role, expected] of expectations) {
    const actor = { role, level: 12, abilities: { cha: 16 } }
    assert.ok(combatActionsFor(actor).some((entry) => entry.id === expected), `${role}: ${expected}`)
    assert.ok(combatActionsFor(actor).every((entry) => entry.sourceUrl.startsWith('https://www.dnd.su/')))
    assert.equal(typeof combatResourceMaximumsFor(actor), 'object')
  }
})

test('каталог классов dnd.su покрывает официальные подклассы и активные умения до 12 уровня', () => {
  const info = combatClassCatalogInfo()
  assert.equal(info.rulesProfile, 'dndsu-5e-2014-official')
  assert.equal(info.classes.length, 12)
  assert.equal(info.classes.reduce((sum, entry) => sum + entry.subclasses, 0), 114)
  assert.equal(info.classes.reduce((sum, entry) => sum + entry.actions, 0), 340)
  assert.ok(info.classes.every((entry) => entry.sourceUrl.startsWith('https://www.dnd.su/class/')))
  assert.ok(combatSubclassOptionsFor({ characterClass: 'fighter' }).some((entry) => entry.name === 'Мастер боевых искусств'))
  assert.ok(combatActionsFor({ characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 3 }).some((entry) => entry.id === 'trip-attack'))
  assert.ok(!combatActionsFor({ characterClass: 'fighter', subclass: 'Чемпион', level: 3 }).some((entry) => entry.id === 'trip-attack'))
})

test('лимиты известных и подготовленных заклинаний зависят от класса, уровня и характеристики', () => {
  assert.deepEqual(spellSelectionRulesFor({ characterClass: 'bard', level: 3, abilities: { cha: 16 } }), {
    classKey: 'bard', mode: 'known', cantrips: 2, spellsKnown: 6, preparedLimit: 0, spellbookMinimum: 0, maximumSpellLevel: 2,
  })
  assert.deepEqual(spellSelectionRulesFor({ characterClass: 'wizard', level: 5, abilities: { int: 18 } }), {
    classKey: 'wizard', mode: 'spellbook', cantrips: 4, spellsKnown: 0, preparedLimit: 9, spellbookMinimum: 14, maximumSpellLevel: 3,
  })
  const wizard = { characterClass: 'wizard', level: 5, abilities: { int: 18 }, knownSpellIds: ['fire-bolt', 'fireball'], preparedSpellIds: [] }
  assert.equal(combatSpellsFor(wizard).find((spell) => spell.id === 'fire-bolt')?.prepared, true)
  assert.equal(combatSpellsFor(wizard).find((spell) => spell.id === 'fireball')?.prepared, false)
  assert.equal(combatSpellFor(wizard, 'fireball'), null)
})

test('Огненный шар разрешается как общая область со спасброском и дружественным огнём', () => {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    players: [
      { id: 'wizard', character: 'Мира', role: 'Волшебник', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { int: 18, dex: 12 }, inventory: [], x: 0, y: 1 },
      { id: 'ally', character: 'Союзник', role: 'Воин', level: 5, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { dex: 10 }, inventory: [], x: 5, y: 1 },
    ],
    enemies: [
      { id: 'enemy-a', name: 'A', hp: 30, maxHp: 30, armor: 10, speed: 30, abilities: { dex: 8 }, x: 6, y: 1, alive: true },
      { id: 'enemy-b', name: 'B', hp: 30, maxHp: 30, armor: 10, speed: 30, abilities: { dex: 8 }, x: 4, y: 1, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'wizard', total: 20 }], active_index: 0, action_economy: { wizard: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'wizard', spell_id: 'fireball', to: { x: 6, y: 1 }, server_authoritative: true }, state, { diceService: dice([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2]), context: { serverAuthoritativeCombat: true } })
  const damageTargets = result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.target_ids[0]).sort()
  assert.deepEqual(damageTargets, ['ally', 'enemy-a', 'enemy-b'])
  assert.ok(result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'spell_slots_3'))
})

test('заговор масштабируется на 5-м и 11-м уровнях', () => {
  const fireBolt = combatSpellsFor({ role: 'Волшебник', level: 11 }).find((spell) => spell.id === 'fire-bolt')
  assert.equal(fireBolt.damage, '1d10')
  const cells = Array.from({ length: 6 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const state = normalizeCampaignState({ players: [{ id: 'wizard', character: 'Мира', role: 'Волшебник', level: 11, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 4, abilities: { int: 18 }, inventory: [], x: 0, y: 0 }], enemies: [{ id: 'target', name: 'Цель', hp: 40, maxHp: 40, armor: 10, speed: 30, abilities: {}, x: 2, y: 0, alive: true }], scene: { cells }, mechanics: { combat: { active: true, initiative: [{ actor_id: 'wizard', total: 20 }], active_index: 0, action_economy: { wizard: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } } })
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'wizard', spell_id: 'fire-bolt', target_id: 'target', server_authoritative: true }, state, { diceService: dice([18, 2, 2, 2]), context: { serverAuthoritativeCombat: true } })
  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.damage_expression, '3d10')
})
