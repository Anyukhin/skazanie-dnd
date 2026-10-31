import '../../../fixtures-env.mjs'
// Эталоны задачи Р6: торговля (нормализаторы жизненного цикла торговцев,
// оценка, сделки), ветки редьюсера `Merchant*`, блоки `validateCommand` 9, 10,
// 18–24, 27, 33, 41–46, 49, 63, 64 и ветки `resolveCommandInternal` сцены,
// кампании, героя, торговли и сценария (без хвоста последствий — задача Р5).
//
// Блоки и ветки снимаются на состояниях корпуса паритета: из записей корпуса
// берутся «зёрна» — состояние, вход и контекст команды каждого типа Р6, — и к
// ним добавляются варианты: поле команды удалено, обнулено, заменено мусором
// или чужим id из состояния; контекст другой; бой идёт (`patches`). Состояния
// лежат в эталоне целиком (gzip), тест идёт без каталога корпуса.
//
// Ветка исполняется строками движка (подготовка 13033–13701 и `case` Р6) в
// области имён открытой копии: проверку команды делает JS целиком, ветка Rust
// получает уже проверенную JS команду. Вложенный разбор (проверка навыка у
// осведомителя, диалога, договора, рыцаря) идёт в JS полностью, с хвостом.
//
//   node rust/crates/sk-rules/fixtures/gen-r6.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, SOURCE_URL, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0006_5eed
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
  return text.length > 200 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    if (error?.name !== 'RulesValidationError') return { fault: String(error?.name), code: error?.code ?? null }
    return { err: [error.code, error.message] }
  }
}

// --- помощники торговли на синтетических входах -----------------------------------

