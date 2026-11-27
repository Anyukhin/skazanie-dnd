import '../../../fixtures-env.mjs'
// Эталоны `server/loot-tables.mjs` для Rust-переноса (`sk-items`).
//
// Случайности в модуле нет: выдача выводится из SHA-256 идентификатора
// встречи. Поэтому «сиды» здесь — сотни идентификаторов встреч по всем темам и
// сложностям, мусорные параметры (неизвестная тема, `null` вместо id, число
// вместо строки) и магическая находка на всех порогах опыта.
//
// Запуск: node rust/crates/sk-items/fixtures/gen-loot-tables.mjs
import { recorder, rng } from './record.mjs'

const L = await import(new URL('../../../../server/loot-tables.mjs', import.meta.url).href)

const random = rng(7_500)
const pick = (list) => list[Math.floor(random() * list.length)]
const r = recorder('server/loot-tables.mjs')

r.constant('ENCOUNTER_LOOT_POLICY_ID', L.ENCOUNTER_LOOT_POLICY_ID)
r.constant('ENCOUNTER_MAGIC_LOOT_POLICY_ID', L.ENCOUNTER_MAGIC_LOOT_POLICY_ID)
r.constant('LOOT_BY_THEME', L.LOOT_BY_THEME)

const THEMES = Object.keys(L.LOOT_BY_THEME)
for (const theme of THEMES) {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    for (let index = 0; index < 24; index += 1) {
      r.call('serverEncounterLoot', L.serverEncounterLoot, { theme, difficulty, encounterId: `${theme}-${difficulty}-${index}` })
    }
  }
}
const JUNK_OPTIONS = [
  undefined, {}, { theme: 'dragons' }, { theme: null, difficulty: null, encounterId: null }, { difficulty: 'deadly' },
  { theme: ['cave'], encounterId: 42 }, { encounterId: ['a', 'b'] }, { encounterId: { id: 1 } }, { theme: 'Cave' },
  { theme: 'constructor' }, { difficulty: 'toString' }, { theme: 'generic', difficulty: 'hard', encounterId: '' },
  { theme: 'vermin', difficulty: 'hard', encounterId: 'scene:map-seed:prop-1:asset-7' }, 'строка', 7, null,
]
for (const options of JUNK_OPTIONS) r.call('serverEncounterLoot', L.serverEncounterLoot, options)
for (let index = 0; index < 120; index += 1) {
  r.call('serverEncounterLoot', L.serverEncounterLoot, {
    theme: pick([...THEMES, 'unknown', null]),
    difficulty: pick(['easy', 'medium', 'hard', 'deadly', undefined]),
    encounterId: pick([`random-${index}`, `scene:${index}:prop`, index, null]),
  })
}

for (let index = 1; index <= 300; index += 1) {
  for (const totalXp of [0, 199, 300, 700, 900, 5_000]) {
    r.call('serverEncounterMagicLoot', L.serverEncounterMagicLoot, { encounterId: `enc-${index}`, totalXp })
  }
}
for (const options of [undefined, {}, { totalXp: '900', encounterId: 'enc-23' }, { totalXp: null, encounterId: 'enc-23' }, { totalXp: -5 }, { totalXp: 'много' }, { encounterId: null, totalXp: 5_000 }, { encounterId: 7, totalXp: 5_000 }, null]) {
  r.call('serverEncounterMagicLoot', L.serverEncounterMagicLoot, options)
}
r.write('loot-tables.json')
