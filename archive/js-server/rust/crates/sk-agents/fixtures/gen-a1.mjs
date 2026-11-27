import '../../../fixtures-env.mjs'
// Эталоны задачи А1 (`sk-agents`): `server/campaign-bootstrap.mjs`,
// `campaign-recap.mjs`, `creative-director.mjs`, `lore-author.mjs`,
// `lore-voice.mjs`.
//
//   node rust/crates/sk-agents/fixtures/gen-a1.mjs [--corpus <каталог corpus-v1>]
//
// Модель — заглушка по сценарию: записывает каждый вызов (`completeJson` /
// `complete`: запрос и опции) и отдаёт заданные ответы — корректные, битые,
// с лишними полями, ошибки с кодом и без. Rust повторяет те же сценарии своей
// заглушкой и сверяет запросы к модели и итог роли. Системные сообщения в
// записи заменены хешем (`sha256:<hex>`) — промпт тот же файл.
//
// Создание кампании: время (`ruleset_locked_at`, метка сообщения) заменяется
// на `<now>`, срок повтора — на `<remaining>`; итог — SHA-256 строки
// `JSON.stringify`, первые случаи — целиком (для отладки).
//
// Выход — `a1.json.gz`.
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// `store.mjs` при импорте читает `.env` (`dotenv/config`): для эталона он не
// нужен, импорт подменяется пустым модулем.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const storage = mkdtempSync(join(tmpdir(), 'sk-a1-'))
process.env.DND_STORAGE_DIR = storage
delete process.env.ROUTERAI_API_KEY

const { CampaignBootstrapper, normalizeOpeningCanon } = await import('../../../../server/campaign-bootstrap.mjs')
const recap = await import('../../../../server/campaign-recap.mjs')
const creative = await import('../../../../server/creative-director.mjs')
const { LoreAuthor } = await import('../../../../server/lore-author.mjs')
const { LoreVoice, verifyLoreAnswer } = await import('../../../../server/lore-voice.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { listWorldTemplates } = await import('../../../../server/world-template-catalog.mjs')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpusRoot = flag('--corpus', 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1')

let seed = 0x00a1_5eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const sha = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

/** Вызов модели в записи: системный промпт — хешем. */
function recordedCall(method, input, options) {
  const copy = plain(input)
  for (const message of copy?.messages ?? []) {
    if (message?.role === 'system') message.content = `sha256:${createHash('sha256').update(String(message.content)).digest('hex')}`
  }
  return { method, input: copy, options: plain(options ?? {}) }
}

/**
 * Заглушка модели по сценарию. Ответ — `{ value }` (итог `completeJson` или
 * `complete`) или `{ error: { code?, message } }`; кончились ответы — ошибка
 * без кода.
 */
function scriptedClient(replies, { retryTimeouts = false } = {}) {
  const calls = []
  let index = 0
  const answer = () => {
    const reply = replies[index++]
    if (!reply) throw new Error('Сценарий модели закончился')
    if (reply.error) throw Object.assign(new Error(reply.error.message ?? 'отказ'), reply.error.code ? { code: reply.error.code } : {})
    return structuredClone(reply.value)
  }
  const record = (method, input, options) => {
    const call = recordedCall(method, input, options)
    if (retryTimeouts && calls.length > 0 && typeof call.input?.timeoutMs === 'number') {
      if (call.input.timeoutMs < 30_000 || call.input.timeoutMs > 120_000) throw new Error('срок повтора вне окна')
      call.input.timeoutMs = '<remaining>'
    }
    calls.push(call)
  }
  return {
    calls,
    async completeJson(input, options) { record('completeJson', input, options); return answer() },
    async complete(input, options) { record('complete', input, options); return answer() },
  }
}

function corpusStates(limit, filter, step = 7) {
  const dir = join(corpusRoot, 'states')
  if (!existsSync(dir)) return []
  const out = []
  const names = readdirSync(dir).sort()
  for (let index = 0; index < names.length && out.length < limit; index += step) {
    const file = join(dir, names[index])
    if (statSync(file).size > 260_000) continue
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (filter(state)) out.push(state)
  }
  return out
}

// ============================================================================
// Создание кампании
// ============================================================================

