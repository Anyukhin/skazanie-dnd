/**
 * Корпус настоящих реплик игроков для сквозного прогона (eval, в тесты не входит).
 *
 * Читает хранилище только на чтение — трассы ходов (`turn-traces/**`, поле
 * `intent.raw_message`) и хронику комнат (`rooms/*.json`, сообщения игрока) —
 * и дописывает в `eval/player-phrases.json` свободные реплики. Служебные
 * подписи команд доски («Переместить героя на клетку…», «Завершить ход»),
 * карточки голосований и карты мира отбрасываются: это не то, что игрок
 * печатает сам. Уже собранные строки и их разметка сохраняются.
 *
 *   node eval/collect-player-phrases.mjs                    # из ./storage
 *   node eval/collect-player-phrases.mjs --storage <каталог>
 *
 * Новые строки получают `kind: "unsorted"`: вид (осмотр, разговор, уход,
 * вопрос, шутка) проставляется руками — по нему бот выбирает, когда фразу
 * сказать. Корпус живёт в git, поэтому перед коммитом его стоит просмотреть:
 * личного в репликах быть не должно.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const storageFlag = argv.indexOf('--storage')
const STORAGE = resolve(ROOT, storageFlag >= 0 ? argv[storageFlag + 1] : 'storage')
const CORPUS = join(ROOT, 'eval', 'player-phrases.json')

const SERVICE = [
  /^Переместить героя/u, /^Завершить ход$/u, /^Торговая операция$/u, /^Атаковать выбранную цель$/u,
  /^Использовать выбранное/u, /^Импортировать/u, /^Повысить уровень/u, /^Обновление развития/u,
  /^Бросить характеристику/u, /^Определить стартовое/u, /^EncounterAssembler/u, /^\[(РЕШЕНИЕ ГРУППЫ|ГЛОБАЛЬНАЯ КАРТА)\]/u,
  /^Предлагаю покинуть локацию «/u, /^\/why$/u, /Уточнение игрока:/u,
]

function* files(directory) {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (name.endsWith('.json')) yield path
  }
}

function read(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

const found = new Map()
const add = (text, source) => {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (clean.length < 3 || clean.length > 300 || SERVICE.some((pattern) => pattern.test(clean))) return
  if (!found.has(clean)) found.set(clean, source)
}
for (const path of files(join(STORAGE, 'turn-traces'))) {
  const trace = read(path)
  if (trace?.intent?.intent === 'structured_commands') continue
  add(trace?.intent?.raw_message, `trace:${trace?.campaign_id ?? '?'}`)
}
for (const path of files(join(STORAGE, 'rooms'))) {
  const room = read(path)
  for (const message of (room?.state ?? room)?.messages ?? []) {
    if (message?.speaker === 'player') add(message.text, `room:${(room?.state ?? room)?.sessionCode ?? '?'}`)
  }
}

const corpus = existsSync(CORPUS) ? read(CORPUS) : null
const phrases = corpus?.phrases ?? []
const known = new Set(phrases.map((entry) => entry.text))
let added = 0
for (const [text, source] of found) {
  if (known.has(text)) continue
  phrases.push({ text, kind: 'unsorted', source })
  added += 1
}
writeFileSync(CORPUS, `${JSON.stringify({
  version: 1,
  description: corpus?.description ?? 'Настоящие реплики игроков из партий и плейтестов. Бот сквозного прогона говорит их по виду: explore — осмотр, social — разговор с присутствующим, exit — уход, question — вопрос о мире, creative — нестандартное действие. Доля тупиков на них — честная, в отличие от заготовленных фраз бота. Пополнение — node eval/collect-player-phrases.mjs, затем разметка kind руками.',
  phrases,
}, null, 2)}\n`)
console.log(`Найдено ${found.size} свободных реплик, добавлено ${added}, всего в корпусе ${phrases.length}: ${CORPUS}`)
