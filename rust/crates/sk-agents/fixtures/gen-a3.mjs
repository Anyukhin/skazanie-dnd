import '../../../fixtures-env.mjs'
// Эталоны задачи А3 (`sk-agents`): `server/free-action-adjudication.mjs` и
// `server/action-adjudicator.mjs`.
//
//   node rust/crates/sk-agents/fixtures/gen-a3.mjs [--corpus <каталог corpus-v1>]
//
// Входы: фразы игроков (`eval/player-phrases.json`, `eval/playtest-dead-ends.json`),
// строки из тестов JS о модулях, синтетика и мусор; состояния — сцены из
// тестов JS, свежие кампании авторских миров без модели и снимки корпуса.
// Детерминированные функции сверяются по SHA-256 (первые 12 знаков) каждого
// результата; арбитр с моделью — с записывающей заглушкой (корректные ответы,
// битые, лишние поля, ссылки вне брифа, отказ с кодом и без): сверяются
// запросы к модели (системное сообщение — хешем, пользовательское — хешем
// после первых случаев) и итог.
//
// Выход — `a3.json.gz`.
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
process.env.DND_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'sk-a3-'))
delete process.env.ROUTERAI_API_KEY

const root = new URL('../../../../', import.meta.url)
const fa = await import('../../../../server/free-action-adjudication.mjs')
const aa = await import('../../../../server/action-adjudicator.mjs')
const { normalizeCampaignState, resolveCommand, applyGameEvent } = await import('../../../../server/rules-engine.mjs')
const tm = await import('../../../../server/tactical-map.mjs')
const { generateBuildingScene } = await import('../../../../server/building-generator.mjs')
const { normalizeDeclaredLevels } = await import('../../../../server/level-generator.mjs')
const { SRD_5_2_1_MONSTER_ALLOWLIST } = await import('../../../../server/encounter-assembler.mjs')
const { enemyLoadoutFor } = await import('../../../../server/enemy-loadouts.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { CampaignBootstrapper } = await import('../../../../server/campaign-bootstrap.mjs')
const { lootContainersInScene, lootContainerList } = await import('../../../../server/loot-containers.mjs')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpusRoot = flag('--corpus', 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1')

let seed = 0x00a3_5eed
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
const short = (value) => sha(value).slice(0, 12)
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

// ============================================================================
// Фразы
// ============================================================================

const phraseSet = new Set()
const addPhrase = (text) => { if (typeof text === 'string' && text.length <= 600) phraseSet.add(text) }
const players = JSON.parse(readFileSync(new URL('eval/player-phrases.json', root), 'utf8'))
for (const entry of players.phrases) addPhrase(entry.text)
const deadEnds = JSON.parse(readFileSync(new URL('eval/playtest-dead-ends.json', root), 'utf8'))
for (const entry of deadEnds.cases) addPhrase(entry.text)
const realPhrases = [...phraseSet]

// Строки из тестов JS о модулях: всё кириллическое в кавычках.
const testFiles = [
  'action-adjudicator', 'free-action-adjudication', 'free-action-approach', 'free-action-discovery',
  'free-action-hazard-contact', 'free-action-hazard-safety', 'free-action-wall-contact', 'free-action',
  'level-transition-phrase', 'llm-refusal-fallback', 'loot-containers', 'pickpocket', 'scene-prop-improvisation',
  'intent-routing', 'dm-dialogue-upgrade', 'gm-secrets', 'table-situations-doc', 'player-request-router',
]
const testPhrases = new Set()
for (const name of testFiles) {
  const source = readFileSync(new URL(`test/${name}.test.mjs`, root), 'utf8')
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.){4,300})'|"((?:[^"\\\n]|\\.){4,300})"/gu)) {
    const raw = match[1] ?? match[2]
    if (!/[а-яё]/iu.test(raw) || raw.includes('${')) continue
    const text = raw.replace(/\\(['"\\])/gu, '$1').replace(/\\n/gu, '\n')
    testPhrases.add(text)
  }
}
for (const text of testPhrases) addPhrase(text)

const synthetic = [
  '', ' ', '   \n\t ', '?', '!!!', '…', '«»', '""', 'a', 'я', '123', '-1', 'NaN', 'undefined', 'null', '[object Object]',
  'Подхожу к Лиде', 'иду к бочкам', 'Мирель выходит к мосткам', 'подхожу к баркасу и осматриваю его', 'Борин идёт к бочкам, чтобы осмотреть их',
  'Подхожу к себе', 'иду к концу', 'Иду к двери', 'Иду к колодцу', 'Подхожу к стойке трактира', 'Подхожу к алтарю', 'Иду к доске объявлений',
  'Иду к   бочкам   и   двери', 'выхожу к причалу, подхожу к баркасу', 'Подхожу к Борину и передаю ему верёвку',
  'Сажусь на костёр', 'Касаюсь огня', 'Не касаюсь огня', 'Сажусь рядом с костром', 'Перепрыгиваю через костёр', 'Прыгаю в лаву', 'Читаю главу о славе',
  'Врезаюсь в стену', 'Не врезаюсь в стену', 'Врезаюсь в стену, чтобы пробить её', 'Если я врежусь в стену?', 'Хочу врезаться в стену',
  'Трогаю кислоту', 'Наступаю на осколки стекла', 'Лезу в пропасть', 'Прыгаю в обрыв', 'Сажусь на ловушку', 'Трогаю метеор',
  'Передаю Бору верёвку', 'Даю Бору 3 верёвки', 'Отдаю верёвку', 'Беру у Бора верёвку', 'Передаю товарищу меч', 'Отдаю 999 стрел',
  'Обчищаю карманы Горазда', 'Залезаю в кошель стражнику', 'Тяну кошелёк у Ильмы', 'Обчищаю карман', 'Ворую из кармана у Тарна',
  'Обыскиваю тело разбойника', 'Обыскиваю тела', 'Осматриваю убитых', 'Обыскиваю поверженных', 'Приседает у тел, обыскивает одежду', 'Ищу в карманах пленного',
  'Обыскиваю телегу', 'Проверяю мертвеца', 'Обыскиваю всех', 'Обыскиваю схрон', 'Обыскиваю брошенный мешок',
  'Поднимаемся по лестнице на второй этаж', 'Спускаемся в подвал', 'Поднимаемся наверх по склону к замку', 'Идём на чердак', 'Спускаюсь вниз по лестнице',
  'Открываю дверь', 'Закрываю дверь', 'Выбиваю дверь', 'Выламываю дверь, не ломая её', 'Взламываю дверь отмычками', 'Подпираю дверь верёвкой', 'Снимаю баррикаду',
  'Баррикадирую дверь скамьёй', 'Выбиваю баррикаду', 'Отпираю дверь passage-door', 'Открываю двери',
  'Захожу внутрь', 'Вхожу внутрь монастыря', 'Толкаю дверь плечом и вхожу первым. «За мной»', 'Не вхожу внутрь', 'Можно ли войти внутрь?', 'Пролезаю внутрь через окно',
  'Вхожу в маяк', 'Вхожу в храм', 'Протискиваюсь внутрь', 'толкает дверь, чтобы войти первым', 'Подхожу к двери маяка и вхожу в маяк',
  'Записываю в тетрадь знак', 'заносит в тетрадь знак, царапину и волокна верёвки', 'Отмечаю в своём дневнике дорогу', 'Записываю в тетрадь «пароль»',
  'Завязываю верёвку', 'Развязываю и заново завязываю свою верёвку, проверяя прочность узлов перед использованием.', 'Подбрасываю монету и ловлю её левой рукой.',
  'Целую её в щёку', 'Обнимаю Бора', 'Пожимаю ему руку', 'Обнимаю стражника, чтобы стащить ключ',
  'Проталкиваюсь к шлюзам и смотрю, кто их открывает', 'Пробираюсь к перилам и прыгаю вниз', 'Иду к окну и прислушиваюсь',
  'Поднимаю весь замок', 'Взлетаю над городом', 'Лечу в небо', 'Поднимаю шишку с пола',
  'Снимаю копию схемы', 'Переписываю письмо', 'Зарисовываю знак', 'Переписываюсь с братом',
  'Прячусь за бочками в тени', 'Крадусь мимо стражи', 'Тихо говорит Борину', 'Тихо пробираюсь вдоль стены', 'Раскрывает тетрадь',
  'Запугиваю стражника силой', 'Убеждаю хозяйку помочь', 'Обманываю купца', 'Кричу «Пожар!»', 'Отвлекаю стражу шумом',
  'Простукиваю бочки — нет ли тайника', 'Осматриваю обелиск', 'Смотрим на маяк — загорится ли огонь?', 'Вспоминаю, что известно о культе',
  'Взбираюсь на стену', 'Делаю сальто', 'Колесо во дворе', 'Поджигаю сено факелом', 'Опрокидываю шкаф на гоблина', 'Опрокидываю жаровню',
  'Использую заклинание «Огненный снаряд»', 'Колдую заговор Священное пламя', 'Применяю умение «Второе дыхание»',
  'Без спешки, много времени, незапертая дверь', 'В шторм и дым, в темноте ищу проход', 'Прячусь за телегой и колонной',
  'Атакую гоблина; затем отступаю', 'if then', 'Иду дальше, потом спрашиваю', 'Подхожу к Лиде и прошу помощи',
  'Подхожу к Лиде, не покидая укрытия', 'Не двигаюсь', 'Подхожу к Лида Воронина без перемещения',
  'ПОДХОЖУ К ЛИДЕ', 'подхожу ко лиде', 'Ёлка, ёж, ёмкость', 'Ｐｏｄｈｏｚｈｕ', 'ﬁre огонь', '🔥 касаюсь огня 🔥', 'Подхожу к 🐟 рыбе',
  'a'.repeat(1_200), 'Сажусь '.repeat(200), 'к к к к к к к', 'иду к, к; к.', 'шагаю к — мосткам — и смотрю',
]
for (const text of synthetic) addPhrase(text)
// Мусор: случайные куски слов.
const syllables = ['под', 'хож', 'у', ' к ', 'бочк', 'ам', 'двер', 'и', ' ', ',', 'огн', 'ю', 'тел', 'о', 'обыск', 'ив', 'аю', 'лест', 'ниц', 'е', 'вход', 'внутрь', '?', '«', '»', 'не ', 'стен', 'врезаюсь', 'прыг', 'карман']
for (let index = 0; index < 120; index += 1) {
  addPhrase(Array.from({ length: 2 + int(10) }, () => pick(syllables)).join(''))
}
const phrases = [...phraseSet]
const phraseIndex = new Map(phrases.map((text, index) => [text, index]))

// ============================================================================
// Состояния
// ============================================================================

const states = []
const addState = (label, state, actors) => { states.push({ label, state: plain(state), actors }) }

function harbour() {
  const map = tm.createTacticalMap({ width: 12, height: 6, locationId: 'harbour', seed: 'approach' })
  tm.addZone(map, { id: 'street', kind: 'exterior', label: 'Улица' })
  tm.addZone(map, { id: 'pier', kind: 'exterior', label: 'Мостки' })
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 12; x += 1) {
    tm.setCell(map, x, y, { passable: true, revealed: true, material: x >= 8 ? 'wood' : 'stone', zone: x >= 8 ? 'pier' : 'street' })
  }
  tm.addProp(map, { id: 'barrel-1', assetId: 'barrel', x: 6, y: 1 })
  tm.addProp(map, { id: 'boat-1', assetId: 'rowboat', x: 10, y: 4 })
  return normalizeCampaignState({
    sessionCode: 'APPROACH',
    scene: { title: 'Причал', location: 'Причал', location_id: 'harbour', map: tm.serializeTacticalMap(map), cells: tm.legacyCellsFromTacticalMap(map) },
    players: [
      { id: 'hero', character: 'Мирель', x: 0, y: 2, hp: 10, maxHp: 10, armor: 11, speed: 30, inventory: [{ id: 'rope-1', name: 'Верёвка', quantity: 2 }] },
      { id: 'ally', character: 'Борин', x: 0, y: 3, hp: 10, maxHp: 10, armor: 16, speed: 25, inventory: [{ id: 'sword', name: 'Меч' }] },
    ],
    social: { npcs: [{ id: 'lida', name: 'Лида Воронина', role: 'рыбачка', location: 'Причал', visibility: 'party', available: true, tags: ['рыбачка', 'secret:x'] }] },
    npc_world: { schema_version: 3, placements: [{ npc_id: 'lida', location_id: 'harbour', x: 9, y: 1 }], inventories: {}, vitals: {} },
  })
}
addState('harbour', harbour(), ['hero', 'ally'])
{
  const state = harbour()
  const map = tm.deserializeTacticalMap(state.scene.map)
  for (let y = 0; y < 6; y += 1) for (let x = 6; x < 12; x += 1) tm.setCell(map, x, y, { revealed: false })
  state.scene.map = tm.serializeTacticalMap(map)
  addState('harbour-fog', state, ['hero'])
}

function hazardState({ withFire = true, fireX = 1, fireRevealed = true, assetId = 'campfire', cells = [], hazards = null } = {}) {
  const map = tm.createTacticalMap({ width: 4, height: 1, locationId: 'hazard-test', seed: 'hazard-test', fill: { passable: true, revealed: true, material: 'stone' } })
  if (withFire) {
    tm.addProp(map, { id: 'campfire-1', assetId, x: fireX + 0.5, y: 0.5, footprint: [{ x: fireX, y: 0 }] })
    if (!fireRevealed) tm.setCell(map, fireX, 0, { revealed: false })
  }
  return normalizeCampaignState({
    sessionCode: 'HAZARD-TEST', partyMemberIds: ['hero'], activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 20, maxHp: 20, speed: 30, x: 0, y: 0, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }],
    scene: { title: 'Огонь', location: 'Огонь', cells, map: tm.serializeTacticalMap(map) },
    ...(hazards ? { mechanics: { hazards } } : {}),
  })
}
addState('hazard-fire', hazardState(), ['hero'])
addState('hazard-far', hazardState({ fireX: 3 }), ['hero'])
addState('hazard-hidden', hazardState({ fireRevealed: false }), ['hero'])
addState('hazard-none', hazardState({ withFire: false }), ['hero'])
addState('hazard-brazier', hazardState({ assetId: 'brazier' }), ['hero'])
addState('hazard-haystack', hazardState({ assetId: 'haystack' }), ['hero'])
addState('hazard-legacy', hazardState({ withFire: false, cells: [{ x: 1, y: 0, hazardId: 'hazard-fire', revealed: true }, { x: 0, y: 0, hazard_id: 'acid', revealed: true }] }), ['hero'])
addState('hazard-active', hazardState({ withFire: false, hazards: { hero: [{ id: 'fire', type: 'fire' }, { hazard_id: 'кислота' }] } }), ['hero'])
{
  const state = hazardState()
  state.mechanics.scene_interactions = { 'campfire-1': { state: 'extinguished' } }
  addState('hazard-out', state, ['hero'])
}
// Костёр, скрытый ведущим, на раскрытой клетке: опасностью не считается. Метка ставится
// после нормализации — нормализация пересобирает карту и сама её не хранит.
{
  const state = hazardState()
  state.scene.map.props.find((prop) => prop.id === 'campfire-1').visibility = 'gm_only'
  addState('hazard-gm-only', state, ['hero'])
}
{
  const map = tm.createTacticalMap({ width: 4, height: 2, locationId: 'cell-hazards', seed: 'cell-hazards', fill: { passable: true, revealed: true, material: 'stone' } })
  tm.setCell(map, 1, 0, { hazardId: 'hazard-fire' })
  tm.setCell(map, 0, 1, { hazardId: 'shards' })
  tm.setCell(map, 3, 1, { hazardId: 'lava' })
  addState('cell-hazards', normalizeCampaignState({
    sessionCode: 'CELLS', players: [{ id: 'hero', character: 'Ада', hp: 20, maxHp: 20, x: 0, y: 0, inventory: [] }],
    scene: { title: 'Пещера', location: 'Пещера', cells: [], map: tm.serializeTacticalMap(map) },
  }), ['hero'])
}

