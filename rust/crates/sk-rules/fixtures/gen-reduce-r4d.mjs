import '../../../fixtures-env.mjs'
// Эталоны Р4в-2: ветки жизни вещи, героя, наград, контейнеров добычи и
// должностей и реестры-выводы (летопись, мир за кадром, почта, пленные,
// рыцарь, разговоры, автономия) на событиях корпуса и их порче.
//
// Из корпуса берутся самые маленькие состояния «до» каждого типа
// (неподвижные точки нормализации, как в `gen-reduce-r4a-corpus.mjs`), к ним —
// само событие и его порченые варианты: поле payload заменено мусором
// (`null`, отсутствие, пустая строка, дроби, строки-числа, ключи прототипа,
// длинный текст, не тот тип), чужая или пустая цель, иной действующий,
// иная версия схемы, соседний тип события. Наград в корпусе нет —
// `EncounterRewardsDistributed` собирается здесь на тех же состояниях.
//
// Эталон — sha256 `JSON.stringify` состояния после `applyGameEvent` без
// производных полей героя (`combatSpells`, `combatActions`, `characterSheet`,
// `inventoryLoad`): совпадает и содержимое, и порядок ключей. Событие, на
// котором JS бросает, помечено `throws`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-reduce-r4d.mjs <корпус>
// Отладка: … gen-reduce-r4d.mjs <корпус> --dump <номер случая> — состояние JS.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'
import { ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION as REWARDS_VERSION } from '../../../../server/encounter-rewards.mjs'

const corpus = process.argv[2]
if (!corpus || corpus.startsWith('--')) throw new Error('Укажите каталог корпуса')
const E = await loadOpenCopy()
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

let seed = 0x4a4d0d02
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p

// Тип → [сколько состояний взять, сколько порченых вариантов на событие].
const ITEM = ['ItemEquipped', 'ItemUnequipped', 'ItemTransferred', 'ItemAttunementChanged', 'ItemChargesSpent', 'ItemDestroyed', 'MagicItemActivationChanged']
const HERO = ['SpellSelectionsUpdated', 'CharacterChoicesUpdated', 'CharacterLeveledUp', 'CharacterImported']
const LOOT = ['LootContainerCreated', 'LootContainerTaken']
const OFFICE = ['OfficeVacated', 'OfficeHolderInstalled', 'OfficeSuccessionSkipped']
const PLAN = {
  ItemEquipped: [3, 12], ItemUnequipped: [2, 12], ItemTransferred: [3, 12], ItemAttunementChanged: [3, 12], ItemChargesSpent: [3, 12],
  ItemDestroyed: [2, 12], MagicItemActivationChanged: [3, 12], ItemGranted: [3, 12],
  SpellSelectionsUpdated: [2, 12], CharacterChoicesUpdated: [3, 14], CharacterLeveledUp: [3, 14], CharacterImported: [3, 10],
  LootContainerCreated: [3, 12], LootContainerTaken: [3, 12],
  OfficeVacated: [1, 14], OfficeHolderInstalled: [1, 12], OfficeSuccessionSkipped: [1, 12],
  CourierLetterDelivered: [2, 6], CourierLetterAnswered: [2, 6], CourierLetterReturned: [1, 6], CourierLetterUnanswered: [1, 6],
  CaptiveInterrogated: [2, 6], CaptiveNeglected: [1, 6], CaptiveExecuted: [1, 6], CaptiveMoved: [1, 6], CaptiveFed: [1, 6], CaptiveReleased: [1, 6],
  DialogueOptionChosen: [1, 8], OffscreenWorldStepResolved: [2, 6], WitnessConsequencePropagated: [2, 6], FactionReputationAdjusted: [2, 6],
  ScenarioKnightReleaseFailed: [1, 6], ScenarioKnightReleased: [1, 6], TavernCheatCaught: [1, 6], NpcPromiseResolved: [1, 6],
}
const SIBLINGS = Object.fromEntries([...ITEM.map((type) => [type, ITEM]), ...HERO.map((type) => [type, HERO]), ...LOOT.map((type) => [type, LOOT]), ...OFFICE.map((type) => [type, OFFICE])])

