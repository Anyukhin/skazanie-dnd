import '../../../fixtures-env.mjs'
// Эталоны задачи Р7: общество — блоки `validateCommand` 11–17, 25, 26; ветки
// разбора NPC мира, пленных, зверей, парлея, контейнеров, таверны,
// благословения, почты и закона; предпросмотры (`previewD20Check`,
// `previewTavernDiceRoll`), отказ молитвы (`shrinePrayerRefusalFor`), события
// благословения (`blessingGrantedEvents`); `eventSummary` и
// `actorNameResolver` на синтетических событиях всех ветвей.
//
// Состояния — из корпуса (`tmp/corpus-v1/states`): «до команды» записей
// перенесённых типов, по несколько на тип. Команды — записанные команды и их
// мутации с мусором (чужой актор, пустые и выдуманные id, ставки вне набора,
// неизвестные исходы, ручные броски). Ветки снимаются полным
// `resolveCommandInternal` открытой копии: Rust разбирает без хвоста
// последствий (Р5), поэтому сверяет события и броски началом списков JS.
//
// Выход — `fixtures/society-r7.json.gz`; длинные значения — `sha256:` строки
// `JSON.stringify`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-society-r7.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, SOURCE_URL, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0007_5eed
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
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 160 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function attempt(fn, shape = out) {
  try {
    return { ok: shape(fn()) }
  } catch (error) {
    if (error?.name !== 'RulesValidationError') return { fault: String(error?.name), message: String(error?.message ?? '') }
    return { err: [error.code, error.message] }
  }
}
/** `U` внутри объекта — поле со значением `undefined` (в Rust поля нет). */
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}

// --- состояния корпуса ------------------------------------------------------------

const TYPES = [
  'PlaceNpc', 'MoveNpc', 'HarmNpc', 'InterrogateCaptive', 'ReleaseCaptive', 'HandCaptiveToGuards', 'FeedCaptive', 'NeglectCaptive', 'ExecuteCaptive',
  'FeedBeast', 'ScareWithBeast', 'CalmBeast', 'ProposeParley', 'SettleParley', 'LootContainer', 'OpenTavernDiceRound', 'AnswerTavernDiceRound',
  'LeaveTavernDiceRound', 'OrderTavernDrink', 'ReceiveNpcBlessing', 'SendLetter', 'ClearWantedLevel', 'ResolveGuardEncounter',
]
const PER_TYPE = 4
const records = new Map(TYPES.map((type) => [type, []]))
for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const type = entry?.command?.command_type
    if (records.has(type)) records.get(type).push(entry)
  }
}
const stateIndex = new Map()
const states = []
const seeds = []
for (const [type, list] of records) {
  const chosen = []
  const step = Math.max(1, Math.floor(list.length / PER_TYPE))
  for (let index = 0; index < list.length && chosen.length < PER_TYPE; index += step) chosen.push(list[index])
  for (const entry of chosen) {
    if (!stateIndex.has(entry.state)) {
      stateIndex.set(entry.state, states.length)
      states.push(JSON.parse(readFileSync(join(corpusDir, 'states', `${entry.state}.json`), 'utf8')))
    }
    seeds.push({ type, s: stateIndex.get(entry.state), command: entry.command, context: entry.context ?? {} })
  }
}
const snapshots = states.map((state) => JSON.stringify(state))
const normalized = states.map((state) => E.normalizeCampaignState(structuredClone(state)))

// --- команды ----------------------------------------------------------------------

