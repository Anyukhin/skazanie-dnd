import '../../../fixtures-env.mjs'
// Эталон `Math.cos` движка V8 для Rust (`sk_core::v8math::cos`):
//
//   node rust/crates/sk-themes/fixtures/gen-math-cos.mjs
//
// Открытая местность считает косинусом контур опушки (`Math.cos(y * 0.23 +
// phase)`, `Math.cos(x * 0.25 + phase)`), а `Math.floor` превращает последний
// бит в клетку кромки. Эталон — битовые образы `Math.cos` на аргументах того
// вида, что даёт раскладка, на случайных аргументах и на особых значениях.
import { mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_15)
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const cases = []
const add = (x) => cases.push([bits(x), bits(Math.cos(x))])

for (let index = 0; index < 4000; index += 1) add((random() - 0.5) * 120)
for (let index = 0; index < 600; index += 1) add((random() - 0.5) * 4)
for (let index = 0; index < 300; index += 1) add((random() - 0.5) * 2e5)
for (let index = 0; index < 200; index += 1) add((random() - 0.5) * 1e-6)
for (const x of [0, -0, 1, -1, 2.5, 100, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 1e-30, 0.78539816, 0.785398164, 2 ** 19 * Math.PI, 1e6, -1e6]) add(x)
// Аргументы раскладки открытой местности: фаза — `random() * Math.PI * 2`.
for (let sample = 0; sample < 80; sample += 1) {
  const phase = random() * Math.PI * 2
  for (let step = 0; step < 61; step += 1) {
    add(step * 0.23 + phase)
    add(step * 0.25 + phase)
  }
}
writeFixture(new URL('./math-cos.json', import.meta.url), { cases })
