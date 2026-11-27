import '../../../fixtures-env.mjs'
// Эталон `Math.sin` движка V8 для Rust:
//
//   node rust/crates/sk-settlements/fixtures/gen-math-sin.mjs
//
// Генератор поселения считает синусом изгиб улицы и русло реки, а округление
// и сравнение `> 0.75` превращают последний бит в клетку. Эталон — битовые
// образы `Math.sin` на аргументах того вида, что даёт генератор (доля ширины
// карты на π и фаза), и на случайных аргументах в том же диапазоне.
import { mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_15)
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const cases = []
const add = (x) => cases.push([bits(x), bits(Math.sin(x))])

for (let index = 0; index < 4000; index += 1) add((random() - 0.5) * 120)
for (let index = 0; index < 400; index += 1) add((random() - 0.5) * 4)
for (let index = 0; index < 200; index += 1) add((random() - 0.5) * 1e-6)
for (const x of [0, -0, 1, -1, Math.PI, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 1e-30, 2 ** 19 * Math.PI, 1e6]) add(x)
// Аргументы генератора: изгиб органической улицы, русло и разлив реки.
for (let sample = 0; sample < 60; sample += 1) {
  const phase = random() * Math.PI * 2
  const width = 26 + Math.floor(random() * 35)
  for (let x = 0; x < width; x += 1) {
    add((x / Math.max(1, width - 1)) * Math.PI * 1.5 + phase)
    add((x / Math.max(1, width - 1)) * Math.PI * 2.4 + phase)
    add(x * 0.53 + phase * 1.7)
  }
}
writeFixture(new URL('./math-sin.json', import.meta.url), { cases })
