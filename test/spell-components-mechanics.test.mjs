import assert from 'node:assert/strict'
import test from 'node:test'
import { combatSpellFor, monsterCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { createItemInstance } from '../server/item-instances.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand, spellComponentAvailabilityFor } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const item = (id, equipped = false) => materializeCatalogItem(`srd_5_2_1:${id}`, { id, quantity: 1, equipped })
function fixture({ inventory = [], conditions = [], characterClass = 'wizard', ruleset = 'dnd_5e_2014',
  known = ['magic-missile', 'fireball', 'chromatic-orb', 'shield', 'absorb-elements'] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'COMPONENTS', ruleset_id: ruleset, ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'], partyMemberIds: ['caster', 'ally'],
    players: [{ id: 'caster', character: 'Заклинатель', characterClass, level: 12, hp: 60, maxHp: 60, armor: 15, speed: 30,
      x: 1, y: 1, inventory, currency: { gold: 1000 }, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 18 },
      knownSpellIds: known, preparedSpellIds: known },
    { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1, hp: 10, maxHp: 10, x: 0, y: 0, inventory: [] }],
    enemies: [{ id: 'enemy', name: 'Цель', hp: 200, maxHp: 200, armor: 10, alive: true, x: 7, y: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } }],
    scene: { cells: Array.from({ length: 40 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true })) },
    mechanics: { conditions: { caster: conditions.map(id => ({ id, duration: 'until-used' })) }, combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'enemy', total: 10 }],
      action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true }, enemy: { action: true, reaction: true } } } },
  })
}

function cast(state, spellId = 'magic-missile', values = [3], extra = {}) {
  let roll = 0
  return resolveCommand({ command_type: 'CastSpell', command_id: `components:${spellId}`, actor_id: 'caster', spell_id: spellId,
    target_id: 'enemy', server_authoritative: true, ...extra }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `component-roll:${++roll}` }),
    context: { serverAuthoritativeCombat: true },
  })
}

const after = (state, events) => events.reduce(applyGameEvent, state)
const availability = (state, id) => spellComponentAvailabilityFor(state, state.players[0], combatSpellFor(state.players[0], id, { rulesetId: state.ruleset_id }))

test('отчисления не заменяются кошельком или сумкой компонентов до реализации отдельного платежа', () => {
  for (const id of ['jims-magic-missile', 'jims-glowing-coin', 'gift-of-gab']) {
    const state = fixture({ known: [id], inventory: [item('component-pouch')] })
    const before = structuredClone(state)
    assert.equal(availability(state, id).code, 'SPELL_SPECIAL_COMPONENT_UNSUPPORTED', id)
    assert.throws(() => cast(state, id, []), error => error.code === (id === 'gift-of-gab' ? 'RULING_REQUIRED' : 'MECHANICS_NOT_VERIFIED'), id)
    assert.deepEqual(state, before, 'отказ не тратит ни деньги, ни ячейку, ни действие')
  }
})