const ids = (list) => (Array.isArray(list) ? list : []).map((entry) => String(entry?.id ?? entry?.actor_id ?? '')).filter(Boolean)
function pools(state) {
  return {
    heroes: ids(state.players),
    enemies: ids(state.enemies),
    npcs: ids(state.social?.npcs),
    captives: ids(state.captives?.list ?? state.captives),
    beasts: ids(state.beasts?.list ?? state.beasts),
  }
}
const CONTEXTS = [{}, { isAdmin: true }, { isDirector: true }, { serverAuthoritativeCombat: true }, { isAdmin: 'yes' }, { isNpcScheduler: true }]
function mutate(seedEntry, state) {
  const base = json(seedEntry.command)
  const pool = pools(state)
  const input = { ...base }
  const vary = (key, options) => { if (chance(0.35)) input[key] = pick(options) }
  vary('actor_id', [base.actor_id, base.actor_id, ...pool.heroes, ...pool.enemies.slice(0, 2), 'ghost', null, U])
  vary('visibility', ['party', 'public', 'gm_only', U])
  if ('npc_id' in base || ['PlaceNpc', 'MoveNpc', 'HarmNpc', 'OpenTavernDiceRound', 'ReceiveNpcBlessing'].includes(base.command_type)) vary('npc_id', [base.npc_id, base.npc_id, ...pool.npcs.slice(0, 4), 'ghost', ''])
  if ('captive_id' in base) vary('captive_id', [base.captive_id, base.captive_id, ...pool.captives.slice(0, 3), 'ghost', ''])
  if ('beast_id' in base) vary('beast_id', [base.beast_id, base.beast_id, ...pool.beasts.slice(0, 3), 'ghost', ''])
  if (['InterrogateCaptive', 'ProposeParley', 'ResolveGuardEncounter'].includes(base.command_type)) vary('skill', [base.skill, 'persuasion', 'intimidation', 'stealth', 'athletics', 'x', U])
  if (base.command_type === 'SettleParley') vary('outcome', [base.outcome, 'withdraw', 'tribute', 'surrender', 'resume', 'x', ''])
  if (base.command_type === 'ResolveGuardEncounter') vary('resolution', [base.resolution, 'fine', 'surrender', 'fight', 'flee', 'x'])
  if (base.command_type === 'OpenTavernDiceRound') vary('stake_cp', [base.stake_cp, 10, 50, 200, 7, '50', U])
  if (base.command_type === 'AnswerTavernDiceRound') vary('approach', [base.approach, 'fair', 'cheat', 'watch', 'x', U])
  if (base.command_type === 'SendLetter') {
    vary('addressee_kind', [base.addressee_kind, 'npc', 'faction', 'x'])
    vary('addressee_id', [base.addressee_id, ...pool.npcs.slice(0, 3), 'ghost', ''])
    vary('body', [base.body, '', '   ', 'Обещаю вернуть долг к весне.', 'Привет'])
  }
  if (base.command_type === 'ClearWantedLevel') vary('region_id', [base.region_id, '', 'ghost', U])
  if (['PlaceNpc', 'MoveNpc'].includes(base.command_type)) vary('to', [base.to, { x: int(12), y: int(12) }, { x: -1, y: 2 }, null])
  if (base.command_type === 'HarmNpc') vary('amount', [base.amount, 1, 5, 50, -1, 'x'])
  if (chance(0.15)) input.verified_roll = pick([U, { roll_id: 'v-1', dice: [int(20) + 1] }, { roll_id: 'v-2', dice: [int(20) + 1, int(20) + 1] }, { dice: [] }])
  input.command_id = chance(0.8) ? base.command_id ?? `cmd-${int(1000)}` : `cmd-${int(1000)}`
  const context = chance(0.5) ? json(seedEntry.context) : pick(CONTEXTS)
  return { input: deepUndefined(input), context }
}
const commands = []
for (const seedEntry of seeds) {
  const state = states[seedEntry.s]
  commands.push({ s: seedEntry.s, input: json(seedEntry.command), context: json(seedEntry.context) })
  for (let n = 0; n < 14; n += 1) {
    const { input, context } = mutate(seedEntry, state)
    commands.push({ s: seedEntry.s, input: json(input), context: json(context) })
  }
}

// --- блоки проверки ----------------------------------------------------------------