function wallActor(id, x, y) {
  return { id, character: id, hp: 20, maxHp: 20, x, y, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }
}
function nativeWall({ wall = true, originRevealed = true, wallRevealed = true, wallX = 1, edgeKind = null, actorX = 0 } = {}) {
  const map = tm.createTacticalMap({ width: 4, height: 1, locationId: 'wall-contact', seed: 'wall-contact', fill: { passable: true, revealed: true, material: 'stone' } })
  if (wall || edgeKind) {
    tm.setEdge(map, wallX - 1, 0, wallX, 0, { kind: edgeKind ?? 'wall', blocksMove: wall, blocksSight: wall })
    if (!originRevealed) tm.setCell(map, wallX - 1, 0, { revealed: false })
    if (!wallRevealed) tm.setCell(map, wallX, 0, { revealed: false })
  }
  return normalizeCampaignState({
    sessionCode: 'WALL-CONTACT', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [wallActor('hero', actorX, 0), wallActor('other', actorX === 3 ? 0 : 3, 0)],
    scene: { title: 'Зал', location: 'Зал', cells: [], map: tm.serializeTacticalMap(map) },
  })
}
addState('wall', nativeWall(), ['hero', 'other'])
addState('wall-hidden-origin', nativeWall({ originRevealed: false }), ['hero'])
addState('wall-far', nativeWall({ wallX: 3 }), ['hero'])
addState('wall-window', nativeWall({ wall: false, edgeKind: 'window' }), ['hero'])
{
  const legacy = (revealed) => {
    const result = normalizeCampaignState({
      sessionCode: 'WALL-LEGACY', activePlayerId: 'hero', partyMemberIds: ['hero'],
      players: [wallActor('hero', 0, 0), wallActor('other', 3, 0)],
      scene: { title: 'Старый зал', location: 'Старый зал', cells: [
        { x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'wall', revealed },
        { x: 2, y: 0, type: 'floor', revealed: true }, { x: 3, y: 0, type: 'floor', revealed: true },
      ] },
    })
    delete result.scene.map
    return result
  }
  addState('wall-legacy', legacy(true), ['hero'])
  addState('wall-legacy-hidden', legacy(false), ['hero'])
}

