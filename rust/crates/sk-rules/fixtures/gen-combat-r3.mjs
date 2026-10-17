import '../../../fixtures-env.mjs'
// Эталоны задачи Р3: оружие и профили атаки, умения классов, предметы NPC,
// монстры и легендарные действия, экономика хода и `assertTurn`, сборка
// встречи; блоки `validateCommand` 50–53 (актёр, цели, полномочия, ход).
//
// Состояния трёх родов, все — после `normalizeCampaignState` (так их видят
// функции движка):
// - синтетические: герои и противники из корпуса (настоящие стат-блоки,
//   инвентари, легендарные блоки), переставленные в случайный бой — состояния,
//   экономика хода (обычная и версионная, кадры Атаки), инициатива и группы,
//   окна реакции, ресурсы, мир NPC;
// - корпус как есть (`tmp/corpus-v1/states`);
// - состояния записей корпуса для блоков 50–53: команда записи проходит
//   `normalizeCommand` и блоки 2–49 в JS, затем каждый из блоков 50–53.
//
// Вызов — `{ f, s, a, o }`, как у `gen-vitals.mjs` (`U` — `undefined`,
// `{ "$actor": id }` — участник состояния по ссылке, выход `ok`/`err`/`fault`,
// длинный JSON — `sha256:`). Контекст с серверными маркерами — поле `__marks`
// (`monk`, `loading`, `offhand`, `divine`). Файл пишется gzip (`combat-r3.json.gz`).
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-combat-r3.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { materializeCatalogItem } from '../../../../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { npcUsableItems, npcWeaponBindings } from '../../../../server/npc-equipment.mjs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
// `command_id` записей корпуса без него — предсказуемый, иначе эталон менялся бы от запуска к запуску.
let uuidCounter = 0
globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++uuidCounter}`
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0003_5eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'

function out(value) {
  if (value === undefined) return U
  if (value instanceof Set) value = [...value]
  if (value instanceof Map) value = [...value]
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 200 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    // Отказ с кодом (`RulesValidationError`, `EncounterAssemblyError`,
    // `AuthoredNpcValidationError`) — отказ правила; прочее — ошибка JS.
    if (error?.name !== 'RulesValidationError' && typeof error?.code !== 'string') return { fault: String(error?.name), message: String(error?.message ?? '') }
    return { err: [error.code, error.message] }
  }
}

// --- пулы участников из корпуса --------------------------------------------------

const statesDir = join(corpusDir, 'states')
const players = []
const enemies = []
const scenes = []
const swingScenes = []
const special = []
const corpusStates = []
const seenActors = new Set()
if (existsSync(statesDir)) {
  const files = readdirSync(statesDir).sort()
  for (const file of files) {
    if (players.length >= 300 && enemies.length >= 300 && corpusStates.length >= 60 && swingScenes.length >= 8) break
    const path = join(statesDir, file)
    const size = statSync(path).size
    if (size > 60_000) {
      // Сцены с люстрой живут в больших состояниях: берём из них только сцену.
      if (swingScenes.length < 8 && size < 400_000) {
        const text = readFileSync(path, 'utf8')
        if (text.includes('chandelier')) {
          const scene = JSON.parse(text).scene
          if (Array.isArray(scene?.cells) && JSON.stringify(scene?.map ?? '').includes('chandelier')) swingScenes.push(scene)
        }
      }
      continue
    }
    const state = JSON.parse(readFileSync(path, 'utf8'))
    for (const actor of state.players ?? []) {
      const key = sha(actor)
      if (players.length < 300 && !seenActors.has(key) && chance(0.5)) { seenActors.add(key); players.push(actor) }
    }
    for (const actor of state.enemies ?? []) {
      const key = sha(actor)
      if (enemies.length < 300 && !seenActors.has(key) && chance(0.6)) { seenActors.add(key); enemies.push(actor) }
    }
    if (scenes.length < 40 && Array.isArray(state.scene?.cells) && state.scene.cells.length && chance(0.2)) scenes.push(state.scene)
    if (swingScenes.length < 15 && Array.isArray(state.scene?.cells) && JSON.stringify(state.scene?.map ?? '').includes('chandelier')) swingScenes.push(state.scene)
    for (const actor of state.enemies ?? []) {
      if (special.length < 160 && (actor?.legendary || actor?.spellcasting || npcUsableItems(actor, { rulesetId: state.ruleset_id }).length) && chance(0.5)) special.push(actor)
    }
    if (corpusStates.length < 60 && (state.mechanics?.combat?.active ? chance(0.25) : chance(0.03))) corpusStates.push(state)
  }
}

const CATALOG = ['longsword', 'dagger', 'shortbow', 'longbow', 'light-crossbow', 'heavy-crossbow', 'hand-crossbow', 'quarterstaff', 'club', 'greataxe', 'javelin', 'scimitar', 'shortsword', 'rapier', 'spear', 'greatsword', 'handaxe', 'shield', 'chain-mail', 'leather-armor', 'arrows-20', 'bolts-20']
function extraItems(ownerId) {
  const items = []
  for (let n = int(4); n > 0; n -= 1) {
    const catalogId = `srd_5_2_1:${pick(CATALOG)}`
    let item
    try { item = materializeCatalogItem(catalogId, { id: `item-${ownerId}-${n}`, quantity: pick([1, 1, 1, 2, 0, 20]), equipped: chance(0.7) }) } catch { continue }
    if (chance(0.3)) item.equipped_slot = pick(['main_hand', 'off_hand'])
    items.push(item)
  }
  if (chance(0.25)) {
    // Две лёгкие руки: вторая — в слоте off_hand.
    for (const [n, catalog, slot] of [[7, pick(['dagger', 'shortsword', 'scimitar', 'handaxe']), 'main_hand'], [8, pick(['dagger', 'shortsword', 'handaxe']), 'off_hand']]) {
      try { items.push({ ...materializeCatalogItem(`srd_5_2_1:${catalog}`, { id: `item-${ownerId}-${n}`, quantity: 1, equipped: true }), equipped_slot: slot }) } catch {}
    }
  }
  if (chance(0.25)) {
    try { items.push(materializeCatalogItem(`srd_5_2_1:${pick(['quarterstaff', 'club'])}`, { id: `item-${ownerId}-9`, quantity: 1, equipped: true })) } catch {}
  }
  if (chance(0.2)) items.push({ id: `custom-${ownerId}`, name: 'Самодельный клинок', type: 'weapon', equipped: true, quantity: 1, combat: pick([{ kind: 'melee', damage: '1d6', damageType: 'slashing', properties: ['finesse', 'light'] }, { kind: 'ranged', damage: 8, normalRange: 30, longRange: 120, modes: [{ id: 'shot', kind: 'ranged', ammunition: true }, { id: 'bash', kind: 'melee', damage: '1d4', abilities: ['str'] }] }, { kind: 'thrown' }]), ...(chance(0.3) ? { magical: true } : {}), ...(chance(0.3) ? { properties: ['magic', 'loading'] } : {}) })
  return items
}

const SUBCLASSES = ['champion', 'Чемпион', 'hunter', 'Охотник', 'evocation', 'open-hand', 'life', null]
const FEATURES = ['fighting-style-archery', 'fighting-style-dueling', 'fighting-style-thrown', 'fighting-style-great-weapon', 'fighting-style-two-weapon', 'fighting-style-defense', 'crossbow-expert', 'devils-sight']
function heroFrom(source, index) {
  const actor = json(source)
  actor.id = `hero-${index}`
  if (chance(0.5)) actor.inventory = [...(Array.isArray(actor.inventory) ? actor.inventory : []), ...extraItems(actor.id)]
  if (chance(0.3)) actor.subclass = pick(SUBCLASSES)
  if (chance(0.25)) {
    const [cls, sub] = pick([['fighter', 'Чемпион'], ['ranger', 'Охотник'], ['fighter', null], ['ranger', null], ['monk', null], ['paladin', null], ['sorcerer', null], ['bard', null]])
    Object.assign(actor, { characterClass: cls, class: cls, level: pick([3, 5, 15, 2]) })
    if (sub) actor.subclass = sub
  }
  if (chance(0.3)) actor.level = pick([1, 3, 5, 11, 15, 20, '7'])
  if (chance(0.3)) actor.selectedFeatureIds = [...new Set([...(Array.isArray(actor.selectedFeatureIds) ? actor.selectedFeatureIds : []), pick(FEATURES), pick(FEATURES)])]
  if (chance(0.1)) actor.creationBenefits = { static: { ignore_loading_property: true } }
  if (chance(0.05)) Object.assign(actor, { characterSetupRequired: true, characterSetupStage: pick(['leveling', 'species']) })
  if (chance(0.3)) actor.hp = pick([0, 1, Math.max(1, Number(actor.maxHp ?? actor.max_hp ?? 10) - 3), actor.maxHp])
  return actor
}
function foeFrom(source, index) {
  const actor = json(source)
  actor.id = `foe-${index}`
  if (chance(0.15)) actor.legendary = { uses: pick([3, 2, 1]), resistance: 1, actions: [{ id: 'tail', name: 'Хвост', kind: 'attack', cost: 1, attack_modifier: 7, damage_expression: '2d6+4', range_feet: pick([10, 5, 30]) }, { id: 'wing', name: 'Крылья', kind: 'save', cost: 2, save_ability: 'dex', save_dc: 15, radius_feet: pick([0, 15]), cooldown_turns: pick([0, 1]) }] }
  if (chance(0.15)) actor.traits = [...(Array.isArray(actor.traits) ? actor.traits : []), pick([
    { id: 'multiattack', attacks: 2 }, { id: 'multiattack', action_counts: { bite: 1, claw: 2, '': 3, zero: 0 } }, { id: 'multiattack', sequence: ['bite', 'claw'] }, { id: 'multiattack', same_action: true, attacks: 3, action_id: 'claw' },
    { id: 'magic-weapons', mechanics: { weapon_attacks_magical: true } },
  ])]
  if (chance(0.2)) actor.action_profiles = [...(Array.isArray(actor.action_profiles) ? actor.action_profiles : []), { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_dice: '2d6', damage_bonus: 3, damage_type: 'piercing', recharge: pick([5, '5-6', 0, { min: 6, group: 'breath' }]), ...(chance(0.3) ? { recharge_group: 'breath' } : {}) }, { id: 'claw', kind: 'melee', damage_expression: pick(['1d8+2', 'x', '']), uses: pick([0, 1]) }]
  if (chance(0.1)) actor.special_actions = [{ id: 'breath', name_ru: 'Дыхание', recharge: 5, recharge_group: 'breath' }]
  if (chance(0.1)) actor.spellcasting = { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [{ id: 'magic-missile', uses: 3 }, { id: 'fire-bolt', uses: 'at-will' }, { id: 'fireball', uses: 1 }, { id: 'unknown-spell', uses: 1 }] }
  if (chance(0.15)) actor.hp = Math.max(1, Math.floor(Number(actor.maxHp ?? 10) * 0.2))
  if (chance(0.1)) actor.origin = { kind: 'authored-npc', npc_id: pick(['npc-a', 'npc-b']) }
  if (chance(0.1)) actor.attack_profile = { name: 'Старый удар', damageDice: 6, rangeFeet: pick([5, 30, 900]) }
  if (chance(0.3)) actor.hp = pick([0, 1, actor.maxHp])
  return actor
}

const ECONOMY_FLAGS = () => ({ action: chance(0.6), bonus_action: chance(0.7), reaction: chance(0.8), object_interaction: chance(0.7), movement: true })
function economyFor(ids, id) {
  const base = { ...ECONOMY_FLAGS(), attacks_used: pick([0, 0, 1, 2, 3]), attacks_allowed: pick([1, 2, 3]), extra_actions: pick([0, 0, 1]), surged_action_only: chance(0.15), loading_weapon_item_ids: { action: chance(0.3) ? [`item-${id}-1`, `item-${id}-2`] : [], bonus_action: [], reaction: [] } }
  if (chance(0.4)) Object.assign(base, { action_economy_version: 2, attack_action_id: pick(['attack-action:a', '', null]), attack_action_kind: pick(['normal', 'extra', 'surge', 'haste', 'bogus']), attack_action_limit: pick([1, 2, 3, 'x']), attack_action_stack: chance(0.4) ? [{ id: 'f1', kind: pick(['normal', 'haste']), limit: 2, attacks_used: pick([0, 1]) }, { id: '', kind: 'normal' }] : [] })
  if (chance(0.2)) Object.assign(base, { extra_action_kind: pick(['haste', 'surge', 'odd']), extra_action_limit: pick([1, 2, 'x']) })
  if (chance(0.2)) Object.assign(base, { multiattack_action_id: pick(['bite', 'claw']), multiattack_action_ids: chance(0.5) ? [pick(['bite', 'claw'])] : undefined })
  if (chance(0.1)) base.colossus_slayer_turn_key = 'combat:1:hero-0'
  return base
}
const CONDITIONS = ['shillelagh', 'shillelagh', 'hasted', 'slowed', 'command:halt', 'command:approach', 'command:flee', 'command:grovel', 'command:drop', 'charmed', 'metamagic-quickened', 'stunned', 'unconscious', 'incapacitated', 'prone', 'poisoned', 'magic-weapon', 'holy-weapon', 'bardic-inspiration', 'shillelagh', 'weapon-coated', 'monster-action-used', 'legendary-action-used', 'legendary-cooldown:wing', 'npc-tactic-used:heal', 'monster-spell-used']
function conditionFor(name, actor, ids) {
  const items = Array.isArray(actor.inventory) ? actor.inventory : []
  switch (name) {
    case 'charmed': return { id: 'charmed', source_actor: pick(ids) }
    case 'bardic-inspiration': return { id: 'bardic-inspiration', source_actor: pick([...ids, 'ghost']) }
    case 'shillelagh': return { id: 'shillelagh', source_item_id: (() => { const staffs = items.filter((entry) => /club|quarterstaff/u.test(String(entry?.catalog_id ?? ''))); const item = pick(staffs.length && chance(0.8) ? staffs : items); return item?.item_instance_id ?? item?.id ?? 'x' })(), spellcasting_ability: pick(['wis', 'cha', 'str', 'x', undefined]), effect_id: pick(['eff-1', undefined]) }
    case 'weapon-coated': return { id: `weapon-coated:${pick(items)?.item_instance_id ?? pick(items)?.id ?? 'x'}`, rider_damage: pick(['1d4', '2d6', null]), rider_damage_type: pick(['poison', undefined]), rider_source_name: pick(['Яд змеи', undefined]) }
    case 'monster-action-used': return `monster-action-used:${pick(['bite', 'claw', 'breath', pick(actor.action_profiles ?? [{}])?.id ?? 'x'])}`
    case 'legendary-action-used': return `legendary-action-used:${pick([1, 2])}:${pick(['r1i0', 'r1i1', 'r2i0'])}`
    case 'monster-spell-used': return `monster-spell-used:${pick(['fire-bolt', 'magic-missile', 'fireball'])}#${pick([1, 2])}`
    default: return chance(0.7) ? { id: name } : name
  }
}