test('Magic Missile требует V/S, но не требует вещи или оплаты компонента', () => {
  const state = fixture()
  const result = cast(state)
  assert.equal(result.events.some(event => event.event_type === 'ItemConsumed'), false)
  assert.equal(result.events.filter(event => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(after(state, result.events).enemies[0].hp, 188)
  assert.deepEqual(after(state, JSON.parse(JSON.stringify(result.events))), after(state, result.events))
})

test('слова невозможны в текущей области Silence, но deafened само по себе не запрещает речь', () => {
  const state = fixture({ conditions: ['deafened'] })
  assert.equal(availability(state, 'magic-missile').available, true)
  state.mechanics.active_effects.push({ effect_id: 'silence:one', spell_id: 'silence', center: { x: 1, y: 1 }, radius_feet: 20, area_shape: 'sphere' })
  const before = structuredClone(state)
  assert.throws(() => cast(state), error => error.code === 'SPELL_VERBAL_COMPONENT_BLOCKED')
  assert.deepEqual(state, before, 'отказ не расходует ячейку, действие или предмет')
  state.mechanics.active_effects = []
  assert.equal(availability(state, 'magic-missile').available, true)
})

test('занятые оружием и щитом руки блокируют S; War Caster разрешает жесты', () => {
  const state = fixture({ inventory: [item('longsword', true), item('shield', true)] })
  assert.throws(() => cast(state), error => error.code === 'SPELL_SOMATIC_COMPONENT_BLOCKED')
  state.players[0].creationBenefits = { somatic_components_with_hands_full: true }
  assert.equal(availability(state, 'magic-missile').available, true)
  assert.ok(cast(state).events.some(event => event.event_type === 'SpellCast'))
})

test('Subtle 2014 убирает V/S, но не снабжает материальным компонентом', () => {
  const state = fixture({ conditions: ['silenced', 'metamagic-subtle'], inventory: [item('longsword', true), item('shield', true)] })
  assert.equal(availability(state, 'magic-missile').available, true)
  assert.ok(cast(state).events.some(event => event.event_type === 'SpellCast'))
  assert.equal(availability(state, 'fireball').code, 'SPELL_MATERIAL_COMPONENT_REQUIRED')
})

test('Fireball принимает реальный pouch или классовый focus, но не название или поддельные metadata', () => {
  const forged = fixture({ inventory: [{ id: 'fake', type: 'other', name: 'Мешочек с компонентами', quantity: 1, component_pouch: true }] })
  assert.equal(availability(forged, 'fireball').code, 'SPELL_MATERIAL_COMPONENT_REQUIRED')
  for (const catalogId of ['component-pouch', 'arcane-focus-wand']) {
    const state = fixture({ inventory: [item(catalogId)] })
    const result = cast(state, 'fireball', [1, 1, 1, 1, 1, 1, 1, 1, 10], { to: { x: 7, y: 1 } })
    assert.equal(after(state, result.events).enemies[0].hp, 192)
    assert.equal(result.events.some(event => event.event_type === 'ItemConsumed'), false)
  }
  assert.equal(availability(fixture({ inventory: [item('druidic-focus-mistletoe')] }), 'fireball').available, false)
})

test('Chromatic Orb требует алмаз, не золото/название/фокус; успешный каст сохраняет алмаз', () => {
  for (const inventory of [[], [item('arcane-focus-wand')], [{ id: 'fake', type: 'treasure', name: 'Алмаз', quantity: 1,
    base_price_cp: 5000, material_component: { kind: 'diamond', value_cp: 5000 } }]]) {
    const state = fixture({ inventory })
    const before = structuredClone(state)
    assert.throws(() => cast(state, 'chromatic-orb', [], { spell_option: 'fire' }), error => error.code === 'SPELL_MATERIAL_COMPONENT_REQUIRED')
    assert.deepEqual(state, before)
  }
  const state = fixture({ inventory: [item('diamond-50gp')] })
  const result = cast(state, 'chromatic-orb', [15, 5, 4, 3], { spell_option: 'fire' })
  const final = after(state, result.events)
  assert.equal(final.enemies[0].hp, 188)
  assert.equal(final.players[0].inventory.find(entry => entry.id === 'diamond-50gp').quantity, 1)
  assert.equal(final.players[0].currency.gold, 1000)
  assert.equal(result.events.some(event => event.event_type === 'ItemConsumed'), false)
})

test('War Caster не создаёт руку для дорогого M', () => {
  const state = fixture({ inventory: [item('diamond-50gp'), item('longsword', true), item('shield', true)] })
  state.players[0].creationBenefits = { somatic_components_with_hands_full: true }
  assert.equal(availability(state, 'chromatic-orb').code, 'SPELL_MATERIAL_HAND_REQUIRED')
})

test('оружейный компонент нужно держать: меч в сумке не делает безоружный удар клинком', () => {
  const state = fixture({ known: ['booming-blade'], inventory: [item('longsword')] })
  assert.equal(availability(state, 'booming-blade').code, 'SPELL_MATERIAL_WEAPON_REQUIRED')
  state.players[0].inventory[0].equipped = true
  assert.equal(availability(state, 'booming-blade').available, true)
})

test('рука с фокусом подходит для S/M вместе, но не заменяет свободную руку у S-only', () => {
  const state = fixture({ inventory: [item('arcane-focus-wand', true), item('shield', true)] })
  assert.equal(availability(state, 'fireball').available, true)
  assert.equal(availability(state, 'magic-missile').code, 'SPELL_SOMATIC_COMPONENT_BLOCKED')
})

test('надетый святой символ заменяет M, но сам по себе не освобождает руки для S', () => {
  const state = fixture({ characterClass: 'cleric', inventory: [item('holy-symbol-amulet', true), item('longsword', true), item('shield', true)] })
  state.players[0].creationBenefits = { domain_spells: ['fireball'] }
  assert.equal(availability(state, 'fireball').code, 'SPELL_SOMATIC_COMPONENT_BLOCKED')
  state.players[0].creationBenefits.somatic_components_with_hands_full = true
  assert.equal(availability(state, 'fireball').available, true)
})

test('подходящий фокус в руке учитывается независимо от порядка надетых амулетов', () => {
  for (const inventory of [
    [item('holy-symbol-amulet', true), item('holy-symbol-reliquary', true), item('shield', true)],
    [item('shield', true), item('holy-symbol-reliquary', true), item('holy-symbol-amulet', true)],
  ]) {
    const state = fixture({ characterClass: 'cleric', inventory })
    state.players[0].creationBenefits = { domain_spells: ['fireball'] }
    assert.equal(availability(state, 'fireball').available, true)
  }
})

test('явное освобождение NPC от M/S сохраняется, но не переносится на другое заклинание', () => {
  const state = fixture()
  const npc = { ...state.enemies[0], spellcasting: { ability: 'int', save_dc: 15, spells: [
    { id: 'fireball', uses: 'at-will', components_not_required: ['material', 'somatic'] },
    { id: 'chromatic-orb', uses: 'at-will' },
  ] } }
  const fireball = monsterCombatSpellFor(npc, 'fireball', { rulesetId: 'dnd_5e_2014' })
  assert.deepEqual(fireball.components, { verbal: true, somatic: false, material: null })
  assert.equal(spellComponentAvailabilityFor(state, npc, fireball).available, true)
  assert.equal(monsterCombatSpellFor(npc, 'chromatic-orb', { rulesetId: 'dnd_5e_2014' }).components.material.costGp, 50)
})

test('проекция раскрывает причину компонентов только владельцу карточки', () => {
  const state = fixture()
  const own = campaignStateForViewer(state, { role: 'player', playerId: 'caster' }, 'caster')
  const other = campaignStateForViewer(state, { role: 'player', playerId: 'ally' }, 'ally')
  assert.equal(own.players.find(player => player.id === 'caster').combatSpells.find(spell => spell.id === 'chromatic-orb').componentAvailability.available, false)
  assert.equal(other.players.find(player => player.id === 'caster').combatSpells.some(spell => spell.componentAvailability), false)
})

test('legacy ruleset не получает компоненты и отказы другой редакции', () => {
  const state = fixture({ ruleset: 'srd_5_2_1', conditions: ['silenced'], inventory: [item('longsword', true), item('shield', true)] })
  assert.equal(combatSpellFor(state.players[0], 'magic-missile').components, undefined)
  assert.ok(cast(state).events.some(event => event.event_type === 'SpellCast'))
})

test('ожидающее решение не позволяет начать второе заклинание поверх первого', () => {
  const initial = fixture()
  initial.mechanics.combat.active_index = 1
  initial.enemies[0].spellcasting = { ability: 'int', save_dc: 12, attack_bonus: 4, spells: [{ id: 'magic-missile', uses: 'at-will' }] }
  const enemyCast = (commandId, state) => resolveCommand({ command_type: 'CastSpell', command_id: commandId,
    actor_id: 'enemy', spell_id: 'magic-missile', target_id: 'caster', server_authoritative: true }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([3]), idFactory: () => `pending:${commandId}` }),
    context: { serverAuthoritativeCombat: true, isNpcScheduler: true },
  })
  const opened = enemyCast('first-cast', initial)
  const pending = after(initial, opened.events)
  assert.equal(pending.mechanics.combat.reaction_window.trigger, 'magic-missile-shield-choice')
  const before = structuredClone(pending)
  assert.throws(() => enemyCast('second-cast', pending), error => error.code === 'COMBAT_REACTION_PENDING')
  assert.deepEqual(pending, before)
})