const blocks = {
  b11: await blockFunction([[6204, 6213]], ['if (NPC_WORLD_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b12: await blockFunction([[6214, 6243]], ['if (CAPTIVE_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b13: await blockFunction([[6244, 6251]], ['if (LOOT_CONTAINER_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b14: await blockFunction([[6252, 6260]], ['if (BEAST_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b15: await blockFunction([[6261, 6287]], ['if (PARLEY_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b16: await blockFunction([[6288, 6352]], ['if (LAW_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b17: await blockFunction([[6353, 6465]], ['if (TAVERN_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b25: await blockFunction([[6641, 6679]], ['if (BLESSING_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
  b26: await blockFunction([[6683, 6683]], ['if (COURIER_LETTER_COMMAND_TYPES.has(command.command_type))'], ['state', 'command', 'context'], 'return command'),
}
const normalizedCommands = []
const blockCases = []
for (const entry of commands) {
  const state = normalized[entry.s]
  let command
  try {
    globalThis.__SK_OPEN_COPY_UUID__ = (() => { let n = 0; return () => `uuid-${++n}` })()
    command = E.normalizeCommand(json(entry.input), state)
  } catch { continue }
  const input = normalizedCommands.push({ s: entry.s, command: json(command), context: entry.context }) - 1
  for (const [name, run] of Object.entries(blocks)) {
    if (!blockApplies(name, command.command_type)) continue
    blockCases.push({ block: name, input, ...attempt(() => run(state, structuredClone(command), entry.context)) })
    // Та же команда в чужих состояниях: бой, другая сцена, другие герои.
    for (let n = 0; n < 3; n += 1) {
      const other = int(normalized.length)
      blockCases.push({ block: name, input, s: other, ...attempt(() => run(normalized[other], structuredClone(command), entry.context)) })
    }
  }
}
function blockApplies(name, type) {
  const sets = {
    b11: E.NPC_WORLD_COMMAND_TYPES, b12: E.CAPTIVE_COMMAND_TYPES, b13: E.LOOT_CONTAINER_COMMAND_TYPES, b14: E.BEAST_COMMAND_TYPES, b15: E.PARLEY_COMMAND_TYPES,
    b16: E.LAW_COMMAND_TYPES, b17: E.TAVERN_COMMAND_TYPES, b25: E.BLESSING_COMMAND_TYPES, b26: E.COURIER_LETTER_COMMAND_TYPES,
  }
  // Блок чужого типа ничего не делает: такой случай нужен изредка.
  return sets[name].has(type) || chance(0.03)
}

// --- ветки разбора ------------------------------------------------------------------

const branchCases = []
for (const entry of commands) {
  if (entry.input.command_type === 'CalmBeast') continue
  const values = Array.from({ length: 12 }, () => int(20) + 1)
  globalThis.__SK_OPEN_COPY_UUID__ = (() => { let n = 0; return () => `uuid-${++n}` })()
  const o = attempt(() => E.resolveCommandInternal(json(entry.input), structuredClone(states[entry.s]), { diceService: service(values), context: entry.context }), (result) => ({
    events: result.events.map((event) => sha(event)),
    rolls: result.rolls.map((roll) => sha(roll)),
    first: out(result.events[0]),
  }))
  branchCases.push({ s: entry.s, input: entry.input, context: entry.context, v: values, o })
  {
    // Та же команда в чужом состоянии.
    const other = int(states.length)
    const values = Array.from({ length: 12 }, () => int(20) + 1)
    globalThis.__SK_OPEN_COPY_UUID__ = (() => { let n = 0; return () => `uuid-${++n}` })()
    const o = attempt(() => E.resolveCommandInternal(json(entry.input), structuredClone(states[other]), { diceService: service(values), context: entry.context }), (result) => ({
      events: result.events.map((event) => sha(event)),
      rolls: result.rolls.map((roll) => sha(roll)),
      first: out(result.events[0]),
    }))
    branchCases.push({ s: other, input: entry.input, context: entry.context, v: values, o })
  }
}

// --- предпросмотры и помощники ------------------------------------------------------

const calls = []
function call(f, s, args, fn) {
  calls.push({ f, s, a: args, o: attempt(() => fn(normalized[s], ...args.map(deepUndefined))) })
}
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha', 'CON', '', null, U]
const SKILLS = ['perception', 'stealth', 'persuasion', 'sleight_of_hand', 'sleight-of-hand', 'insight', 'Insight ', 'religion', 'athletics', 'x', '', null, U]
for (let s = 0; s < normalized.length; s += 1) {
  const state = normalized[s]
  const pool = pools(state)
  const actors = [...pool.heroes, ...pool.enemies.slice(0, 2), 'ghost', U]
  for (const actorId of actors) {
    for (let n = 0; n < 6; n += 1) {
      const options = { actorId, kind: pick(['check', 'check', 'save', U, 'x']), ability: pick(ABILITIES), skill: pick(SKILLS), difficulty: pick([U, 15, '12', null, 'x', 30]), proficient: pick([U, true, false, 1]) }
      call('previewD20Check', s, [options], (st, o) => E.previewD20Check(st, o))
    }
    call('previewTavernDiceRoll', s, [actorId, pick([U, 'cheat', 'fair', 'watch', null])], (st, a, b) => E.previewTavernDiceRoll(st, a, b))
  }
  const props = (state.scene?.map?.props ?? []).map((prop) => String(prop?.id ?? '')).filter(Boolean)
  const shrines = props.filter((id) => /shrine|altar|святын|алтар/iu.test(id))
  for (const propId of [...shrines, ...props.slice(0, 2), 'ghost']) {
    for (const actorId of [...pool.heroes.slice(0, 2), 'ghost']) {
      call('shrinePrayerRefusalFor', s, [actorId, propId], (st, a, b) => E.shrinePrayerRefusalFor(structuredClone(st), { actorId: a, propId: b }))
    }
  }
  for (const heroId of [...pool.heroes.slice(0, 2), 'ghost']) {
    const options = { heroId, source: pick(['priest', 'shrine']), placeName: pick(['', 'Храм', U]), npcId: pick(['', 'npc-1', U]), npcName: pick(['', 'Отец Савва', U]), minutes: pick([0, 90, -5, 'x', U]), sourceEventId: pick(['', 'npc-blessing:1', U]) }
    const command = { command_id: 'cmd-b', campaign_id: 'camp', actor_id: heroId, ruleset_id: state.ruleset_id, source_rule_ids: [], target_ids: [], visibility: pick(['party', U]) }
    call('blessingGrantedEvents', s, [command, options], (st, c, o) => E.blessingGrantedEvents(c, st, o))
  }
}

// --- сводки событий ------------------------------------------------------------------

const engineLines = readFileSync(SOURCE_URL, 'utf8').split(/\r?\n/)
const summaryStart = engineLines.findIndex((line) => line.startsWith('export function eventSummary('))
const summaryEnd = engineLines.findIndex((line, index) => index > summaryStart && line.startsWith('}'))
const summarySource = engineLines.slice(summaryStart, summaryEnd).join('\n')
const chunks = summarySource.split(/\n\s*case /u).slice(1)
const caseTypes = []
for (const chunk of chunks) {
  const label = /^'([A-Za-z]+)'|^([A-Z_]+):/u.exec(chunk)
  const type = label?.[1] ?? E[label?.[2]]
  if (!type) continue
  const fields = [...new Set([...chunk.matchAll(/payload\.([a-z_]+)/gu)].map((match) => match[1]))]
  const nested = [...chunk.matchAll(/payload\.([a-z_]+)\?\.(?:\[0\]\?\.)?([a-z_]+)/gu)].map((match) => [match[1], match[2]])
  caseTypes.push({ type, fields, nested })
}
const VALUES = [U, U, null, '', 0, 1, 7, -3, 2.5, 'текст', 'hero-1', 'npc-x', 'foe-1', true, false, [], ['a', null, 3], {}, 'fine', 'surrender', 'fight', 'win', 'loss', 'push', 'caught', 'long', 'dead', 'enemies', 'auto', 'never', 'blessed', 'omen', 'trace', 'ammunition', 'patron-ejected', 'opponent-broke', 'scene-program-rebuild', 'scene-floor-refresh', 'minute', 'hour', 'constructor', 'toString', 'cast:shield', 'resolved', 'victory', 'победа']
function randomPayload(spec) {
  const payload = {}
  for (const field of spec.fields) if (chance(0.7)) payload[field] = pick(VALUES)
  for (const [outer, inner] of spec.nested) {
    if (!chance(0.6)) continue
    const nestedValue = { [inner]: pick(VALUES) }
    payload[outer] = outer === 'item_immunity_sources' ? [nestedValue] : outer === 'step' ? { lines: pick([['Мир', null, 'сдвинулся'], [], 'x']) } : nestedValue
  }
  if (spec.fields.includes('loot') && chance(0.5)) payload.loot = [{ name: 'Меч', quantity: 2 }, { name: 'Щит' }, { quantity: null }]
  if (spec.fields.includes('allocations') && chance(0.5)) payload.allocations = [{ recipient_id: 'hero-1' }, { recipient_id: 'ghost' }, { recipient_id: '' }, {}]
  if (spec.fields.includes('levels') && chance(0.5)) payload.levels = [{}, {}]
  if (spec.fields.includes('encounter') && chance(0.5)) payload.encounter = { enemies: [{ name: 'Гоблин' }, { name: null }, {}], place_name: pick(VALUES), officer_rank: pick(VALUES), officer_name: pick(VALUES) }
  return payload
}
const resolverStates = [
  { players: [{ id: 'hero-1', character: 'Ада' }, { id: 'hero-2', name: 'Бран' }, { actor_id: 'hero-3', name: '' }, { id: 7, character: 'Число' }], enemies: [{ id: 'foe-1', name: 'Гоблин' }], actors: [{ id: 'hero-1', name: 'Перезапись' }], social: { npcs: [{ id: 'npc-x', name: 'Мира' }, { id: 'foe-1', name: 'не то' }] } },
  ...normalized.slice(0, 3),
]
const resolvers = resolverStates.map((state) => E.actorNameResolver(state))
const summaries = []
// Мусорный payload, на котором JS бросает `TypeError`, помечается `__throw__:` — Rust печатает текст пустого значения (см. шапку `summary.rs`).
const summaryText = (fn) => { try { const value = fn(); return value === undefined ? U : value } catch (error) { return `__throw__:${error?.name}` } }
const ACTORS = [U, null, '', 'hero-1', 'hero-2', 'hero-3', 'foe-1', 'npc-x', 'ghost', 7]
const TARGETS = [U, null, [], ['hero-1'], ['npc-x', 'b'], ['foe-1'], 'строка', [7]]
for (const spec of caseTypes) {
  for (let n = 0; n < 14; n += 1) {
    const event = deepUndefined({ event_type: spec.type, actor_id: pick(ACTORS), target_ids: pick(TARGETS), payload: randomPayload(spec) })
    const e = json(event)
    const r = int(resolvers.length)
    summaries.push({ e, r, plain: summaryText(() => E.eventSummary(e)), named: summaryText(() => E.eventSummary(e, resolvers[r])) })
  }
}
for (const e of [{ event_type: 'NpcDied' }, { event_type: 'NpcDied', payload: null }, { event_type: 'NpcDied', payload: 'строка' }, { event_type: 'Unknown' }, { payload: {} }, { event_type: 'TimeAdvanced', payload: { unit: 'constructor', amount: 2 } }]) {
  summaries.push({ e, r: 0, plain: summaryText(() => E.eventSummary(e)), named: summaryText(() => E.eventSummary(e, resolvers[0])) })
}

const mutated = states.map((state, index) => (JSON.stringify(state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, normalized_sha: normalized.map((state) => sha(state)), commands: normalizedCommands, blocks: blockCases, branches: branchCases, calls, resolver_states: resolverStates.slice(0, 1), summaries }
const text = `${JSON.stringify(output)}\n`
writeFileSync(new URL('society-r7.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
const okBranches = branchCases.filter((entry) => entry.o.ok).length
console.log(`society-r7.json.gz: состояний ${states.length} (${(text.length / 1e6).toFixed(1)} МБ JSON), команд ${normalizedCommands.length}, блоков ${blockCases.length}, веток ${branchCases.length} (приняты ${okBranches}), вызовов ${calls.length}, сводок ${summaries.length} (типов ${caseTypes.length})`)