function syntheticState(index) {
  const heroes = Array.from({ length: 1 + int(3) }, (_, n) => heroFrom(pick(players), `${index}-${n}`))
  const foes = Array.from({ length: int(4) }, (_, n) => foeFrom(special.length && chance(0.5) ? pick(special) : pick(enemies), `${index}-${n}`))
  const summons = chance(0.2) ? [{ id: `summon-${index}`, kind: 'summon', faction: 'party', ownerId: heroes[0].id, hp: 5, maxHp: 5, x: 1, y: 1 }] : []
  const all = [...heroes, ...foes, ...summons]
  const ids = all.map((actor) => actor.id)
  const conditions = {}
  const positions = {}
  for (const actor of foes) {
    // Потраченный приём с перезарядкой — чтобы начало хода было что бросать.
    for (const action of [...(Array.isArray(actor.action_profiles) ? actor.action_profiles : []), ...(Array.isArray(actor.special_actions) ? actor.special_actions : [])]) {
      if (E.rechargeMinimumOf(action) > 0 && chance(0.6)) (conditions[actor.id] ??= []).push(`monster-action-used:${E.monsterActionUsageKey(action)}`)
    }
  }
  for (const actor of all) {
    if (chance(0.7)) conditions[actor.id] = Array.from({ length: int(4) }, () => conditionFor(pick(CONDITIONS), actor, ids))
    if (chance(0.9)) positions[actor.id] = { x: int(10), y: int(10) }
  }
  const swing = swingScenes.length && chance(0.2)
  const scene = swing ? json(pick(swingScenes)) : chance(0.5) && scenes.length ? json(pick(scenes)) : { turn: 1, cells: Array.from({ length: 100 }, (_, n) => ({ x: n % 10, y: Math.floor(n / 10), type: chance(0.1) ? 'wall' : 'floor', revealed: chance(0.9) })) }
  if (swing) {
    for (const cell of scene.cells) if (chance(0.9)) cell.revealed = true
    const prop = (E.sceneTacticalMap({ scene })?.props ?? []).find((candidate) => String(candidate.assetId).includes('chandelier'))
    const anchor = prop?.footprint?.[0] ?? (prop ? { x: Math.floor(prop.x), y: Math.floor(prop.y) } : null)
    if (anchor) positions[heroes[0].id] = { x: anchor.x + pick([0, 1, -1, 2]), y: anchor.y + pick([0, 1, -1]) }
  }
  const order = [...ids].sort(() => random() - 0.5)
  const resources = Object.fromEntries(heroes.map((hero) => [hero.id, {
    spell_slots_1: { current: pick([0, 1, 3]), max: 3 }, spell_slots_2: { current: pick([0, 2]), max: pick([0, 2]) }, spell_slots_3: { current: pick([0, 1]), max: 2 },
    sorcery_points: { current: pick([0, 2, 5, 9]), max: pick([5, 9]) }, lay_on_hands: { current: pick([0, 3, 25]), max: 25 },
  }]))
  return {
    ruleset_id: pick(['srd_5_2_1', 'dnd_5e_2014', 'dnd_5e_2014']),
    state_version: 4,
    sessionCode: pick(['ABC', undefined]),
    players: heroes,
    enemies: foes,
    actors: summons,
    partyMemberIds: chance(0.8) ? heroes.map((hero) => hero.id) : [],
    scene,
    social: chance(0.3) ? { npcs: [{ id: 'npc-a', name: 'Стражник' }, { id: 'npc-b', name: 'Капитан' }] } : undefined,
    npc_world: chance(0.3) ? { vitals: { 'npc-a': { hp: pick([0, 5, 12]), max_hp: 12, alive: chance(0.8) } } } : undefined,
    world_offices: chance(0.2) ? { offices: [{ holder_npc_id: 'npc-a', defender_npc_ids: ['npc-b'] }] } : undefined,
    mechanics: {
      conditions,
      positions,
      resources,
      combat: {
        active: chance(0.85),
        round: pick([1, 2, 3]),
        group_initiative: chance(0.3),
        initiative: order.map((id) => ({ actor_id: id, total: int(20) })),
        active_index: pick([0, 0, 1, 2, -1, 9]),
        turn_completed: chance(0.3) ? order.filter(() => chance(0.3)) : [],
        action_economy: Object.fromEntries(ids.filter(() => chance(0.85)).map((id) => [id, economyFor(ids, id)])),
        ...(chance(0.25) ? { reaction_window: { window_id: 'w1', actor_id: pick(ids), action_ids: [pick(['opportunity-attack', 'readied-attack', 'cast:shield', 'indomitable', 'shield', 'uncanny-dodge']), 'decline-reaction'], trigger: pick(['failed-saving-throw', 'saving-throw-bonus-choice', 'movement', 'attack']) } } : {}),
      },
      shapes: chance(0.1) ? { [heroes[0].id]: { form: { wild_shape: true } } } : {},
    },
  }
}