const baseHero = {
  id: 'nova', name: 'Анна', character: 'Нова Рей', role: 'Пилот · ур. 1', species: 'Человек',
  background: 'Бывший навигатор', backstory: 'Ищет пропавший исследовательский корабль своего брата.',
  speed: 30, maxHp: 12, armor: 13, online: true,
}
const corpusHeroes = []
for (const state of corpusStates(40, (state) => Array.isArray(state.players) && state.players.length > 0, 23)) {
  for (const player of state.players) if (corpusHeroes.length < 60 && player && typeof player === 'object') corpusHeroes.push(player)
}
const heroVariants = [
  baseHero,
  { id: 'borin', character: 'Борин', role: 'Воин · ур. 1', characterClass: 'fighter', backstory: 'Кузнец из горной деревни.', abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 } },
  { id: 'mirel', character: 'Мирель', role: 'Жрица', species: 'Эльф', characterClass: 'cleric', inventory: [{ id: 'x', name: 'Посох' }], currency: { gold: 3 } },
  { id: 'slot-1', character: 'Свободное место', characterSetupRequired: true },
  { id: 'ila', character: '   Ила   Тень  ', role: 'Плут', portrait: '/assets/ila.webp', color: '#123456', initials: 'ИТ', level: '3', maxHp: '17', armor: 99, speed: -5, experience: 1e12, online: false },
  { id: 'junk', character: 'Мусор', level: 2.5, maxHp: null, armor: 'abc', abilities: [1, 2], currency: 'много', inventory: 'нет', alignment: '   ' },
  { id: 'hero-long', character: 'Очень длинное имя героя, которое превышает восемьдесят знаков и будет обрезано при нормализации листа', backstory: 'а'.repeat(2500) },
]
const worlds = [
  {},
  { era: 'Далёкое будущее', genre: 'Космическая опера', tone: 'Исследование неизвестного', premise: 'Человечество впервые принимает сигнал из-за границы изученного космоса.', openingSituation: 'Экипаж прибывает к молчащей орбитальной станции вслед за сигналом бедствия.' },
  { genre: 'Нуар', premise: 'Детектив ищет пропавшую певицу в ночном городе.' },
  { preset: 'Постапокалипсис', premise: 'Пустошь после войны.', openingSituation: 'Караван выживших стоит у Разломанной трассы.' },
  { genre: 'Тёмное фэнтези', openingSituation: 'Ночь, гроза. Герои сидят в портовой таверне «Ржавый якорь» и ждут лодочника.' },
  { openingSituation: 'Отряд заходит в трактир у дороги, спасаясь от ливня.' },
  { openingSituation: 'Герои стоят у дверей таверны и спорят, стоит ли входить.' },
  { openingSituation: 'Говорят, у моста орудует разбойник с волками.' },
  { premise: 'Культисты похищают детей в деревне.', startingLocation: 'Деревня Ольховка' },
  { startingLocation: 'Крепость Серого Камня', openingSituation: 'Утро. Туман лежит на стенах крепости.' },
  { themes: 'дружба, долг', boundaries: 'без жестокости к детям', magicLevel: 'высокий', technologyLevel: 'средневековье' },
  { openingSituation: 'Герои укрылись в часовне на холме, пока снаружи бушует метель.' },
  { openingSituation: 'В лавке алхимика пахнет серой. Отряд ждёт хозяина.' },
  { openingSituation: 'Вечером путники входят в храм забытого бога.' },
  { premise: 'Лес, роща и луг вокруг древнего дуба.', era: 'Древность' },
  { premise: 'Пустыня и пески.', genre: 'Приключение' },
  { era: 123, genre: ['a', 'b'], premise: { x: 1 }, openingSituation: true },
  'просто строка',
  { openingSituation: 'Сидят в кабинете старого мага, в маленькой комнате у камина.' },
  { openingSituation: 'Отряд прячется в амбаре на окраине; «в таверне» им сказали ждать.' },
]
const worldTemplateIds = listWorldTemplates().map((template) => template.id)

