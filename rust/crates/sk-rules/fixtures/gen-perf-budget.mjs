// Эталон бюджета скорости sk-rules (`tests/perf_budget.rs`): три состояния
// корпуса паритета и одна запись редьюсера с событиями.
//   SK_CORPUS=<каталог corpus-v1> node fixtures/gen-perf-budget.mjs
// Состояния берутся как есть — нормализация и редьюсер сверены с JS корпусом
// (`sk-corpus`), здесь важны только размер и состав:
// - `large` — крупнейшее состояние корпуса (≈4 МБ: шесть запомненных карт мест
//   и карта сцены на сотни клеток);
// - `caster` — медианное состояние с двумя волшебниками 9-го и 5-го уровня
//   (карточки заклинаний);
// - `plain` — медианное состояние без заклинателей высокого уровня;
// - `replay` — запись корпуса с несколькими событиями подряд.
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const CORPUS = process.env.SK_CORPUS
if (!CORPUS) throw new Error('SK_CORPUS: каталог корпуса паритета (tmp/corpus-v1)')
const STATES = {
  large: 'f54115e658a8c6dfbd5f5ba655e2101f34989b6c0c9885c764f799d39c7375d4',
  caster: 'caf1e38f848215e24c53067ffbdf9110b0a04279bc56257823a0ce18ed469edf',
  plain: '8e200431f5545688cac0d97723733ae6d5f1d701c8f3fe814d75bc0b7ff23f00',
}
// MakeAreaAttack в бою: 13 событий подряд на состоянии ≈25 КБ.
const REPLAY = { file: 'corpus-51408.jsonl', row: 16 }
const readState = (hash) => JSON.parse(readFileSync(`${CORPUS}/states/${hash}.json`, 'utf8'))

function replayRecord() {
  let row = 0
  for (const line of readFileSync(`${CORPUS}/${REPLAY.file}`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    row += 1
    if (row === REPLAY.row) {
      const record = JSON.parse(line)
      return { state: readState(record.state), events: record.outcome.events }
    }
  }
  throw new Error(`нет записи ${REPLAY.file}:${REPLAY.row}`)
}

const fixture = { ...Object.fromEntries(Object.entries(STATES).map(([key, hash]) => [key, readState(hash)])), replay: replayRecord() }
const out = new URL('./perf-budget.json.gz', import.meta.url)
writeFileSync(out, gzipSync(JSON.stringify(fixture), { level: 9 }))
console.log('записано', out.pathname)
