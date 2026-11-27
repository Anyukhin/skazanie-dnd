import '../../../fixtures-env.mjs'
// Эталоны для сверки уже перенесённого (задача Р0): экономика хода
// (`rules-engine.mjs`, 9336–9509, 23645–23796, 24114–24198), тактический ход
// `synchronizeTacticalTurn` (24097) и журналы (24002–24072). Состояния —
// случайные бои с героями разных классов и уровней, монстрами с мультиатакой
// и мусорной экономикой; функции JS правят копию состояния, эталон —
// экономика или журнал после вызова.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-turn-economy.mjs
import { writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const clone = (value) => (value === undefined ? undefined : structuredClone(value))
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

let seed = 0xec0e0001
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p

const heroes = [
  { id: 'fighter', characterClass: 'fighter', level: 5 }, { id: 'veteran', characterClass: 'fighter', level: 11 }, { id: 'mage', characterClass: 'wizard', level: 6, role: 'Маг' },
  { id: 'monk', characterClass: 'monk', level: 5 }, { id: 'bard', characterClass: 'bard', level: 6, subclass: 'College of Valor' }, { id: 'rogue', role: 'плут', level: 3 },
  { id: 'paladin', role: 'Паладин', level: 7 }, { id: 'ranger', characterClass: 'ranger', level: 4 },
]
const monsters = [
  { id: 'ogre', traits: [{ id: 'multiattack', attacks: 2 }], action_profiles: [{ id: 'club' }] },
  { id: 'owlbear', traits: [{ id: 'multiattack', sequence: ['beak', 'claws'] }], action_profiles: [{ id: 'beak' }, { id: 'claws' }] },
  { id: 'drake', traits: [{ id: 'multiattack', action_counts: { bite: 1, claw: 2, '': 3 } }], action_profiles: [{ id: 'bite' }, { id: 'claw' }] },
  { id: 'harpy', traits: [{ id: 'multiattack', sequences: [['claws', 'club'], ['claws']], sequence_conditions: [null, { requires: 'flying' }] }], action_profiles: [{ id: 'claws' }, { id: 'club' }], movement_mode: 'fly' },
  { id: 'goblin', traits: ['nimble-escape'], action_profiles: [{ id: 'scimitar' }] },
]
const kinds = ['normal', 'extra', 'surge', 'haste', 'weird', undefined]
function randomLoading() {
  if (chance(0.3)) return undefined
  if (chance(0.1)) return pick(['x', [], null])
  return { action: pick([[], ['bow'], ['bow', ' bow', 'bow'], 'bow']), ...(chance(0.6) ? { bonus_action: pick([[], ['hand-xbow']]) } : {}), ...(chance(0.3) ? { reaction: ['bow'] } : {}) }
}
function randomFrame() {
  return { id: pick(['f-1', 'f-2', '', 7]), kind: pick(kinds), limit: pick([1, 2, 3, '2', 0, undefined]), attacks_used: pick([0, 1, 2, -1, '1', undefined]), loading_weapon_item_ids: randomLoading() }
}
function randomEconomy() {
  const economy = {}
  const set = (key, values) => { if (chance(0.7)) economy[key] = pick(values) }
  set('action', [true, false, true, 1])
  set('bonus_action', [true, false])
  set('reaction', [true, false])
  set('movement', [true, false])
  set('object_interaction', [true, false])
  set('movement_spent', [0, 15, '10', -5])
  set('extra_actions', [0, 1, 2, '1', -1])
  set('surged_action_only', [false, true])
  set('attacks_used', [0, 1, 2, '1'])
  set('attacks_allowed', [1, 2, 3])
  set('action_economy_version', [2, 1, undefined, '2'])
  if (chance(0.6)) economy.attack_action_id = pick(['attack-action:c1', '', 'f-0'])
  set('attack_action_kind', kinds)
  set('attack_action_limit', [1, 2, 3, '3', 0])
  if (chance(0.4)) economy.attack_action_stack = pick([[], [randomFrame()], [randomFrame(), randomFrame()], 'x', [null, randomFrame()]])
  if (chance(0.5)) economy.loading_weapon_item_ids = randomLoading()
  set('extra_action_kind', kinds)
  set('extra_action_limit', [1, 2])
  set('multiattack_action_id', ['bite', null])
  set('multiattack_action_ids', [['bite'], [null, 5], 'x'])
  return JSON.parse(JSON.stringify(economy))
}
function randomState() {
  const actors = [pick(heroes), pick(heroes), pick(monsters), pick(monsters)]
  const players = actors.filter((actor) => !actor.traits).map((actor) => ({ ...actor, hp: 10 }))
  const enemies = actors.filter((actor) => actor.traits).map((actor) => ({ ...actor, hp: 10 }))
  const ids = [...new Set(actors.map((actor) => actor.id))]
  const economy = {}
  for (const id of ids) if (chance(0.8)) economy[id] = randomEconomy()
  const conditions = {}
  for (const id of ids) if (chance(0.3)) conditions[id] = [pick([{ id: 'hasted' }, 'hasted', { id: 'slowed' }])]
  const initiative = ids.map((id) => ({ actor_id: id }))
  return JSON.parse(JSON.stringify({
    ruleset_id: pick(['dnd_5e_2014', 'srd_5_2_1']),
    state_version: pick([3, 7]),
    scene: chance(0.8) ? { turn: pick([4, '5', 2.5, null]) } : {},
    players: players.filter((value, index, list) => list.findIndex((item) => item.id === value.id) === index),
    enemies: enemies.filter((value, index, list) => list.findIndex((item) => item.id === value.id) === index),
    actors: [],
    battleLog: [], mapFeedback: [], economyLog: [],
    mechanics: {
      combat: { active: pick([true, true, true, false, 1]), round: pick([1, 2, '3']), active_index: pick([0, 1, 2, -1, 9, '1']), initiative: chance(0.9) ? initiative : [], action_economy: economy },
      conditions,
    },
  }))
}

const states = Array.from({ length: 160 }, randomState)
const cases = { helpers: [], spend: [], attack: [], sync: [], limits: [], turn_key: [], journal: [] }

for (const raw of [undefined, null, 'x', [], {}, { action: ['a', 'a', ' b '], bonus_action: 'x', reaction: [null, 5] }, { action: [], other: ['z'] }]) {
  const economy = { foo: 1, loading_weapon_item_ids: raw }
  cases.helpers.push({
    raw: raw === undefined ? '__undefined__' : raw,
    normalized: E.normalizeLoadingWeaponItemIds(raw),
    with_item: ['action', 'bonus_action', 'reaction'].map((resource) => ['bow', '', null, 5, 'a'].map((item) => E.withLoadingWeaponItem(economy, resource, item))),
    cleared: ['action', 'bonus_action', 'reaction'].map((resource) => E.clearLoadingWeaponResource(economy, resource)),
  })
}
cases.frames = Array.from({ length: 120 }, () => {
  const economy = randomEconomy()
  const frame = E.attackActionFrameFromEconomy(economy)
  return { economy, frame, pending: E.pendingAttackActionFrames(economy), with_frame: frame ? E.attackActionEconomyWithFrame(economy, frame) : null, version: E.actionEconomyEventVersion(economy) }
})
cases.loading_resource = []
for (const reactionAttack of [true, false]) for (const payload of [null, {}, { loading_action_type: 'bonus_action' }, { loading_action_type: 'reaction' }, { loading_action_type: ['action'] }, { loading_action_type: 'x' }]) {
  cases.loading_resource.push({ reaction_attack: reactionAttack, payload, expected: E.loadingResourceFor({ reaction_attack: reactionAttack }, {}, payload) })
}

for (const [stateIndex, state] of states.entries()) {
  const ids = [...state.players, ...state.enemies].map((actor) => actor.id)
  for (const id of [...ids, 'ghost']) {
    for (const call of ['combat:action', 'combat:bonus_action', 'combat:reaction', 'combat:magic', 'combat:normal', 'frame', 'frame:surge', 'frame:haste', 'spell', 'only', 'replacement']) {
      if (!chance(0.35)) continue
      const copy = clone(state)
      if (call.startsWith('combat:')) {
        const kind = call.slice(7)
        const resource = ['magic', 'normal'].includes(kind) ? 'action' : kind
        E.spendCombatEconomy(copy, id, resource, { magic: kind === 'magic', normalActionOnly: kind === 'normal' })
      } else if (call === 'frame') E.spendVersionedActionFrame(copy, id)
      else if (call === 'frame:surge') E.spendVersionedActionFrame(copy, id, { allowSurge: false })
      else if (call === 'frame:haste') E.spendVersionedActionFrame(copy, id, { allowHaste: true })
      else if (call === 'spell') E.spendVersionedSpellAction(copy, id)
      else if (call === 'only') E.spendVersionedActionOnly(copy, id)
      else E.spendVersionedAttackReplacement(copy, id)
      cases.spend.push({ state: stateIndex, id, call, expected: copy.mechanics.combat.action_economy[id] ?? null })
    }
    if (chance(0.6)) {
      const copy = clone(state)
      const payload = JSON.parse(JSON.stringify({
        attack_action_resource: pick(['action', 'action', 'bonus_action', undefined, ['action']]),
        ...(chance(0.2) ? { reaction_attack: pick([true, 'yes']) } : {}),
        attack_action_boundary: pick(['start', 'continue', undefined, 5]),
        attack_action_kind: pick(kinds),
        ...(chance(0.6) ? { attack_action_limit: pick([1, 2, 3, '2', 0]) } : {}),
        ...(chance(0.5) ? { attack_action_id: pick(['a-1', 7, null]) } : {}),
        ...(chance(0.4) ? { loading_weapon: pick([true, 1]), loading_limit_applies: pick([true, false, undefined]), item_id: pick(['bow', 5, null, undefined]) } : {}),
        ...(chance(0.3) ? { loading_action_type: pick(['bonus_action', 'reaction', 'x']) } : {}),
        ...(chance(0.4) ? { action_id: pick(['bite', 'claws', '', 0]) } : {}),
      }))
      const event = JSON.parse(JSON.stringify({ event_type: 'AttackResolved', actor_id: id, ...(chance(0.7) ? { command_id: pick(['cmd-1', '']) } : {}), ...(chance(0.4) ? { event_id: pick(['e-1', 9]) } : {}) }))
      E.applyVersionedAttackEconomy(copy, event, payload)
      cases.attack.push({ state: stateIndex, event, payload, expected: copy.mechanics.combat.action_economy[id] ?? null })
    }
    const actor = [...state.players, ...state.enemies].find((candidate) => candidate.id === id) ?? null
    if (actor && chance(0.5)) {
      cases.limits.push({
        state: stateIndex, id, actor,
        allowed: E.allowedWeaponAttacks(state, actor, id),
        normal: E.weaponAttackLimitForAction(state, actor, id, {}),
        multiattack: E.weaponAttackLimitForAction(state, actor, id, { monster_ability: 'multiattack' }),
      })
    }
  }
  const copy = clone(state)
  E.synchronizeTacticalTurn(copy)
  cases.sync.push({ state: stateIndex, expected: { activePlayerId: copy.activePlayerId ?? null, tacticalTurn: copy.tacticalTurn ?? null } })
  cases.turn_key.push({ state: stateIndex, fallback: 'ghost', expected: E.combatTurnKey(state, 'ghost') })
}

// ---------- журналы ----------
for (let index = 0; index < 150; index += 1) {
  const stateIndex = Math.floor(random() * states.length)
  const state = clone(states[stateIndex])
  if (chance(0.5)) state.battleLog = Array.from({ length: pick([0, 3, 50]) }, (_, n) => ({ id: pick([`e-${n}`, `cmd:Damage:${n}`, n]), type: 'attack', ...(chance(0.3) ? { spellId: pick(['fire-bolt', 5]), spellName: pick(['Огненный снаряд', '', 7]) } : {}) }))
  if (chance(0.3)) state.mapFeedback = Array.from({ length: pick([0, 6]) }, (_, n) => ({ id: `f-${n}` }))
  const event = JSON.parse(JSON.stringify({ event_type: pick(['DamageApplied', 'AttackResolved']), ...(chance(0.6) ? { command_id: pick(['cmd', 'e-1']) } : {}), ...(chance(0.4) ? { event_id: pick(['e-1', 'e-2', 3]) } : {}), actor_id: pick(['fighter', 'ogre', 'ghost']) }))
  const entry = { type: 'note', ...(chance(0.3) ? { id: 'override' } : {}), value: index }
  const battle = clone(state)
  E.appendBattleLog(battle, event, entry)
  const feedback = clone(state)
  E.appendMapFeedback(feedback, event, entry)
  const economy = clone(state)
  E.appendEconomyLog(economy, event, entry)
  const spell = pick([undefined, null, '', 'fire-bolt', 5, 0])
  const payload = JSON.parse(JSON.stringify({ name: pick([undefined, 'Дыхание', 0]), action_id: pick(['breath', undefined]), area: chance(0.8) ? {
    from: pick([{ x: 1, y: 2 }, { x: '3', y: '4' }, { x: '', y: 0 }, { x: '0x10', y: 1 }, null, 'xy', { x: [5], y: 1 }]),
    to: pick([{ x: 5, y: 5 }, { x: 1.5, y: 2 }, { x: 2, y: 3 }]),
    shape: pick(['cone', 'line', 'sphere', 'cube', undefined]), size_feet: pick([15, 2, '30', undefined]), target_ids: pick([['a', 5, null], undefined, 'x']),
    damage_type: pick(['fire', '', undefined]), save_ability: pick(['dex', undefined]),
  } : undefined }))
  cases.journal.push({
    state: stateIndex, battle_log_before: state.battleLog, map_feedback_before: state.mapFeedback, event, entry,
    journal_id: E.eventJournalId(state, event),
    battle_log: battle.battleLog, map_feedback: feedback.mapFeedback, economy_log: economy.economyLog,
    spell_id: spell === undefined ? '__undefined__' : spell, spell_name: E.recentBattleSpellName(state, spell) ?? null,
    payload, area: E.battleLogAreaFromPayload(state, event, payload) ?? null,
  })
}
cases.endpoints = [undefined, null, [], [{ x: 1, y: 1 }], [{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: '1', y: 2 }, null, { x: 3, y: '4' }], [[1], { x: 1, y: 1 }], [{ x: 1.5, y: 1 }, { x: 1, y: 1 }], 'ab']
  .map((value) => ({ value: value === undefined ? '__undefined__' : value, expected: E.attackEndpointsFor(value) }))

const out = { source_sha256: sourceSha256(), states, cases: json(cases) }
writeFileSync(new URL('turn-economy.json', import.meta.url), `${JSON.stringify(out)}\n`)
console.log('turn-economy.json:', Object.entries(out.cases).map(([key, list]) => `${key} ${list.length}`).join(', '))