function tavern({ reveal = true, near = true } = {}) {
  const map = generateBuildingScene({ seed: 'лестница словами', locationId: 'loc-tavern', levels: normalizeDeclaredLevels([{ offset: 1, hint: 'комнаты постояльцев' }]) })
  if (reveal) for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (tm.cellAt(map, x, y)) tm.setCell(map, x, y, { revealed: true })
  const stairs = map.props.find((prop) => prop.transition)
  const anchor = { x: Math.floor(stairs.x), y: Math.floor(stairs.y) }
  const furniture = new Set(map.props.filter((prop) => prop.blocksMove && !prop.mount).flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  const cells = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = tm.cellAt(map, x, y)
    if (cell?.passable && cell.zone === 'hall' && !(x === anchor.x && y === anchor.y) && !furniture.has(`${x},${y}`)) cells.push({ x, y, d: Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) })
  }
  cells.sort((left, right) => (near ? left.d - right.d : right.d - left.d) || left.y - right.y || (near ? left.x - right.x : right.x - left.x))
  const spots = cells.slice(0, 2)
  const party = ['hero-a', 'hero-b']
  return normalizeCampaignState({
    sessionCode: 'STAIRS-PHRASE', campaign: 'Лестница словами', engine_mode: 'enforce', partyMemberIds: [...party], activePlayerId: party[0],
    players: party.map((id, index) => ({ id, character: `Герой ${index + 1}`, level: 1, hp: 10, maxHp: 10, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], ...spots[index] })),
    worldMap: { seed: 'stairs-seed', currentLocationId: 'loc-tavern', locations: [{ id: 'loc-tavern', name: 'Постоялый двор', kind: 'settlement' }, { id: 'tower', name: 'Скальный маяк', kind: 'landmark' }] },
    scene: {
      title: 'Постоялый двор', location: 'Постоялый двор', location_id: 'loc-tavern', objective: 'Найти хозяина', turn: 1,
      levels: normalizeDeclaredLevels([{ offset: 1, hint: 'комнаты постояльцев' }]),
      map: tm.serializeTacticalMap(map), cells: tm.legacyCellsFromTacticalMap(map),
    },
    mechanics: { positions: Object.fromEntries(party.map((id, index) => [id, { x: spots[index].x, y: spots[index].y }])), world_time: { elapsed_minutes: 0 } },
  })
}
addState('tavern-near', tavern(), ['hero-a'])
addState('tavern-far', tavern({ near: false }), ['hero-a', 'hero-b'])
addState('tavern-fog', tavern({ reveal: false }), ['hero-a'])
{
  const state = tavern({ near: false })
  state.mechanics.combat = { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero-a' }] }
  addState('tavern-combat', state, ['hero-a'])
}

function faHero(id, character = id) {
  return { id, character, name: character, hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }
}
function faCampaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'FREE-ACTION', activePlayerId: 'hero',
    scene: { title: 'Зал', location: 'Старый трактир', objective: 'Осмотреть зал', cells: [] },
    players: [faHero('hero', 'Ада'), faHero('other', 'Бор')],
    ...overrides,
  })
}
function passageCampaign(doorState = 'open', { darkInside = false, location = 'Монастырь' } = {}) {
  const map = tm.createTacticalMap({ width: 5, height: 3, locationId: 'passage-fixture', seed: 'passage-fixture', sizeClass: 'arena' })
  tm.addZone(map, { id: 'outside', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Снаружи' })
  tm.addZone(map, { id: 'inside', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Монастырь' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 5; x += 1) tm.setCell(map, x, y, { passable: y === 1, revealed: !darkInside || x < 2, zone: x < 2 ? 'outside' : 'inside' })
  tm.setDoor(map, { id: 'passage-door', x: 1, y: 1, dir: 'e', state: doorState })
  return faCampaign({
    scene: { title: 'Вход', location, objective: 'Войти внутрь', cells: tm.legacyCellsFromTacticalMap(map), map: tm.serializeTacticalMap(map) },
    players: [{ ...faHero('hero', 'Ада'), inventory: [{ id: 'plank', name: 'Доска' }, { id: 'rope', name: 'Верёвка' }] }, faHero('other', 'Бор')],
    worldMap: { locations: [{ id: 'm', name: 'Монастырь' }, { id: 'l', name: 'Скальный маяк' }, { id: 't', name: 'Башня мага', known: false }, { id: 'h', name: 'Дом старосты' }] },
    mechanics: { combat: { active: false }, positions: { hero: { x: 0, y: 1 }, other: { x: 4, y: 1 } } },
  })
}
addState('passage-open', passageCampaign('open'), ['hero', 'other'])
addState('passage-closed', passageCampaign('closed'), ['hero'])
addState('passage-locked', passageCampaign('locked'), ['hero'])
addState('passage-dark', passageCampaign('closed', { darkInside: true }), ['hero'])
addState('passage-tavern', passageCampaign('open', { location: 'Таверна' }), ['hero'])
{
  const map = tm.createTacticalMap({ width: 6, height: 3, locationId: 'porch-fixture', seed: 'porch-fixture', sizeClass: 'arena' })
  tm.addZone(map, { id: 'outside', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Снаружи' })
  tm.addZone(map, { id: 'porch', kind: 'interior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Крыльцо' })
  tm.addZone(map, { id: 'hall', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Зал' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) tm.setCell(map, x, y, { passable: y === 1, revealed: true, zone: x === 0 ? 'outside' : x < 3 ? 'porch' : 'hall' })
  tm.setDoor(map, { id: 'porch-door', x: 2, y: 1, dir: 'e', state: 'open' })
  addState('porch', faCampaign({
    scene: { title: 'Монастырь', location: 'Монастырь', objective: 'Войти внутрь', cells: tm.legacyCellsFromTacticalMap(map), map: tm.serializeTacticalMap(map) },
    mechanics: { combat: { active: false }, positions: { hero: { x: 0, y: 1 }, other: { x: 5, y: 1 } } },
  }), ['hero'])
}
{
  // Две двери на равном расстоянии и барикада.
  const map = tm.createTacticalMap({ width: 5, height: 5, locationId: 'twin-doors', seed: 'twin', sizeClass: 'arena' })
  tm.addZone(map, { id: 'outside', kind: 'exterior', label: 'Двор' })
  tm.addZone(map, { id: 'inside', kind: 'interior', label: 'Дом' })
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) tm.setCell(map, x, y, { passable: true, revealed: true, zone: x < 2 ? 'outside' : 'inside' })
  for (let y = 0; y < 5; y += 1) tm.setEdge(map, 1, y, 2, y, { kind: 'wall', blocksMove: true, blocksSight: true })
  tm.setDoor(map, { id: 'door-north', x: 1, y: 1, dir: 'e', state: 'open' })
  tm.setDoor(map, { id: 'door-south', x: 1, y: 3, dir: 'e', state: 'open' })
  addState('twin-doors', faCampaign({
    scene: { title: 'Дом', location: 'Дом старосты', cells: tm.legacyCellsFromTacticalMap(map), map: tm.serializeTacticalMap(map) },
    players: [{ ...faHero('hero', 'Ада'), x: 1, y: 2 }, { ...faHero('other', 'Бор'), x: 0, y: 0 }],
    mechanics: { combat: { active: false }, positions: { hero: { x: 1, y: 2 }, other: { x: 0, y: 0 } } },
  }), ['hero'])
  const barricaded = tm.deserializeTacticalMap(tm.serializeTacticalMap(map))
  tm.setDoor(barricaded, { id: 'door-north', x: 1, y: 1, dir: 'e', state: 'closed', barricade: { material_item_id: 'plank', strength: 15 } })
  addState('barricade', faCampaign({
    scene: { title: 'Дом', location: 'Дом старосты', cells: tm.legacyCellsFromTacticalMap(barricaded), map: tm.serializeTacticalMap(barricaded) },
    players: [{ ...faHero('hero', 'Ада'), x: 1, y: 1, inventory: [{ id: 'bench', name: 'Скамья' }] }, faHero('other', 'Бор')],
    mechanics: { combat: { active: false }, positions: { hero: { x: 1, y: 1 } } },
  }), ['hero'])
}
addState('free-action-base', faCampaign({
  players: [
    { ...faHero('hero', 'Ада'), inventory: [{ id: 'rope', name: 'Верёвка', quantity: 3 }, { id: 'torch', name: 'Факел' }, { id: 'torch-2', name: 'Факел' }, { id: 'ring', name: 'Кольцо', equipped: true }, { id: 'amulet', name: 'Амулет', attuned_to: 'hero' }], currency: { gold: 2 } },
    { ...faHero('other', 'Бор'), inventory: [{ id: 'sword', name: 'Меч' }] },
  ],
}), ['hero', 'other'])
addState('free-action-combat', faCampaign({
  players: [{ ...faHero('hero', 'Ада'), inventory: [{ id: 'rope', name: 'Верёвка' }] }, faHero('other', 'Бор')],
  mechanics: { combat: { active: true, round: 2, active_index: 0, initiative: [{ actor_id: 'hero' }] } },
}), ['hero'])

function adjScene() {
  return normalizeCampaignState({
    players: [{
      id: 'hero', character: 'Аster', characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 15, speed: 30, x: 0, y: 0,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
      classSkillProficiencies: ['athletics', 'perception'], skillExpertiseIds: ['perception'], preparedSpellIds: ['sacred-flame'],
      inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1, equipped: false }],
    }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 25, maxHp: 25, armor: 12, alive: true, x: 1, y: 0 }],
    scene: { title: 'Мост', location: 'Мост', mood: 'Ветрено', objective: 'Удержать мост', turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: true, round: 2, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }], action_economy: { hero: { action: true, bonus_action: false, movement: true, movement_spent: 10 } } } },
  })
}
{
  const state = adjScene()
  state.social.npcs.push({ id: 'secret', name: 'Тайный наблюдатель', location: state.scene.location, visibility: 'gm_only', available: true })
  state.social.npcs.push({ id: 'keeper', name: 'Смотритель моста', role: 'смотритель', location: state.scene.location, visibility: 'party', available: true, tags: ['смотритель', 'quest:bridge'] })
  addState('adjudicator', state, ['hero'])
}
{
  const map = tm.createTacticalMap({ width: 3, height: 1, locationId: 'contact-preview', seed: 'contact-preview', fill: { passable: true, revealed: true, material: 'stone' } })
  tm.addProp(map, { id: 'campfire-preview', assetId: 'campfire', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] })
  tm.setEdge(map, 0, 0, 0, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  const current = adjScene()
  addState('adjudicator-contact', normalizeCampaignState({
    ...current, scene: { ...current.scene, map: tm.serializeTacticalMap(map), cells: [] },
    mechanics: { ...current.mechanics, combat: { ...current.mechanics.combat, active: false } },
  }), ['hero'])
}

function stable({ withFire = true, distantBed = false, hiddenCorner = false, twinChests = false, combat = true } = {}) {
  const map = tm.createTacticalMap({ width: 6, height: 4, locationId: 'stable', seed: 'prop-improv', fill: { passable: true, revealed: true, material: 'wood' } })
  if (hiddenCorner) tm.setCell(map, 4, 3, { revealed: false })
  tm.addProp(map, { id: 'prop-haystack', assetId: 'haystack', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] })
  tm.addProp(map, { id: 'prop-shelf', assetId: 'bookshelf', x: 0.5, y: 1.5, footprint: [{ x: 0, y: 1 }] })
  if (distantBed) tm.addProp(map, { id: 'prop-bed', assetId: 'bed', x: 4.5, y: 3.5, footprint: [{ x: 4, y: 3 }] })
  if (twinChests) {
    tm.addProp(map, { id: 'prop-chest-sheet', assetId: 'chest', x: 0.5, y: 2.5, footprint: [{ x: 0, y: 2 }] })
    tm.addProp(map, { id: 'prop-chest-real', assetId: 'chest', x: 5.5, y: 2.5, footprint: [{ x: 5, y: 2 }] })
  }
  if (withFire) tm.addProp(map, { id: 'prop-fire', assetId: 'campfire', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const serialized = tm.serializeTacticalMap(map)
  if (hiddenCorner) serialized.props.push({ id: 'prop-gm', assetId: 'barrel', x: 3, y: 3, visibility: 'gm_only' }, { id: 'prop-hidden', assetId: 'crate', x: 2, y: 3, revealed: false })
  return normalizeCampaignState({
    sessionCode: 'PROP-IMPROV', campaign: 'Мост к обстановке', partyMemberIds: ['hero'], activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', level: 3, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2, abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 12, cha: 10 }, classSkillProficiencies: ['athletics'], x: 0, y: 0, inventory: [] }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 14, maxHp: 14, armor: 13, alive: true, abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, x: 0, y: 1 }],
    scene: { title: 'Конюшня', location: 'Конюшня', objective: 'Выбить налётчика', turn: 1, map: serialized },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, goblin: { x: 0, y: 1 } }, world_time: { elapsed_minutes: 0 },
      combat: combat ? { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } : { active: false },
    },
  })
}
addState('stable', stable(), ['hero'])
addState('stable-peace', stable({ distantBed: true, twinChests: true, combat: false }), ['hero'])
addState('stable-hidden', stable({ hiddenCorner: true, withFire: false }), ['hero'])

