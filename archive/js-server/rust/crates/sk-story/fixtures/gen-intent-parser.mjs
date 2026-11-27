import '../../../fixtures-env.mjs'
import './capture-hook.mjs'
// Эталон server/intent-parser.mjs для Rust:
//
//   SK_STORY_CAPTURE=<capture.jsonl> node rust/crates/sk-story/fixtures/gen-intent-parser.mjs [каталог корпуса]
//
// Источники входов:
//
// - настоящие вызовы из тестов JS (`capture-tests.mjs`: free-action,
//   intent-routing, dm-dialogue-upgrade, narrator-dialogue-routing,
//   spell-by-words, сценарные тесты и др.) — файл `SK_STORY_CAPTURE`;
// - настоящие фразы игроков (`eval/player-phrases.json`,
//   `eval/playtest-dead-ends.json`, `eval/intent-routing-*.json`,
//   `eval/improvisation-*.json`) на состояниях из тестов и корпуса паритета;
// - тысячи случайных фраз из обрывков настоящих, мусор, длинные строки,
//   символы, которые меняет NFKC, и эмодзи.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { P, RUNNERS, STATE_ARGS, MODULE_OF, prepare, stats, fixtureWriter, mulberry32, chooser, viaJson, corpusDir, corpusRecords, corpusStateText, hasLoneSurrogate } from './story-fixtures.mjs'

const writer = fixtureWriter('intent-parser', ['social', 'players', 'enemies', 'actors', 'merchants', 'scenario_attention', 'worldMemory'])
const random = mulberry32(2026_10_18)
const { int, pick, chance } = chooser(random)

function record(name, args, cap = Infinity) {
  if ((writer.counts.get(name) ?? 0) >= cap) return false
  const prepared = prepare(name, args)
  if (!prepared) return false
  return writer.call(name, RUNNERS[name], prepared, { stateArgs: STATE_ARGS[name] ?? [], cap, limit: 800 })
}

// ---------------------------------------------------------------------------
// 1. Настоящие вызовы из тестов

const captureFile = process.env.SK_STORY_CAPTURE
const capturedStates = []
const phrases = new Set()
if (captureFile && existsSync(captureFile)) {
  for (const line of readFileSync(captureFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (MODULE_OF[entry.fn] !== 'intent-parser') continue
    const args = entry.args.map((arg) => (arg === '\u0000undefined' ? undefined : arg))
    record(entry.fn, args, 1500)
    if (typeof args[0] === 'string') phrases.add(args[0])
    if (entry.fn === 'IntentParser.parse' && args[2] && typeof args[2] === 'object') capturedStates.push({ state: args[2], playerId: args[1] })
  }
} else {
  console.warn('gen-intent-parser: нет SK_STORY_CAPTURE — эталон без вызовов из тестов')
}
console.log(`из тестов: ${writer.cases.length}`)

// ---------------------------------------------------------------------------
// 2. Фразы игроков

const evalDir = new URL('../../../../eval/', import.meta.url)
for (const file of readdirSync(evalDir).filter((name) => /^(player-phrases|playtest-dead-ends|intent-routing-.*|improvisation-.*)\.json$/u.test(name))) {
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (['text', 'message', 'phrase', 'input'].includes(key) && value.length < 400) phrases.add(value)
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key))
    else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) walk(item, child)
  }
  try { walk(JSON.parse(readFileSync(new URL(file, evalDir), 'utf8')), '') } catch { /* не JSON */ }
}
const real = [...phrases].filter((phrase) => !hasLoneSurrogate(phrase))
console.log(`фраз: ${real.length}`)

// ---------------------------------------------------------------------------
// 3. Случайные фразы