const landmarkKinds = ['well', 'altar', 'market_stall', 'campfire', 'crate', 'statue', 'hearth', 'cart']
function modelOpening(variant) {
  const npcNames = ['Хавер Брин', 'Ила Тойн', 'Старый Дорр', 'Сестра Мэй', 'Кузнец Тарг', 'Рыбак Олл']
  const opening = {
    campaignName: pick(['Зелёный камень', '', 'Туман над Лиссой', '  ']),
    partyName: pick(['Одиночка', '', 'Странники']),
    worldSummary: 'Долина с тихими деревнями, где под землёй спит старое зло.',
    worldHistory: 'Сто лет назад здесь пала империя.\r\n\n\n\nС тех пор   деревни живут   сами по себе.',
    openingNarration: pick([
      'К вечеру Тихий Брод погружается в тишину.\n\nУ колодца из земли выступает зелёный камень, и Хавер Брин смотрит на него с опаской.',
      'Отряд сидит в таверне «Сонный карп». За окном дождь.\n\nТрактирщик Хавер Брин вытирает кружку и ждёт вопросов.',
      'Б'.repeat(2500) + '\n\n' + 'В'.repeat(1500),
      '',
    ]),
    scene: {
      title: pick(['Камень у тихого брода', 'Сонный карп', '', 'Ночь']),
      location: pick(['Тихий Брод', 'Таверна «Сонный карп»', 'Крепость', '']),
      mood: 'Тревожная тишина', objective: pick(['Понять, что с камнем', 'Найти лодочника до рассвета', '']),
      theme: pick(['тихая деревня у реки', 'таверна', 'крепость', 'пещера']),
      danger: pick(['низкая', 'средняя', 'высокая', 'экстремальная']),
      ...(chance(0.5) ? { scene_kind: pick(['settlement', 'wilderness', 'dungeon', 'bogus']) } : {}),
      ...(chance(0.4) ? { settlement_type: pick(['village', 'town', 'city', 'castle']) } : {}),
      map: {
        layout: pick(['open', 'streets', 'rooms', 'zigzag']), pattern: pick(['natural', 'village', 'keep', 'bogus']),
        material: pick(['earth', 'stone', 'wood', 'lava']), scale: pick(['site', 'room', 'stronghold', 'region', 'galaxy']),
        width: pick([15, 3, 100, '20', 17.5]), height: pick([11, 2, 90, '12']), openness: pick([0.6, 2, -1, 'x']), water: pick([0, 0.5, 0.1]),
        featureCount: pick([6, 1, 40]),
        ...(chance(0.5) ? { theme_id: pick(['tavern', 'settlement', 'building']) } : {}),
        ...(chance(0.6) ? { design: { topology: pick(['river', 'market', 'bogus']), building_use: 'tavern', landmarks: [{ kind: pick(landmarkKinds), role: 'focus' }, { kind: pick(landmarkKinds), role: 'npc_post', npc: npcNames[0] }, { id: 'well', count: 3 }] } } : {}),
      },
    },
    hook: pick(['Зелёный камень', 'Найти лодочника до рассвета. Он знает путь через болота, и только он.', '']),
    npcs: npcNames.slice(0, int(7)).map((name, index) => ({
      name, role: pick(['трактирщик', 'староста деревни', 'кузнец', '']), summary: index % 2 ? `${name} хранит ящик с записями у колодца.` : '',
      voice: 'Говорит тихо.', goals: ['Выжить', '', 5], beliefs: index % 3 ? ['Слухи врут'] : 'не массив', faction_id: index % 2 ? 'river' : '',
      id: `model-id-${index}`, location: 'Где-то', inventory: [{ id: 'coin' }], tags: ['x'], mechanics: { hp: 5 },
    })),
    ...(chance(0.7) ? { secrets: [{ clue: 'Под колодцем спрятан старый ключ от склепа.', topic: 'ключ', skills: ['investigation', 'Sleight of Hand', 'flying'], holder: npcNames[0] }, { clue: 'коротко' }, 'строка', { clue: 'Староста тайно платит культистам за молчание.', holder: 'Никто' }] } : {}),
    ...(chance(0.7) ? { canon: ['Баркас «Илин» вернулся вчера вечером без команды.', { fact: 'Пристань в двух часах ходьбы от деревни.' }, 'коротко', 'Баркас «Илин» вернулся вчера вечером без команды.', 42] } : {}),
    ...(chance(0.3) ? { worldRules: { offices: [{ id: 'x' }] }, extra_field: 'лишнее' } : {}),
  }
  if (variant === 'worldmap') {
    opening.scene.location = 'Тихий Брод'
    opening.worldMap = {
      name: 'Долина', locations: [
        { id: 'tihiy-brod', name: 'Тихий Брод', kind: 'village', x: 500, y: 360, summary: 'Деревня у брода.', known: true, visited: true },
        { id: 'veyr', name: 'Вейр', kind: 'city', x: 300, y: 200, summary: 'Город.', known: true, visited: false },
      ],
      routes: [{ id: 'route-1', from: 'tihiy-brod', to: 'veyr', kind: 'road', distance: 3, danger: 'низкая', discovered: true }],
    }
  }
  return opening
}

const llmScripts = [
  () => null,
  () => [{ value: modelOpening() }],
  () => [{ value: modelOpening('worldmap') }],
  () => [{ value: null }],
  () => [{ value: [1, 2, 3] }],
  () => [{ value: 'строка' }],
  () => [{ value: { scene: 'не объект', npcs: 'нет', campaignName: 42 } }],
  () => [{ error: { code: 'LLM_TIMEOUT', message: 'timeout' } }],
  () => [{ error: { message: 'без кода' } }],
  () => [{ error: { code: 'LLM_PROVIDER_UNAVAILABLE', message: 'лёг' } }, { value: modelOpening() }],
  () => [{ error: { code: 'LLM_FALLBACK_EXHAUSTED', message: 'все' } }, { error: { code: 'LLM_PROVIDER_ERROR', message: 'снова' } }],
]
const loreScripts = [
  () => null,
  () => [{ value: { role: 'assistant', content: '  Пролог: давным-давно в долине…  ' } }],
  () => [{ value: { text: 'Текст из поля text.' } }],
  () => [{ error: { code: 'LLM_TIMEOUT', message: 'нет' } }],
  () => [{ value: { content: null, text: 12 } }],
]

function sanitizeState(state) {
  const copy = plain(state)
  if (copy && typeof copy === 'object') {
    if ('ruleset_locked_at' in copy) copy.ruleset_locked_at = '<now>'
    if (Array.isArray(copy.messages)) for (const message of copy.messages) if (message && 'timestamp' in message) message.timestamp = '<now>'
  }
  return copy
}

const bootstrap = []
async function bootstrapCase(input, { llm = null, lore = null, dice = null, keep = false, label = '' } = {}) {
  const client = llm ? scriptedClient(llm, { retryTimeouts: true }) : null
  const loreClient = lore ? scriptedClient(lore) : null
  const options = { retryPauseMs: 0 }
  if (client) options.llmClient = client
  if (loreClient) options.loreAuthor = new LoreAuthor({ llmClient: loreClient })
  if (dice) options.diceService = new DiceService({ rng: new SequenceDiceRng(dice) })
  const bootstrapper = new CampaignBootstrapper(options)
  const entry = { label, input: plain(input), llm, lore, dice, hasLoreAuthor: Boolean(lore) }
  try {
    const state = sanitizeState(await bootstrapper.create(structuredClone(input)))
    entry.ok = sha(state)
    entry.summary = { campaign: state.campaign, generatedBy: state.campaignConcept?.generatedBy, location: state.scene?.location, players: state.players.map((player) => [player.id, player.x, player.y]) }
    if (keep) entry.state = state
  } catch (error) {
    entry.err = errorOf(error)
  }
  entry.calls = client?.calls ?? []
  entry.loreCalls = loreClient?.calls ?? []
  bootstrap.push(entry)
}

