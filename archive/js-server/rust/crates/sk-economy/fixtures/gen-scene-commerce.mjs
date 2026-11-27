import '../../../fixtures-env.mjs'
// Эталоны `server/scene-commerce.mjs` для Rust-переноса (`sk-economy`):
// решение о лавке для сотен сцен (поселения, дикая местность, смешанные
// тексты на русском и английском) и замыслы Режиссёра поверх них.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-scene-commerce.mjs
import { chooser, recorder, rng } from './record.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const S = await import(url('scene-commerce.mjs'))

const random = rng(20261020)
const { pick, chance } = chooser(random)
const r = recorder('server/scene-commerce.mjs')
r.constant('SCENE_COMMERCE_PLAN_VERSION', S.SCENE_COMMERCE_PLAN_VERSION)

const WORDS = ['Большой город Норвин', 'Город Норвин', 'городок', 'Деревня у реки', 'село Подгорье', 'Посёлок', 'поселок', 'поселение',
  'Рыночная площадь', 'улица Ткачей', 'Порт', 'портом', 'Таверна «Рыжий кот»', 'Северная застава', 'Форпост', 'гарнизон', 'столица',
  'мегаполис', 'большого города', 'Чаща у Серого ручья', 'Подземный архив', 'Серая чаща', 'Северный тракт', 'дорога', 'караван',
  'кузница', 'арсенал', 'храм', 'лекарь', 'аптека', 'алхимик', 'склад провианта', 'city of Norvin', 'TOWN', 'village', 'market street',
  'harbour', 'harbor', 'outpost', 'large  city', 'capital', 'weapon smith', 'temple', 'road', 'Городские улицы и кузницы', 'городские улицы',
  'дикая местность', 'подземные помещения', 'Путь из большого города приводит героев в лес.', 'горожане', 'портной', 'ſtreet', '']

function phrase() {
  if (chance(0.1)) return pick([null, 7, ['город', 'рынок'], { a: 1 }, undefined])
  const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(WORDS))
  return parts.join(pick([' ', '\n', ', ', '\t ', '']))
}

function scene() {
  if (chance(0.03)) return pick([undefined, 'строка', 5])
  const value = {}
  for (const key of ['location', 'title', 'theme', 'arrival']) if (chance(0.6)) value[key] = phrase()
  if (chance(0.2)) value.map = pick([{ layout: phrase() }, 'город', null, {}])
  return value
}

const scenes = Array.from({ length: 400 }, scene)
for (const value of scenes) r.call('defaultSceneShopIntent', S.defaultSceneShopIntent, value)

const FIELDS = ['action', 'settlement_type', 'theme', 'budget_cp', 'reason']
for (let index = 0; index < 500; index += 1) {
  const input = {}
  for (const key of FIELDS) {
    if (!chance(0.6)) continue
    input[key] = {
      action: pick(['create', 'none', 'CREATE', 'destroy', null, 1]),
      settlement_type: pick(['village', 'town', 'city', 'outpost', 'traveling', 'metropolis', 'constructor', null]),
      theme: pick(['general', 'provisions', 'arms', 'healing', 'black-market', 'toString']),
      budget_cp: pick([7_500, 99, 500_000, 1_000_001, '12000', 2.5, null, 'x', [300], 1e21]),
      reason: pick(['Рынок закрыт по сюжету.', '  ', '', 'r'.repeat(300), null, 'Строка\nс переносом']),
    }[key]
  }
  if (chance(0.06)) input.base_price_cp = 1
  const subject = chance(0.92) ? input : pick([null, undefined, [], 'create', 5])
  r.call('normalizeSceneShopIntent', S.normalizeSceneShopIntent, subject, pick(scenes))
}
r.call('normalizeSceneShopIntent', S.normalizeSceneShopIntent, undefined)
r.write('scene-commerce.json')
