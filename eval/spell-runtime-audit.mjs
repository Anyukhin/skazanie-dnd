// Поимённый прогон команд, а не приёмка полноты правил заклинания.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { canonicalCombatSpellFor, combatSpellFor } from '../server/combat-spells.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { ITEM_CATALOG, materializeCatalogItem } from '../server/item-catalog.mjs'
import { createTacticalMap, serializeTacticalMap, setDoor } from '../server/tactical-map.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const root = new URL('../', import.meta.url)
export const catalog = JSON.parse(readFileSync(new URL('data/dndsu-spells-0-6.json', root), 'utf8')).spells
const FULL_CLASSES = ['wizard', 'cleric', 'druid', 'sorcerer', 'bard', 'warlock']
const economy = () => ({ action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 })
const abilities = { str: 16, dex: 14, con: 14, int: 18, wis: 18, cha: 18 }
export function spellRuntimeFixture(id) {
  const profile = canonicalCombatSpellFor(id, { rulesetId: 'dnd_5e_2014' })
  const characterClass = FULL_CLASSES.find(key => profile.classes.includes(key)) ?? 'wizard'
  const inventory = ['quarterstaff', 'component-pouch', 'longbow', 'arrows-20']
    .map((key, i) => materializeCatalogItem(`srd_5_2_1:${key}`, { id: `gear-${i}`, quantity: 1, equipped: i === 0 }))
  for (const item of Object.values(ITEM_CATALOG).filter(item => item.material_component || item.type === 'book')) {
    inventory.push(materializeCatalogItem(item.catalog_id ?? item.id, { id: `material-${inventory.length}`, quantity: 2 }))
  }
  inventory.push({ id: 'book', catalog_id: 'phb_2014:equipment:book', name: 'Книга', type: 'book', quantity: 1 })
  const caster = { id: 'caster', character: 'Заклинатель', characterClass, level: 12, characterSetupRequired: false,
    hp: 100, maxHp: 100, armor: 14, speed: 30, proficiency: 4, abilities, inventory,
    knownSpellIds: [id], preparedSpellIds: profile.level ? [id] : [], classSkillProficiencies: [], x: 2, y: 2 }
  // Исключительно стенд: паладин/следопыт 12-го уровня не получают ячейки 4–5.
  // Явная выдача источника позволяет проверить handler, но не доказывает
  // доступность заклинания настоящему герою через создание/развитие персонажа.
  if (!profile.classes.includes(characterClass)) caster.creationSpellGrants = [{ id, ability: 'int', uses: 1, source: 'runtime-audit-fixture' }]
  const ally = { ...caster, id: 'ally', character: 'Союзник', characterClass: 'fighter',
    inventory: [], knownSpellIds: [], preparedSpellIds: [], hp: 40, x: 2, y: 3,
    classSkillProficiencies: ['athletics'] }
  const enemy = { id: 'enemy', name: 'Противник', creature_type: profile.requiredCreatureTypes?.[0] ?? 'humanoid',
    hp: 100, maxHp: 100, armor: 10, speed: 30, proficiency: 0, abilities: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
    alive: true, x: 3, y: 2 }
  const state = normalizeCampaignState({ sessionCode: `AUDIT-${id}`, ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'], players: [caster, ally], enemies: [enemy],
    partyMemberIds: ['caster', 'ally'], activePlayerId: 'caster',
    scene: { turn: 1, title: 'Полигон заклинаний', cells: Array.from({ length: 160 }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20), type: 'floor', revealed: true })) },
    mechanics: { world_time: { elapsed_minutes: 0, elapsed_seconds: 0, clock_version: 2 },
      resources: { caster: { ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`spell_slots_${n}`, { current: 3, max: 3 }])),
        pact_slots: { current: 3, max: 3 }, mystic_arcanum_6: { current: 1, max: 1 },
        [`species_spell_${id}`]: { current: 1, max: 1 } } },
      combat: { active: profile.actionType !== 'long_cast', round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'enemy', total: 10 }, { actor_id: 'ally', total: 5 }],
        action_economy: { caster: economy(), enemy: economy(), ally: economy() } } } })
  // Стабилизация действует только на умирающего: союзник стенда лежит с 0 хитов.
  if (profile.stabilizesDying === true) {
    state.players[1].hp = 0
    state.mechanics.death.saving_throws.ally = { successes: 0, failures: 1, stable: false }
    state.mechanics.conditions.ally = [{ id: 'unconscious', duration: null }]
  }
  const runtime = combatSpellFor(state.players[0], id, { rulesetId: state.ruleset_id })
  assert.ok(runtime, `Нет источника заклинания в стенде: ${id}`)
  const command = { command_type: 'CastSpell', command_id: `audit:${id}`, actor_id: 'caster', spell_id: id, server_authoritative: true }
  if (profile.target === 'point') command.to = profile.areaOrigin === 'self' ? { x: 3, y: 2 } : { x: 4, y: 2 }
  if (id === 'cordon-of-arrows') command.to = { x: 3, y: 2 }
  if (profile.target !== 'point' && profile.target !== 'self' || profile.selectTargetsInArea) {
    const target = profile.target === 'ally' || profile.kind === 'healing' ? 'ally' : 'enemy'
    command.target_id = target; command.target_ids = [target]
  }
  if (profile.spellOptions?.length) command.spell_option = profile.spellOptions[0]
  if (id === 'borrowed-knowledge' || id === 'skill-empowerment') command.spell_option = 'athletics'
  if (id === 'shillelagh' || id === 'booming-blade' || id === 'green-flame-blade') command.item_id = 'gear-0'
  if (id === 'knock') {
    const map = createTacticalMap({ width: 20, height: 8, fill: { passable: true, revealed: true, material: 'stone' } })
    setDoor(map, { id: 'locked-door', x: 4, y: 2, dir: 'e', state: 'locked', blocksMove: true, blocksSight: true })
    state.scene.map = serializeTacticalMap(map)
    delete state.scene.cells
  }
  if (id === 'dispel-magic') state.mechanics.active_effects = [{ effect_id: 'dispel-target', spell_id: 'web', source_actor: 'enemy',
    center: { x: 4, y: 2 }, radius: 10, area_shape: 'sphere', spell_level_version: 1, slot_level: 5 }]
  if (profile.actionType === 'reaction' && ['partial', 'verified'].includes(profile.mechanicsSupport)) {
    command.command_type = 'UseCombatAction'; command.action_id = `cast:${id}`
    state.mechanics.combat.reaction_window = {
      id: `window:${id}`, trigger: id === 'counterspell' ? 'spell-cast' : 'attack-hit', actor_id: 'caster', source_actor_id: 'enemy', target_id: 'caster',
      action_ids: [command.action_id], action_options: [{ id: command.action_id, resource: runtime.slotResource, slot_level: runtime.slotLevel ?? profile.level }],
      trigger_roll: { kept: 18, total: 22, modifier: 4, armor_class: 14, hit: true, critical: false },
      damage: { applied_amount: 8, raw_amount: 8, damage_type: id === 'absorb-elements' ? 'fire' : 'slashing', hp_before: 100, hp_after: 92 },
      // Окно Контрзаклинания держит прерываемое заклинание под своим ключом —
      // ровно тем, который читает движок; остальные окна — общей командой.
      [id === 'counterspell' ? 'pending_spell_command' : 'pending_command']: { command_type: 'CastSpell', command_id: 'incoming-spell', actor_id: 'enemy', spell_id: 'fireball', slot_level: 3, to: { x: 2, y: 2 }, server_authoritative: true },
      spell_level: 3, spell_id: 'fireball',
    }
  }
  return { state, command, profile, runtime }
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function dice(id, variant) {
  let counter = 0
  return new DiceService({ rng: { randint: (min, max) => variant === 'low' ? min : max },
    idFactory: () => `audit-roll:${id}:${variant}:${++counter}`, now: () => '2026-09-30T10:00:00.000Z' })
}
export function probeSpellRuntime(id) {
  const { state, command, profile, runtime } = spellRuntimeFixture(id)
  const before = hash(state)
  const context = { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] }
  const result = { spellId: id, name: profile.name, level: profile.level, support: profile.mechanicsSupport,
    supportNote: profile.supportNote ?? null, kind: profile.kind, actionType: profile.actionType,
    fixture: 'synthetic-source-and-materials', acceptance: 'not-assessed', checks: {}, refusals: [], variants: [] }
  function refusal(label, rejectedState, rejectedCommand, expectedCodes) {
    const original = hash(rejectedState)
    let calls = 0
    const service = new DiceService({ rng: { randint: min => { calls++; return min } } })
    assert.throws(() => resolveCommand(rejectedCommand, rejectedState, { diceService: service, context }), error => expectedCodes.includes(error.code), label)
    assert.equal(hash(rejectedState), original, `${label}: отказ изменил состояние`)
    assert.equal(calls, 0, `${label}: отказ бросил кости`)
    result.refusals.push({ scenario: label, inputUnchanged: true, noDice: true })
  }
  try { resolveCommand(command, state, { diceService: dice(id, 'low'), context: { ...context, allowedActorIds: ['ally'] } }); throw new Error('Чужой игрок выполнил заклинание') }
  catch (error) { assert.equal(error.code, 'ACTOR_FORBIDDEN'); result.checks.foreignActorDenied = true }
  if (['partial', 'verified'].includes(profile.mechanicsSupport)) {
    if (runtime.slotResource) {
      const empty = structuredClone(state)
      for (const pool of Object.values(empty.mechanics.resources.caster)) pool.current = 0
      refusal('empty-resources', empty, command, ['INSUFFICIENT_RESOURCE'])
    }
    if (profile.components?.material) {
      const empty = structuredClone(state); empty.players[0].inventory = []
      refusal('missing-materials', empty, command, ['SPELL_MATERIAL_COMPONENT_REQUIRED', 'SPELL_MATERIAL_WEAPON_REQUIRED'])
    }
    if (profile.spellOptions?.length && command.command_type === 'CastSpell') {
      const missing = { ...command }; delete missing.spell_option
      refusal('missing-choice', state, missing, ['SPELL_OPTION_REQUIRED'])
    }
    if (profile.target === 'point') refusal('invalid-point', state, { ...command, to: { x: 9999, y: 9999 } }, ['INVALID_DESTINATION'])
    else if (profile.target !== 'self' && command.command_type === 'CastSpell') {
      refusal('unknown-creature', state, { ...command, target_id: 'unknown-actor', target_ids: ['unknown-actor'] }, ['INVALID_SPELL_TARGET', 'TARGET_NOT_FOUND'])
    }
    if (profile.actionType === 'reaction') {
      const direct = { ...command, command_type: 'CastSpell' }; delete direct.action_id
      refusal('direct-reaction-command-during-window', state, direct, ['COMBAT_REACTION_PENDING'])
      const noWindow = structuredClone(state); delete noWindow.mechanics.combat.reaction_window
      refusal('direct-reaction-command-without-trigger', noWindow, direct, ['REACTION_NOT_AVAILABLE'])
      refusal('reaction-without-trigger', noWindow, command, ['REACTION_NOT_AVAILABLE'])
    }
  }
  for (const variant of ['low', 'high']) {
    try {
      const cast = resolveCommand(command, state, { diceService: dice(id, variant), context })
      assert.ok(['partial', 'verified'].includes(profile.mechanicsSupport), 'Блокируемая карточка выполнилась')
      assert.equal(hash(state), before, 'Разрешение команды изменило исходное состояние')
      let live = cast.events.reduce(applyGameEvent, state)
      const events = [...cast.events]
      let declinedWindows = 0
      while (live.mechanics.combat.reaction_window) {
        assert.ok(declinedWindows < 20, 'Цепочка реакций не завершается')
        const actorId = live.mechanics.combat.reaction_window.actor_id
        const decline = resolveCommand({ command_type: 'UseCombatAction', command_id: `audit:${id}:${variant}:decline:${++declinedWindows}`,
          actor_id: actorId, action_id: 'decline-reaction', server_authoritative: true }, live,
          { diceService: dice(`${id}:decline:${declinedWindows}`, variant), context: { ...context, allowedActorIds: [actorId] } })
        events.push(...decline.events)
        live = decline.events.reduce(applyGameEvent, live)
      }
      const replayed = replayEvents(state, JSON.parse(JSON.stringify(events)))
      assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(live)), 'Сохранённые события меняют результат replay')
      const slot = runtime.slotResource
      const spent = events.filter(event => event.event_type === 'ResourceSpent' && event.actor_id === 'caster' && event.payload.resource === slot)
      assert.equal(spent.length, slot ? 1 : 0, 'Количество оплат заклинания')
      if (slot) assert.equal(live.mechanics.resources.caster[slot].current, state.mechanics.resources.caster[slot].current - 1)
      assert.ok(cast.events.length > 0, 'Нет событий выполненной команды')
      const remaining = ['action', 'bonus_action', 'reaction'].filter(key => live.mechanics.combat.action_economy.caster?.[key] === false)
      result.variants.push({ variant, outcome: 'executed', eventTypes: [...new Set(events.map(event => event.event_type))], declinedWindows,
        resourcesSpent: spent.map(event => event.payload.resource), economySpent: remaining, replay: 'passed' })
    } catch (error) {
      assert.equal(hash(state), before, 'Отказ изменил исходное состояние')
      if (['MECHANICS_NOT_VERIFIED', 'RULING_REQUIRED', 'COMBAT_NOT_ACTIVE', 'SPELL_CAST_TIME_TOO_LONG'].includes(error.code) && !['partial', 'verified'].includes(profile.mechanicsSupport)) {
        result.variants.push({ variant, outcome: 'safely-blocked', code: error.code, reason: error.message })
      } else {
        result.variants.push({ variant, outcome: 'needs-investigation', code: error.code ?? error.name, reason: error.message })
      }
    }
  }
  result.checks.inputUnchanged = hash(state) === before
  result.status = result.variants.every(v => v.outcome === 'executed') ? 'execution-smoke-passed'
    : result.variants.every(v => v.outcome === 'safely-blocked') ? 'blocking-smoke-passed' : 'needs-investigation'
  return result
}

