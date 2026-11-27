import '../../../fixtures-env.mjs'
// Эталоны задачи Р11: ветки `resolveCommandInternal` начала и конца боя,
// предметов, дверей и объектов сцены, уговора зверя и незнакомца сценария —
// полным путём `resolveCommand` (обёртки, хвост последствий), а также
// `validateCommand` на тех же входах и `sortedInitiative`.
//
// Состояния: записи корпуса (`tmp/corpus-v1`) с командами Р11 — их состояние,
// вход и контекст — и цепочки от них: после удачной команды события
// применяются `applyGameEvent`, и следующая команда идёт по новому состоянию
// (дверь открыта — её закрывают, баррикада стоит — её снимают, бой начат — его
// заканчивают). Входы варьируются: кости, герой и его место у двери или
// объекта, предметы в инвентаре, намерение, контекст.
//
// Исход — `{ ok: { command, events, rolls, types } }` с sha256 строк
// `JSON.stringify` (типы событий — для отладки) или отказ `{ err: [code,
// message] }` / `{ fault: name }`. Полные исходы — `SK_R11_FULL=<файл>`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-r11.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { materializeCatalogItem } from '../../../../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0011_5eed
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
const sha = (text) => createHash('sha256').update(text).digest('hex')
const U = '__undefined__'