test('Greater Restoration расходует одну порцию алмазной пыли, а не деньги или обычный алмаз', () => {
  const state = fixture({ characterClass: 'cleric', known: ['greater-restoration'], inventory: [
    { ...item('material-diamond-dust-100gp'), quantity: 2 },
  ] })
  state.mechanics.conditions.ally = [{ id: 'petrified', duration: 'until-removed' }]
  const result = cast(state, 'greater-restoration', [], { target_id: 'ally', spell_option: 'petrified' })
  const final = after(state, result.events)
  assert.equal(result.events.filter(event => event.event_type === 'ItemConsumed').length, 1)
  assert.equal(final.players[0].inventory.find(entry => entry.id === 'material-diamond-dust-100gp').quantity, 1)
  assert.equal(final.players[0].currency.gold, 1000)
  assert.equal((final.mechanics.conditions.ally ?? []).some(condition => condition.id === 'petrified'), false)
  assert.deepEqual(after(state, JSON.parse(JSON.stringify(result.events))), final)
  const missing = fixture({ characterClass: 'cleric', known: ['greater-restoration'], inventory: [item('diamond-50gp')] })
  assert.throws(() => cast(missing, 'greater-restoration', [], { target_id: 'ally', spell_option: 'petrified' }),
    error => error.code === 'SPELL_MATERIAL_COMPONENT_REQUIRED')
})