const calls = []
const encode = (args) => args.map((arg) => (arg === undefined ? U : json(arg)))
function call(f, args, fn) {
  calls.push({ f, a: encode(args), o: attempt(fn) })
}
const CATALOG = ['srd_5_2_1:longsword', 'srd_5_2_1:rope-hempen-50-feet', 'srd_5_2_1:potion-of-healing', 'srd_5_2_1:shield', 'srd_5_2_1:dagger', 'srd_5_2_1:torch', 'srd_5_2_1:rations-1-day', 'unknown:item', 'srd_5_2_1:chain-mail']
const garbage = () => pick([null, undefined, '', '  ', 0, -3, 1.5, 'x'.repeat(130), [], {}, true, '7', 'ok id', 'ok-id'])
const pricing = () => pick([undefined, null, 'x', [], {
  ...(chance(0.5) ? { mode: pick(['catalog', 'catalog_with_agent_adjustment', 'free', null, 5]) } : {}),
  ...(chance(0.4) ? { buy_markup_bps: pick([500, 12000, 40000, '15000', 1.5, null]) } : {}),
  ...(chance(0.4) ? { sell_rate_bps: pick([500, 6000, 'x', null]) } : {}),
  ...(chance(0.4) ? { bargain_dc: pick([1, 12, 40, '10']) } : {}),
  ...(chance(0.3) ? { success_discount_bps: pick([-1, 700, 9000]) } : {}),
  ...(chance(0.3) ? { failure_markup_bps: pick([0, 300, 6000]) } : {}),
  ...(chance(0.3) ? { agent_adjustment_bps: pick([-3000, 150, 2500, 'x']) } : {}),
  ...(chance(0.3) ? { agent_adjustment_limit_percent: pick([0, 10, 50, -5]) } : {}),
  ...(chance(0.3) ? { description: pick(['  Цены  ', 5, 'x'.repeat(600), null]) } : {}),
  ...(chance(0.1) ? { junk: 1 } : {}),
}])
const stockEntry = (index) => pick([null, 'x', {
  stock_id: pick([`s-${index}`, `s-${index}`, garbage()]),
  catalog_id: pick([...CATALOG, garbage()]),
  ...(chance(0.6) ? { quantity: pick([1, 3, 0, 1_000_000, '2', 1.5, null]) } : {}),
  ...(chance(0.3) ? { name: pick(['  Меч  ', 7, '', null]) } : {}),
  ...(chance(0.2) ? { type: pick(['weapon', 3, null]) } : {}),
  ...(chance(0.2) ? { weight: pick([2, null, 'x']) } : {}),
  ...(chance(0.3) ? { rarity: pick(['редкий', null, 3, '']) } : {}),
  ...(chance(0.2) ? { description: pick(['Описание', 4]) } : {}),
  ...(chance(0.2) ? { properties: pick(['Свойства', {}]) } : {}),
  ...(chance(0.05) ? { price: 5 } : {}),
}])
const merchantInput = () => pick([null, [], 'x', {
  ...(chance(0.85) ? { id: pick(['m-1', 'm-2', garbage()]) } : { merchant_id: pick(['m-3', garbage()]) }),
  ...(chance(0.8) ? { name: pick(['Марта', '  Олаф ', '', 5, null]) } : {}),
  ...(chance(0.8) ? { location: pick(['Рынок', ' Порт ', '', 4, null]) } : {}),
  ...(chance(0.3) ? { location_id: pick(['market', '', 0, 5, ' ']) } : {}),
  ...(chance(0.3) ? { title: pick(['Торговка', 5]) } : {}),
  ...(chance(0.2) ? { greeting: 'Привет' } : {}),
  ...(chance(0.2) ? { voice: 'хрипло' } : {}),
  ...(chance(0.2) ? { description: pick(['Лавка', null]) } : {}),
  ...(chance(0.3) ? { available: pick([true, false, 'yes', null]) } : {}),
  ...(chance(0.4) ? { purse_cp: pick([0, 500, -1, 1.5, '100', 9_000_000_001, null]) } : {}),
  ...(chance(0.5) ? { pricing: pricing() } : {}),
  ...(chance(0.7) ? { stock: pick([null, 'x', Array.from({ length: int(4) }, (_, i) => stockEntry(i))]) } : {}),
  ...(chance(0.3) ? { services: [{ service_id: 'svc', name: 'Ночлег', base_price_cp: 50, kind: 'lodging', requires_presence: pick([true, false]) }, { id: 'svc' }] } : {}),
  ...(chance(0.3) ? { restock_policy: { enabled: pick([true, false]), interval_minutes: pick([30, 1440]), targets: [{ stock_id: 's-0', target_quantity: 5 }, { stock_id: 'nope', target_quantity: 1 }] } } : {}),
  ...(chance(0.05) ? { extra: 1 } : {}),
}])
let canonicalMerchant = null
for (let n = 0; n < 900; n += 1) {
  const input = merchantInput()
  call('normalizeLifecycleMerchant', [input], () => E.normalizeLifecycleMerchant(json(input)))
  try { canonicalMerchant = E.normalizeLifecycleMerchant(json(input)) } catch {}
  const canonical = canonicalMerchant && chance(0.7) ? canonicalMerchant : input
  call('lifecycleMerchantFromCanonical', [canonical], () => E.lifecycleMerchantFromCanonical(json(canonical)))
  const price = pricing()
  const current = pick([undefined, null, {}, canonicalMerchant?.pricing, { description: 'x'.repeat(700), agent_adjustment_limit_percent: pick([5, 40]) }])
  call('normalizeLifecyclePricing', [price, current], () => E.normalizeLifecyclePricing(json(price), json(current)))
  call('lifecyclePricingFromCanonical', [price, current], () => E.lifecyclePricingFromCanonical(json(price), json(current)))
  const entry = stockEntry(n)
  const merchantId = pick(['m-1', 'x'.repeat(130), 'shop'])
  const index = int(4)
  call('normalizeLifecycleStockEntry', [entry, merchantId, index], () => E.normalizeLifecycleStockEntry(json(entry), merchantId, index))
  call('lifecycleStockFromCanonical', [entry, merchantId, index], () => E.lifecycleStockFromCanonical(json(entry), merchantId, index))
  const configuration = pick([null, 'x', {}, {
    ...(chance(0.4) ? { name: pick(['Новая', '', 4, null]) } : {}),
    ...(chance(0.3) ? { title: pick(['Т', 3]) } : {}),
    ...(chance(0.2) ? { description: pick(['О', null]) } : {}),
    ...(chance(0.2) ? { greeting: 'Эй' } : {}),
    ...(chance(0.2) ? { voice: 'тихо' } : {}),
    ...(chance(0.3) ? { purse_cp: pick([10, -4, 'x', null]) } : {}),
    ...(chance(0.4) ? { pricing: pricing() } : {}),
    ...(chance(0.05) ? { location: 'нельзя' } : {}),
  }])
  const owner = canonicalMerchant ?? { id: 'm-1', stock: [], pricing: {} }
  call('normalizeLifecycleConfiguration', [configuration, owner], () => E.normalizeLifecycleConfiguration(json(configuration), json(owner)))
  call('lifecycleConfigurationFromCanonical', [configuration, owner], () => E.lifecycleConfigurationFromCanonical(json(configuration), json(owner)))
  const restock = pick([null, [], 'x', Array.from({ length: 1 + int(3) }, (_, i) => pick([
    stockEntry(i),
    { stock_id: owner.stock?.[0]?.stock_id ?? 's-0', quantity: pick([1, 5, 999_999, 'x']), ...(chance(0.3) ? { catalog_id: pick([owner.stock?.[0]?.catalog_id ?? CATALOG[0], CATALOG[1], 5]) } : {}) },
  ]))])
  call('normalizeLifecycleRestock', [restock, owner], () => E.normalizeLifecycleRestock(json(restock), json(owner)))
  const item = pick([null, {}, { id: 'i-1', name: pick(['Кубок', null, 5]), type: pick(['treasure', 'Weapon', 'gem', null, 3]), rarity: pick(['Редкий', 'very_rare', 'сюжетный', '', null]), catalog_id: pick([undefined, 'custom:cup', CATALOG[0]]), stack_key: pick([undefined, 'a:b:c', '', 'plain']) }, { id: 'q', quest_item: true }, { id: 's', sellable: false }, { id: 't', type: 'QUEST' }])
  call('appraisalCategory', [item], () => E.appraisalCategory(json(item)))
  call('appraisalBlocked', [item], () => E.appraisalBlocked(json(item)))
  if (item && typeof item === 'object' && item.id) {
    const actor = { id: pick(['hero', 7]) }
    call('appraisalForInventoryItem', [actor, { id: 'm-1' }, item], () => E.appraisalForInventoryItem(json(actor), { id: 'm-1' }, json(item)))
  }
  const stockId = pick(['s-0', 's-1', 5, null, undefined])
  call('merchantStock', [owner, stockId], () => E.merchantStock(json(owner), stockId))
  const unit = pick([1, 10, 0, -5, 1.5, '20', 9_000_000_000, null])
  const quantity = pick([1, 3, 0, 999, 1000, '2', null])
  call('checkedTransactionTotal', [unit, quantity], () => E.checkedTransactionTotal(unit, quantity))
}