const pickHeroes = () => {
  const count = 1 + int(4)
  const pool = chance(0.5) ? heroVariants : corpusHeroes.length ? corpusHeroes : heroVariants
  const heroes = []
  for (let index = 0; index < count; index += 1) {
    const hero = { ...structuredClone(pick(pool)), id: `hero-${index + 1}` }
    // Листы корпуса держат имя в `name`; без `character` герой не создаётся.
    if (!hero.character && chance(0.9)) hero.character = hero.name ?? 'Безымянный'
    heroes.push(hero)
  }
  return heroes
}

let keepCount = 0
for (let index = 0; index < 150; index += 1) {
  const world = pick(worlds)
  const input = {
    code: pick(['ALPHA-1', 'boot-x', 'STARS-01', 'TEST-' + index]),
    ...(chance(0.8) ? { name: pick(['Новая кампания', 'За пределами Ориона', '', 'Хроники']) } : {}),
    ...(chance(0.8) ? { partyName: pick(['Новый отряд', 'Экипаж', '']) } : {}),
    world,
    players: pickHeroes(),
    ...(chance(0.3) ? { campaignMode: pick(['adventure', 'persistent']) } : {}),
    ...(chance(0.2) ? { startLevel: pick([1, 3, '5', '']) } : {}),
    ...(chance(0.2) ? { rulesetId: pick(['srd_5_2_1', 'dnd_5e_2014']) } : {}),
    ...(chance(0.1) ? { merchants: [{ id: 'm1', name: 'Торговец Зуб', location: 'Рынок', inventory: [{ id: 'rope', name: 'Верёвка', price: { gold: 1 } }] }] } : {}),
  }
  const llm = pick(llmScripts)()
  const lore = chance(0.25) ? pick(loreScripts)() : null
  const dice = chance(0.35) ? [1 + int(6), 1 + int(5), 1 + int(8), 1 + int(8)] : null
  await bootstrapCase(input, { llm, lore, dice, keep: keepCount++ < 4, label: `random-${index}` })
}
// Регион вдохновения по костям (как test/campaign-bootstrap.test.mjs).
for (let region = 1; region <= 8; region += 1) {
  await bootstrapCase({ code: 'PERSIST-API', name: 'Постоянный мир', partyName: 'Путники', rulesetId: 'srd_5_2_1', campaignMode: 'persistent', players: [0, 1].map((slot) => ({ ...baseHero, id: `hero-slot-${slot + 1}`, hp: 12 })) }, { dice: [1, region, 1, 1], label: `region-${region}` })
}
// Авторские шаблоны мира.
for (const id of worldTemplateIds) {
  for (const llm of [null, [{ value: modelOpening() }]]) {
    await bootstrapCase({ code: 'TPL-' + id.slice(0, 10).toUpperCase().replace(/[^A-Z0-9-]/g, 'X'), name: 'Новая кампания', partyName: 'Новый отряд', worldTemplateId: id, world: { boundaries: 'без пауков' }, players: [baseHero, { ...heroVariants[1] }], campaignMode: pick(['adventure', 'persistent']) }, { llm, lore: [{ value: { content: 'не должен звучать' } }], label: `template-${id}`, keep: false })
  }
}
// Отказы и мусор.
const failures = [
  { code: 'ab', players: [baseHero] },
  { code: 'OK-CODE', players: [] },
  { code: 'OK-CODE', players: Array.from({ length: 13 }, (_, index) => ({ ...baseHero, id: `h${index}` })) },
  { code: 'OK-CODE', players: 'нет' },
  { code: 'OK-CODE', players: [baseHero], campaignMode: 'bogus' },
  { code: 'OK-CODE', players: [baseHero], campaignMode: null },
  { code: 'OK-CODE', players: [baseHero], startLevel: 0 },
  { code: 'OK-CODE', players: [baseHero], start_level: 13, startLevel: 2 },
  { code: 'OK-CODE', players: [baseHero], startLevel: 2.5 },
  { code: 'OK-CODE', players: [baseHero], startLevel: null },
  { code: 'OK-CODE', players: [baseHero], rulesetId: 'unknown-ruleset' },
  { code: 'OK-CODE', players: [baseHero], ruleset_id: '  ' },
  { code: 'OK-CODE', players: [{ ...baseHero, id: 'bad id!' }] },
  { code: 'OK-CODE', players: [{ ...baseHero, character: '   ' }] },
  { code: 'OK-CODE', players: [baseHero, baseHero] },
  { code: 'OK-CODE', players: [null] },
  { code: 'OK-CODE', players: [baseHero], worldTemplateId: 'no-such-template' },
  { code: 'OK-CODE', players: [baseHero], world: null },
  { code: 'OK-CODE', players: [{ ...baseHero, id: 'ok' }, { id: 'bad id', character: 'x' }] },
  { code: '  lower-case-ok  ', players: [baseHero] },
  { code: 'ÄÖ-123', players: [baseHero] },
]
for (const [index, input] of failures.entries()) await bootstrapCase(input, { label: `failure-${index}`, llm: index % 2 ? [{ value: modelOpening() }] : null })
await bootstrapCase({ code: 'DICE-OUT', players: [baseHero] }, { dice: [1], label: 'dice-exhausted' })
await bootstrapCase({ code: 'DICE-BAD', players: [baseHero] }, { dice: [99, 1, 1, 1], label: 'dice-range' })