const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
const comparable = (state) => {
  const copy = json(state)
  for (const player of copy.players ?? []) for (const field of DERIVED) delete player[field]
  return copy
}
const modeFor = (event) => {
  const marker = event?.reducer_version == null ? 0 : Number(event.reducer_version)
  return (marker > 0 && marker < E.RETENTION_REDUCER_VERSION) || (marker === 0 && Number.isSafeInteger(event?.state_version_after)) ? 'legacy' : 'current'
}
const fixedPoint = (mode, state) => {
  const again = E.withRetentionMode(mode, () => E.normalizeCampaignState(state))
  return JSON.stringify(again) === JSON.stringify(state)
}

// Эталоны лежат в git: состояние больше этого не берётся (кроме должностей —
// они есть только в большой кампании), а память карт мест (`locationMaps`)
// снимается, если состояние без неё — тоже неподвижная точка нормализации.
// Обе стороны сверки начинают с одного и того же урезанного состояния.
const MAX_BASE_SIZE = 260_000
function trimmed(mode, state) {
  if (!state?.locationMaps || !Object.keys(state.locationMaps).length) return state
  const copy = { ...state, locationMaps: {} }
  return fixedPoint(mode, copy) ? copy : state
}

// --- отбор: самые маленькие состояния «до» каждого типа ---------------------

const chosen = new Map() // тип → [{ size, pre, event, mode }]
for (const file of readdirSync(corpus).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(corpus, file), 'utf8').split('\n')) {
    if (!line) continue
    const entry = JSON.parse(line)
    if (!entry.outcome?.ok) continue
    const events = entry.outcome.events ?? []
    if (!events.some((event) => PLAN[event.event_type])) continue
    let state
    try {
      state = E.normalizeCampaignState(JSON.parse(readFileSync(join(corpus, 'states', `${entry.state}.json`), 'utf8')))
    } catch {
      continue
    }
    for (const event of events) {
      try {
        const plan = PLAN[event.event_type]
        if (plan) {
          const mode = modeFor(event)
          const pre = trimmed(mode, E.withRetentionMode(mode, () => E.normalizeCampaignState(state)))
          const text = JSON.stringify(pre)
          const list = chosen.get(event.event_type) ?? []
          const worst = list.length >= plan[0] ? list[list.length - 1].size : Infinity
          const limit = OFFICE.includes(event.event_type) ? Infinity : MAX_BASE_SIZE
          if (text.length < worst && text.length <= limit && !list.some((item) => item.text === text) && fixedPoint(mode, pre)) {
            list.push({ size: text.length, text, event: json(event), mode })
            list.sort((a, b) => a.size - b.size)
            chosen.set(event.event_type, list.slice(0, plan[0]))
          }
        }
        state = E.applyGameEvent(state, event)
      } catch {
        break
      }
    }
  }
}

// --- состояния ----------------------------------------------------------------

const bases = []
const baseIndex = new Map()
function baseFor(text) {
  if (!baseIndex.has(text)) {
    baseIndex.set(text, bases.length)
    bases.push(JSON.parse(text))
  }
  return baseIndex.get(text)
}

// --- порча --------------------------------------------------------------------

const GARBAGE = [null, undefined, '', '  ', 'x', 0, -1, 1.5, 2, '2', 'abc', true, false, [], {}, ['a'], { x: 1 }, 'constructor', '__proto__', 'я'.repeat(300), 9e15, -7.25]
function mutateValue(value, depth = 0) {
  if (depth < 3 && value && typeof value === 'object' && chance(0.55)) {
    const copy = json(value)
    const keys = Object.keys(copy)
    if (keys.length) {
      const key = pick(keys)
      const next = mutateValue(copy[key], depth + 1)
      if (next === undefined && !Array.isArray(copy)) delete copy[key]
      else copy[key] = next ?? null
      return copy
    }
  }
  return json(pick(GARBAGE)) ?? (chance(0.5) ? undefined : null)
}

function idsOf(state) {
  const ids = [...(state.players ?? []), ...(state.enemies ?? []), ...(state.actors ?? [])].map((actor) => String(actor?.id ?? '')).filter(Boolean)
  return ids.length ? ids : ['hero']
}