console.log(`пулы: героев ${players.length}, врагов ${enemies.length}, особых ${special.length}, сцен ${scenes.length}, люстр ${swingScenes.length}`)
const states = []
// Производные поля героя (`combatSpells`, `combatActions`) движок пересчитывает
// сам и функции Р3 их не читают; без них эталон в десятки раз меньше. И JS, и
// Rust считают по одному и тому же урезанному состоянию.
function stripDerived(state) {
  for (const list of ['players', 'actors', 'enemies']) {
    for (const actor of Array.isArray(state?.[list]) ? state[list] : []) {
      delete actor.combatSpells
      delete actor.combatActions
    }
  }
  return state
}
function addState(kind, raw) {
  let state
  try { state = E.normalizeCampaignState(json(raw)) } catch { return }
  state = stripDerived(json(state))
  // Нормализация собирает инвентарь противника по шаблону заново, поэтому
  // расходники кладутся уже в нормализованное состояние.
  if (kind === 'synthetic') for (const actor of state.enemies ?? []) {
    if (chance(0.35)) {
      // Расходники противника: зелье, склянки, яд (тактики `npc-equipment`).
      const loadout = actor.loadout && typeof actor.loadout === 'object' ? actor.loadout : { schema_version: 1, policy_id: 'enemy-loadout-v1', template_id: 'srd_5_2_1:tough-boss', items: [] }
      const extra = ['potion-of-healing', 'acid', 'alchemists-fire', 'poison-basic'].filter(() => chance(0.5)).map((key, n) => ({ schema_version: 1, item_instance_id: `${actor.id}-use-${n}`, catalog_id: `srd_5_2_1:${key}`, quantity: pick([1, 2, 0]), snapshot: { name: pick(['Склянка', '']) } }))
      actor.loadout = { ...loadout, items: [...(Array.isArray(loadout.items) ? loadout.items : []), ...extra] }
    }
  }
  states.push({ kind, state })
}
for (let index = 0; index < 160 && players.length; index += 1) addState('synthetic', syntheticState(index))
for (const state of corpusStates) addState('corpus', state)