// normalizeOpeningCanon.
const canonInputs = [undefined, null, 'строка', [], ['Короткий', 'Достаточно длинный факт', { fact: 'Факт из объекта без ошибок' }, null, 5, 'Достаточно длинный факт'], Array.from({ length: 10 }, (_, index) => `Факт номер ${index} про деревню`), ['  много    пробелов   внутри факта  ']]
const canon = canonInputs.map((value) => ({ value: plain(value), undef: value === undefined, out: normalizeOpeningCanon(value) }))

// ============================================================================
// Рекап
// ============================================================================

const recapStates = corpusStates(30, (state) => (state.worldMemory?.summaries ?? []).length > 0 || (state.social?.promises ?? []).length > 0, 5)
const syntheticMemory = (count) => ({
  worldMemory: {
    summaries: [
      ...Array.from({ length: count }, (_, index) => ({ id: `sum-${index}`, title: index % 3 ? `Глава ${index}` : 'Пока вас не было — новости', summary: `Сводка номер ${index}: отряд сделал дело.`, visibility: index === 2 ? 'gm_only' : 'party' })),
      { id: 'empty', title: 'Пусто', summary: '   ', visibility: 'party' },
    ],
    quests: [{ id: 'q1', title: 'Найти лодочника', summary: 'Он знает путь', status: 'active', visibility: 'party' }, { id: 'q2', title: 'Тайная', status: 'active', visibility: 'gm_only' }, { id: 'q3', title: 'Готово', status: 'completed', visibility: 'party' }],
    threads: [{ id: 't1', title: 'Шёпот в колодце', status: 'active', visibility: 'party' }],
  },
  social: { npcs: [], promises: [{ id: 'p1', text: 'Вернуть долг кузнецу', due_hint: 'до зимы', status: 'open', visibility: 'party' }, { id: 'p2', text: '', status: 'open' }] },
})
const recapInputs = [{}, syntheticMemory(1), syntheticMemory(4), syntheticMemory(9), { worldMemory: 'мусор', social: 5 }, ...recapStates]
const recapSourceCases = recapInputs.map((state) => {
  const sources = recap.recapSources(structuredClone(state))
  return { state: plain(state), sources: plain(sources), text: recap.deterministicRecapText(sources) }
})
const deterministicCases = [
  {}, { summaries: [{ title: '', summary: 'Без заголовка' }, { title: 'Т', summary: 'Конец!' }] },
  { summaries: [{ title: 'Х', summary: undefined }], quests: [{ title: 'Цель' }], threads: [{ title: 'Нить', summary: 'Кратко' }], promises: [{ text: 'Долг' }] },
  { summaries: [], quests: [{ title: 'Цель', summary: 'С описанием…' }], promises: [{ text: 'Слово', due_hint: 'завтра' }] },
].map((sources) => ({ sources: plain(sources), text: recap.deterministicRecapText(sources) }))