// --- состояния корпуса и зёрна команд ---------------------------------------------

const KINDS = [
  'BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'PurchaseMerchantService', 'SellItem', 'CreateMerchant', 'ConfigureMerchant', 'RestockMerchant', 'MoveMerchant', 'SetMerchantAvailability', 'PickpocketNpc',
  'ReceiveScenarioPurse', 'ResolveScenarioInformant', 'ChooseDialogueOption', 'ChooseScenarioArmoryItem', 'NegotiateScenarioTreaty', 'ReturnKnightHead', 'ReleaseCursedKnight', 'StageScenarioStranger',
  'UseLevelTransition', 'ImportLocationMap', 'RebuildLocationMap', 'AdvanceScene', 'AdvanceTime', 'RevealArea', 'SpawnEntity',
  'ResolveQuestDecision', 'UpdateObjective', 'CompleteCampaign', 'AdvanceCampaignArc', 'UpsertNpcSocialProfile', 'RecordNpcSocialTurn', 'ResolveNpcPromise',
  'SetCharacterChoices', 'SetSpellSelections', 'LevelUp', 'ImportCharacter', 'RollCharacterAbilities', 'RollCharacterWealth',
  'UpsertWorldEntity', 'RecordWorldFact', 'RevealWorldFact', 'RecordKnowledgeRevelation', 'RecordWorldRelationship', 'UpsertQuest', 'AdvanceQuestClock', 'ResolveQuest', 'UpsertNarrativeThread', 'RecordNpcBelief', 'RecordRumor', 'ResolveEpistemicClaim', 'RecordNarrativeSummary',
]
const SEEDS_PER_KIND = 4
const seeds = new Map(KINDS.map((kind) => [kind, []]))
const header = /^\{"v":1,"state":"([0-9a-f]{64})","command":\{[^{}]*?"command_type":"([A-Za-z]+)"/
for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus-')).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    const match = header.exec(line.slice(0, 1200))
    if (!match || !seeds.has(match[2])) continue
    const list = seeds.get(match[2])
    if (list.length >= SEEDS_PER_KIND * 3) continue
    const record = JSON.parse(line)
    if (list.some((entry) => entry.state === record.state)) continue
    list.push({ state: record.state, command: record.command, context: record.context, ok: record.outcome?.ok === true })
  }
}
// Предпочитаем зёрна, которые JS принял: отказ покрывают варианты.
for (const [kind, list] of seeds) seeds.set(kind, [...list.filter((entry) => entry.ok), ...list.filter((entry) => !entry.ok)].slice(0, SEEDS_PER_KIND))
const stateIndex = new Map()
const states = []
const snapshots = []
function stateOf(hash) {
  if (!stateIndex.has(hash)) {
    stateIndex.set(hash, states.length)
    states.push(JSON.parse(readFileSync(join(corpusDir, 'states', `${hash}.json`), 'utf8')))
    snapshots.push(sha(states.at(-1)))
  }
  return stateIndex.get(hash)
}