export function auditSpellRuntime() {
  const spells = catalog.map(spell => {
    try { return probeSpellRuntime(spell.id) }
    catch (error) { return { spellId: spell.id, name: spell.name, level: spell.level, status: 'needs-investigation',
      issue: { code: error.code ?? error.name, reason: error.message, cause: error.actual?.code ?? null } } }
  })
  const counts = Object.fromEntries([...new Set(spells.map(spell => spell.status))].map(status => [status, spells.filter(spell => spell.status === status).length]))
  return { schemaVersion: 'spell-runtime-smoke/v1', rulesetId: 'dnd_5e_2014', observedAt: new Date().toISOString(),
    scope: 'All 439 profiles: low/high dice, foreign-actor refusal, atomic resolution, resource accounting and JSON event replay. Synthetic fixtures do not prove source completeness, normal player acquisition, HTTP idempotency or browser/audio acceptance.',
    summary: { catalog: spells.length, ...counts, individuallyAccepted: 0 }, spells }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditSpellRuntime()
  const output = process.argv.indexOf('--output')
  if (output >= 0) writeFileSync(process.argv[output + 1], `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report.summary, null, 2))
  for (const card of report.spells.filter(card => card.status === 'needs-investigation')) console.log(JSON.stringify(card))
  if (report.summary['needs-investigation']) process.exitCode = 1
}
