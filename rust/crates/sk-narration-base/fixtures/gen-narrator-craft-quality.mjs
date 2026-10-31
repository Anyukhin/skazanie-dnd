// Эталон для `narrator_craft_quality.rs`: каталог клише и находки в текстах.
//
//   node rust/crates/sk-narration-base/fixtures/gen-narrator-craft-quality.mjs
import { writeFileSync } from 'node:fs'

import { NARRATOR_CLICHE_CATALOG, findNarratorCliches } from '../../../../server/narrator-craft-quality.mjs'

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(9)
const choice = (list) => list[Math.floor(random() * list.length)]

const fragments = [
  'Воздух густеет.', 'ВОЗДУХ  ГУСТЕЕТ', 'воздух\nгустеет', 'повисает тишина', 'Повисла тишина', 'на одно мгновение замирает', 'на мгновенье застывает',
  'в глазах мелькает узнавание', 'В ГЛАЗАХ ВСПЫХИВАЕТ', 'берёт себя в руки', 'берет себя в руки', 'ноги подкашиваются', 'мир плывёт', 'мир плывет',
  'в воздухе пахнет дымом', 'солнце клонится к закату', 'небо в багровых тонах', 'багровое закатное небо', 'небо, которое на закате стало багровым',
  'голос перекрывает гул', 'в последнем рывке', 'в последний рывок', 'настороженность тает', 'Мирина настороженность таёт', 'бросает взгляд',
  'бросил короткий взгляд', 'в голове крутится мысль', 'тишина стоит такая', 'нити одного узла', 'нить одного узла', 'Ｖоздух густеет',
  'Мира открывает дверь.', 'Стражник кивает.', 'Дождь стучит по крыше.', '', 'небо\nбагровое', `НЕБО${'x'.repeat(30)}БАГРОВ`,
  `небо${'я'.repeat(24)}багров`, `небо${'я'.repeat(25)}багров`,
]
const texts = [...fragments]
for (let index = 0; index < 220; index += 1) texts.push(Array.from({ length: 1 + Math.floor(random() * 4) }, () => choice(fragments)).join(' '))
texts.push(null, 42)
const cases = texts.map((text) => ({ text, found: findNarratorCliches(text) }))
writeFileSync(new URL('./narrator-craft-quality.json', import.meta.url), `${JSON.stringify({ catalog: NARRATOR_CLICHE_CATALOG, cases })}\n`)
console.log(`текстов ${cases.length}, находок ${cases.reduce((sum, item) => sum + item.found.length, 0)}`)
