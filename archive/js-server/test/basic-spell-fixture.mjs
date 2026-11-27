import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
export const BASIC_IDS = ['poison-spray', 'sacred-flame', 'inflict-wounds', 'cure-wounds', 'healing-word', 'blade-ward', 'bless', 'shield-of-faith']
const CLERIC_IDS = BASIC_IDS.filter(id => !['poison-spray', 'blade-ward'].includes(id))
export function basicFixture({ characterClass = 'cleric', level = 12, subclass = 'Домен войны', combat = false } = {}) {
  const hero = (id, x, extra = {}) => ({ id, character: id, characterClass, level, subclass: ({ life: 'Домен жизни', knowledge: 'Домен знаний' })[subclass] ?? subclass, hp: 40, maxHp: 100, armor: 12, speed: 30, proficiency: level >= 9 ? 4 : level >= 5 ? 3 : 2,
    abilities: { str: 10, dex: 10, con: 12, int: 16, wis: 16, cha: 16 },
    knownSpellIds: characterClass === 'wizard' ? ['poison-spray', 'blade-ward'] : CLERIC_IDS,
    preparedSpellIds: CLERIC_IDS.filter(id => canonicalCombatSpellFor(id).level > 0).slice(0, level === 1 ? 4 : 5),
    inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: `${id}-pouch`, quantity: 1 })], x, y: 1, ...extra })
  return normalizeCampaignState({ sessionCode: 'BASIC2014', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    partyMemberIds: ['caster', 'ally', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'], players: [hero('caster', 1), hero('ally', 2), ...['third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'].map((id, i) => hero(id, 3 + i))],
    enemies: [{ id: 'enemy', name: 'Цель', hp: 100, maxHp: 100, armor: 12, speed: 30, x: 2, y: 2, creature_type: 'humanoid', abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } }],
    scene: { cells: Array.from({ length: 144 }, (_, i) => ({ x: i % 12, y: Math.floor(i / 12), type: 'floor', revealed: true })) },
    mechanics: { resources: { caster: Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`spell_slots_${level}`, { current: 3, max: 3 }])) }, combat: { active: combat, round: 1, active_index: 0, initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'enemy', total: 10 }], action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true } } } } })
}
export function basicRun(state, command, values = []) {
  let id = 0
  return resolveCommand({ command_id: 'basic-cast', actor_id: 'caster', server_authoritative: true, ...command }, state, { diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `basic-roll-${++id}` }), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}
