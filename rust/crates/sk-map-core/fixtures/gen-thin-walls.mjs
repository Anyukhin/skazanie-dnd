import '../../../fixtures-env.mjs'
// Эталон server/thin-walls.mjs для Rust на случайных планировках:
//
//   node rust/crates/sk-map-core/fixtures/gen-thin-walls.mjs
//
// Вызовы изнутри настоящих генераторов — в `generator-calls.json`; здесь —
// краевые случаи: двойная кладка, служебная зона `walls`, двери в стене и в
// перегородке, проёмы без двери, вода, дыры в контуре, `keepBorder: false`.
// Вход — сериализованная карта; выход — итог и SHA-256 сериализации после
// прохода (у первых случаев — карта целиком, для отладки).
import * as t from '../../../../server/tactical-map.mjs'
import { THIN_WALLS_VERSION, thinWalls } from '../../../../server/thin-walls.mjs'
import { attempt, hash, mulberry32, writeFixture } from './common.mjs'
import { randomLayout } from './layouts.mjs'

const random = mulberry32(2026_10_15)
const cases = []
for (let index = 0; index < 300; index += 1) {
  const map = randomLayout(t, random, `thin-walls:${index}`)
  const before = JSON.parse(JSON.stringify(t.serializeTacticalMap(map)))
  const copy = t.deserializeTacticalMap(before)
  const keepBorder = index % 5 === 4 ? false : index % 7 === 3 ? undefined : true
  const options = keepBorder === undefined ? undefined : { keepBorder }
  const outcome = attempt(() => thinWalls(copy, options))
  const after = t.serializeTacticalMap(copy)
  cases.push({ before, options: options ?? null, outcome, after: index < 24 ? after : hash(after) })
}

writeFixture(new URL('./thin-walls.json', import.meta.url), {
  version: THIN_WALLS_VERSION,
  cases,
})