const NOW = Date.parse('2026-10-20T18:00:00.000Z')
const recapCacheFile = join(storage, 'recap-cache.json')
const recapRuns = []
const recapScripts = [
  null,
  [{ value: { recap: '  В прошлой серии   отряд нашёл камень.  ' } }],
  [{ value: { recap: '' } }],
  [{ value: null }],
  [{ value: { other: 'поле' } }],
  [{ error: { code: 'LLM_TIMEOUT', message: 'нет' } }],
  [{ value: { recap: 'Р'.repeat(2000) } }],
]
const recapCalls = [
  { campaignId: 'ASTO-1', state: syntheticMemory(4), stateVersion: 3, lastEventAt: '2026-10-19T08:00:00.000Z' },
  { campaignId: 'ASTO-1', state: syntheticMemory(4), stateVersion: 3, lastEventAt: '2026-10-19T08:00:00.000Z' },
  { campaignId: 'ASTO-1', state: syntheticMemory(5), stateVersion: 4, lastEventAt: '2026-10-19T08:00:00.000Z' },
  { campaignId: 'asto 2!', state: syntheticMemory(2), stateVersion: '7', lastEventAt: '2026-10-20T15:00:00.000Z' },
  { campaignId: 'ASTO-3', state: syntheticMemory(2), stateVersion: -2, lastEventAt: '2026-10-20T09:00:00.000Z' },
  { campaignId: 'ASTO-4', state: {}, stateVersion: 1, lastEventAt: '2026-10-01T00:00:00.000Z' },
  { campaignId: 'ASTO-5', state: syntheticMemory(3), stateVersion: 1.5, lastEventAt: 'не дата' },
  { campaignId: 'ASTO-6', state: syntheticMemory(3), stateVersion: null, lastEventAt: null },
  { campaignId: 'ASTO-7', state: syntheticMemory(3) },
  { campaignId: 'ASTO-8', state: syntheticMemory(3), stateVersion: 2, lastEventAt: '2026-10-20T10:00:00.000Z' },
]
for (const [scriptIndex, script] of recapScripts.entries()) {
  rmSync(recapCacheFile, { force: true })
  for (const withCache of [true, false]) {
    for (const gapHours of withCache ? [undefined] : [undefined, 2, -1, 'x']) {
      rmSync(recapCacheFile, { force: true })
      const client = script ? scriptedClient([...script, ...script, ...script, ...script, ...script, ...script, ...script, ...script, ...script, ...script]) : null
      const service = new recap.CampaignRecapService({ llmClient: client, cache: withCache ? new recap.RecapCacheStore({ storageFile: recapCacheFile }) : null, gapHours, now: () => NOW })
      const results = []
      for (const call of recapCalls) results.push(plain(await service.recapFor(structuredClone(call))))
      recapRuns.push({
        script, withCache, gapHours: gapHours === undefined ? '__undefined__' : gapHours, results, calls: client?.calls ?? [],
        cache: withCache && existsSync(recapCacheFile) ? JSON.parse(readFileSync(recapCacheFile, 'utf8')) : null,
      })
    }
  }
}
// Кеш: испорченный файл, чужая схема, вытеснение.
const cacheCases = []
for (const content of ['{битый', JSON.stringify({ schema_version: 2, entries: {} }), JSON.stringify({ schema_version: 1, entries: [] }), JSON.stringify({ schema_version: 1, entries: { 'X:1': { text: 'старое', provider: 'model' }, 'ASTO-1:2': { text: '' }, 'ASTO-1:3': { text: 'кеш', provider: '' }, 'B:1': 5 } })]) {
  writeFileSync(recapCacheFile, content)
  const store = new recap.RecapCacheStore({ storageFile: recapCacheFile })
  const gets = [['ASTO-1', 3], ['ASTO-1', 2], ['X', 1], ['B', 1], ['x', '1']].map(([id, version]) => plain(store.get(id, version)))
  store.set('ASTO-1', 9, { text: 'новое', provider: 'model', created_at: 'c' })
  cacheCases.push({ content, gets, after: JSON.parse(readFileSync(recapCacheFile, 'utf8')) })
}
{
  rmSync(recapCacheFile, { force: true })
  const store = new recap.RecapCacheStore({ storageFile: recapCacheFile })
  for (let index = 0; index < 205; index += 1) store.set(`C-${index}`, index, { text: `t${index}` })
  store.set('C-3', 50, { text: 'обновлено' })
  cacheCases.push({ content: null, gets: [], after: JSON.parse(readFileSync(recapCacheFile, 'utf8')) })
}
const recapKeys = [['A', 1], ['a-b c', '2'], [null, null], [undefined, undefined], ['Длинный-код-кампании-1234567890', 1.25], ['x', -3], ['x', 'abc']].map(([id, version]) => ({ args: plain([id ?? null, version ?? null]), undef: [id === undefined, version === undefined], key: new recap.RecapCacheStore({ storageFile: recapCacheFile }).key(id, version) }))

// ============================================================================
// Творческий режиссёр
// ============================================================================