/** Состояние с заплатками `[[путь…], значение]`. */
function patched(index, patches) {
  const state = structuredClone(states[index])
  for (const [path, value] of patches) {
    let target = state
    for (const key of path.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      target = target[key]
    }
    target[path.at(-1)] = value
  }
  return state
}

function idsOf(state) {
  const ids = []
  for (const list of [state.players, state.enemies, state.actors]) for (const actor of list ?? []) ids.push(String(actor?.id))
  for (const npc of state.social?.npcs ?? []) ids.push(String(npc?.id))
  for (const merchant of state.merchants ?? []) ids.push(String(merchant?.id))
  for (const merchant of state.merchants ?? []) for (const stock of merchant?.stock ?? []) ids.push(String(stock?.stock_id))
  for (const player of state.players ?? []) for (const item of player?.inventory ?? []) ids.push(String(item?.id))
  return ids
}

/** Вариант входа: поле удалено, обнулено, заменено мусором или чужим id. */
function mutate(command, state) {
  const copy = structuredClone(command)
  const keys = Object.keys(copy).filter((key) => !['command_type', 'command_id', 'expected_state_version'].includes(key))
  for (let step = 1 + int(2); step > 0 && keys.length; step -= 1) {
    const key = pick(keys)
    const ids = idsOf(state)
    const roll = int(6)
    if (roll === 0) delete copy[key]
    else if (roll === 1) copy[key] = null
    else if (roll === 2) copy[key] = garbage()
    else if (roll === 3 && ids.length) copy[key] = pick(ids)
    else if (copy[key] && typeof copy[key] === 'object' && !Array.isArray(copy[key])) {
      const inner = Object.keys(copy[key])
      if (inner.length) {
        const field = pick(inner)
        copy[key][field] = pick([null, garbage(), ids.length ? pick(ids) : 'x'])
        if (chance(0.3)) delete copy[key][field]
      }
    } else if (Array.isArray(copy[key])) copy[key] = chance(0.5) ? [] : copy[key].slice(0, 1)
    else copy[key] = pick([garbage(), String(copy[key] ?? '') + 'x'])
  }
  if (chance(0.15)) copy.actor_id = pick([...(state.players ?? []).map((player) => player.id), 'ghost', null])
  return copy
}
const CONTEXTS = [{}, { isAdmin: true }, { isDirector: true }, { isAdmin: true, isDirector: true }, { mapImportAuthorized: true }, { isSocialController: true }, { isAdmin: 'yes' }]
const PATCHES = [[], [], [], [[['mechanics', 'combat', 'active'], true]], [[['merchants'], []]], [[['agentInteraction'], { id: 'i-1', status: 'open' }]]]

// --- блоки проверки -------------------------------------------------------------

