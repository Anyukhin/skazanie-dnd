// Эталон для `deterministic_narration.rs`: нормализация текста рассказчиков
// (`cleanNarrationText`, `narrationTextOr`) на значениях любых типов.
//
//   node rust/crates/sk-narration-base/fixtures/gen-deterministic-narration.mjs
import { writeFileSync } from 'node:fs'

import { NARRATOR_PRIORITY, cleanNarrationText, narrationTextOr } from '../../../../server/deterministic-narration.mjs'

const values = [
  null, '', ' ', 'Дверь скрипит', '  Дверь \n\t скрипит  ', 'а б в　г', 'перенос\r\nстроки', 'x'.repeat(1500),
  `${'слово '.repeat(40)}конец`, 'Ｍира', 12.5, 0, -0, 1e21, 1.5e-7, true, false, [1, ' два ', null, [3]], { a: 1 }, [], 'ё'.repeat(130),
  ' разделитель строк', '  ', 'эмодзи 🐉 в середине', '\tтаб\t',
]
const maximums = [undefined, 0, 1, 3, 80, 120, 180]
const clean = []
const or = []
for (const value of values) {
  for (const maximum of maximums) {
    clean.push({ value, maximum: maximum ?? null, text: maximum === undefined ? cleanNarrationText(value) : cleanNarrationText(value, maximum) })
    for (const fallback of ['предмет', '']) {
      or.push({ value, fallback, maximum: maximum ?? null, text: maximum === undefined ? narrationTextOr(value, fallback) : narrationTextOr(value, fallback, maximum) })
    }
  }
}
const fixture = { priority: NARRATOR_PRIORITY, clean, or }
writeFileSync(new URL('./deterministic-narration.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
console.log(`cleanNarrationText ${clean.length}, narrationTextOr ${or.length}`)
