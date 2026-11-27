import '../../../fixtures-env.mjs'
// Эталон server/authored-location-maps.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-authored-location-maps.mjs
//
// - встроенный каталог: id, число, описание и хеш каждой карты (Rust читает
//   `data/authored-location-maps-v1.json` сам), поиск по рыхлым значениям id;
// - разбор каталога: карты сцены `buildThemedScene` (как в
//   `test/authored-location-maps.test.mjs`) и порча — версия, не массив,
//   не объект, обёртка `{ location_id, map }`, чужой id, повтор, неверный
//   маркер, невалидная карта, отказ чтения карты, полнота.
import * as t from '../../../../server/tactical-map.mjs'
import * as authored from '../../../../server/authored-location-maps.mjs'
import { buildThemedScene } from '../../../../server/scene-themes.mjs'
import { encode, errorOf, hash, writeFixture } from './common.mjs'

const ids = authored.authoredLocationMapIds()
const catalog = ids.map((id) => ({
  id,
  meta: authored.authoredLocationMapMetaFor(id),
  map: hash(t.serializeTacticalMap(authored.authoredLocationMapFor(id))),
  snapshot: hash(authored.authoredLocationMapCatalogSnapshot().get(id)),
}))

const probes = [
  ids[0], ` ${ids[1]} `, ids[2].toUpperCase(), '../fake', 'fake-location-id', '', null, 5, 'a'.repeat(121), `${ids[3]}\n`, ['astohan-stormberg'], { id: ids[0] }, 'astohan-stormberg', true,
].map((value) => ({
  value: encode(value),
  has: authored.hasAuthoredLocationMap(value),
  meta: authored.authoredLocationMapMetaFor(value),
  map: authored.authoredLocationMapFor(value) ? hash(t.serializeTacticalMap(authored.authoredLocationMapFor(value))) : null,
}))
probes.push({ value: encode(undefined), has: authored.hasAuthoredLocationMap(undefined), meta: authored.authoredLocationMapMetaFor(undefined), map: null })

function fixtureMap(locationId, theme = 'городские улицы', themeId = 'settlement') {
  const map = buildThemedScene({ location: 'площадь', theme, themeId, locationId, seed: `fixture:${locationId}`, width: 20, height: 20 }).map
  map.tilesetId = `authored-location:${locationId}:v1`
  return JSON.parse(JSON.stringify(t.serializeTacticalMap(map)))
}

// Входы разбора — шаблоны над тремя картами: объект с ключом `$map` — копия
// карты с заменой полей из `$set` (и повтором первого предмета при
// `$dupProp`). Rust собирает вход тем же способом.
const bases = {
  valid: fixtureMap('fixture-location'),
  second: fixtureMap('fixture-two', 'склеп', 'crypt'),
  raw: JSON.parse(JSON.stringify(authored.authoredLocationMapCatalogSnapshot().get(ids[0]))),
}
function materialize(value) {
  if (Array.isArray(value)) return value.map(materialize)
  if (!value || typeof value !== 'object') return value
  if (typeof value.$map === 'string') {
    const map = JSON.parse(JSON.stringify(bases[value.$map]))
    if (value.$dupProp) map.props = [...map.props, map.props[0]]
    return Object.assign(map, materialize(value.$set ?? {}))
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]))
}
const valid = { $map: 'valid' }
const second = { $map: 'second' }
const raw = { $map: 'raw' }
const set = (name, fields) => ({ $map: name, $set: fields })
const inputs = [
  { schema_version: 1, maps: [valid] },
  { schema_version: 1, maps: [valid, second] },
  { schema_version: 1, maps: [{ location_id: 'fixture-location', map: valid }] },
  { schema_version: 1, maps: [{ locationId: 'fixture-location', map: valid }] },
  { schema_version: 1, maps: [{ location_id: null, locationId: 'fixture-location', map: valid }] },
  { schema_version: 1, maps: [{ location_id: ' fixture-location ', map: valid }] },
  { schema_version: 1, maps: [{ location_id: 'fixture-location', map: set('valid', { locationId: 'other-location' }) }] },
  { schema_version: 1, maps: [set('valid', { tilesetId: 'authored-location:other-location:v1' })] },
  { schema_version: 1, maps: [set('valid', { tilesetId: 'authored-tactical:fixture-location:v2' })] },
  { schema_version: 1, maps: [set('valid', { tilesetId: 'authored-location:fixture-location:v0' })] },
  { schema_version: 1, maps: [set('valid', { locationId: '../fake' })] },
  { schema_version: 1, maps: [set('valid', { locationId: '' })] },
  { schema_version: 1, maps: [{ location_id: 5, map: valid }] },
  { schema_version: 1, maps: [{ location_id: { id: 1 }, map: valid }] },
  { schema_version: 1, maps: [valid, valid] },
  { schema_version: 1, maps: [{ $map: 'valid', $dupProp: true }] },
  { schema_version: 1, maps: [set('valid', { spawnPoints: [{ id: 'party', x: 99, y: 99, role: 'party' }] })] },
  { schema_version: 1, maps: [set('valid', { doors: [null] })] },
  { schema_version: 1, maps: [set('valid', { layers: { present: 'AAAA' } })] },
  { schema_version: 1, maps: [set('valid', { catalogRevision: 'Bad Rev!' })] },
  { schema_version: 1, maps: [{ location_id: 'fixture-location', map: [] }] },
  { schema_version: 1, maps: [null] },
  { schema_version: 1, maps: [[]] },
  { schema_version: 1, maps: [5] },
  { schema_version: 1, maps: 'x' },
  { schema_version: 1 },
  { schema_version: '1', maps: [valid] },
  { schema_version: 2, maps: [valid] },
  { maps: [valid] },
  null, [], 'catalog', 7,
  { schema_version: 1.0, maps: [raw] },
  { schema_version: 1, maps: [] },
]
const normalize = []
for (const template of inputs) {
  const outcomes = [false, true].map((requireComplete) => {
    try {
      const maps = authored.normalizeAuthoredLocationMapCatalog(materialize(template), requireComplete ? { requireComplete } : undefined)
      return { ok: [...maps].map(([id, map]) => [id, hash(map)]) }
    } catch (error) {
      return { error: errorOf(error) }
    }
  })
  normalize.push({ input: template, outcomes })
}
// Полный встроенный каталог проходит и с требованием полноты.
const full = JSON.parse(JSON.stringify({ schema_version: 1, maps: ids.map((id) => authored.authoredLocationMapCatalogSnapshot().get(id)) }))
const complete = [...authored.normalizeAuthoredLocationMapCatalog(full, { requireComplete: true })].map(([id, map]) => [id, hash(map)])

writeFixture(new URL('./authored-location-maps.json', import.meta.url), {
  constants: {
    version: authored.AUTHORED_LOCATION_MAP_CATALOG_VERSION,
    marker: authored.AUTHORED_LOCATION_MAP_MARKER.source,
    id: authored.AUTHORED_LOCATION_MAP_ID.source,
    count: authored.authoredLocationMapCount(),
    ids,
  },
  bases,
  catalog,
  probes,
  normalize,
  complete,
})