const lines = readFileSync(SOURCE_URL, 'utf8').split(/\r?\n/)
const BLOCKS = {
  b9: [6207, 6216], b10: [6217, 6226], b18: [6489, 6502], b19: [6503, 6525], b20: [6526, 6549], b21: [6550, 6572], b22: [6573, 6602], b23: [6603, 6642], b24: [6643, 6663],
  b27: [6707, 6716], b33: [6787, 6799], b41: [6833, 6836], b42: [6837, 6848], b43: [6849, 6865], b44: [6866, 6885], b45: [6886, 6901], b46: [6902, 6922], b49: [6945, 6977], b63: [7087, 7179], b64: [7194, 7225],
}
const blocks = {}
for (const [name, [from, to]] of Object.entries(BLOCKS)) {
  const anchor = lines[from - 1].trim().slice(0, 30)
  blocks[name] = await blockFunction([[from, to]], [anchor], ['state', 'command', 'context'], 'return command')
}

// --- ветки разбора без хвоста -----------------------------------------------------

const PREP = [13083, 13751]
const CASES = [[19761, 19834], [20402, 20983], [22367, 22661], [22796, 22811], [22818, 22950]]
const ANCHORS = ["if (!diceService)", "case 'UseLevelTransition'", "case 'BargainWithMerchant'", "case 'ImportLocationMap'", "case 'RevealArea'", 'case \'UpsertWorldEntity\'']
;[PREP, ...CASES].forEach(([from], index) => { if (!lines[from - 1].trimStart().startsWith(ANCHORS[index])) throw new Error(`строка ${from} не «${ANCHORS[index]}»`) })
const prep = lines.slice(PREP[0] - 1, PREP[1]).join('\n')
const body = CASES.map(([from, to]) => lines.slice(from - 1, to).join('\n')).join('\n')
// eslint-disable-next-line no-new-func -- нестрогий режим нужен ради `with`
const branchFn = new Function('__engine', 'input', 'rawState', 'diceService', 'context', `with (__engine) {\n${prep}\nswitch (command.command_type) {\n${body}\n}\nreturn { command, events, rolls }\n}`)

function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const D20_KINDS = new Set(['BargainWithMerchant', 'PickpocketNpc', 'ResolveScenarioInformant', 'ChooseDialogueOption', 'NegotiateScenarioTreaty', 'ReleaseCursedKnight'])