function mutateEvent(event, state) {
  const next = json(event)
  const ids = idsOf(state)
  const count = 1 + Math.floor(random() * 3)
  for (let step = 0; step < count; step += 1) {
    const roll = random()
    if (roll < 0.62) {
      if (!next.payload || typeof next.payload !== 'object' || Array.isArray(next.payload) || chance(0.04)) {
        next.payload = chance(0.5) ? json(pick([null, 'строка', 5, []])) : next.payload
        continue
      }
      const keys = Object.keys(next.payload)
      const key = chance(0.1) || !keys.length ? pick(['schema_version', 'combat_action', 'recipient_kind', 'progression_source', 'resource_grant_version', 'item_id', 'container_id']) : pick(keys)
      const value = key === 'combat_action' && chance(0.5) ? pick(['action', 'object_interaction', 'bonus_action', 'reaction', '']) : mutateValue(next.payload[key])
      if (value === undefined) delete next.payload[key]
      else next.payload[key] = value
    } else if (roll < 0.74) {
      const other = pick(ids)
      next.target_ids = pick([[], ['ghost'], [` ${other} `], [other], [other, other], [''], ['constructor']])
    } else if (roll < 0.82) {
      next.actor_id = pick([null, 'ghost', pick(ids), ''])
    } else if (roll < 0.9) {
      const version = pick([1, 2, 3, 0, null, undefined])
      if (version === undefined) delete next.event_schema_version
      else next.event_schema_version = version
    } else if (SIBLINGS[next.event_type]) {
      next.event_type = pick(SIBLINGS[next.event_type])
    }
  }
  return next
}

// --- награды: событий в корпусе нет, собираются на состояниях с героями ------

function rewardEvents(state) {
  const players = (state.players ?? []).map((player) => String(player?.id ?? '')).filter(Boolean)
  if (!players.length) return []
  const items = [
    { id: 'reward-dagger', name: 'Кинжал', type: 'weapon', quantity: 1, weight: 1 },
    { id: 'reward-coins-pouch', name: 'Кошель', type: 'gear', quantity: 2 },
    { id: 'reward-ring', name: 'Кольцо защиты', type: 'gear', magic: true, quantity: 1, equipped: true, attunement: { required: true } },
  ]
  const base = (allocations, extra = {}) => ({
    event_id: `reward-${players[0]}-${allocations.length}`, event_type: 'EncounterRewardsDistributed', actor_id: players[0], target_ids: [],
    event_schema_version: REWARDS_VERSION, payload: { schema_version: REWARDS_VERSION, encounter_id: 'enc-1', allocations, unassigned: { xp: 0, coins_cp: 0, items: [] }, ...extra },
  })
  const events = [
    base([{ recipient_id: players[0], coins_cp: 37, items: [items[0]] }]),
    base(players.slice(0, 3).map((id, index) => ({ recipient_id: id, coins_cp: 10 * index, items: index === 0 ? [items[1], items[2]] : [] }))),
    base([{ recipient_id: players[0], coins_cp: 0, items: [] }]),
    base([{ recipient_id: ` ${players[0]} `, coins_cp: 5, items: [items[2]] }]),
    base([{ recipient_id: players[0], coins_cp: 5 }, { recipient_id: players[0], coins_cp: 5 }]),
    base([{ recipient_id: 'ghost', coins_cp: 5, items: [] }]),
    base([{ recipient_id: players[0], coins_cp: -5, items: [] }]),
    base([{ recipient_id: players[0], coins_cp: 2.5, items: [] }]),
    base([{ recipient_id: players[0], coins_cp: '12', items: [] }]),
    base([{ recipient_id: players[0], coins_cp: 9e15, items: [] }]),
    base([{ recipient_id: players[0], coins_cp: 1, items: [{ name: 'Без id' }] }]),
    base([{ recipient_id: players[0], coins_cp: 1, items: [items[0], items[0]] }]),
    base([{ recipient_id: players[0], coins_cp: 1, items: 'не массив' }]),
    base('не массив'),
    base([null]),
  ]
  const variants = []
  for (const event of events) {
    variants.push(event)
    for (let index = 0; index < 3; index += 1) variants.push(mutateEvent(event, state))
  }
  return variants
}

// --- случаи -------------------------------------------------------------------