function pickpocketFixture({ npcs = null, combat = false } = {}) {
  const people = npcs ?? [
    { id: 'npc-1', name: 'Горазд', role: 'купец', location: 'Рынок', available: true, visibility: 'party' },
    { id: 'npc-2', name: 'Ждан', role: 'страж', location: 'Рынок', available: true, visibility: 'party' },
  ]
  return normalizeCampaignState({
    sessionCode: 'THIEF-UNIT', partyMemberIds: ['hero', 'ally'],
    members: [{ user_id: 'user-1', hero_id: 'hero', role: 'player' }, { user_id: 'user-2', hero_id: 'ally', role: 'player' }],
    players: [
      { id: 'hero', character: 'Ильма', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 3, proficiency: 2, x: 1, y: 1, abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 12 }, currency: { copper: 0, silver: 0, gold: 0, platinum: 0 }, inventory: [] },
      { id: 'ally', character: 'Тарн', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 3, proficiency: 2, x: 2, y: 1, abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [{ id: 'rope', name: 'Верёвка' }] },
    ],
    social: { npcs: people },
    npc_world: { placements: [{ npc_id: 'npc-1', location_id: 'Рынок', x: 2, y: 1 }, { npc_id: 'npc-2', location_id: 'Рынок', x: 3, y: 1 }] },
    worldMap: { seed: 'thief-seed', regions: [{ id: 'region-1', name: 'Приречье', biome: 'plains', x: 200, y: 200, radius: 205 }], locations: [{ id: 'market', name: 'Рынок', kind: 'town', x: 200, y: 200, regionId: 'region-1' }], currentLocationId: 'market' },
    scene: { turn: 1, location: 'Рынок', cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
    mechanics: combat ? { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 12 }] } } : {},
  })
}
addState('pickpocket', pickpocketFixture(), ['hero', 'ally'])
addState('pickpocket-combat', pickpocketFixture({ combat: true }), ['hero'])
addState('pickpocket-twins', pickpocketFixture({ npcs: [
  { id: 'npc-1', name: 'Горазд Старший', role: 'купец', location: 'Рынок', available: true, visibility: 'party' },
  { id: 'npc-2', name: 'Горазд Младший', role: 'купец', location: 'Рынок', available: true, visibility: 'party' },
  { id: 'npc-3', name: 'Ушедший', location: 'Рынок', available: false, visibility: 'party' },
  { id: 'npc-4', name: 'Дальний', location: 'Порт', available: true, visibility: 'party' },
] }), ['hero'])