let uuidCounter = 0
globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++uuidCounter}`

function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const DICE = [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 2, 3, 4, 3, 4, 10, 12, 15, 18, 19, 20, 20, 1, 8]
const diceValues = (n = 40) => Array.from({ length: n }, () => pick(DICE))
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}

// --- состояния ---------------------------------------------------------------------

/** Состояние без производных полей героя и без библиотеки карт локаций. */
function compact(state) {
  const copy = json(state)
  for (const player of copy?.players ?? []) for (const field of ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']) delete player[field]
  delete copy.locationMaps
  return copy
}
const states = []
const stateIndex = new Map()
let stateBytes = 0
function addState(state) {
  const text = JSON.stringify(compact(state))
  const key = sha(text)
  if (stateIndex.has(key)) return stateIndex.get(key)
  const index = states.length
  states.push(JSON.parse(text))
  stateIndex.set(key, index)
  stateBytes += text.length
  return index
}

const TYPES = ['ResolveImprovisedAction', 'BarricadeDoor', 'ClearDoorBarricade', 'OperateDoor', 'OperateSceneObject', 'AttackNpc', 'CreateEncounter', 'StartCombat', 'EndCombat',
  'StageScenarioStranger', 'CalmBeast', 'GrantItem', 'EquipItem', 'TransferItem', 'AttuneItem', 'ActivateItem', 'UseItem']
const seeds = []
for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus-')).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line) continue
    const record = JSON.parse(line)
    if (!TYPES.includes(record.command?.command_type)) continue
    const size = statSync(join(corpusDir, 'states', `${record.state}.json`)).size
    seeds.push({ ...record, size })
  }
}
// Крупные состояния (встречи по авторскому NPC, сценарий Асстохана) — по
// нескольку на тип: бюджет эталонов.
const bigByType = new Map()
const chosen = seeds.filter((record) => {
  if (record.size <= 60_000) return true
  const type = record.command.command_type
  const taken = bigByType.get(type) ?? 0
  const limit = type === 'StageScenarioStranger' ? 4 : 3
  if (taken >= limit) return false
  bigByType.set(type, taken + 1)
  return true
})
const stateCache = new Map()
function corpusState(hash) {
  if (!stateCache.has(hash)) stateCache.set(hash, JSON.parse(readFileSync(join(corpusDir, 'states', `${hash}.json`), 'utf8')))
  return json(stateCache.get(hash))
}

// --- изменения входа и состояния -----------------------------------------------------

const heroesOf = (state) => (state.players ?? []).map((actor) => E.actorId(actor))
const enemiesOf = (state) => (state.enemies ?? []).map((actor) => E.actorId(actor))
const actorsOf = (state) => E.listActors(state).map((actor) => E.actorId(actor))
function place(state, actorId, cell) {
  state.mechanics ??= {}
  state.mechanics.positions ??= {}
  state.mechanics.positions[actorId] = { x: cell.x, y: cell.y }
}
function hero(state, actorId) {
  return (state.players ?? []).find((player) => E.actorId(player) === actorId)
}
function giveItems(state, actorId, items) {
  const player = hero(state, actorId)
  if (!player) return
  player.inventory = [...(Array.isArray(player.inventory) ? player.inventory : []), ...items]
}
function catalog(id, instance) {
  try {
    return materializeCatalogItem(id, instance)
  } catch {
    return null
  }
}
const MATERIALS = [
  { id: 'mat-planks', name: 'Доски', quantity: 2, tags: ['wood'] },
  { id: 'mat-empty', name: 'Доски', quantity: 0, tags: ['wood'] },
  { id: 'mat-rope', name: 'Верёвка пеньковая', quantity: 1 },
  { id: 'mat-cloak', name: 'Плащ', quantity: 1 },
  { id: 'mat-bench', name: 'Скамья', quantity: 1, equipped: true },
  { id: 'mat-quest', name: 'Доска', quantity: 1, quest_item: true },
  { id: 'mat-tagged', name: 'Брусок', quantity: 1, tags: 'quest-wood' },
  { id: 'mat-oak', name: 'Свёрток', quantity: '3', material: 'Oak WOOD' },
]
const USABLE = ['srd_5_2_1:acid', 'srd_5_2_1:alchemists-fire', 'srd_5_2_1:antitoxin', 'srd_5_2_1:caltrops', 'srd_5_2_1:healers-kit', 'srd_5_2_1:holy-water', 'srd_5_2_1:oil-flask',
  'srd_5_2_1:poison-basic', 'srd_5_2_1:potion-of-healing', 'srd_5_2_1:wand-of-magic-missiles', 'scenario_astohan:kaelan-tear', 'scenario_astohan:lomar-ward', 'srd_5_2_1:rations-one-day']
const GRANTS = ['srd_5_2_1:longsword', 'srd_5_2_1:potion-of-healing', 'srd_5_2_1:chain-mail', 'srd_5_2_1:rope-hempen-50-feet', 'srd_5_2_1:club', 'srd_5_2_1:weapon-of-warning-longsword', 'nope:missing']

function doorCell(map) {
  const door = pick(map.doors)
  const neighbor = door.dir === 'e' ? { x: door.x + 1, y: door.y } : { x: door.x, y: door.y + 1 }
  return { door, cell: chance(0.5) ? { x: door.x, y: door.y } : neighbor }
}
function propCell(prop) {
  const cells = Array.isArray(prop.footprint) && prop.footprint.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
  const base = pick(cells)
  return pick([base, { x: base.x + 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y + 1 }, { x: base.x + 3, y: base.y }])
}

/** Команда семейства по состоянию: `base` — вход записи корпуса. */
function nextInput(type, state, base, context, n) {
  const input = { ...json(base), command_type: type, command_id: `r11-${n}`, expected_state_version: state.state_version }
  const heroes = heroesOf(state)
  const actorId = input.actor_id && heroes.includes(input.actor_id) ? input.actor_id : pick(heroes)
  const map = state.scene?.map
  switch (type) {
    case 'OperateDoor':
    case 'BarricadeDoor':
    case 'ClearDoorBarricade': {
      input.actor_id = actorId
      if (map?.doors?.length) {
        const { door, cell } = doorCell(map)
        input.door_id = chance(0.9) ? door.id : 'door-missing'
        if (chance(0.85)) place(state, actorId, cell)
      }
      if (type === 'OperateDoor') input.intent = pick(['open', 'close', 'force', 'lockpick', 'open', 'force', 'smash', U])
      if (type === 'BarricadeDoor') {
        if (chance(0.7)) giveItems(state, actorId, json(MATERIALS))
        input.material_item_id = pick([...MATERIALS.map((item) => item.id), 'mat-planks', 'mat-planks', 'mat-rope', 'ghost'])
      }
      if (type === 'ClearDoorBarricade') input.force = pick([true, false, U, true])
      if (chance(0.3)) hero(state, actorId).toolProficiencies = ['thieves_tools']
      break
    }
    case 'OperateSceneObject': {
      input.actor_id = actorId
      const props = map?.props ?? []
      if (props.length) {
        const prop = pick(props)
        input.prop_id = chance(0.92) ? prop.id : 'prop-missing'
        if (chance(0.85)) place(state, actorId, propCell(prop))
      }
      input.intent = pick(['inspect', 'open', 'lockpick', 'take', 'use', 'topple', 'ignite', 'pray', 'inspect', 'open', 'take', 'dance'])
      input.approach = pick([U, U, 'force', 'careful'])
      if (input.approach === 'force' && chance(0.7)) input.server_authoritative = true
      if (chance(0.3)) hero(state, actorId).toolProficiencies = ['thieves_tools']
      if (chance(0.2)) giveItems(state, actorId, [catalog('srd_5_2_1:alchemists-fire', { id: 'fire-flask', quantity: 1 })].filter(Boolean))
      delete input.verified_roll
      break
    }
    case 'ResolveImprovisedAction':
      input.actor_id = actorId
      input.action_cost = pick(['action', 'bonus_action', 'free', 'reaction', U])
      input.summary = pick(['Опрокидываю стол', '', 'x'.repeat(200), U])
      break
    case 'StartCombat': {
      if (chance(0.3)) input.group_initiative = pick([true, 'yes'])
      if (chance(0.25)) {
        const owner = pick(heroes)
        state.actors = [...(state.actors ?? []), { id: `summon-${n}`, name: 'Дух', kind: 'summon', faction: 'party', ownerId: owner, hp: pick([5, 0]), maxHp: 5, alive: true, x: 1, y: 1,
          ...(chance(0.5) ? { summon_lifecycle_version: 2, expires_at_seconds: pick([0, null, 999999]) } : {}) }]
      }
      for (const id of heroes) {
        const player = hero(state, id)
        if (chance(0.15)) player.initiativeBonus = pick([3, '5', 50, 'x'])
        if (chance(0.1)) player.creationBenefits = { ...(player.creationBenefits ?? {}), initiative_bonus: pick([2, U, '1']) }
        if (chance(0.1)) Object.assign(player, { characterClass: 'barbarian', class: 'barbarian', level: pick([6, 7, 12]) })
        if (chance(0.1)) giveItems(state, id, [catalog('srd_5_2_1:weapon-of-warning-longsword', { id: `warn-${id}`, quantity: 1, equipped: true, attuned_to: id })].filter(Boolean))
      }
      if (chance(0.15) && (state.campaign == null || typeof state.campaign === 'object')) { state.campaign ??= {}; state.campaign.rules = { ...(state.campaign.rules ?? {}), group_initiative: true } }
      if (chance(0.2) && input.actor_id) context.openingAction = { actor_id: input.actor_id, free_strike: chance(0.5), command_type: 'MakeAttack', target_id: pick(enemiesOf(state)) ?? 'x' }
      break
    }
    case 'EndCombat':
      if (chance(0.3) && state.mechanics?.combat?.active) state.mechanics.combat.round_time_pending = true
      if (chance(0.4)) input.reason = pick(['victory', '', 'x'.repeat(200), U, 'fled'])
      break
    case 'GrantItem': {
      input.actor_id = actorId
      const id = pick(GRANTS)
      input.item = pick([
        { catalog_id: id, quantity: pick([1, 2, U]), origin: pick([U, 'stolen', 'found', 'quest_reward', 'weird']) },
        { name: 'Самоцвет', type: 'treasure', weight: pick([0.5, 0, 'x', 2000]), quantity: pick([1, 3]), id: pick([U, '', 'gem-1']) },
        { name: 'Наковальня', weight: 900, quantity: 1 },
      ])
      break
    }
    case 'EquipItem':
    case 'TransferItem':
    case 'AttuneItem':
    case 'ActivateItem': {
      const player = hero(state, actorId)
      if (chance(0.3)) {
        const club = catalog(pick(['srd_5_2_1:club', 'srd_5_2_1:quarterstaff']), { id: `club-${n}`, quantity: 1, equipped: chance(0.5) })
        if (club) {
          giveItems(state, actorId, [club])
          state.mechanics.conditions ??= {}
          state.mechanics.conditions[actorId] = [...(state.mechanics.conditions[actorId] ?? []), { id: 'shillelagh', source_item_id: club.id, ...(chance(0.5) ? { effect_id: 'eff-sh' } : {}) }]
          if (chance(0.7)) input.item_id = club.id
        }
      }
      if (input.actor_id !== actorId || !input.item_id || chance(0.3)) {
        input.actor_id = actorId
        const items = (Array.isArray(player?.inventory) ? player.inventory : []).filter(Boolean)
        if (items.length) input.item_id = pick(items).id
      }
      if (type === 'EquipItem') {
        input.equipped = pick([true, false, true])
        input.equip_slot = pick([U, 'main_hand', 'off_hand', 'armor', 'main_hand'])
      }
      if (type === 'TransferItem') {
        const others = heroes.filter((id) => id !== actorId)
        input.recipient_id = pick([...others, ...others, actorId, 'ghost'])
        input.recipient_kind = 'hero'
        input.quantity = pick([1, 2, U])
      }
      if (type === 'AttuneItem') input.attuned = pick([true, false])
      if (type === 'ActivateItem') input.activated = pick([true, false])
      break
    }
    case 'UseItem': {
      if (context.isNpcScheduler === true) break
      if (chance(0.7)) {
        const id = pick(USABLE)
        const item = catalog(id, { id: `use-${n}`, quantity: pick([1, 2, 3]), equipped: true, attuned_to: actorId, ...(id.includes('wand') ? { charges: pick([1, 3, 7]) } : {}) })
        if (item) {
          giveItems(state, actorId, [item])
          if (chance(0.4)) giveItems(state, actorId, [catalog('srd_5_2_1:dagger', { id: `dagger-${n}`, quantity: 1, equipped: true })].filter(Boolean))
          for (const key of ['to', 'use_mode', 'weapon_id', 'charges_to_spend', 'spell_id', 'formula', 'projectile_count', 'npc_tactic']) delete input[key]
          input.actor_id = actorId
          input.item_id = item.id
          const targets = [actorId, ...actorsOf(state)]
          input.target_id = pick([...targets, actorId, actorId])
          if (chance(0.3)) input.use_mode = 'spill'
          if (id.includes('caltrops') || input.use_mode === 'spill') {
            const at = state.mechanics?.positions?.[actorId] ?? { x: 1, y: 1 }
            input.to = { x: at.x + int(3) - 1, y: at.y + int(3) - 1 }
          }
          if (id.includes('poison')) input.weapon_id = pick([`dagger-${n}`, 'nope'])
          if (id.includes('wand')) input.charges_to_spend = pick([1, 2, 3, U])
        }
      }
      break
    }
    default:
      break
  }
  return deepUndefined(input)
}

// --- исходы ------------------------------------------------------------------------

const full = process.env.SK_R11_FULL ? [] : null
function digest(value) {
  return sha(JSON.stringify(value))
}
function failure(error) {
  if (error?.name === 'RulesValidationError') return { err: [error.code, error.message] }
  return { fault: String(error?.name ?? 'Error'), message: String(error?.message ?? '') }
}
const seen = new Map()
const note = (events) => { for (const event of events ?? []) seen.set(event.event_type, (seen.get(event.event_type) ?? 0) + 1) }

const cases = []
const validations = []
function run(s, input, context, values, branch = false) {
  uuidCounter = 0
  const raw = states[s]
  let result = null
  let o
  try {
    result = E.resolveCommand(json(input), json(raw), { diceService: service(values), context: json(context) })
    note(result.events)
    o = { ok: { command: digest(result.command), events: digest(result.events), rolls: digest(result.rolls), types: result.events.map((event) => event.event_type) } }
  } catch (error) {
    o = failure(error)
  }
  const index = cases.length
  cases.push({ s, input, context, v: values, o, ...(branch ? { branch: true } : {}) })
  if (full) full.push({ index, o: result ? { command: result.command, events: result.events, rolls: result.rolls } : o })
  if (!branch && chance(0.25)) {
    uuidCounter = 0
    let v
    try {
      v = { ok: digest(E.validateCommand(json(input), json(raw), json(context))) }
    } catch (error) {
      v = failure(error)
    }
    validations.push({ s, input, context, o: v })
  }
  return result
}

/** Состояние после событий команды. */
function after(state, events) {
  return events.reduce((current, event) => E.applyGameEvent(current, event), state)
}

// Цепочки: какие команды идут следом за командой семейства.
const FOLLOW = {
  OperateDoor: ['OperateDoor', 'OperateDoor', 'BarricadeDoor', 'ClearDoorBarricade'],
  BarricadeDoor: ['ClearDoorBarricade', 'ClearDoorBarricade', 'OperateDoor', 'BarricadeDoor'],
  ClearDoorBarricade: ['OperateDoor', 'BarricadeDoor', 'ClearDoorBarricade'],
  OperateSceneObject: ['OperateSceneObject'],
  ResolveImprovisedAction: ['ResolveImprovisedAction'],
  AttackNpc: ['EndCombat'],
  CreateEncounter: ['StartCombat'],
  StartCombat: ['EndCombat', 'UseItem', 'ResolveImprovisedAction', 'OperateDoor'],
  EndCombat: ['GrantItem', 'UseItem'],
  CalmBeast: ['CalmBeast', 'CalmBeast', 'FeedBeast'],
  FeedBeast: ['CalmBeast'],
  StageScenarioStranger: [],
  GrantItem: ['EquipItem', 'UseItem', 'TransferItem', 'GrantItem'],
  EquipItem: ['EquipItem', 'TransferItem', 'AttuneItem', 'UseItem'],
  TransferItem: ['EquipItem', 'TransferItem'],
  AttuneItem: ['ActivateItem', 'EquipItem'],
  ActivateItem: ['ActivateItem', 'UseItem'],
  UseItem: ['UseItem', 'UseItem', 'EquipItem'],
}
const ADMIN_FOLLOW = new Set(['EndCombat', 'StartCombat', 'GrantItem'])

const REPEATS = { StageScenarioStranger: 8, CalmBeast: 6, AttackNpc: 4, CreateEncounter: 3, OperateDoor: 8, BarricadeDoor: 10, ClearDoorBarricade: 10, OperateSceneObject: 6, ResolveImprovisedAction: 4, GrantItem: 8, AttuneItem: 6, ActivateItem: 6, UseItem: 5 }
let counter = 0
for (const record of chosen) {
  const type = record.command.command_type
  const repeats = REPEATS[type] ?? 3
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    let state = corpusState(record.state)
    let context = json(record.context ?? {})
    let currentType = type
    let base = record.command
    const steps = attempt === 0 ? 1 : 1 + int(4)
    for (let step = 0; step < steps; step += 1) {
      counter += 1
      let input
      if (attempt === 0 && step === 0) {
        input = json(record.command)
      } else if (step === 0) {
        input = nextInput(currentType, state, base, context, counter)
      } else {
        input = nextInput(currentType, state, base, context, counter)
      }
      let branch = false
      if (currentType === 'StageScenarioStranger') {
        // Незнакомца дописывает блок проверки сценария (Р6): в эталон идёт уже
        // проверенная команда, Rust сверяет ветку без проверки
        // (`resolveBranchWithoutTail`); отказы этого блока — эталоны Р6.
        try { input = E.validateCommand(json(input), json(state), json(context)) } catch { break }
        branch = true
      }
      if (currentType === 'FeedBeast') giveItems(state, input.actor_id, [catalog('srd_5_2_1:rations-one-day', { id: `ration-${counter}`, quantity: 2 })].filter(Boolean))
      const s = addState(state)
      const values = attempt === 0 && step === 0 && Array.isArray(record.dice) ? null : diceValues()
      const dice = values ?? diceValues()
      const result = run(s, input, context, dice, branch)
      if (!result) break
      state = compact(after(states[s], result.events))
      const follow = FOLLOW[currentType] ?? []
      if (!follow.length) break
      currentType = pick(follow)
      base = { command_type: currentType, actor_id: input.actor_id, campaign_id: input.campaign_id, server_authoritative: input.server_authoritative, beast_id: input.beast_id }
      if (ADMIN_FOLLOW.has(currentType)) context = { isAdmin: true, serverAuthoritativeCombat: true }
    }
  }
  if (stateBytes > 70_000_000) break
}

// --- sortedInitiative ----------------------------------------------------------------

const initiatives = []
for (let n = 0; n < 300; n += 1) {
  const entries = Array.from({ length: 1 + int(9) }, (_, index) => ({
    actor_id: pick(['hero-a', 'Hero-b', 'вождь', 'goblin-1', 'goblin-10', 'goblin-2', 'z', 'Ёж', 'ёж', `a${index}`]),
    total: pick([5, 10, 10, 12, 20, 0, -1, NaN, 15.5]),
    modifier: pick([0, 2, 2, -1, 5, NaN, 0.5]),
  }))
  initiatives.push({ entries: entries.map((entry) => ({ ...entry, total: Number.isNaN(entry.total) ? 'NaN' : entry.total, modifier: Number.isNaN(entry.modifier) ? 'NaN' : entry.modifier })), o: E.sortedInitiative(entries).map((entry) => entry.actor_id) })
}

const output = { source_sha256: sourceSha256(), states, cases, validations, initiatives }
const text = `${JSON.stringify(output)}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('r11.json.gz', import.meta.url), gz)
if (full) writeFileSync(process.env.SK_R11_FULL, JSON.stringify(full))
const count = (list) => list.filter((entry) => entry.o.ok !== undefined).length
const byType = {}
for (const entry of cases) {
  const key = entry.input.command_type
  byType[key] ??= [0, 0]
  byType[key][0] += 1
  if (entry.o.ok !== undefined) byType[key][1] += 1
}
console.log(Object.entries(byType).map(([key, [all, ok]]) => `${key}:${ok}/${all}`).join(' '))
console.log([...seen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log(`r11.json.gz: ${(gz.length / 1e6).toFixed(2)} МБ (JSON ${(text.length / 1e6).toFixed(1)} МБ), состояний ${states.length}, разборов ${cases.length} (ok ${count(cases)}), проверок ${validations.length}, инициатив ${initiatives.length}`)
