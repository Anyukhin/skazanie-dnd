import '../../../fixtures-env.mjs'
// Эталоны `server/item-appraisal.mjs` для Rust-переноса (`sk-economy`):
// каталожная оценка каждой записи лавки, формула для самодельных вещей по
// всем категориям, редкостям и состояниям, и сотни отказов контракта.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-item-appraisal.mjs
import { chooser, recorder, rng } from './record.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const A = await import(url('item-appraisal.mjs'))
const C = await import(url('item-catalog.mjs'))

const random = rng(20261015)
const { pick, chance } = chooser(random)
const r = recorder('server/item-appraisal.mjs')
for (const name of ['ITEM_APPRAISAL_CONTRACT_VERSION', 'CATALOG_APPRAISAL_POLICY_ID', 'CATEGORY_APPRAISAL_POLICY_ID', 'MAX_APPRAISED_UNIT_PRICE_CP', 'ITEM_APPRAISAL_POLICIES']) {
  r.constant(name, A[name])
}

const POLICIES = [undefined, A.CATALOG_APPRAISAL_POLICY_ID, A.CATEGORY_APPRAISAL_POLICY_ID, 'agent:free-price:v1', '', ' ' + A.CATEGORY_APPRAISAL_POLICY_ID, 7, null, '-bad']
const options = () => {
  const roll = random()
  if (roll < 0.1) return undefined
  if (roll < 0.15) return pick([null, [], 'x', { policyId: A.CATEGORY_APPRAISAL_POLICY_ID, estimatedPriceCp: 1 }])
  const policy = pick(POLICIES)
  return policy === undefined ? {} : { policyId: policy }
}

for (const catalogId of [...Object.keys(C.ITEM_CATALOG), ...Object.keys(C.SCENARIO_ITEM_CATALOG), ' srd_5_2_1:torch ', 'homebrew:moon', 'srd_5_2_1:DAGGER']) {
  r.call('appraiseItem', A.appraiseItem, { catalog_id: catalogId, ...(chance(0.5) ? { item_id: pick(['potion-1', ' x ', '-bad', 7]) } : {}), ...(chance(0.5) ? { name: pick(['Зелье  лечения', '   ', 'x'.repeat(121), 5]) } : {}) }, pick([undefined, {}, { policyId: A.CATALOG_APPRAISAL_POLICY_ID }, { policyId: A.CATEGORY_APPRAISAL_POLICY_ID }]))
}
const CATEGORIES = ['miscellaneous', 'consumable', 'tool', 'treasure', 'weapon', 'armor']
const RARITIES = ['common', 'uncommon', 'rare', 'very_rare', 'legendary']
const CONDITIONS = ['broken', 'damaged', 'worn', 'serviceable', 'fine', 'pristine']
for (const category of CATEGORIES) {
  for (const rarity of RARITIES) {
    for (const condition of CONDITIONS) {
      r.call('appraiseItem', A.appraiseItem, { homebrew_id: `homebrew:${category}-${rarity}`, item_id: 'item-17', name: 'Осколок лунного клинка', category, rarity, condition }, { policyId: A.CATEGORY_APPRAISAL_POLICY_ID })
    }
  }
}

const FIELDS = ['catalog_id', 'homebrew_id', 'item_id', 'name', 'category', 'rarity', 'condition', 'base_price_cp', 'secret', 'price_provenance', 'appraisal_fingerprint', 'zeta', '0']
for (let index = 0; index < 600; index += 1) {
  const input = {}
  if (chance(0.85)) input.homebrew_id = pick(['homebrew:moon', ' homebrew:moon ', 'Ｈomebrew:x', '', null, 7, '-x', 'a'.repeat(121), 'ok.id_1'])
  if (chance(0.15)) input.catalog_id = pick(['srd_5_2_1:torch', '', null, 'homebrew:moon'])
  if (chance(0.6)) input.item_id = pick(['item-17', '', null, 5, ' i ', '#'])
  if (chance(0.85)) input.name = pick(['Осколок', '  Осколок   лунного\tклинка ', '', null, 7, 'x'.repeat(120), 'x'.repeat(121), 'ｘ'])
  if (chance(0.85)) input.category = pick([...CATEGORIES, 'artifact', null, 7])
  if (chance(0.85)) input.rarity = pick([...RARITIES, 'unique', 'constructor', null])
  if (chance(0.85)) input.condition = pick([...CONDITIONS, 'enchanted-by-agent', 'toString'])
  if (chance(0.08)) input[pick(FIELDS.slice(7))] = 999_999
  const subject = chance(0.03) ? pick([null, [], 'x', 5]) : input
  r.call('appraiseItem', A.appraiseItem, subject, options())
}
r.call('appraiseItem', A.appraiseItem, undefined)
r.write('item-appraisal.json')