const words = [...new Set(real.flatMap((phrase) => phrase.split(/\s+/u)).filter(Boolean))]
const extras = ['а', 'и', 'ну', 'так', 'слушай', 'скажи', 'подскажите', 'потом', 'затем', 'после этого', 'сначала', 'и затем', ', а потом', 'чтобы', 'дабы', 'не', 'ты', 'вы', 'Ваше величество,', 'Ваша светлость,', 'Ребята,', '(ooc)', '((', '//', 'вне игры:', 'ждём до', 'полуночи', 'рассвета', 'заката', 'прыгаю', 'бью', 'стреляю', 'подхожу к', 'обыскиваю тело', 'труп', 'Огненный снаряд', 'Волшебную стрелу', 'Лечение ран', 'нелетально', 'оглушаю', 'проверка', 'спасбросок', 'check', '/why', 'fly', 'teleport', '42', '7', '100', '1000', '?', '!', '.', ';', ',', '«Кривой»', '“цитата”', 'ﬁ', 'Ｆｕｌｌ', 'ё', 'Ё', 'ſ', 'K', '😀', '🐉', ' ', '\t', '\n', '​', 'смотрю', 'наблюдаю за', 'следы', 'карту', 'руны', 'тихо', 'убеждаю', 'запугиваю', 'вру', 'вручаю', 'долгую', 'склоняюсь', 'кошель короля', 'оружейной', 'беру плащ', 'выдаю Тобана', 'договор с драконом', 'голову рыцарю', 'отдыхаем', 'привал', 'end turn', 'начать бой', 'бой окончен']
function randomPhrase() {
  const roll = random()
  if (roll < 0.35) {
    const base = pick(real) ?? ''
    const parts = base.split(/\s+/u)
    const position = int(0, parts.length)
    parts.splice(position, chance(0.5) ? 1 : 0, ...Array.from({ length: int(1, 3) }, () => (chance(0.5) ? pick(extras) : pick(words))))
    return parts.join(chance(0.9) ? ' ' : pick(['  ', '\t', ', ', '. ']))
  }
  if (roll < 0.75) return Array.from({ length: int(1, 14) }, () => (chance(0.55) ? pick(words) : pick(extras))).join(' ') + pick(['', '', '?', '.', '!', ' ?', '?!'])
  if (roll < 0.85) {
    const alphabet = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁabcxyz0123456789 ,.!?;:-«»"()/\\[]{}*+^$|ﬁ😀́'
    return Array.from({ length: int(0, 60) }, () => [...alphabet][int(0, [...alphabet].length - 1)]).join('')
  }
  if (roll < 0.9) return Array.from({ length: int(150, 400) }, () => pick(words)).join(' ')
  if (roll < 0.95) return pick([undefined, null, '', ' ', 0, 5, true, ['бью', 'гоблина'], { text: 'бью' }, '   бью гоблина   '])
  return `${pick(extras)} ${pick(real) ?? ''}`
}

const TEXT_FNS = ['inferRequestKind', 'isSceneObservationRequest', 'waitTargetFromText', 'classifyFreeActionKind', 'actionSequence']
for (const phrase of real) for (const fn of TEXT_FNS) record(fn, [phrase])
for (let i = 0; i < 2500; i += 1) {
  const phrase = randomPhrase()
  for (const fn of TEXT_FNS) record(fn, [phrase], 4500)
}
for (const value of [undefined, null, '', 'action', 'question', 'discussion', ' Question ', 'QUESTION', 'DISCUSSION\n', 'delete', 'İ', 5, true, ['question'], {}]) record('normalizeRequestKind', [value])

// sameNameToken: слова фраз в нижнем регистре.
const lowerWords = [...new Set(real.flatMap((phrase) => phrase.toLocaleLowerCase('ru').match(/\p{L}[\p{L}\p{M}]*|\d+/gu) ?? []))]
const nameWords = ['марта', 'марте', 'марту', 'мартен', 'арес', 'ареса', 'аресу', 'борис', 'бориса', 'финн', 'финна', 'ильса', 'ильсе', 'смотритель', 'смотрителю', 'смотрительница', 'конь', 'коня', 'путь', 'пути', 'ив', 'ян', '12', '12а', 'king', 'kings']
for (let i = 0; i < 1500; i += 1) {
  const left = chance(0.5) ? pick(nameWords) : pick(lowerWords)
  const right = chance(0.5) ? pick(nameWords) : (chance(0.5) ? pick(lowerWords) : left)
  record('sameNameToken', [left, right], 1700)
}