// Добыча: убитые разбойники с настоящим инвентарём.
function bandit(id, { x = 2, y = 1, hp = 11, seed = 'loot-seed' } = {}) {
  const statBlockId = 'srd_5_2_1:bandit'
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return {
    id, name: `Разбойник ${id.slice(-1)}`, creature_type: block.creature_type, hp, maxHp: block.hp, armor: block.armor, speed: block.speed,
    abilities: { ...block.abilities }, x, y, alive: hp > 0, stat_block_id: statBlockId, provenance: { xp: block.xp },
    action_profiles: block.action_profiles, loadout: enemyLoadoutFor({ statBlockId, block, ownerId: id, seed }),
  }
}
function lootCampaign({ combat = true, enemies = [bandit('foe-1')], heroX = 2 } = {}) {
  const grid = []
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 10; x += 1) grid.push({ x, y, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'LOOT', campaign: 'Контейнеры добычи', activePlayerId: 'hero', partyMemberIds: ['hero', 'mate'], partyName: 'Отряд героев',
    scene: { title: 'Разграбленный склад', location: 'Склад', location_id: 'warehouse', turn: 1, grid: { width: 10, height: 6 }, cells: grid },
    players: [
      { id: 'hero', character: 'Ада', characterClass: 'fighter', level: 3, hp: 24, maxHp: 24, armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: heroX, y: 2 },
      { id: 'mate', character: 'Борх', characterClass: 'fighter', level: 3, hp: 24, maxHp: 24, armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 6, y: 4 },
    ],
    enemies,
    worldMap: { seed: 'loot-world', locations: [{ id: 'warehouse', name: 'Склад', kind: 'ruin', x: 10, y: 10 }], routes: [] },
    mechanics: {
      world_time: { elapsed_minutes: 120 },
      encounter: { id: 'enc-1', encounter_id: 'enc-1', status: 'active', enemy_ids: enemies.map((enemy) => enemy.id) },
      combat: combat
        ? { active: true, round: 2, active_index: 0, initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe-1', total: 6 }], action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, mate: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } }
        : { active: false, round: 0, initiative: [], active_index: -1, action_economy: {} },
    },
  })
}
function lootCommit(state, command) {
  const result = resolveCommand({ campaign_id: 'LOOT', command_id: `${command.command_type}-${state.state_version}-${int(1e9).toString(36)}`, ...command }, state, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { allowedActorIds: ['hero', 'mate'] } })
  return result.events.reduce(applyGameEvent, state)
}
const kill = (state, enemyId) => lootCommit(state, { command_type: 'ApplyDamage', actor_id: 'hero', target_id: enemyId, amount: Math.max(1, state.enemies.find((enemy) => enemy.id === enemyId).hp), damage_type: 'slashing' })
try {
  const one = kill(lootCampaign({ combat: false }), 'foe-1')
  addState('loot-one', one, ['hero', 'mate'])
  const fight = kill(lootCampaign({ combat: true }), 'foe-1')
  addState('loot-combat', fight, ['hero'])
  const twoNear = kill(kill(lootCampaign({ combat: false, enemies: [bandit('foe-1', { x: 1, y: 2 }), bandit('foe-2', { x: 3, y: 2, seed: 'other' })] }), 'foe-1'), 'foe-2')
  addState('loot-two-near', twoNear, ['hero', 'mate'])
  const twoFar = kill(kill(lootCampaign({ combat: false, heroX: 9, enemies: [bandit('foe-1', { x: 1, y: 0 }), bandit('foe-2', { x: 1, y: 4, seed: 'other' })] }), 'foe-1'), 'foe-2')
  addState('loot-two-far', twoFar, ['hero'])
  const container = lootContainerList(one).find((entry) => entry.kind === 'corpse')
  const emptied = lootCommit(one, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines: container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })) })
  addState('loot-emptied', emptied, ['hero'])
  const moved = plain(one)
  moved.scene.location_id = 'elsewhere'
  addState('loot-other-level', moved, ['hero'])
} catch (error) {
  console.error('добыча не собралась:', error.message)
}
{
  const state = lootCampaign({ combat: false, enemies: [{ id: 'foe-x', name: 'Скелет', hp: 0, alive: false, x: 3, y: 2, loadout: { items: [], purse_cp: 0 } }, { id: 'foe-y', name: 'Скелет Второй', hp: 0, alive: false, x: 4, y: 2 }] })
  state.entities = [{ id: 'remains-1', kind: 'remains', name: 'Останки', search_contents: [{ id: 'coin' }] }]
  addState('corpses-legacy', state, ['hero'])
  const single = lootCampaign({ combat: false, enemies: [{ id: 'foe-z', name: 'Культист', hp: 0, alive: false, x: 3, y: 2, loadout: { items: [{ id: 'dagger' }], purse_cp: 5 } }] })
  addState('corpse-carried', single, ['hero'])
}

// Свежие кампании авторских миров без модели (как в тесте тупиков).
const bootHero = {
  id: 'hero', character: 'Брам', name: 'Игрок', role: 'Жрец · ур. 1', characterClass: 'cleric', level: 1, hp: 11, maxHp: 11, armor: 18, speed: 25,
  proficiency: 2, abilities: { str: 10, dex: 14, con: 15, int: 12, wis: 16, cha: 8 }, inventory: [], x: 3, y: 2,
  knownSpellIds: ['sacred-flame', 'guidance'], preparedSpellIds: ['cure-wounds', 'bless'],
}
for (const worldTemplateId of [deadEnds.world_template_id, 'astohan-plains']) {
  try {
    const state = await new CampaignBootstrapper().create({ code: 'DEAD-ENDS', worldTemplateId, players: [bootHero] })
    addState(`boot-${worldTemplateId}`, state, ['hero'])
  } catch (error) {
    console.error('мир не создался:', worldTemplateId, error.message)
  }
}

// Снимки корпуса.
const corpusLabels = []
{
  const dir = join(corpusRoot, 'states')
  if (existsSync(dir)) {
    const names = readdirSync(dir).sort()
    let taken = 0
    for (let index = 0; index < names.length && taken < 34; index += 307) {
      const file = join(dir, names[index])
      if (statSync(file).size > 240_000) continue
      const state = JSON.parse(readFileSync(file, 'utf8'))
      const actors = (Array.isArray(state.players) ? state.players : []).map((player) => player?.id).filter((id) => typeof id === 'string').slice(0, 2)
      if (!actors.length) continue
      addState(`corpus-${names[index]}`, state, actors)
      corpusLabels.push(names[index])
      taken += 1
    }
  }
}
console.error('состояний:', states.length, 'фраз:', phrases.length, 'из тестов:', testPhrases.size)

