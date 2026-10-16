import '../../../fixtures-env.mjs'
import { startCapture, quietly, fixtureWriter, outcomeOf, viaJson, mulberry32, chooser, pickKeys, mapList, corpusDir, corpusRecords, corpusState, runTestFiles } from './lib.mjs'
// Эталон server/scene-narration.mjs для Rust:
//
//   node rust/crates/sk-narration/fixtures/gen-scene-narration.mjs [каталог корпуса]
//
// Источники: настоящие вызовы при прогоне тестов JS, корпус паритета (каждый
// успешный ход с `SceneAdvanced` и состояние после него) и случайные переходы с
// мусором. Состояние и payload урезаются до читаемых полей с проверкой исхода.
const s = await import('../../../../server/scene-narration.mjs')

const writer = fixtureWriter('scene-narration')
const stats = {}

const FNS = {
  sceneNarration: { fn: (...args) => s.sceneNarration(...args), states: [1] },
  hasSceneEvent: { fn: (...args) => s.hasSceneEvent(...args), states: [] },
}

const MERCHANT_KEYS = ['merchant_id', 'total_quantity_added', 'location_after', 'available_after', 'roll_total', 'difficulty', 'success', 'item_name', 'item_id', 'base_unit_price_cp', 'catalog_id', 'quantity', 'total_price_cp']

function tightEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const out = pickKeys(event, ['event_type', 'payload'])
  const payload = out.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out
  const type = String(out.event_type ?? '')
  if (type === 'SceneAdvanced') out.payload = pickKeys(payload, ['transition', 'arrival'])
  else if (type === 'TimeAdvanced') out.payload = pickKeys(payload, ['elapsed_minutes'])
  else if (type.startsWith('Merchant')) {
    out.payload = pickKeys(payload, MERCHANT_KEYS)
    if (Object.hasOwn(payload, 'merchant')) out.payload.merchant = pickKeys(payload.merchant, ['name', 'location'])
    if (Object.hasOwn(payload, 'item')) out.payload.item = pickKeys(payload.item, ['name'])
  } else out.payload = {}
  return out
}

function slimState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (Object.hasOwn(state, 'merchants')) out.merchants = mapList(state.merchants, (merchant) => pickKeys(merchant, ['id', 'name', 'location']))
  const time = state.mechanics?.world_time
  if (time !== undefined) out.mechanics = { world_time: time && typeof time === 'object' && !Array.isArray(time) ? pickKeys(time, ['elapsed_minutes']) : time }
  else if (Object.hasOwn(state, 'mechanics')) out.mechanics = state.mechanics && typeof state.mechanics === 'object' ? {} : state.mechanics
  return out
}

function record(name, rawArgs, source) {
  const spec = FNS[name]
  const args = rawArgs.map(viaJson)
  const expected = quietly(() => outcomeOf(spec.fn, args))
  const strips = [
    (list) => list.map((arg, index) => (index === 0 ? mapList(arg, tightEvent) : spec.states.includes(index) ? slimState(arg) : arg)),
    (list) => list.map((arg, index) => (spec.states.includes(index) ? slimState(arg) : arg)),
  ]
  for (const strip of strips) {
    const candidate = strip(args)
    const outcome = quietly(() => outcomeOf(spec.fn, candidate))
    if (JSON.stringify(outcome) === JSON.stringify(expected)) {
      stats.stripped = (stats.stripped ?? 0) + 1
      return writer.add(name, candidate, outcome, { stateArgs: spec.states, source })
    }
  }
  stats.full = (stats.full ?? 0) + 1
  return writer.add(name, args, expected, { stateArgs: spec.states, source })
}