// ---------------------------------------------------------------------------
// 4. Состояния: из тестов и корпуса

const states = capturedStates.slice()
const dir = corpusDir(process.argv[2])
if (dir) {
  const seen = new Set()
  let astohan = 0
  let other = 0
  for (const entry of corpusRecords(dir)) {
    if (seen.has(entry.state)) continue
    seen.add(entry.state)
    const text = corpusStateText(dir, entry.state)
    if (!text) continue
    const isAstohan = text.includes('"astohan-dragon-hunt"')
    if (isAstohan ? astohan >= 40 : other >= 40) continue
    if (!isAstohan && seen.size % 7 !== 0) continue
    const state = JSON.parse(text)
    if (isAstohan) astohan += 1
    else other += 1
    const players = Array.isArray(state.players) ? state.players : []
    states.push({ state, playerId: players[0]?.id })
    if (astohan >= 40 && other >= 40) break
  }
  console.log(`корпус: Асстохан ${astohan}, прочие ${other}`)
}
console.log(`состояний: ${states.length}`)

// Боевые варианты: заклинание словами разбирается только в бою.
function inCombat({ state, playerId }) {
  const copy = JSON.parse(JSON.stringify(state))
  copy.mechanics = { ...(copy.mechanics ?? {}), combat: { ...(copy.mechanics?.combat ?? {}), active: true } }
  return { state: copy, playerId }
}