const creativeStates = [
  { scene: { title: 'Зал', location: 'Крепость', mood: 'Гулкий камень', objective: 'Выстоять' }, players: [{ id: 'hero', character: 'Лира', role: 'Жрица · ур. 2', backstory: 'Ищет сестру.', bonds: 'Сестра Ила', hp: 0 }, { id: 'borin', character: 'Борин', hp: 7 }], enemies: [{ id: 'guard', name: 'Страж', hp: 0, maxHp: 12, alive: false }, { id: 'gob', name: 'Гоблин 1' }], actors: [], mechanics: { combat: { active: true }, death: { heroes: { hero: { status: 'dead' } } } } },
  { players: [{ id: 'hero', character: 'Лира' }], enemies: [{ id: 'wolf', name: 'Волк' }] },
  { players: [{ actor_id: 'p1', name: 'Безымянный', hp: '0' }], enemies: [{ id: 'e1' }], actors: [{ id: 'npc', character: 'Староста' }], mechanics: { combat: { active: false } } },
  {},
  ...corpusStates(12, (state) => Array.isArray(state.players) && state.players.length > 0 && Array.isArray(state.enemies) && state.enemies.length > 0, 11),
]
function eventsFor(state) {
  const heroes = (state.players ?? []).map((actor) => String(actor?.id ?? actor?.actor_id ?? ''))
  const enemies = (state.enemies ?? []).map((actor) => String(actor?.id ?? ''))
  const anyHero = () => pick([...heroes, 'nobody'])
  const anyEnemy = () => pick([...enemies, 'nobody'])
  const kinds = [
    () => ({ event_type: 'ActorMoved', actor_id: anyHero(), target_ids: [anyHero()], payload: { distance: 10 } }),
    () => ({ event_type: 'AttackResolved', actor_id: anyHero(), target_ids: [anyEnemy()], payload: { hit: chance(0.7), critical: chance(0.4), target_id: chance(0.5) ? anyEnemy() : undefined }, source_rule_ids: ['srd:attack'] }),
    () => ({ event_type: 'AttackResolved', actor_id: anyEnemy(), payload: { hit: true, critical: true, target_id: anyHero() } }),
    () => ({ event_type: 'HitPointsReducedToZero', actor_id: anyHero(), target_ids: [anyEnemy()], payload: {}, source_rule_ids: ['srd:zero', 'srd:zero'] }),
    () => ({ event_type: 'HitPointsReducedToZero', actor_id: anyEnemy(), target_ids: chance(0.5) ? [anyHero()] : undefined, payload: { target_id: anyHero() } }),
    () => ({ event_type: 'HeroDied', actor_id: anyHero(), target_ids: [anyHero()], payload: { hero_name: 'x' } }),
    () => ({ event_type: 'ConditionAdded', actor_id: anyEnemy(), target_ids: chance(0.5) ? [anyEnemy()] : [], payload: { condition: pick(['fled', 'surrendered', 'prone']) } }),
    () => ({ event_type: 'DamageApplied', actor_id: anyHero(), target_ids: [anyEnemy()], payload: { amount: 5 }, visibility: 'public', source_rule_ids: 'srd:damage' }),
    () => ({ event_type: 'SpellCast', actor_id: anyHero(), target_ids: [anyHero()], payload: {} }),
    () => ({ event_type: 'EncounterOutcomeRecorded', payload: { outcome: pick(['enemies_defeated', 'fled', 'party_incapacitated', 'draw']), secret: 'x' } }),
    () => ({ event_type: 'EncounterRewardsDistributed', payload: { gold: 5 } }),
    () => ({ event_type: 'EncounterCreated', payload: { encounter: { theme: pick(['bandits', undefined]), enemies: [{ name: 'Разбойник 1' }, { name: 'Волк 12' }, { name: '  ' }, null, { name: 'Главарь' }] } } }),
    () => ({ event_type: 'TimeAdvanced', payload: { minutes: 480 } }),
    () => ({ event_type: 'HeroStabilized', actor_id: anyHero(), target_ids: [anyHero()] }),
  ]
  const events = []
  const count = 1 + int(5)
  for (let index = 0; index < count; index += 1) {
    const event = plain(pick(kinds)())
    if (chance(0.8)) event.event_id = `ev-${int(1000)}`
    events.push(event)
  }
  return events
}
const narratorReplies = [
  { narration: 'Страж оседает у расколотой колонны.', provider: 'RouterAI', verification: { valid: true }, suggestions: [] },
  { narration: 'Сухой текст.', provider: 'deterministic-fallback' },
  { narration: '   ', provider: 'RouterAI' },
  { narration: null, provider: null },
  { provider: 'deterministic' },
  'строка',
  null,
]
const creativeCases = []
const momentCases = []
for (let round = 0; round < 260; round += 1) {
  const state = pick(creativeStates)
  const events = eventsFor(state)
  const note = pick(['', '  ', 'За Илу!', undefined, 'Р'.repeat(500)])
  const actorId = pick(['', 'hero', 'borin', undefined, String(state.players?.[0]?.id ?? 'x')])
  momentCases.push({
    events, state: plain(state), note: plain(note), noteUndef: note === undefined, actorId: plain(actorId), actorUndef: actorId === undefined,
    moment: plain(creative.criticalMomentFor(events, state)),
    flourish: plain(creative.heroFlourishFor(events, state, { playerNote: note, actorId })),
  })
  const method = pick(['renderCriticalMoment', 'renderCriticalMoment', 'renderAftermath', 'renderEncounterOpening'])
  const reply = pick(narratorReplies)
  const renders = []
  const narrator = { render: async (brief, options) => { renders.push({ brief: plain(brief), options: plain(options) }); if (reply === 'throw') throw new Error('x'); return structuredClone(reply) } }
  const director = new creative.CriticalNarrationCoordinator({ narrator })
  const input = { events, state, viewer: pick([undefined, { playerId: 'hero', partyIds: ['hero'], isPartyMember: true }, {}]), recentNarrations: pick([undefined, ['Тишина.', '', null, 5], 'не массив']), playerNote: note, actorId, lastPlayerAction: pick([undefined, 'Бью в дверь', '   ']) }
  const entry = { method, input: plain(input), reply: plain(reply) }
  try {
    entry.out = plain(await director[method](structuredClone(input)))
    if (entry.out === undefined) entry.out = null
  } catch (error) {
    entry.err = errorOf(error)
  }
  entry.renders = renders
  creativeCases.push(entry)
}
const lineCases = []
for (const kind of ['enemy_defeated', 'hero_fallen', 'hero_died', 'enemy_fled', 'enemy_surrendered', 'critical_hit', 'unknown']) {
  for (const name of ['Гоблин 1', '  ', 'Имя $& и $$ и $` и $\'', '']) {
    for (const ids of [[], ['a'], ['a', 'b', null], [undefined, 'c']]) {
      const events = ids.map((id) => (id === undefined ? {} : { event_id: id }))
      const trigger = { kind, target_id: 'gob', target_name: name }
      lineCases.push({ trigger, events: plain(events), out: creative.criticalMomentLine(trigger, events) })
    }
  }
}

// ============================================================================
// Летописец и хранитель знаний
// ============================================================================

const loreCases = []
const loreInputs = [
  { kind: 'prologue', input: { campaign: 'Хроники Лиссы', worldSummary: 'Долина.', worldHistory: '  История  ', heroes: [baseHero, { character: 'Б', role: 5, backstory: 'x'.repeat(500) }, 'строка', 7, ...Array(5).fill({ character: 'Лишний' })] } },
  { kind: 'prologue', input: {} },
  { kind: 'prologue', input: { heroes: 'не массив' } },
  { kind: 'prologue', input: { heroes: [null] } },
  { kind: 'chronicle', input: { arcNumber: '3', epilogue: 'Арка закрыта.', facts: Array.from({ length: 30 }, (_, index) => ({ id: index })), promises: [{ text: 'долг' }] } },
  { kind: 'chronicle', input: { arcNumber: 0 } },
  { kind: 'chronicle', input: { arcNumber: 'x', facts: 'нет' } },
  { kind: 'chronicle', input: {} },
]
for (const { kind, input } of loreInputs) {
  for (const script of loreScripts) {
    const client = script() ? scriptedClient(script()) : null
    const author = new LoreAuthor({ llmClient: client })
    const entry = { kind, input: plain(input), script: script() }
    try {
      entry.out = kind === 'prologue' ? await author.composePrologue(structuredClone(input)) : await author.composeArcChronicle(structuredClone(input))
    } catch (error) {
      entry.err = errorOf(error)
    }
    entry.calls = client?.calls ?? []
    loreCases.push(entry)
  }
}

