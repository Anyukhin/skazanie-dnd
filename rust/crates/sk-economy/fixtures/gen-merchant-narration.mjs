import '../../../fixtures-env.mjs'
// Эталоны `server/merchant-narration.mjs` для Rust-переноса (`sk-economy`):
// текст рассказчика по каждому виду события торговли, с полными, пустыми и
// мусорными payload, со смесью событий и с торговцем из состояния и без.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-merchant-narration.mjs
import { chooser, recorder, rng } from './record.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const N = await import(url('merchant-narration.mjs'))

const random = rng(20261021)
const { pick, int, chance } = chooser(random)
const r = recorder('server/merchant-narration.mjs')
r.constant('merchantNarrator', { id: N.merchantNarrator.id, priority: N.merchantNarrator.priority, promptVersion: N.merchantNarrator.promptVersion, provider: N.merchantNarrator.provider })

const TYPES = ['MerchantBargainResolved', 'MerchantItemAppraised', 'MerchantPurchaseCompleted', 'MerchantSaleCompleted', 'MerchantCreated',
  'MerchantConfigured', 'MerchantRestocked', 'MerchantMoved', 'MerchantAvailabilityChanged']
const OTHER = ['ActorMoved', 'AttackResolved', 'SceneAdvanced', '', null]
const STATES = [
  { merchants: [{ id: 'marten', name: 'Мартен', location: 'Рыночная площадь' }, { id: 'ilara', name: '  Илара \n Медный Перст ', location: '' }] },
  { merchants: [{ id: 'marten', name: '', location: 'Порт' }] },
  { merchants: [{ id: 'marten', name: 'x'.repeat(200), location: 'y'.repeat(300) }] },
  {},
  { merchants: 'нет' },
]
const value = () => pick([undefined, null, 0, 1, 12, 15, 99, 5_511, 12_345, 100, 10, -5, 2.5, '42', 'abc', 1e21, true, 9_007_199_254_740_993])
const textValue = () => pick([undefined, null, '', '   ', 'Зелье лечения', '  Верёвка\tпеньковая ', 7, 'z'.repeat(200), ['a', 'b']])

function payload() {
  if (chance(0.06)) return pick([undefined, null, 'x', ['marten']])
  const result = {}
  if (chance(0.85)) result.merchant_id = pick(['marten', ' marten ', 'ilara', 'missing', 7, null])
  if (chance(0.3)) result.merchant = pick([{ name: 'Из события', location: 'Северный тракт' }, { name: '' }, { location: '  Порт  ' }, null, 'x'])
  for (const key of ['roll_total', 'difficulty', 'total_quantity_added', 'base_unit_price_cp', 'quantity', 'total_price_cp']) if (chance(0.5)) result[key] = value()
  for (const key of ['item_name', 'item_id', 'catalog_id', 'location_after']) if (chance(0.4)) result[key] = textValue()
  if (chance(0.4)) result.item = pick([{ name: textValue() }, null, 'x', {}])
  if (chance(0.4)) result.success = pick([true, false, 'true', 1])
  if (chance(0.4)) result.available_after = pick([true, false, 'true'])
  return result
}

function event() {
  const roll = random()
  const type = roll < 0.8 ? pick(TYPES) : roll < 0.95 ? pick(OTHER) : pick([['MerchantCreated'], 7])
  return chance(0.97) ? { event_type: type, payload: payload() } : pick([null, 'x', {}])
}

for (let index = 0; index < 700; index += 1) {
  const events = Array.from({ length: int(0, 4) }, event)
  const state = pick(STATES)
  r.call('hasMerchantEvent', N.hasMerchantEvent, events)
  r.call('merchantNarration', N.merchantNarration, events, state)
}
for (const events of [undefined, null, 'x', {}]) {
  r.call('hasMerchantEvent', N.hasMerchantEvent, events)
  r.call('merchantNarration', N.merchantNarration, events, STATES[0])
}
r.write('merchant-narration.json')