// ============================================================================
// Детерминированные функции без состояния
// ============================================================================

const pure = phrases.map((text) => {
  const out = {}
  const run = (key, fn) => { try { out[key] = plain(fn()) } catch (error) { out[key] = { __error: errorOf(error) } } }
  run('interpret', () => fa.interpretFreeAction(text))
  run('recognized', () => fa.hasRecognizedFreeActionApproach(text))
  run('approach', () => fa.approachRequestFrom(text))
  run('corpse', () => fa.freeActionIsCorpseSearch(text))
  run('copy', () => fa.freeActionIsCopyRequest(text))
  run('passageGoal', () => fa.freeActionGoalIsPassage(text))
  run('hazardId', () => fa.canonicalEnvironmentHazardId(text))
  run('mundane', () => fa.mundaneActionOutcome(text))
  run('mundaneCtx', () => fa.mundaneActionOutcome(text, { heroName: 'Мирель', npcNames: ['Старый Финн', 'Лида', 'Ждан', 'Четвёртый'], onward: 'Скальный маяк' }))
  run('mundaneCombat', () => fa.mundaneActionOutcome(text, { inCombat: true }))
  run('fingerprint', () => fa.attemptFingerprint({ actorId: 'hero', approach: text, obstacle: text.slice(0, 20) }))
  run('travel', () => aa.cleanTravelDestination(text))
  run('detail', () => aa.cleanSuccessDetail(text))
  return { h: short(out), ...(pureFull(text) ? { out } : {}) }
})
function pureFull(text) { return phraseIndex.get(text) < 60 }

// Нормализация прочтения: мусор и почти правильные значения.
const anyValue = () => pick([
  undefined, null, '', ' ', 'wis', 'STR', 'dex', 'cha', 'perception', 'Sleight_Of_Hand', 'sleight-of-hand', 'animal_handling', 'nature', 'magic',
  'trivial', 'plausible', 'strenuous', 'impossible_without_means', 'none', 'minor', 'serious', 'deadly', 'injury', 'noise', 'exposure', 'time',
  'routine', 'stunt', 'social', 'knowledge', 'instant', 'brief', 'minutes', 'extended', 'prolonged', 'action', 'bonus_action', 'free',
  'fire', 'огонь', 'кипяток', 'lava', 'acid', 'обрыв', 'стекло', 'pit', 'hazard-fire', 'prone', 'topple_prop', 'ignite_prop', 'hazard_damage',
  0, 1, 2.5, -3, true, false, [], ['wis'], [1, 2], {}, { a: 1 }, 'a'.repeat(300), '  Цель  с  пробелами  ', 'ｗｉｓ', 'free-action-resolution/v2', 'free-action-resolution/v1',
])
const READING_KEYS = ['goal_summary', 'approach_summary', 'ability', 'skill', 'plausibility', 'risk', 'obstacle', 'required_means', 'action_cost', 'effect', 'effect_target', 'hazard', 'prop_id', 'target_id', 'item_id', 'proficiency', 'consequence_type', 'activity_kind', 'duration_class', 'source', 'policy_version']
function randomReading() {
  const reading = {}
  for (const key of READING_KEYS) {
    if (!chance(0.7)) continue
    reading[key] = key === 'required_means' && chance(0.6)
      ? Array.from({ length: int(6) }, () => pick(['верёвка', 'Верёвка', '', '  ', 'огниво', 'заклинание «Огненный снаряд»', 'rope', 'sacred-flame', 5, null, 'факел', 'факел']))
      : anyValue()
  }
  return reading
}
const normalizeCases = []
for (let index = 0; index < 600; index += 1) {
  const input = randomReading()
  const text = chance(0.3) ? '' : pick(phrases)
  const kept = plain(input)
  // Случайные аргументы выбираются заранее и записываются: Rust повторяет вызовы по ним.
  const kind = pick(['__undefined__', 'check', 'save', null])
  const passage = chance(0.5)
  const resolution = chance(0.8) ? { mode: 'check', difficulty: pick([10, 15, 20, undefined]), difficulty_category: pick(['easy', 'medium', 'hard']), difficulty_factors: ['combat_pressure', 'combat_pressure', ' x ', 7, ''] } : { mode: 'auto_success' }
  const withPolicy = chance(0.5)
  const minutes = pick([0, 1, 2, 5, 11, 12, 21, 22, 25, 101, 111, 1.7, -3, 'x', null, '__undefined__', 1e6])
  const damage = pick(['fire', 'FIRE', 'cold', 'psychic', 'unknown', '', null, '__undefined__', 3])
  const arg = (value) => (value === '__undefined__' ? undefined : value)
  const out = {}
  const run = (key, fn) => { try { out[key] = plain(fn()) } catch (error) { out[key] = { __error: errorOf(error) } } }
  run('normalize', () => fa.normalizeFreeActionReading(input, text))
  run('mode', () => fa.resolutionModeFor(input))
  run('policy', () => fa.freeActionResolutionPolicy(input))
  run('failForward', () => fa.failForwardFor(input.risk, input.consequence_type))
  run('explain', () => fa.explainActionCheck(input))
  run('label', () => fa.d20CheckLabel({ kind: arg(kind), ability: input.ability, skill: input.skill }))
  run('promise', () => fa.freeActionSuccessPromise(input, { passageAvailable: passage }))
  run('promiseNo', () => fa.freeActionSuccessPromise(input))
  run('stakes', () => fa.stakesFor({ ...input, resolution, outcome_policy: withPolicy ? fa.freeActionResolutionPolicy(input) : null }))
  run('minutes', () => fa.minutesLabelRu(arg(minutes)))
  run('damage', () => fa.damageTypeLabelRu(arg(damage)))
  // Аргументы как в JS: `undefined` в JSON не попадает, поэтому входы записаны отдельно.
  normalizeCases.push({ input: kept, text, kind, passage, resolution: plain(resolution), withPolicy, minutes, damage, h: short(out), ...(index < 40 ? { out } : {}) })
}

// Средства и подтверждение.
const confirmCases = []
for (let index = 0; index < 60; index += 1) {
  const text = pick(phrases)
  const context = pick([
    null, {}, { kind: 'free_action' },
    { kind: 'free_action', action_fingerprint: createHash('sha256').update(JSON.stringify(text.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 1000))).digest('hex').slice(0, 20), reading: {}, state_version: pick([3, 3.5, '3', null, 4]) },
    { kind: 'free_action', action_fingerprint: 'wrong', reading: {}, state_version: 3 },
    { kind: 'other', action_fingerprint: 'x', reading: null, state_version: 3 },
  ])
  const version = pick([3, 4, '3', null, undefined])
  let out
  try { fa.assertFreeActionConfirmation(context, text, version); out = { ok: true } } catch (error) { out = { err: errorOf(error) } }
  confirmCases.push({ context, text, version: version === undefined ? '__undefined__' : version, out })
}

// ============================================================================
// Функции состояния
// ============================================================================

const meansProbe = ['верёвка', 'Верёвка', 'огниво', 'заклинание «Огненный снаряд»', 'Священное пламя', 'заговор «Священное пламя»', 'sacred-flame', 'меч', 'Факел', 'умение «Второе дыхание»', 'боевой стиль «Защита»', 'атлетика', 'athletics', 'несуществующее', '']