const spellPhrases = ['швыряю Огненный снаряд в гоблина', 'бью огненным снарядом', 'Волшебная стрела в хобгоблина', 'накладываю заклинание Лечение ран', 'колдую волшебную стрелу нелетально', 'Огненные ладони', 'сотворяю щит', 'бросаю свет', 'кастую священное пламя на скелета']
let parsed = 0
for (let i = 0; i < 4200 && states.length; i += 1) {
  const base = pick(states)
  const { state, playerId } = chance(0.3) ? inCombat(base) : base
  const phrase = chance(0.15) ? pick(spellPhrases) : (chance(0.5) ? pick(real) : randomPhrase())
  const player = chance(0.9) ? playerId : pick([undefined, null, '', 'nobody'])
  if (record('IntentParser.parse', [phrase, player, state], 6000)) parsed += 1
  if (i % 3 === 0) record('resolvePresentSocialActors', [phrase, state], 2500)
  if (i % 4 === 0) record('namedKnownSpell', [chance(0.5) ? pick(spellPhrases) : phrase, state, player], 1500)
}
console.log(`разбор: ${parsed}`)
// Узкие ветки: названное заклинание, ожидание, неоднозначный собеседник,
// обращение по титулу.
const { canonicalCombatSpellFor } = await import(new URL('../../../../server/combat-spells.mjs', import.meta.url).href)
const casters = states.filter(({ state }) => (state.players ?? []).some((player) => Array.isArray(player?.knownSpellIds) && player.knownSpellIds.length))
for (let i = 0; i < 500 && casters.length; i += 1) {
  const { state, playerId } = inCombat(pick(casters))
  const hero = (state.players ?? []).find((player) => Array.isArray(player?.knownSpellIds) && player.knownSpellIds.length)
  const spellId = pick([...(hero.knownSpellIds ?? []), ...(hero.preparedSpellIds ?? [])])
  const name = String(canonicalCombatSpellFor(spellId, { rulesetId: state.ruleset_id })?.name ?? spellId)
  const enemy = pick(state.enemies ?? []) ?? {}
  const phrase = `${pick(['швыряю', 'бросаю', 'кастую', 'применяю', ''])} ${pick([name, name.toLocaleLowerCase('ru'), name.replace(/ый\b/gu, 'ым'), `${name} нелетально`])} ${chance(0.6) ? `в ${String(enemy.name ?? '')}` : ''}`
  record('IntentParser.parse', [phrase, hero.id ?? playerId, state], 6600)
  record('namedKnownSpell', [phrase, state, hero.id], 1900)
}
const hours = ['полуночи', 'рассвета', 'утра', 'зари', 'полудня', 'заката', 'вечера', 'сумерек', 'ночи', 'темноты', 'стемнеет']
for (const verb of ['ждём до', 'подождём до', 'дожидаемся', 'пережидаем до', 'караулим до', 'ждать до', 'жду', 'ждём здесь до самой']) {
  for (const hour of hours) {
    const phrase = `${verb} ${hour}${chance(0.3) ? ' и смотрим на дорогу' : ''}`
    for (const fn of ['waitTargetFromText', 'actionSequence', 'inferRequestKind']) record(fn, [phrase])
    if (states.length) record('IntentParser.parse', [phrase, 'hero', pick(states).state])
  }
}
const crowd = {
  scene: { location: 'Рынок' },
  players: [{ id: 'hero', character: 'Мирт', name: 'Игрок' }],
  social: { npcs: [
    { id: 'guard-1', name: 'Борис', role: 'стражник', location: 'Рынок', tags: ['guard'] },
    { id: 'guard-2', name: 'Глеб', role: 'стражник', location: 'Рынок', tags: ['guard', 'faction:watch'] },
    { id: 'king', name: 'Король Арес', role: 'король', location: 'Рынок', aliases: ['Арес Третий'] },
    { id: 'duke', name: 'Герцог Вейн', role: 'лорд', location: 'Рынок' },
    { id: 'keeper', name: 'Ильса', role: 'старшая смотрительница дамбы', location: 'Рынок' },
    { id: 'silas', name: 'Силас', aliases: ['Кривой'], location: 'Рынок' },
    { id: 'away', name: 'Марта', role: 'трактирщица', location: 'Порт' },
    { id: 'gone', name: 'Финн', available: false, location: 'Рынок' },
  ] },
  merchants: [{ id: 'trader-1', name: 'Ольга', role: 'merchant', location: 'Рынок' }, { id: 'trader-2', name: 'Пётр', tags: ['merchant'], location: 'Рынок' }],
}
const crowdPhrases = ['Спрашиваю стражника о дороге', 'говорю с торговцем о цене', 'Ваше величество, какое поручение?', 'Ваша светлость, вы обещали плату', 'Ваше высочество, где принц?', 'подхожу к смотрителю дамбы и спрашиваю о воде', 'Силас «Кривой», вы сказали правду?', 'Борис, ты видел вора?', 'Ареса спрашиваю о драконе', 'наблюдаю за Глебом, когда король говорит', 'слежу за воротами, пока стражник отвернулся', 'покупаю у торговца верёвку', 'Марта, налей эля', 'Финн, ты тут?', 'Кривой, стой!', 'убеждаю стражников пропустить нас', 'бью стражника', 'атакую', 'подхожу к королю и бью его', 'запрыгиваю на стол и бью Бориса', 'Арес Третий, слушай', 'Глеб: где капитан?']
for (const phrase of crowdPhrases) {
  for (const state of [crowd, { ...crowd, scene: { location: 'Порт' } }, { ...crowd, mechanics: { combat: { active: true } } }]) {
    record('IntentParser.parse', [phrase, 'hero', state])
    record('resolvePresentSocialActors', [phrase, state])
  }
}
record('IntentParser.parse', ['бью гоблина', 'hero', undefined])
record('IntentParser.parse', ['', 'hero', {}])
record('IntentParser.parse', [undefined, undefined, null])

// buildRuleQueries на результатах разбора.
const intents = writer.cases.filter((entry) => entry.fn === 'IntentParser.parse' && entry.result && typeof entry.result === 'object').map((entry) => entry.result)
for (let i = 0; i < 600 && intents.length; i += 1) record('buildRuleQueries', [pick(intents), { mechanics: { combat: { active: chance(0.5) } } }], 900)
for (const intent of [undefined, null, {}, { intent: 'attack' }, { raw_message: 5, intent: 'healing' }, { raw_message: 'плыву', intent: 'cast_spell', approach: 'spell' }, { raw_message: { a: 1 } }]) record('buildRuleQueries', [intent, undefined])

writer.write(new URL('./intent-parser.json.gz', import.meta.url))
console.log(`урезано ${stats.stripped}, расширено ${stats.widened}, отброшено ${stats.dropped}`)
