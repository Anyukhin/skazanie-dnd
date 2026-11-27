import '../../../fixtures-env.mjs'
// Эталон `Math.log2` и `Math.log10` движка V8 для Rust:
//
//   node rust/crates/sk-story/fixtures/gen-math-log.mjs
//
// Подбор библиотечной карты штрафует расхождение площади `log2` и награждает
// популярность `log10`; очки сравниваются с порогом и между собой, поэтому
// последний бит важен. Аргументы — того вида, что даёт подбор (отношение
// площадей, 1 + число скачиваний), и случайные.
import { mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_15)
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const cases = []
const add = (x) => cases.push([bits(x), bits(Math.log2(x)), bits(Math.log10(x))])

for (const x of [0, -0, 1, 2, 10, 100, 1000, 0.5, 0.1, 3, 7, 1e-310, 5e-324, 1.7976931348623157e308, -1, Infinity, NaN, 1 + 2 ** -52, 1 - 2 ** -53]) add(x)
for (let index = 0; index < 3000; index += 1) add(random() * 20)
for (let index = 0; index < 1000; index += 1) add(2 ** ((random() - 0.5) * 60))
for (let index = 0; index < 1000; index += 1) add(1 + random() * 1e-5)
for (let index = 0; index < 1000; index += 1) add(1 + Math.floor(random() * 20000))
// Отношения площадей подбора: этаж карты к заявке.
for (const floor of [16, 64, 96, 120, 200, 256, 300, 400, 420, 500, 600, 900, 1600]) {
  for (const area of [256, 260, 400, 520, 572, 676, 780, 900, 1200, 1320, 1600, 2112, 2400, 2640, 3600]) add(floor / area)
}
writeFixture(new URL('./math-log.json', import.meta.url), { cases })