// 1. Настоящие вызовы при прогоне тестов JS.
const captured = []
const stop = startCapture((module, name, args) => {
  if (module !== 'server/scene-narration.mjs' || !FNS[name]) return undefined
  try {
    captured.push({ name, args: args.map(viaJson) })
  } catch { /* вход не сериализуется */ }
  return undefined
})
await runTestFiles(['scene-narration', 'deterministic-narration', 'scene-summary', 'weather', 'tavern-life']
  .map((name) => new URL(`../../../../test/${name}.test.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')))
stop()
for (const entry of captured) record(entry.name, entry.args, 'tests')
console.log(`тесты JS: перехвачено ${captured.length} вызовов`)

// 2. Корпус паритета.
const corpus = corpusDir(process.argv[2])
if (corpus) {
  let used = 0
  for (const row of corpusRecords(corpus)) {
    const events = row.events
    if (!events.some((event) => event?.event_type === 'SceneAdvanced' || String(event?.event_type ?? '').startsWith('Merchant'))) continue
    const state = corpusState(corpus, row.after)
    if (!state) continue
    used += 1
    record('sceneNarration', [events, state], 'corpus')
    record('hasSceneEvent', [events], 'corpus')
  }
  console.log(`корпус: использовано ходов ${used}`)
}

// 3. Случайные переходы и мусор.
const random = mulberry32(2026_10_17)
const { int, pick, chance } = chooser(random)
const GARBAGE = [null, 0, -30, 1e21, '', 'строка', '90', 'Infinity', [], [45], ['x'], {}, { a: 1 }, true, false, '😀']
const garbage = () => pick(GARBAGE)
const maybe = (value, p = 0.1) => (chance(p) ? garbage() : value)
const PHRASES = [
  'Отряд покидает старый тракт', 'Отряд покидает старый тракт.', 'Тордин добирается до таверны «Морской Змей»', 'Впереди открываются ворота Норвина!',
  'Кто там?', 'Тишина…', 'Он сказал: "стой"', 'Дверь (старая)', 'Ряд [три]', '  много   пробелов\tвнутри  ', 'Конец»', 'Эмодзи 😀', '',
  `${'Длинная дорога. '.repeat(70)}`, `${'я'.repeat(999)}😀`, 'Без точки ”',
]
const MERCHANTS = [{ id: 'shop-1', name: 'Илара', location: 'Город Норвин' }, { id: 'shop-2', name: '', location: '' }, { id: 'shop-3', name: '  Гном   Бруно ' }]
const MERCHANT_TYPES = ['MerchantCreated', 'MerchantConfigured', 'MerchantRestocked', 'MerchantMoved', 'MerchantAvailabilityChanged', 'MerchantBargainResolved', 'MerchantItemAppraised', 'MerchantPurchaseCompleted', 'MerchantSaleCompleted']

function randomEvent() {
  const roll = random()
  if (roll < 0.35) return { event_type: 'SceneAdvanced', payload: maybe({ transition: maybe(pick(PHRASES)), arrival: maybe(pick(PHRASES)) }, 0.05) }
  if (roll < 0.65) return { event_type: 'TimeAdvanced', payload: { elapsed_minutes: maybe(pick([0, 15, 29, 30, 44, 45, 60, 75, 89, 90, 120, 135, 150, 360, 390, 720, 750, 780, 1440, 5000])) } }
  if (roll < 0.85) {
    const merchant = pick(MERCHANTS)
    return {
      event_type: pick(MERCHANT_TYPES),
      payload: {
        merchant_id: maybe(merchant.id), merchant: maybe(merchant), total_quantity_added: maybe(int(0, 9)), location_after: maybe('Рынок'), available_after: pick([true, false]),
        roll_total: maybe(int(1, 25)), difficulty: maybe(int(10, 20)), success: pick([true, false]), item_name: maybe('Кинжал'), base_unit_price_cp: maybe(int(0, 9999)),
        item: maybe({ name: 'Верёвка' }), quantity: maybe(int(0, 4)), total_price_cp: maybe(int(0, 12345)),
      },
    }
  }
  if (roll < 0.95) return { event_type: pick(['ObjectiveUpdated', 'SceneAdvanced', 'TimeAdvanced', ['SceneAdvanced']]), payload: maybe({}, 0.5) }
  return pick([5, 'событие', [], {}, { event_type: 'SceneAdvanced' }])
}

for (let index = 0; index < 1_200; index += 1) {
  const events = Array.from({ length: int(1, 5) }, randomEvent)
  const state = chance(0.95) ? {
    ...(chance(0.8) ? { mechanics: { world_time: { elapsed_minutes: maybe(int(0, 4000), 0.05) } } } : {}),
    ...(chance(0.6) ? { merchants: MERCHANTS.slice(0, int(0, 3)) } : {}),
  } : garbage()
  record('sceneNarration', [events, state], 'random')
  if (index % 4 === 0) record('hasSceneEvent', [events], 'random')
}

console.log('урезание:', stats)
writer.write(new URL('./scene-narration.json.gz', import.meta.url))