function stateBundle(state, actorId, text) {
  const out = {}
  const run = (key, fn) => { try { out[key] = plain(fn()) } catch (error) { out[key] = { __error: errorOf(error) } } }
  const interp = fa.interpretFreeAction(text)
  let bound = null
  try { bound = fa.bindFreeActionReadingToState(state, actorId, text, interp) } catch { bound = null }
  run('harmless', () => fa.harmlessFreeActionReading(state, actorId, text))
  run('roleplay', () => fa.roleplaySpeechReading(state, text))
  run('bound', () => fa.bindFreeActionReadingToState(state, actorId, text, interp))
  run('preserved', () => fa.bindFreeActionReadingToState(state, actorId, text, { ...interp, policy_version: 'free-action-resolution/v1', target_id: 'ally' }, { preserveActionProfile: true }))
  const reading = bound ?? interp
  run('contextual', () => fa.contextualResolutionFor(state, actorId, reading, text))
  run('contact', () => fa.resolveHazardContact(state, actorId, text, reading))
  run('contactRaw', () => fa.resolveHazardContact(state, actorId, text, { risk: 'deadly', target_id: 'x' }))
  run('transfer', () => fa.resolveInventoryTransfer(state, actorId, text, reading))
  run('exploration', () => fa.resolveExplorationCommand(state, actorId, text))
  run('approachPlan', () => fa.freeActionApproachPlan(state, actorId, text))
  run('pickpocket', () => fa.resolvePickpocket(state, actorId, text, reading))
  run('corpse', () => fa.resolveCorpseSearch(state, actorId, text, reading))
  run('passage', () => fa.freeActionPassagePlan(state, actorId, text))
  run('passageDestination', () => fa.freeActionPassageDestination(state, actorId, text))
  run('place', () => fa.passageDestinationPlace(state, text))
  run('means', () => fa.verifyMeans(state, actorId, reading.required_means))
  run('hazardNear', () => fa.confirmedHazardNear(state, actorId, reading.hazard || 'fire'))
  run('policy', () => fa.freeActionResolutionPolicy(reading))
  return out
}

const stateCases = []
const perState = []
for (const [stateIndex, { label, state, actors }] of states.entries()) {
  const corpus = label.startsWith('corpus-')
  const own = corpus
    ? [...realPhrases.filter(() => chance(0.25)), ...synthetic.filter(() => chance(0.1)), ...[...testPhrases].filter(() => chance(0.03))]
    : [...synthetic, ...[...testPhrases].filter(() => chance(0.5)), ...realPhrases.filter(() => chance(0.3))]
  const unique = [...new Set(own)].filter((text) => phraseIndex.has(text))
  for (const actorId of actors) {
    const texts = actorId === actors[0] ? unique : unique.filter(() => chance(0.3))
    for (const text of texts) {
      const out = stateBundle(state, actorId, text)
      const hashes = Object.fromEntries(Object.entries(out).map(([key, value]) => [key, short(value)]))
      stateCases.push({ s: stateIndex, a: actorId, t: phraseIndex.get(text), h: hashes, ...(stateCases.length < 30 ? { out } : {}) })
    }
  }
  // Сводка состояния.
  const actorId = actors[0]
  const summary = {}
  const run = (key, fn) => { try { summary[key] = plain(fn()) } catch (error) { summary[key] = { __error: errorOf(error) } } }
  run('description', () => aa.knownSceneDescription(state))
  run('situation', () => fa.situationFingerprint(state))
  run('previous', () => fa.previousFailedAttempt(state, 'x'))
  run('means', () => fa.verifyMeans(state, actorId, meansProbe))
  run('meansNone', () => fa.verifyMeans(state, actorId, null))
  run('revealed', () => { const test = aa.revealedPropPredicate(state); return (Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []).map((prop) => test(prop)) })
  run('lootApproach', () => {
    let containers = []
    try { containers = lootContainersInScene(state, { includeEmptied: true }) } catch { containers = [] }
    return [...containers, { x: 1.5, y: 2 }, { x: 'a' }, {}].map((container) => fa.lootApproachDestination(state, actorId, container))
  })
  run('briefs', () => [
    aa.adjudicationBrief(state, actorId, 'Осматриваюсь'),
    aa.adjudicationBrief(state, actorId, 'Поджигаю сено', { recent: [{ question: 'Можно?', answer: 'Да' }], action: 'Поджигаю', request_kind: 'question' }),
  ].map((brief) => short(brief)))
  perState.push({ h: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, short(value)])), ...(stateIndex < 4 || label.startsWith('loot') ? { out: summary } : {}) })
}

// Полный бриф — для первых состояний.
const briefFull = states.slice(0, 3).map(({ state, actors }) => aa.adjudicationBrief(state, actors[0], 'Осматриваюсь'))

// ============================================================================
// Арбитр с моделью
// ============================================================================

function recordedCall(method, input, options, index) {
  const copy = plain(input)
  for (const message of copy?.messages ?? []) {
    if (message?.role === 'system') message.content = `sha256:${createHash('sha256').update(String(message.content)).digest('hex')}`
    if (message?.role === 'user' && index >= 6) message.content = `sha256:${createHash('sha256').update(String(message.content)).digest('hex')}`
  }
  return { method, input: copy, options: plain(options ?? {}) }
}
function scriptedClient(replies, index) {
  const calls = []
  let cursor = 0
  return {
    calls,
    async completeJson(input, options) {
      calls.push(recordedCall('completeJson', input, options, index))
      const reply = replies[cursor++]
      if (!reply) throw new Error('Сценарий модели закончился')
      if (reply.error) throw Object.assign(new Error(reply.error.message ?? 'отказ'), reply.error.code ? { code: reply.error.code } : {})
      return structuredClone(reply.value)
    },
  }
}

const baseReply = {
  goal_summary: 'Отвлечь стражу', approach_summary: 'Шумом переключить внимание', obstacle: 'стража',
  ability: 'cha', skill: 'performance', plausibility: 'plausible', risk: 'minor', action_cost: 'action',
  effect: 'none', proficiency: 'none', consequence_type: 'noise',
}
function repliesFor(state, actorId) {
  const brief = aa.adjudicationBrief(state, actorId, 'x')
  const other = brief.participants.find((entry) => entry.id !== actorId)?.id ?? 'ghost'
  const npc = brief.participants.find((entry) => entry.side === 'npc')?.id ?? 'ghost-npc'
  const ignitable = brief.scene_props.find((entry) => entry.verbs.includes('ignite'))?.id ?? 'no-prop'
  const topplable = brief.scene_props.find((entry) => entry.verbs.includes('topple'))?.id ?? 'no-prop'
  const item = brief.hero.inventory[0]?.id ?? 'no-item'
  return [
    { label: 'valid', value: baseReply },
    { label: 'valid-full', value: { ...baseReply, activity_kind: 'stunt', duration_class: 'brief', required_means: ['верёвка'], effect_target: '', hazard: '', prop_id: '', target_id: '', item_id: '' } },
    { label: 'extra-field', value: { ...baseReply, dc: 12 } },
    { label: 'missing-goal', value: { ...baseReply, goal_summary: '  ' } },
    { label: 'bad-skill', value: { ...baseReply, skill: 'magic' } },
    { label: 'skill-underscore', value: { ...baseReply, skill: 'Sleight_Of_Hand', ability: 'dex' } },
    { label: 'bad-means', value: { ...baseReply, required_means: ['ok', ''] } },
    { label: 'bad-hazard', value: { ...baseReply, hazard: 'lava' } },
    { label: 'hazard-fire', value: { ...baseReply, hazard: 'fire', effect: 'hazard_damage', effect_target: other } },
    { label: 'unknown-target', value: { ...baseReply, target_id: 'ghost' } },
    { label: 'unknown-effect-target', value: { ...baseReply, effect: 'distract', effect_target: 'ghost' } },
    { label: 'known-target', value: { ...baseReply, effect: 'distract', target_id: other, effect_target: other } },
    { label: 'unknown-item', value: { ...baseReply, item_id: 'ghost-item' } },
    { label: 'known-item', value: { ...baseReply, item_id: item } },
    { label: 'unknown-prop', value: { ...baseReply, effect: 'ignite_prop', prop_id: 'ghost-prop' } },
    { label: 'prop-no-intent', value: { ...baseReply, effect: 'none', prop_id: ignitable } },
    { label: 'ignite', value: { ...baseReply, effect: 'ignite_prop', prop_id: ignitable, ability: 'dex', skill: 'sleight-of-hand' } },
    { label: 'topple', value: { ...baseReply, effect: 'topple_prop', prop_id: topplable, ability: 'str', skill: 'athletics' } },
    { label: 'topple-wrong-verb', value: { ...baseReply, effect: 'topple_prop', prop_id: ignitable } },
    { label: 'ignite-no-prop', value: { ...baseReply, effect: 'ignite_prop' } },
    { label: 'route-travel', value: { ...baseReply, route: 'travel', destination: '«Старая мельница» [на холме]' } },
    { label: 'route-travel-bad', value: { ...baseReply, route: 'travel', destination: '1' } },
    { label: 'route-talk', value: { ...baseReply, route: 'talk', npc_hint: npc } },
    { label: 'route-talk-unknown', value: { ...baseReply, route: 'talk', npc_hint: 'nobody' } },
    { label: 'route-clarify', value: { ...baseReply, route: 'clarify' } },
    { label: 'route-bad', value: { ...baseReply, route: 'fly' } },
    { label: 'route-check', value: { ...baseReply, route: 'check', destination: 'x' } },
    { label: 'details', value: { ...baseReply, success_detail: 'Под доской лежит старая медная пряжка', surface_detail: 'Доски скрипят под ногами у двери', failure_detail: 'Доски скрипят под ногами у двери' } },
    { label: 'details-mechanics', value: { ...baseReply, success_detail: 'Успех: СЛ 15 и урон 1d6', surface_detail: 'коротко', failure_detail: 'x'.repeat(250) } },
    { label: 'details-same', value: { ...baseReply, success_detail: 'На полу видны свежие царапины!', surface_detail: 'На полу видны свежие царапины!', failure_detail: '{Тень} <мелькнула> [за] окном»' } },
    { label: 'detail-too-long', value: { ...baseReply, success_detail: 'x'.repeat(301) } },
    { label: 'detail-not-string', value: { ...baseReply, success_detail: 5 } },
    { label: 'null', value: null },
    { label: 'array', value: [baseReply] },
    { label: 'string', value: 'не JSON' },
    { label: 'error-code', error: { code: 'LLM_TIMEOUT', message: 'таймаут' } },
    { label: 'error-plain', error: { message: 'сеть' } },
  ]
}

