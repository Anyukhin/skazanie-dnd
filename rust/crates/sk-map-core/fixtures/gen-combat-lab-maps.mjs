import '../../../fixtures-env.mjs'
// Эталон server/combat-lab-maps.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-combat-lab-maps.mjs
//
// Каталог арен боевого стенда целиком (клетки, сериализованная карта, точки
// появления, рельеф) и выбор арены по рыхлому id.
import { COMBAT_LAB_MAPS, COMBAT_LAB_MAPS_VERSION, combatLabMapById, combatLabMapCatalog } from '../../../../server/combat-lab-maps.mjs'
import { encode, writeFixture } from './common.mjs'

const probes = ['forest-clearing', 'missing-map', '', null, undefined, ['cavern-bridge'], ' open-courtyard', 5]
  .map((value) => ({ value: encode(value), result: combatLabMapById(value)?.id ?? null }))

writeFixture(new URL('./combat-lab-maps.json', import.meta.url), {
  version: COMBAT_LAB_MAPS_VERSION,
  maps: JSON.parse(JSON.stringify(COMBAT_LAB_MAPS)),
  catalogEqual: JSON.stringify(combatLabMapCatalog()) === JSON.stringify(COMBAT_LAB_MAPS),
  probes,
})