// --- вызовы ------------------------------------------------------------------------

const snapshots = states.map((entry) => JSON.stringify(entry.state))
const calls = []
const actorArg = (id) => ({ $actor: id })
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  // Поле `U` внутри объекта — отсутствующее поле (как после JSON), а не ключ со значением `undefined`.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== U).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}
function resolveArg(state, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$actor === 'string' && Object.keys(value).length === 1) return E.findActor(state, value.$actor)
  return deepUndefined(value)
}
function contextOf(raw) {
  const { __marks: marks, ...rest } = raw ?? {}
  const context = { ...rest }
  if (marks?.monk) context[E.MONK_BONUS_ATTACK_CONTEXT] = E.MONK_BONUS_ATTACK_TOKEN
  if (marks?.loading) context[E.LOADING_ACTION_TYPE_CONTEXT] = marks.loading
  if (marks?.offhand) context[E.OFFHAND_ATTACK_CONTEXT] = true
  return context
}
function call(f, s, args, fn) {
  const state = states[s]?.state
  const resolved = args.map((arg) => resolveArg(state, arg))
  calls.push({ f, s, a: args, o: attempt(() => fn(state, ...resolved)) })
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceCalls = []
function diceCall(f, s, args, fn) {
  const state = states[s].state
  const values = Array.from({ length: 8 }, () => pick([1, 2, 3, 4, 5, 6, 1, 2]))
  const transcript = []
  const dice = E.recordingDiceService(service(values), transcript)
  const resolved = args.map((arg) => resolveArg(state, arg))
  const o = attempt(() => fn(state, dice, ...resolved))
  diceCalls.push({ f, s, a: args, v: values, o, t: json(transcript) })
}

const COMMAND_BASE = (state, actorId) => ({ command_id: `cmd-${int(100)}`, campaign_id: 'camp', actor_id: actorId, ruleset_id: state.ruleset_id, source_rule_ids: [], target_ids: [], visibility: pick(['public', 'party', undefined]) })
const ACTION_IDS = ['dash', 'disengage', 'hide', 'use-object', 'opportunity-attack', 'readied-attack', 'readied-spell', 'cast:shield', 'decline-reaction', 'indomitable', 'second-wind', 'martial-arts-strike', 'flurry-of-blows', 'action-surge', 'rage', 'shield', 'uncanny-dodge', 'divine-smite', 'lay-on-hands', 'font-of-magic', null, 'bite', 'claw']
const SPELLS = ['fire-bolt', 'healing-word', 'shield', 'misty-step', 'magic-missile', 'cure-wounds', 'haste', 'shillelagh', 'hex', 'bless', 'counterspell', 'fireball', 'nonexistent']
const TYPES = ['UseMonsterAction', 'MakeAttack', 'MakeAttack', 'MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'EquipItem', 'CastSpell', 'CastSpell', 'UseCombatAction', 'UseCombatAction', 'UseItem', 'ActivateItem', 'IdentifyEnemy', 'ProposeParley', 'CalmBeast', 'FeedBeast', 'MoveActor', 'OperateDoor', 'BarricadeDoor', 'OperateSceneObject', 'LootContainer', 'ReturnKnightHead', 'NegotiateScenarioTreaty', 'EndCombat', 'EndTurn', 'ResolveImprovisedAction', 'ApplyDamage', 'TransferItem', 'GrantItem', 'RevealArea', 'AttackNpc']
const CONTEXTS = [{}, {}, { isAdmin: true }, { isNpcScheduler: true }, { isNpcScheduler: true, isAdmin: true }, { allowedActorIds: ['hero-0-0'] }, { reactionResolution: true }, { additionalBeam: true }, { readiedRelease: true }, { spellMovement: true }, { __marks: { monk: true } }, { __marks: { loading: 'bonus_action' } }, { __marks: { loading: 'reaction' } }, { isAdmin: 'yes', allowedActorIds: [] }]

function randomCommand(state) {
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const type = pick(TYPES)
  const actorId = pick([...ids, ...ids, ...ids, 'ghost', null])
  const actor = E.findActor(state, actorId)
  const items = Array.isArray(actor?.inventory) ? actor.inventory : []
  const input = { command_type: type, command_id: `cmd-${int(1000)}`, campaign_id: 'camp', actor_id: actorId, source_rule_ids: [] }
  if (chance(0.7)) input.target_id = pick([...ids, 'ghost'])
  if (chance(0.2)) input.target_ids = [pick(ids), pick([...ids, 'ghost'])]
  if (chance(0.6) && items.length) input.item_id = pick(items).id
  if (chance(0.3)) input.attack_mode = pick(['melee', 'ranged', 'thrown', 'shot', 'bash', ''])
  if (chance(0.2)) input.attack_ability = pick(['str', 'dex', 'wis', ''])
  if (chance(0.7)) input.action_id = pick([...ACTION_IDS, ...(actor?.action_profiles ?? []).map((action) => action.id)])
  if (type === 'CastSpell' || chance(0.1)) input.spell_id = pick(SPELLS)
  if (chance(0.3)) Object.assign(input, { monster_ability: 'multiattack', multiattack_index: pick([1, 2, 3]), multiattack_count: pick([2, 3]) })
  if (type === 'UseItem' && chance(0.8)) input.use_profile = pick([{ combat_action: 'action', kind: 'cast_spell' }, { combat_action: 'bonus_action' }, { combat_action: 'action', attack_replacement: true }, {}])
  if (chance(0.2)) input.use_mode = 'spill'
  if (chance(0.3)) input.combat_action = 'action'
  if (chance(0.2)) input.intent = pick(['force', 'lockpick', 'open'])
  if (chance(0.2)) input.reaction_movement = true
  if (chance(0.2)) input.reaction_attack = true
  if (chance(0.2)) input.action_cost = pick(['bonus_action', 'free', 'action'])
  if (chance(0.2)) input.loot_combat_action = pick(['object_interaction', 'action'])
  if (chance(0.2)) input.container_id = 'loot:x'
  if (chance(0.3)) input.slot_level = pick([1, 2, 3, 4, 0, 'x'])
  if (chance(0.3)) input.font_mode = pick(['convert', 'create', 'other'])
  if (chance(0.3)) input.amount = pick([1, 5, 30, 0, '4'])
  if (type === 'AttackNpc' || chance(0.1)) input.npc_id = pick(['npc-a', 'npc-b', ' npc-a ', ''])
  if (type === 'TransferItem') Object.assign(input, { recipient_kind: 'npc', recipient_id: input.target_id })
  return E.normalizeCommand(json(input), state)
}

for (let s = 0; s < states.length; s += 1) {
  const state = states[s].state
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  if (!ids.length) continue
  const someId = () => pick([...ids, ...ids, ...ids, 'ghost', ''])
  for (let rep = 0; rep < 4; rep += 1) {
    const id = someId()
    const other = someId()
    const actor = E.findActor(state, id)
    const items = Array.isArray(actor?.inventory) ? actor.inventory : []
    const itemId = pick([...items.map((item) => item.id), ...items.map((item) => item.item_instance_id).filter(Boolean), 'ghost', U])
    const actionId = pick([...(actor?.action_profiles ?? []).map((action) => action.id), null, U, 'ghost'])
    const options = { attackMode: pick([null, U, '', 'melee', 'ranged', 'thrown', 'shot', 'bash']), attackAbility: pick([null, U, '', 'str', 'dex', 'wis']), offHand: chance(0.3) }
    // weapons.rs
    call('trustedAttackProfile', s, [actorArg(id), actionId], (st, a, b) => E.trustedAttackProfile(st, a, b))
    call('combatItem', s, [actorArg(id), itemId], (st, a, b) => E.combatItem(a, b))
    call('itemInstanceKey', s, [pick([...items, null, U, { id: 7 }])], (st, a) => E.itemInstanceKey(a))
    call('combatItemForCommand', s, [actorArg(id), itemId], (st, a, b) => E.combatItemForCommand(a, b))
    call('weaponCatalogKey', s, [pick([...items, null, { catalog_id: 'a:B:Quarterstaff' }])], (st, a) => E.weaponCatalogKey(a))
    const item = pick([...items, null])
    call('shillelaghConditionFor', s, [id, item], (st, a, b) => E.shillelaghConditionFor(st, a, b))
    call('shillelaghConditionsFor', s, [id, pick([U, null, item?.id ?? 'x'])], (st, a, b) => E.shillelaghConditionsFor(st, a, b))
    const command = COMMAND_BASE(state, id)
    call('shillelaghRemovalEvents', s, [json(command), pick([U, null, item?.id ?? 'x']), pick([U, null, 'x']), pick([U, 'shillelagh-ended'])], (st, a, b, c, d) => E.shillelaghRemovalEvents(st, a, { itemKey: b, excludeItemKey: c, reason: d }))
    call('shillelaghWeaponFor', s, [item], (st, a) => E.shillelaghWeaponFor(a))
    call('magicalWeaponConditionFor', s, [id], (st, a) => E.magicalWeaponConditionFor(st, a))
    call('monsterWeaponAttacksMagical', s, [actorArg(id)], (st, a) => E.monsterWeaponAttacksMagical(a))
    call('itemAttackProfile', s, [actorArg(id), itemId, options.attackMode, options.attackAbility, options.offHand], (st, a, b, c, d, e) => E.itemAttackProfile(st, a, b, { attackMode: c, attackAbility: d, offHand: e }))
    const selected = items.length ? E.itemAttackProfile(state, actor, pick(items).id, {}) : null
    const binding = pick([null, { catalog_id: 'srd_5_2_1:javelin', magical: chance(0.3) }, { catalog_id: 'srd_5_2_1:longsword' }])
    call('weaponDamageSourceFor', s, [actorArg(id), pick([{ kind: 'melee' }, { kind: 'ranged' }, {}, null]), json(selected) ?? null, binding], (st, a, b, c, d) => E.weaponDamageSourceFor(st, a, b, c, d))
    call('weaponCriticalThreshold', s, [actorArg(id)], (st, a) => E.weaponCriticalThreshold(st, a))
    call('offHandWeaponFor', s, [actorArg(id)], (st, a) => E.offHandWeaponFor(a))
    call('attackKindFor', s, [json(selected) ?? null, pick([{ kind: 'ranged' }, { kind: 'melee' }, null]), binding], (st, a, b, c) => E.attackKindFor(a, b, c))
    call('heroAmmunitionSupply', s, [actorArg(id), json(selected) ?? pick([{ ammunition: true, ammunition_catalog_id: 'srd_5_2_1:arrows-20' }, null])], (st, a, b) => E.heroAmmunitionSupply(a, b))
    call('heroAmmunitionExpenditure', s, [actorArg(id), json(selected) ?? pick([{ ammunition: true, ammunition_catalog_id: 'srd_5_2_1:bolts-20' }, null])], (st, a, b) => E.heroAmmunitionExpenditure(a, b))
    call('equippedWeaponAttacks', s, [actorArg(id)], (st, a) => E.equippedWeaponAttacks(st, a))
    const props = (st) => (E.sceneTacticalMap(st)?.props ?? []).map((prop) => prop.id)
    call('swingDetailsFor', s, [id, pick([...props(state), 'ghost']), chance(0.5)], (st, a, b, c) => { const d = E.swingDetailsFor(st, a, b, { runningStart: c }); return { prop: d.prop, profile: d.profile, anchor: d.anchor, actor: E.actorId(d.actor), from: d.from, reachHeight: d.reachHeight } })
    call('averageDamageOf', s, [pick([{ damage_expression: '2d6+3' }, { damage_expression: '1d8-1' }, { damage_amount: 4 }, { damage_expression: '2d6 + 3', damage_amount: '7' }, null])], (st, a) => E.averageDamageOf(a))
    call('attackProfileFor', s, [id, actionId], (st, a, b) => E.attackProfileFor(st, a, b))
    call('weaponAttackProfileFor', s, [id, itemId, options.attackMode, options.attackAbility], (st, a, b, c, d) => E.weaponAttackProfileFor(st, a, b, { attackMode: c, attackAbility: d }))
    call('opportunityAttackProfile', s, [actorArg(id)], (st, a) => E.opportunityAttackProfile(st, a))
    call('criticalDamageExpression', s, [pick(['1d8+3', '2d6', '60d6-2', 'x', '1d4-1'])], (st, a) => E.criticalDamageExpression(a))
    call('weaponCoatingRiderFor', s, [id, pick([...items.map((entry) => entry.item_instance_id ?? entry.id), 'x', null])], (st, a, b) => E.weaponCoatingRiderFor(st, a, b))
    // class_features.rs
    call('monkMartialArtsAttackProfile', s, [actorArg(id)], (st, a) => E.monkMartialArtsAttackProfile(a))
    call('weaponFightingStyleBonus', s, [actorArg(id), item, pick([{ kind: 'melee' }, { kind: 'ranged' }, { kind: 'ranged', thrown: true }, { kind: 'melee', twoHanded: true }]), pick([[], ['two-handed'], ['light']])], (st, a, b, c, d) => E.weaponFightingStyleBonus(a, b, c, d))
    call('bardicInspirationFor', s, [id], (st, a) => E.bardicInspirationFor(st, a))
    call('bardicInspirationDieSides', s, [actorArg(id)], (st, a) => E.bardicInspirationDieSides(a))
    const classCommand = { ...command, target_id: other, item_id: itemId === U ? null : itemId, attack_mode: options.attackMode === U ? null : options.attackMode, slot_level: pick([1, 2, 3, 0, U, 'x']), font_mode: pick(['convert', 'create', 'x', U]), amount: pick([0, 3, 50, U, '2']) }
    const action = pick([{ id: 'divine-smite', resource: 'spell_slots_1', effect: { kind: 'damage' } }, { id: 'lay-on-hands', resource: 'lay_on_hands', effect: { kind: 'heal', amount: 1 } }, { id: 'font', resource: 'x' }])
    call('divineSmiteActionFor', s, [json(classCommand), action], (st, a, b) => ({ result: E.divineSmiteActionFor(st, a, b), command: a }))
    call('fontOfMagicActionFor', s, [json(classCommand), action], (st, a, b) => ({ result: E.fontOfMagicActionFor(st, a, b), command: a }))
    call('layOnHandsActionFor', s, [json(classCommand), action], (st, a, b) => ({ result: E.layOnHandsActionFor(st, a, b), command: a }))
    call('colossusSlayerReady', s, [actorArg(id), actorArg(other)], (st, a, b) => E.colossusSlayerReady(st, a, b))
    call('sneakAttackDiceCount', s, [actorArg(id)], (st, a) => E.sneakAttackDiceCount(a))
    call('sneakAttackSupportingAlly', s, [id, other], (st, a, b) => E.actorId(E.sneakAttackSupportingAlly(st, a, b)))
    call('assertMonkUnarmedActionAllowed', s, [actorArg(id), pick([{ id: 'martial-arts-strike' }, { id: 'flurry-of-blows' }, { id: 'dash' }, null])], (st, a, b) => E.assertMonkUnarmedActionAllowed(st, a, b))
    // npc_items.rs
    const usable = actor ? npcUsableItems(actor, { rulesetId: state.ruleset_id }) : []
    const usableItem = pick([...usable, ...usable, null])
    const bindings = actor ? npcWeaponBindings(actor).map((entry) => entry.item_instance_id) : []
    const npcCommand = { ...command, command_type: 'UseItem', target_id: usableItem?.tactic === 'flask' ? pick([other, ...((state.players ?? []).map((p) => p.id))]) : pick([id, id, other, null]), target_ids: [], item_id: usableItem ? usableItem.item_instance_id : pick([...items.map((entry) => entry.item_instance_id ?? entry.id), 'x', null]), npc_tactic: usableItem && chance(0.85) ? usableItem.tactic : pick(['heal', 'flask', 'coat', 'x']), weapon_id: pick([...bindings, ...bindings, ...items.map((entry) => entry.item_instance_id ?? entry.id), null]), merchant_id: null, stock_id: null, action_id: null, quantity: 1, expected_state_version: 4, house_rule_id: null, ruling_id: null, request_fingerprint: null, ...(chance(0.1) ? { use_mode: 'x' } : {}) }
    call('validateNpcItemUseCommand', s, [json(npcCommand), pick([{ isNpcScheduler: true }, { isNpcScheduler: true }, {}, { isAdmin: true }])], (st, a, b) => E.validateNpcItemUseCommand(a, st, b))
    call('npcEquipmentSpentEvent', s, [json(command), pick([{ kind: 'potion', item_instance_id: 'x' }, {}, { owner_id: 'override' }])], (st, a, b) => E.npcEquipmentSpentEvent(a, b))
    // monsters.rs
    call('monsterSpellUsesSpent', s, [id, pick(['fire-bolt', 'magic-missile', 'fireball'])], (st, a, b) => E.monsterSpellUsesSpent(st, a, b))
    call('validateMonsterSpellCommand', s, [{ ...json(command), spell_id: pick([...SPELLS, ...(actor?.spellcasting?.spells ?? []).map((entry) => entry?.id), ...(actor?.spellcasting?.spells ?? []).map((entry) => entry?.id)]) }, pick([{ isNpcScheduler: true }, { isNpcScheduler: true }, {}])], (st, a, b) => E.validateMonsterSpellCommand(a, st, b))
    call('validateLegendaryActionCommand', s, [{ ...json(command), target_id: pick([other, ...((state.players ?? []).map((p) => p.id))]), legendary_action_id: pick(['tail', 'wing', 'x', U, ...(actor?.legendary?.actions ?? []).map((entry) => entry?.id)]) }, pick([{ isNpcScheduler: true }, { isNpcScheduler: true }, {}])], (st, a, b) => E.validateLegendaryActionCommand(a, st, b))
    call('legendaryActionsResetAtTurnStart', s, [json(command), id], (st, a, b) => E.legendaryActionsResetAtTurnStart(st, a, b))
    call('npcDamageContext', s, [pick(['npc-a', 'npc-b', id])], (st, a) => E.npcDamageContext(st, a))
    const trait = pick([E.monsterTraitFor(actor, 'multiattack'), { action_counts: { b: 2, a: 1, Z: 9, '': 1 } }, { action_counts: [1, 2] }, null])
    call('monsterMultiattackActionCounts', s, [trait ?? null], (st, a) => [...E.monsterMultiattackActionCounts(a)])
    call('monsterMultiattackActionIds', s, [actorArg(id), pick([null, U, 'bite', 'claw']), pick([U, [], ['bite'], ['claw', 'claw']])], (st, a, b, c) => E.monsterMultiattackActionIds(a, b, c))
    call('syncNpcWorldVital', s, [pick(['npc-a', 'npc-b', '']), pick([U, 0, 4, 99, 'x']), pick([U, 10, 0, 'y']), pick([U, { hp: 3, max_hp: 8, alive: true }])], (st, a, b, c, d) => { const copy = structuredClone(st); E.syncNpcWorldVital(copy, a, { hp: b, maxHp: c, fallback: d }); return copy.npc_world })
    call('syncAuthoredNpcVital', s, [id, pick([U, 0, 4]), pick([U, 10])], (st, a, b, c) => { const copy = structuredClone(st); E.syncAuthoredNpcVital(copy, a, { hp: b, maxHp: c }); return copy.npc_world })
    call('syncSocialNpcVital', s, [pick(['npc-a', 'npc-b', id]), pick([U, 0, 4]), pick([U, 10]), pick([U, 'npc-a', 'npc-b'])], (st, a, b, c, d) => { const copy = structuredClone(st); E.syncSocialNpcVital(copy, a, { hp: b, maxHp: c, npcId: d }); return copy.npc_world })
    // turn.rs
    call('initiativeGroupIds', s, [], (st) => E.initiativeGroupIds(st))
    call('isActiveTurnActor', s, [id], (st, a) => E.isActiveTurnActor(st, a))
    call('isOwnCombatTurn', s, [id], (st, a) => E.isOwnCombatTurn(st, a))
    call('crossbowExpertFor', s, [actorArg(id)], (st, a) => E.crossbowExpertFor(a))
    call('crossbowProfileFor', s, [json(selected) ?? null], (st, a) => E.crossbowProfileFor(a))
    call('loadingWeaponLimitApplies', s, [actorArg(id), json(selected) ?? null], (st, a, b) => Boolean(E.loadingWeaponLimitApplies(st, a, b)))
    const economy = state.mechanics?.combat?.action_economy?.[id]
    call('loadingWeaponUsed', s, [json(economy) ?? null, pick(['action', 'bonus_action', 'reaction']), pick([itemId, `item-${id}-1`])], (st, a, b, c) => E.loadingWeaponUsed(a, b, c))
    call('hasteActionAllows', s, [pick(['dash', 'hide', 'attack', null, U])], (st, a) => E.hasteActionAllows(a))
    call('hasUntouchedNormalActionFrame', s, [json(economy) ?? null], (st, a) => E.hasUntouchedNormalActionFrame(a))
    call('hasteOnlyActionFrame', s, [json(economy) ?? null], (st, a) => E.hasteOnlyActionFrame(a))
    // encounter.rs
    call('authoredOfficeParticipants', s, [pick(['npc-a', 'npc-b', 'npc-c'])], (st, a) => E.authoredOfficeParticipants(st, a))
    call('isEmptyHeroSeat', s, [actorArg(id)], (st, a) => E.isEmptyHeroSeat(a))
    call('encounterAssemblyInput', s, [], (st) => E.encounterAssemblyInput(st))
    call('npcCombatRequestFingerprint', s, [pick([{ actor_id: id, npc_id: 'npc-a' }, { actorId: id, npcId: 'npc-b' }, null, { actor_id: 7 }])], (st, a) => E.npcCombatRequestFingerprint(a))
  }
  for (let rep = 0; rep < 6; rep += 1) {
    let command
    try { command = randomCommand(state) } catch { continue }
    const context = pick(CONTEXTS)
    call('attackActionPlan', s, [json(command), context], (st, a, b) => E.attackActionPlan(st, a, contextOf(b)))
    call('assertTurn', s, [json(command), context], (st, a, b) => E.assertTurn(a, st, contextOf(b)))
    call('assertActorPermission', s, [json(command), context], (st, a, b) => E.assertActorPermission(a, contextOf(b), st))
    call('commandRequiresNormalActionFrame', s, [json(command), json(state.mechanics?.combat?.action_economy?.[command.actor_id]) ?? null], (st, a, b) => E.commandRequiresNormalActionFrame(a, b))
    call('validateAttackNpcCommand', s, [json(command)], (st, a) => E.validateAttackNpcCommand(a, st))
    call('assembleEncounterFromState', s, [{ ...json(command), npc_id: pick(['npc-a', 'npc-b', '', U]), difficulty: pick(['easy', 'medium', 'hard', 'x', U]), theme: pick(['goblins', 'undead', 'generic', U]), seed: pick(['s1', 's2', U]) }], (st, a) => E.assembleEncounterFromState(st, a))
  }
  for (let rep = 0; rep < 3; rep += 1) {
    const id = pick(ids)
    diceCall('greatWeaponFightingReroll', s, [pick([{ expression: '2d6+3', dice: [1, 5], modifier: 3, total: 9 }, { expression: '1d12', dice: [2], modifier: 0, total: 2 }, { expression: '2d6', dice: [3, 6], total: 9 }, { expression: '4d6-1', dice: [1, 2, 1, 6], modifier: -1, total: 9, extra: 'x' }]), { actor_id: id, visibility: pick(['party', undefined]) }], (st, d, a, b) => E.greatWeaponFightingReroll(a, d, b))
    diceCall('monsterRechargeAtTurnStart', s, [COMMAND_BASE(state, 'x'), id], (st, d, a, b) => { const result = E.monsterRechargeAtTurnStart(st, a, b, d); return { events: result.events, rolls: result.rolls } })
  }
}

// --- прицельные вызовы: дубинка «Шиллелага», «Убийца колоссов», вещи противника ---

for (let s = 0; s < states.length; s += 1) {
  const state = states[s].state
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  for (const [ownerId, list] of Object.entries(state.mechanics?.conditions ?? {})) {
    for (const condition of list) {
      if (String(condition?.id ?? condition) !== 'shillelagh') continue
      const owner = E.findActor(state, ownerId)
      const item = (owner?.inventory ?? []).find((entry) => String(entry?.item_instance_id ?? entry?.id) === String(condition.source_item_id)) ?? null
      call('shillelaghConditionFor', s, [ownerId, item], (st, a, b) => E.shillelaghConditionFor(st, a, b))
      call('itemAttackProfile', s, [actorArg(ownerId), item?.id ?? U, U, pick([U, 'wis', 'str', 'dex', 'cha']), false], (st, a, b, c, d, e) => E.itemAttackProfile(st, a, b, { attackMode: c, attackAbility: d, offHand: e }))
      call('shillelaghRemovalEvents', s, [{ ...COMMAND_BASE(state, ownerId) }, pick([U, item?.id ?? 'x']), pick([U, 'x']), U], (st, a, b, c, d) => E.shillelaghRemovalEvents(st, a, { itemKey: b, excludeItemKey: c, reason: d }))
    }
  }
  const chandeliers = (E.sceneTacticalMap(state)?.props ?? []).filter((prop) => String(prop.assetId).includes('chandelier'))
  for (const prop of chandeliers) {
    for (const hero of state.players ?? []) {
      for (const runningStart of [false, true]) call('swingDetailsFor', s, [hero.id, prop.id, runningStart], (st, a, b, c) => { const d = E.swingDetailsFor(st, a, b, { runningStart: c }); return { prop: d.prop, profile: d.profile, anchor: d.anchor, actor: E.actorId(d.actor), from: d.from, reachHeight: d.reachHeight } })
    }
  }
  for (const hero of state.players ?? []) {
    if (E.characterClassKey(hero) !== 'ranger' && E.characterClassKey(hero) !== 'fighter') continue
    for (const other of ids) call('colossusSlayerReady', s, [actorArg(hero.id), actorArg(other)], (st, a, b) => E.colossusSlayerReady(st, a, b))
    call('weaponCriticalThreshold', s, [actorArg(hero.id)], (st, a) => E.weaponCriticalThreshold(st, a))
  }
  for (const enemy of state.enemies ?? []) {
    for (const item of npcUsableItems(enemy, { rulesetId: state.ruleset_id })) {
      const bindings = npcWeaponBindings(enemy).map((entry) => entry.item_instance_id)
      const targets = item.tactic === 'flask' ? (state.players ?? []).map((player) => player.id) : [enemy.id]
      for (const target of targets) {
        const command = { ...COMMAND_BASE(state, enemy.id), command_type: 'UseItem', target_id: target, item_id: item.item_instance_id, npc_tactic: item.tactic, weapon_id: pick([...bindings, null]), merchant_id: null, stock_id: null, action_id: null, quantity: 1, expected_state_version: 4, house_rule_id: null, ruling_id: null, request_fingerprint: null }
        call('validateNpcItemUseCommand', s, [json(command), { isNpcScheduler: true }], (st, a, b) => E.validateNpcItemUseCommand(a, st, b))
      }
    }
    if (enemy.legendary) {
      for (const target of ids) call('validateLegendaryActionCommand', s, [{ ...COMMAND_BASE(state, enemy.id), target_id: target, legendary_action_id: pick((enemy.legendary.actions ?? []).map((entry) => entry?.id)) }, { isNpcScheduler: true }], (st, a, b) => E.validateLegendaryActionCommand(a, st, b))
    }
  }
}

// --- блоки 50–53 по записям корпуса ---------------------------------------------------

const prefix = await blockFunction([[6133, 6954]], ['const state = normalizeCampaignState(rawState)'], ['input', 'rawState', 'context'], 'return { state, command }')
const blocks = {
  b50: await blockFunction([[6955, 6957]], ['if (needsActor(command.command_type)'], ['state', 'command', 'context'], 'return command'),
  b51: await blockFunction([[6958, 6972]], ['for (const id of command.target_ids)'], ['state', 'command', 'context'], 'return command'),
  b52: await blockFunction([[6973, 6973]], ['assertActorPermission(command, context, state)'], ['state', 'command', 'context'], 'return command'),
  b53: await blockFunction([[6974, 6974]], ['assertTurn(command, state, context)'], ['state', 'command', 'context'], 'return command'),
}
const blockStates = []
const blockStateIndex = new Map()
const blockCases = []
const perType = new Map()
const corpusFiles = existsSync(corpusDir) ? readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort() : []
const stateCache = new Map()
outer: for (const file of corpusFiles) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    if (blockCases.length >= 2600) break outer
    let record
    try { record = JSON.parse(line) } catch { continue }
    const type = String(record.command?.command_type ?? '')
    const refused = record.outcome?.ok !== true
    const bucket = `${type}:${refused}`
    if ((perType.get(bucket) ?? 0) >= (refused ? 40 : 25) || chance(0.4)) continue
    const path = join(statesDir, `${record.state}.json`)
    if (!existsSync(path) || statSync(path).size > 90_000) continue
    let raw = stateCache.get(record.state)
    if (!raw) { raw = JSON.parse(readFileSync(path, 'utf8')); stateCache.set(record.state, raw) }
    let prepared
    const context = record.context ?? {}
    try { prepared = prefix(json(record.command), json(raw), context) } catch { continue }
    prepared.state = stripDerived(json(prepared.state))
    if (JSON.stringify(prepared.state).length > 150_000) continue
    const stateKey = sha(prepared.state)
    if (!blockStateIndex.has(stateKey)) { blockStateIndex.set(stateKey, blockStates.length); blockStates.push(json(prepared.state)) }
    perType.set(bucket, (perType.get(bucket) ?? 0) + 1)
    const s = blockStateIndex.get(stateKey)
    const command = json(prepared.command)
    for (const [name, run] of Object.entries(blocks)) {
      blockCases.push({ block: name, s, command, context, ...attempt(() => run(prepared.state, structuredClone(prepared.command), context)) })
    }
  }
}
// Нападение на NPC и сборка встречи — на записях корпуса: состояние и команда
// перед блоком 47 (`validateAttackNpcCommand`), затем сборка встречи.
const prefix47 = await blockFunction([[6133, 6899]], ['const state = normalizeCampaignState(rawState)'], ['input', 'rawState', 'context'], 'return { state, command }')
const encounterTypes = new Map([['AttackNpc', 0], ['CreateEncounter', 0], ['StageEncounter', 0]])
for (const file of corpusFiles) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.includes('"AttackNpc"') && !line.includes('"CreateEncounter"') && !line.includes('"StageEncounter"')) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const type = String(record.command?.command_type ?? '')
    if (!encounterTypes.has(type) || encounterTypes.get(type) >= 40) continue
    const path = join(statesDir, `${record.state}.json`)
    if (!existsSync(path) || statSync(path).size > 900_000) continue
    let prepared
    try { prepared = prefix47(json(record.command), JSON.parse(readFileSync(path, 'utf8')), record.context ?? {}) } catch { continue }
    prepared.state = stripDerived(json(prepared.state))
    if (JSON.stringify(prepared.state).length > 150_000) continue
    encounterTypes.set(type, encounterTypes.get(type) + 1)
    const stateKey = sha(prepared.state)
    if (!blockStateIndex.has(stateKey)) { blockStateIndex.set(stateKey, blockStates.length); blockStates.push(json(prepared.state)) }
    const bs = blockStateIndex.get(stateKey)
    const command = json(prepared.command)
    const state = prepared.state
    calls.push({ f: 'validateAttackNpcCommand', bs, a: [command], o: attempt(() => E.validateAttackNpcCommand(structuredClone(command), state)) })
    calls.push({ f: 'assembleEncounterFromState', bs, a: [command], o: attempt(() => E.assembleEncounterFromState(state, structuredClone(command))) })
    calls.push({ f: 'encounterAssemblyInput', bs, a: [], o: attempt(() => E.encounterAssemblyInput(state)) })
    const npcs = (state.social?.npcs ?? []).map((npc) => String(npc?.id ?? ''))
    for (const npcId of npcs.slice(0, 4)) {
      const variant = { ...command, npc_id: npcId }
      calls.push({ f: 'validateAttackNpcCommand', bs, a: [variant], o: attempt(() => E.validateAttackNpcCommand(structuredClone(variant), state)) })
      calls.push({ f: 'assembleEncounterFromState', bs, a: [variant], o: attempt(() => E.assembleEncounterFromState(state, structuredClone(variant))) })
      calls.push({ f: 'authoredOfficeParticipants', bs, a: [npcId], o: attempt(() => E.authoredOfficeParticipants(state, npcId)) })
      calls.push({ f: 'npcDamageContext', bs, a: [npcId], o: attempt(() => E.npcDamageContext(state, npcId)) })
    }
  }
}

// синтетические команды на синтетических состояниях — через те же блоки
for (let n = 0; n < 1200; n += 1) {
  const s = int(states.length)
  const state = states[s].state
  let command
  try { command = randomCommand(state) } catch { continue }
  const raw = pick(CONTEXTS)
  for (const [name, run] of Object.entries(blocks)) {
    blockCases.push({ block: name, synthetic: s, command: json(command), context: raw, ...attempt(() => run(state, structuredClone(command), contextOf(raw))) })
  }
}

const mutated = states.map((entry, index) => (JSON.stringify(entry.state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(", ")}`)
const output = { source_sha256: sourceSha256(), states: states.map((entry) => entry.state), calls, dice: diceCalls, block_states: blockStates, blocks: blockCases }
const text = `${JSON.stringify(output)}\n`
writeFileSync(new URL('combat-r3.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
const errors = calls.filter((entry) => entry.o.err || entry.o.fault).length
console.log(`combat-r3.json.gz: ${(text.length / 1e6).toFixed(1)} МБ JSON, состояний ${states.length} + ${blockStates.length}, вызовов ${calls.length} (отказов ${errors}), бросков ${diceCalls.length}, блоков ${blockCases.length}`)