const cases = []
const dumps = []
function addCase(base, mode, event) {
  let expected = null
  let throws = false
  try {
    expected = comparable(E.applyGameEvent(bases[base], event))
  } catch {
    throws = true
  }
  cases.push({ base, mode, event, ...(throws ? { throws: true } : { sha256: sha(expected) }) })
  dumps.push(expected)
}

// Должности есть только в большой кампании, и почти одинаковые состояния по
// 400 КБ хранить незачем: пропуск очереди ложится на состояние перед
// назначением (там уже ждёт преемник), освобождение — на своё.
const rewardBases = new Set()
let holderBase = null
const ORDER = (type) => (type === 'OfficeHolderInstalled' ? 0 : 1)
for (const [type, list] of [...chosen.entries()].sort(([a], [b]) => ORDER(a) - ORDER(b) || a.localeCompare(b))) {
  const variants = PLAN[type][1]
  for (const { text, event, mode } of list) {
    const shared = type === 'OfficeSuccessionSkipped' && holderBase?.mode === mode
    const base = shared ? holderBase.base : baseFor(text)
    if (type === 'OfficeHolderInstalled' && !holderBase) holderBase = { base, mode }
    addCase(base, mode, event)
    for (let index = 0; index < variants; index += 1) addCase(base, mode, mutateEvent(event, bases[base]))
    if ((HERO.includes(type) || LOOT.includes(type)) && rewardBases.size < 4 && !rewardBases.has(base)) rewardBases.add(base)
  }
}
for (const base of rewardBases) for (const event of rewardEvents(bases[base])) addCase(base, 'current', event)

// Края листа героя: вывод листа отказывает (негодные характеристики), и
// `refreshPlayerDerivedState` оставляет прежний лист — после нормализации
// это `null`, так что `armor`, `speed`, `proficiency` не трогаются; повышение
// уровня в этом случае бросает. Берутся только неподвижные точки нормализации.
const [heroBase] = rewardBases
const edgeAbilities = [{ str: 'x' }, { str: 99, dex: 1 }, []]
let edgeBases = 0
for (const abilities of heroBase === undefined ? [] : edgeAbilities) {
  const state = json(bases[heroBase])
  const player = state.players?.[0]
  if (!player) break
  player.abilities = abilities
  let fixed = null
  try {
    const normalized = E.normalizeCampaignState(state)
    if (fixedPoint('current', normalized)) fixed = normalized
  } catch { /* не годится */ }
  if (!fixed) continue
  const base = baseFor(JSON.stringify(fixed))
  edgeBases += 1
  const id = String(player.id)
  const events = [
    { event_type: 'ItemGranted', event_schema_version: 2, payload: { item: { id: `edge-item-${edgeBases}`, name: 'Камень', type: 'gear', quantity: 1 } } },
    { event_type: 'SpellSelectionsUpdated', payload: { known_spell_ids: [], prepared_spell_ids: [] } },
    { event_type: 'CharacterChoicesUpdated', payload: { schema_version: 2, subclass: '', creation_benefits: {} } },
    { event_type: 'CharacterLeveledUp', payload: { progression_source: 'milestone' } },
    { event_type: 'ItemConsumed', payload: { item_id: 'nothing', quantity: 1 } },
  ]
  for (const [index, raw] of events.entries()) addCase(base, 'current', { event_id: `edge-sheet-${edgeBases}-${index}`, actor_id: id, target_ids: [id], ...raw })
}

const dump = process.argv.indexOf('--dump')
if (dump >= 0) {
  const at = Number(process.argv[dump + 1])
  console.log(JSON.stringify({ case: cases[at], expected: dumps[at] }, null, 1))
} else {
  const path = new URL('reduce-r4d.json', import.meta.url)
  const text = `${JSON.stringify({ source_sha256: sourceSha256(), bases, cases })}\n`
  writeFileSync(path, text)
  const types = {}
  for (const entry of cases) types[entry.event.event_type] = (types[entry.event.event_type] ?? 0) + 1
  console.log(`состояний: ${bases.length}, случаев: ${cases.length}, бросает JS: ${cases.filter((entry) => entry.throws).length}, размер: ${text.length}`)
  console.log(types)
}