const blockCases = []
const branchCases = []
const blockOf = (kind) => {
  if (E.WORLD_MEMORY_COMMAND_TYPES.has(kind)) return 'b9'
  if (E.NPC_SOCIAL_COMMAND_TYPES.has(kind)) return 'b10'
  return {
    ReceiveScenarioPurse: 'b18', ResolveScenarioInformant: 'b19', ChooseDialogueOption: 'b20', ChooseScenarioArmoryItem: 'b21', NegotiateScenarioTreaty: 'b22', ReturnKnightHead: 'b23', ReleaseCursedKnight: 'b23', StageScenarioStranger: 'b24',
    SetCharacterChoices: 'b27', SetSpellSelections: 'b27', LevelUp: 'b33', ImportCharacter: 'b33', RollCharacterAbilities: 'b33', RollCharacterWealth: 'b33',
    ResolveQuestDecision: 'b41', CompleteCampaign: 'b42', AdvanceCampaignArc: 'b43', ImportLocationMap: 'b44', RebuildLocationMap: 'b45', AdvanceScene: 'b46',
    CreateMerchant: 'b49', ConfigureMerchant: 'b49', RestockMerchant: 'b49', MoveMerchant: 'b49', SetMerchantAvailability: 'b49',
    BargainWithMerchant: 'b63', AppraiseItem: 'b63', BuyItem: 'b63', SellItem: 'b63', PurchaseMerchantService: 'b63', PickpocketNpc: 'b64',
  }[kind]
}
const VARIANTS = 14
for (const kind of KINDS) {
  for (const entry of seeds.get(kind)) {
    const s = stateOf(entry.state)
    for (let variant = 0; variant < VARIANTS; variant += 1) {
      const patches = variant === 0 ? [] : pick(PATCHES)
      const raw = patched(s, patches)
      const input = variant === 0 || variant === 1 ? structuredClone(entry.command) : mutate(entry.command, raw)
      if (!input.command_id) input.command_id = `cmd-${variant}`
      const context = variant === 0 ? { ...entry.context, ...(kind === 'ImportLocationMap' || kind === 'RebuildLocationMap' ? { mapImportAuthorized: true } : {}), ...(kind === 'RecordNpcSocialTurn' || kind === 'ResolveNpcPromise' ? { isSocialController: true } : {}) } : { ...entry.context, ...pick(CONTEXTS) }
      const normalized = E.normalizeCampaignState(E.normalizeCampaignState(raw))
      let command
      globalThis.__SK_OPEN_COPY_UUID__ = (() => { let n = 0; return () => `uuid-${++n}` })()
      try { command = E.normalizeCommand(json(input), normalized) } catch { command = null }
      const block = blockOf(kind)
      if (command && block) blockCases.push({ s, p: patches, block, command: json(command), context, ...attempt(() => blocks[block](normalized, structuredClone(command), context)) })
      if (variant > 3 && !chance(0.5)) continue
      const values = Array.from({ length: 8 }, () => pick(D20_KINDS.has(kind) ? [1, 5, 10, 15, 20, 20] : [1, 2, 3, 4]))
      // Отказ проверки JS сверяется блоками; ветку Rust зовут только с принятой командой.
      let validated
      try {
        validated = E.validateCommand(json(input), E.normalizeCampaignState(raw), { ...context, __resolve_depth: 1 })
      } catch {
        continue
      }
      globalThis.__SK_OPEN_COPY_UUID__ = (() => { let n = 0; return () => `uuid-${++n}` })()
      let o
      try {
        const result = branchFn(E, json(input), raw, service(values), context)
        o = { ok: { sha: sha({ events: result.events, rolls: result.rolls }), types: result.events.map((event) => event.event_type) } }
      } catch (error) {
        o = error?.name === 'RulesValidationError' ? { err: [error.code, error.message] } : { fault: String(error?.name), code: error?.code ?? null }
      }
      branchCases.push({ s, p: patches, command: json(validated), context, v: values, o })
    }
  }
}
delete globalThis.__SK_OPEN_COPY_UUID__

// --- ветки редьюсера Merchant* на вариантах payload --------------------------------