const readCases = []
const readStates = states.map((entry, index) => ({ ...entry, index })).filter((entry, index) => !entry.label.startsWith('corpus-') || index % 4 === 0)
let callIndex = 0
for (const { state, actors, index } of readStates) {
  const actorId = actors[0]
  const replies = repliesFor(state, actorId)
  const texts = ['Отвлекаю стражу шумом', pick(realPhrases), pick(synthetic), 'Поджигаю сено факелом']
  for (const [replyIndex, reply] of replies.entries()) {
    const text = texts[replyIndex % texts.length]
    const fallback = fa.interpretFreeAction(text)
    const dialogue = replyIndex % 5 === 0 ? { recent: [{ question: 'Можно ли?', answer: 'Попробуй' }], action: text, request_kind: 'question' } : {}
    const client = scriptedClient([reply], callIndex)
    const adjudicator = new aa.ActionAdjudicator({ llmClient: client, ...(replyIndex % 7 === 3 ? { timeoutMs: 5_000 } : {}), ...(replyIndex === 2 ? { systemPrompt: 'Подменённый контракт' } : {}) })
    let out
    try { out = { ok: plain(await adjudicator.read(state, actorId, text, fallback, dialogue)) } } catch (error) { out = { err: errorOf(error) } }
    readCases.push({
      s: index, a: actorId, t: phraseIndex.get(text) ?? null, text, label: reply.label, reply, fallback: plain(fallback), dialogue,
      timeout: replyIndex % 7 === 3 ? 5_000 : null, systemPrompt: replyIndex === 2 ? 'Подменённый контракт' : null,
      calls: client.calls, ...out,
    })
    callIndex += 1
  }
  // Без модели.
  const text = pick(phrases)
  const fallback = fa.interpretFreeAction(text)
  let out
  try { out = { ok: plain(await new aa.ActionAdjudicator().read(state, actorId, text, fallback)) } } catch (error) { out = { err: errorOf(error) } }
  readCases.push({ s: index, a: actorId, t: phraseIndex.get(text) ?? null, text, label: 'no-client', reply: null, fallback: plain(fallback), dialogue: {}, timeout: null, systemPrompt: null, calls: [], ...out })
}

// Обсуждение способа.
const questions = [
  'Что будет, если я подожгу стог?', 'Что будет, если подожгу сено?', 'Можно ли опрокинуть шкаф?', 'Можно ли открыть дверь?', 'А если я сяду на костёр?',
  'Могу ли я перепрыгнуть пропасть?', 'Что если я врежусь в стену?', 'Если я не сяду на костёр?', 'Подойти к Лиде?', 'Что если подойти к бочкам?',
  'Можно ли поджечь факелом?', 'Если я взберусь на крышу?', 'Что если закрыть дверь?', 'Могу ли я вспомнить, что известно о культе?', 'А если я сделаю что-то?',
  'Что будет, если я сяду жопой на огонь?', 'А если я подожгу сено?', 'Можно ли опрокинуть шкаф на гоблина?', 'А если поджечь бочку?',
]
const discussCases = []
const discussStates = states.map((entry, index) => ({ ...entry, index })).filter((entry, index) => !entry.label.startsWith('corpus-') || index % 6 === 0)
for (const { state, actors, index } of discussStates) {
  const actorId = actors[0]
  for (const [questionIndex, question] of questions.entries()) {
    const variant = questionIndex >= 16 ? 4 + (questionIndex % 2) : questionIndex % 4
    const props = aa.adjudicationBrief(state, actorId, question).scene_props
    const propFor = (verb) => props.find((entry) => entry.verbs.includes(verb))?.id ?? ''
    const reply = variant === 4 ? { value: { ...baseReply, effect: 'ignite_prop', prop_id: propFor('ignite') } }
      : variant === 5 ? { value: { ...baseReply, effect: 'topple_prop', prop_id: propFor('topple') } }
        : variant === 1 ? { error: { message: 'нет' } } : { value: { ...baseReply, ...(variant === 2 ? { plausibility: 'impossible_without_means' } : {}), ...(variant === 3 ? { risk: 'none', required_means: ['волшебная палочка'] } : {}) } }
    const client = variant === 0 && questionIndex % 8 === 0 ? null : scriptedClient([reply], 99)
    const options = questionIndex === 4
      ? { check: { label: 'Сила (Атлетика)', difficulty: 15, ability: 'str', skill: 'athletics', proposal: { cost: 'действие', on_success: 'Получится.', on_failure: 'Не выйдет.' } } }
      : questionIndex === 5 ? { check: { label: 'Проверка', difficulty: 10 } }
        : { action: questionIndex % 3 ? 'Поджигаю стог' : '', recent: questionIndex % 2 ? [{ question: 'А можно?', answer: 'Да' }] : [] }
    let out
    try { out = { ok: plain(await new aa.ActionAdjudicator({ llmClient: client }).discuss(state, actorId, question, options)) } } catch (error) { out = { err: errorOf(error) } }
    discussCases.push({ s: index, a: actorId, question, reply: client ? reply : null, options, calls: client?.calls ?? [], ...out })
  }
}

const fixture = {
  promptVersion: aa.ACTION_ADJUDICATOR_PROMPT_VERSION,
  promptSha: createHash('sha256').update(readFileSync(new URL('prompts/action_adjudicator/v10.txt', root), 'utf8')).digest('hex'),
  phrases,
  pure,
  normalizeCases,
  confirmCases,
  states: states.map(({ label, state, actors }) => ({ label, state, actors })),
  stateCases,
  perState,
  briefFull,
  readCases,
  discussCases,
}
const json = JSON.stringify(fixture)
const packed = gzipSync(json, { level: 9 })
writeFileSync(new URL('./a3.json.gz', import.meta.url), packed)
console.error(`a3.json.gz: ${(packed.length / 1024 / 1024).toFixed(2)} МБ (JSON ${(json.length / 1024 / 1024).toFixed(1)} МБ); случаев: состояние×фраза ${stateCases.length}, арбитр ${readCases.length}, обсуждение ${discussCases.length}`)