const materials = [
  { found: ['Ключ от склепа лежит под колодцем у старой ивы'], heard: [{ who: 'Хавер Брин', line: 'Лодочник ушёл к болотам на рассвете' }], known: ['Баркас вернулся без команды'], hook: '' },
  { found: [], heard: [], known: [], hook: 'Найти лодочника' },
  { found: [], heard: [], known: [] },
  { found: 'строка-находка', heard: [{ who: '', line: 'Пусто' }] },
  { heard: [{ who: '  Ила Тойн', line: 'Кузнец прячет что-то в горне' }] },
  { found: ['Короткое'], known: ['Ещё одно знание о деревне Ольховке'] },
  { found: { a: 1 } },
  { heard: [null] },
  { known: 5 },
  { heard: { a: 1 } },
  null,
]
const answers = [
  'Вы помните: ключ от склепа спрятан под колодцем у старой ивы. Хавер Брин говорил, что лодочник ушёл к болотам на рассвете, а баркас вернулся без команды.',
  'Коротко.',
  'Ключ лежит под колодцем, и это все 3 находки из материала, которые есть в брифе сервера.',
  'Говорят, Мартен Вельский видел у колодца старую иву, а ключ от склепа там и лежит под колодцем.',
  'Найти лодочника — вот что важно. Говорят, у болот его видели. Иле, Дорру и прочим это не по душе.',
  '  Кузнец   прячет что-то в горне — так говорила Ила Тойн, и ей можно верить, судя по всему.  ',
  'Ещё одно знание о деревне Ольховке: там живут люди. «Ольховка, Ольховка», — шепчет Ветер. Ольховка рядом.',
  'А'.repeat(950),
  '',
  null,
  'Вам известно: Ольховка, Ольховке; затем: Ольховку. Новый Пришлец явился, — Странник. И ещё, Брин.',
]
const contexts = [{}, { location: 'Тихий Брод', hero: 'Нова Рей' }, { location: null, hero: 5 }, null, undefined]
const verifyCases = []
for (const material of [...materials, undefined]) {
  for (const answer of answers) {
    const context = pick(contexts)
    const entry = { answer: plain(answer), material: plain(material), materialUndef: material === undefined, context: plain(context), contextUndef: context === undefined }
    try {
      entry.out = plain(verifyLoreAnswer(answer, material, context))
    } catch (error) {
      entry.err = errorOf(error)
    }
    verifyCases.push(entry)
  }
}
const retellCases = []
const retellScripts = [
  ...answers.slice(0, 7).map((answer) => [{ value: { answer } }]),
  [{ value: null }], [{ value: { answer: 42 } }], [{ error: { code: 'LLM_TIMEOUT', message: 'нет' } }], null,
]
for (const material of materials) {
  for (const script of retellScripts) {
    const client = script ? scriptedClient(script) : null
    const timeout = pick([undefined, 3000, 'x'])
    const voice = new LoreVoice({ llmClient: client, ...(timeout === undefined ? {} : { timeoutMs: timeout }) })
    const input = { question: pick(['Что мы знаем о колодце?', 'Q'.repeat(500), undefined, 7]), material, ...(chance(0.6) ? { location: pick(['Тихий Брод', null]) } : {}), ...(chance(0.6) ? { hero: pick(['Нова Рей', '']) } : {}) }
    const entry = { input: plain(input), script, timeout: timeout === undefined ? '__undefined__' : timeout }
    try {
      entry.out = plain(await voice.retell(structuredClone(input)))
      if (entry.out === undefined) entry.out = null
    } catch (error) {
      entry.err = errorOf(error)
    }
    entry.calls = client?.calls ?? []
    retellCases.push(entry)
  }
}

const out = {
  bootstrap, canon,
  recapSources: recapSourceCases, recapDeterministic: deterministicCases, recapRuns, recapCache: cacheCases, recapKeys, recapNow: NOW, recapCalls: plain(recapCalls),
  moments: momentCases, creative: creativeCases, lines: lineCases,
  lore: loreCases, verify: verifyCases, retell: retellCases,
}
const json = JSON.stringify(out)
const gz = gzipSync(json, { level: 9 })
writeFileSync(new URL('./a1.json.gz', import.meta.url), gz)
rmSync(storage, { recursive: true, force: true })
console.log(`bootstrap=${bootstrap.length} (ok ${bootstrap.filter((entry) => entry.ok).length}) recapSources=${recapSourceCases.length} recapRuns=${recapRuns.length} creative=${creativeCases.length} moments=${momentCases.length} lore=${loreCases.length} verify=${verifyCases.length} retell=${retellCases.length}; json ${(json.length / 1e6).toFixed(2)} МБ, gzip ${(gz.length / 1e6).toFixed(2)} МБ`)