const reduceCases = []
const merchantStates = [...new Set([...seeds.values()].flat().map((entry) => stateOf(entry.state)))].filter((index) => (states[index].merchants ?? []).length)
const projection = (state) => ({
  merchants: state.merchants,
  economyLog: state.economyLog,
  item_appraisals: state.mechanics?.item_appraisals ?? null,
  players: (state.players ?? []).map(({ combatSpells, combatActions, characterSheet, inventoryLoad, ...rest }) => rest),
  enabled_house_rules: state.enabled_house_rules,
})
const EVENT_TYPES = ['MerchantCreated', 'MerchantConfigured', 'MerchantRestocked', 'MerchantEconomyClockAdvanced', 'MerchantMoved', 'MerchantAvailabilityChanged', 'MerchantItemAppraised', 'MerchantBargainResolved', 'MerchantPurchaseCompleted', 'MerchantServicePurchased', 'MerchantSaleCompleted']
for (let n = 0; n < 700 && merchantStates.length; n += 1) {
  const s = pick(merchantStates)
  const state = states[s]
  const merchant = pick(state.merchants)
  const hero = pick(state.players?.length ? state.players : [{ id: 'hero' }])
  const item = pick([...(hero.inventory ?? []), { id: 'new-item', name: 'Новая', quantity: 2, catalog_id: CATALOG[0] }, null])
  const stock = pick([...(merchant.stock ?? []), { stock_id: 'resale:x', catalog_id: CATALOG[1], quantity: 1 }])
  const type = pick(EVENT_TYPES)
  const payload = {
    merchant_id: pick([merchant.id, merchant.id, 'ghost', undefined]),
    ...(type === 'MerchantCreated' ? { merchant: pick([merchant, merchantInput(), { ...merchant, id: 'm-new' }]) } : {}),
    ...(type === 'MerchantConfigured' ? { configuration: pick([{ name: 'Новое имя' }, { pricing: pricing() }, { purse_cp: 5 }, {}]), reset_bargains: pick([true, false, undefined]), changed_fields: ['name', ' x ', 5] } : {}),
    ...(type === 'MerchantRestocked' ? { entries: [{ stock_id: stock.stock_id, quantity_after: pick([3, 0, 'x', undefined]), stock: pick([stock, stockEntry(1), null]) }], total_quantity_added: pick([3, -1, 'x']) } : {}),
    ...(type === 'MerchantEconomyClockAdvanced' ? { scheduled_for_world_minute: 60, processed_at_world_minute: 120, overdue_intervals: pick([0, 2]), entries: [{ stock_id: stock.stock_id, quantity_after: 4 }], world_minute: 120 } : {}),
    ...(type === 'MerchantMoved' ? { location_after: pick(['Порт', '', null, 5]), location_id_after: pick(['port', null, undefined, 4]), location_before: 'Рынок' } : {}),
    ...(type === 'MerchantAvailabilityChanged' ? { available_after: pick([true, false, 'yes']), available_before: pick([true, undefined]) } : {}),
    ...(type === 'MerchantItemAppraised' ? { item_id: item?.id, item_name: item?.name, appraisal: pick([{ base_price_cp: 50, policy_id: 'p' }, null, [], 'x']), base_unit_price_cp: pick([50, 'x']) } : {}),
    ...(type === 'MerchantBargainResolved' ? { success: pick([true, false, 'yes']), natural_roll: pick([20, 'x']), roll_total: 17, modifier: pick([2, null]), difficulty: pick([15, undefined]), pricing_adjustment_bps: pick([-1000, 9000, 'x']) } : {}),
    ...(['MerchantPurchaseCompleted', 'MerchantSaleCompleted'].includes(type) ? { stock_id: stock.stock_id, item: item ? { ...item, quantity: pick([1, 2]) } : null, quantity: pick([1, 2, 0, 'x']), currency_after: pick([{ gold: 3 }, null, { copper: 1_000_000 }]), unit_price_cp: 10, total_price_cp: 20, base_unit_price_cp: 7, catalog_id: pick([stock.catalog_id, null, undefined]), ...(chance(0.5) ? { merchant_purse_after_cp: pick([500, -1, 'x', null]) } : {}), ...(chance(0.3) ? { item_appraisal: { base_price_cp: 5 }, appraisal: { base_price_cp: 5 } } : {}) } : {}),
    ...(type === 'MerchantServicePurchased' ? { service_id: 'svc', service_name: 'Ночлег', service_kind: 'lodging', duration_minutes: pick([480, 'x']), total_price_cp: 50, currency_after: { silver: 2 }, ...(chance(0.5) ? { merchant_purse_after_cp: 999 } : {}) } : {}),
    ...(chance(0.3) ? { policy_id: pick([null, 'custom-policy']) } : {}),
    ...(chance(0.3) ? { request_fingerprint: pick(['fp', null]) } : {}),
  }
  const event = {
    campaign_id: 'c', command_id: `merchant-${n}`, event_type: type, actor_id: pick([hero.id, null]), target_ids: pick([[hero.id], [], ['ghost']]),
    payload: json(payload), source_rule_ids: [], visibility: 'public', event_id: `event-${n}`, created_at: '2026-01-01T00:00:00.000Z', ...(chance(0.5) ? { occurred_at: '2026-01-02T00:00:00.000Z' } : {}),
  }
  const o = attempt(() => sha(projection(E.applyGameEvent(structuredClone(state), event))))
  reduceCases.push({ s, event, o })
}

const mutated = states.map((state, index) => (sha(state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, calls, blocks: blockCases, branches: branchCases, reduce: reduceCases }
const text = JSON.stringify(output)
writeFileSync(new URL('r6.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
const errors = calls.filter((entry) => entry.o.err || entry.o.fault).length
console.log(`r6.json.gz: состояний ${states.length}, вызовов ${calls.length} (отказов ${errors}), блоков ${blockCases.length} (отказов ${blockCases.filter((entry) => entry.err || entry.fault).length}), веток ${branchCases.length}, редьюсер ${reduceCases.length}; ${(text.length / 1e6).toFixed(1)} МБ JSON`)