for (const scenario of [
  { label: 'успешная отмена', action: 'cast:counterspell', rolls: [20], countered: true },
  { label: 'неудачная отмена', action: 'cast:counterspell', rolls: [1], countered: false },
  { label: 'отказ от реакции', action: 'decline-reaction', rolls: [], countered: false },
]) test(`Counterspell: ${scenario.label} сохраняет однократный расход компонента и применения NPC`, () => {
  const initial = fixture({ known: ['counterspell'] })
  initial.mechanics.combat.active_index = 1
  initial.enemies[0].spellcasting = { ability: 'wis', save_dc: 16, attack_bonus: 8,
    spells: [{ id: 'greater-restoration', uses: 1 }] }
  initial.enemies[0].loadout = { items: [createItemInstance({
    catalogId: 'srd_5_2_1:material-diamond-dust-100gp', instanceId: 'npc-dust', quantity: 2,
    owner: { kind: 'enemy', actor_id: 'enemy' },
    origin: { kind: 'enemy_loadout', source_id: 'component-test' },
  })] }
  const dice = new DiceService({ rng: new SequenceDiceRng(scenario.rolls), idFactory: () => 'counterspell-component-roll' })
  const opened = resolveCommand({ command_type: 'CastSpell', command_id: 'npc-restoration', actor_id: 'enemy',
    spell_id: 'greater-restoration', spell_option: 'exhaustion', target_id: 'enemy', server_authoritative: true }, initial,
  { diceService: dice, context: { serverAuthoritativeCombat: true, isNpcScheduler: true } })
  const pending = after(initial, opened.events)
  assert.equal(pending.mechanics.combat.reaction_window.trigger, 'spell-cast')
  assert.equal(pending.enemies[0].loadout.items[0].quantity, 2)
  const counter = resolveCommand({ command_type: 'UseCombatAction', command_id: 'counter-restoration', actor_id: 'caster',
    action_id: scenario.action, server_authoritative: true }, pending, { diceService: dice, context: { serverAuthoritativeCombat: true } })
  const final = after(pending, counter.events)
  assert.equal(counter.events.some(event => event.event_type === 'SpellCountered'), scenario.countered)
  assert.equal(counter.events.filter(event => event.event_type === 'NpcEquipmentSpent').length, 1)
  assert.equal(counter.events.find(event => event.event_type === 'NpcEquipmentSpent').visibility, 'gm_only')
  assert.equal(final.enemies[0].loadout.items[0].quantity, 1)
  assert.ok(final.mechanics.conditions.enemy.some(condition => condition.id === 'monster-spell-used:greater-restoration#1'))
  assert.deepEqual(after(pending, JSON.parse(JSON.stringify(counter.events))), final)
})
