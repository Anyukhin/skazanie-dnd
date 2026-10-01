import { worldClockForAgents, weatherConditionLabel, weatherConditionSummary, dayPhaseLabel, DAY_PHASES, weatherOnDay, campaignDayOf, BIOME_WEATHER_WEIGHTS } from './weather.mjs'
import { worldLocationById } from './world-map.mjs'
import { presentSceneNpcs } from './npc-positioning.mjs'
import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'

/**
 * Физический канон сцены: одна серверная сводка того, **что сейчас вокруг**
 * отряда — час и время суток, погода, свет, крыша над головой, сырость
 * поверхностей, материалы, вид места и кто виден.
 *
 * Зачем отдельный модуль. До него каждый агент получал свой кусок сцены:
 * Рассказчик — `world_clock` и настроение, автор кампании — ничего, а
 * сенсорные якоря выбирались по названию места без оглядки на небо. Живой
 * замер 2026-10-01 поймал два расхождения: пролог «Аквилон встречает ночь
 * туманом» при часах «Утро, 08:00» и «покрытый пылью» мокрый причал в тумане.
 * Ни одно из них не было механикой, поэтому `verifyNarration` их не видел.
 *
 * Устройство:
 * 1. Канон **выводится**, а не хранится. Час и погода — из `weather.mjs`
 *    (`worldClockForAgents`), крыша — из зоны клетки героя, материалы и вода —
 *    из открытых клеток тактической карты, вид места — из карты мира. Своего
 *    состояния у модуля нет, replay его воспроизводит по построению.
 * 2. Канон — для глаз игрока: в нём только открытые клетки и NPC без пометок
 *    `gm_only` / `npc_private`. Поэтому его можно класть в NarrationBrief.
 * 3. Проверка противоречий (`sceneCanonContradictions`) — узкая и
 *    консервативная: она ловит только прямые утверждения о текущем часе, небе
 *    и сухости, пропуская речь в кавычках, сравнения, отрицания и фразы о
 *    другом времени. Это bounded guard, а не семантический классификатор:
 *    пропустить противоречие дешевле, чем отбросить честный текст.
 *
 * Модуль — лист: импортирует только детерминированные модули мира и ничего,
 * что знает о моделях или проверке повествования.
 */

export const SCENE_CANON_VERSION = 'scene-canon/v1'
export const SCENE_CANON_CONTRADICTION = 'SCENE_CANON_CONTRADICTION'

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

const LOCATION_KIND_LABELS = Object.freeze({
  capital: 'столица', city: 'город', town: 'городок', village: 'деревня', port: 'порт',
  fortress: 'крепость', ruin: 'руины', dungeon: 'подземелье', landmark: 'примечательное место', wilds: 'дикие земли',
})

const MATERIAL_LABELS = Object.freeze({
  stone: 'камень', wood: 'дерево', earth: 'земля', grass: 'трава', sand: 'песок', marble: 'мрамор', metal: 'металл', ice: 'лёд',
})

/**
 * Слова, по которым место узнаётся как стоящее у воды. Список закрытый и
 * короткий: «мост» сюда намеренно не входит — мост бывает и над сухим оврагом.
 */
const WATER_PLACE_PATTERN = /(?<!\p{L})(?:причал\p{L}*|пристан\p{L}*|порт(?:а|у|ом|е|ы|ов|овый|овая|овое|овом|овой|овые|овых)?|гаван\p{L}*|берег\p{L}*|набережн\p{L}*|пирс\p{L}*|верф\p{L}*|док(?:а|и|ов|ах)?|рек(?:а|и|е|у|ой)|речн\p{L}*|озер\p{L}*|озёр\p{L}*|болот\p{L}*|топ(?:ь|и|ью)|пруд\p{L}*|залив\p{L}*|бухт\p{L}*|канал\p{L}*|мор(?:е|я|ю|ем)|морск\p{L}*|прибо\p{L}*|волнорез\p{L}*|harbor|harbour|pier|dock|river|coast|shore|marsh|lake)(?!\p{L})/iu

const HIDDEN_VISIBILITY = new Set(['gm_only', 'gmonly', 'npc_private', 'npcprivate'])

function viewerOf(viewer = {}) {
  return {
    playerId: text(viewer.playerId ?? viewer.player_id ?? viewer.viewerId ?? viewer.userId ?? '', 120),
    actorId: text(viewer.actorId ?? viewer.actor_id ?? viewer.heroId ?? viewer.playerId ?? viewer.player_id ?? '', 120),
  }
}

/** Видна ли запись игроку. Канон не раскрывает закрытого даже ведущему: он уходит в тексты для стола. */
function recordVisibleTo(record, viewer) {
  if (!record || typeof record !== 'object') return false
  if (record.hidden === true || record.secret === true) return false
  const visibility = text(record.visibility ?? record.visibility_level ?? 'public', 40).toLowerCase()
  if (HIDDEN_VISIBILITY.has(visibility)) return record.reveal_on_presence === true
  if (visibility === 'specific_player') {
    const allowed = [record.player_id, record.playerId, record.owner_id, ...(Array.isArray(record.visible_to) ? record.visible_to : [])].map((id) => text(id, 120))
    return Boolean(viewer.playerId) && allowed.includes(viewer.playerId)
  }
  return true
}

function tacticalMapOf(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || !rawMap.layers) return null
  try {
    return ArrayBuffer.isView(rawMap.layers.material) ? rawMap : deserializeTacticalMap(rawMap)
  } catch {
    return null
  }
}

/**
 * Материалы и вода по **открытым** клеткам карты: закрытая часть подземелья
 * не должна подсказывать Рассказчику, что за стеной лежит озеро.
 */
function mapSurfaceFacts(rawMap) {
  const map = tacticalMapOf(rawMap)
  if (!map || !Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height)) return { materials: [], water: false }
  const counts = new Map()
  let revealed = 0
  let water = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell?.revealed) continue
      revealed += 1
      counts.set(cell.material, (counts.get(cell.material) ?? 0) + 1)
      if (cell.surface === 'water') water += 1
    }
  }
  if (!revealed) return { materials: [], water: false }
  const materials = [...counts.entries()]
    .filter(([, count]) => count / revealed >= 0.1)
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, 3)
    .map(([material]) => MATERIAL_LABELS[material] ?? '')
    .filter(Boolean)
  return { materials, water: water / revealed >= 0.02 || water >= 6 }
}

function lightFor({ indoors, phase, weather }) {
  if (indoors) {
    if (phase === 'night') return { level: 'interior_dark', label: 'под крышей; светят только очаг, лампы и свечи' }
    if (phase === 'evening') return { level: 'interior_dim', label: 'под крышей; за окнами сумерки, светят очаг и лампы' }
    return { level: 'interior', label: 'под крышей; дневной свет лишь из окон и проёмов' }
  }
  const covered = ['rain', 'storm'].includes(weather)
  if (phase === 'night') {
    if (weather === 'clear') return { level: 'dark', label: 'ночная темнота; светят луна и звёзды' }
    if (weather === 'fog') return { level: 'dark', label: 'кромешная темнота; туман глушит редкие огни' }
    return { level: 'dark', label: 'кромешная темнота; луну и звёзды скрывает небо' }
  }
  if (phase === 'evening') {
    return covered || weather === 'fog'
      ? { level: 'dusk', label: 'ранние сумерки под тяжёлым небом' }
      : { level: 'dusk', label: 'вечерние сумерки, длинные тени' }
  }
  if (weather === 'fog') return { level: 'dim', label: 'рассеянный серый свет; туман скрадывает всё дальше десятка шагов' }
  if (covered) return { level: 'dim', label: 'серый сумрак под тучами' }
  if (weather === 'overcast') return { level: 'daylight', label: phase === 'morning' ? 'ровный серый утренний свет' : 'ровный серый свет без резких теней' }
  return { level: 'daylight', label: phase === 'morning' ? 'утренний свет, низкое солнце' : 'яркий дневной свет' }
}

function wetnessFor({ indoors, weather, waterNearby }) {
  if (indoors) return { wetness: 'sheltered', label: 'под крышей сухо' }
  if (weather === 'rain' || weather === 'storm') return { wetness: 'wet', label: 'мокро: дождь мочит землю, дерево и камень' }
  if (weather === 'fog') return { wetness: 'damp', label: 'сыро: туман оседает влагой на дереве, камне и одежде' }
  if (waterNearby) return { wetness: 'dry', label: 'сухо, но у кромки воды доски и камни влажные' }
  return { wetness: 'dry', label: 'сухо' }
}

function canonSummary(canon) {
  const parts = []
  if (canon.time.phase_label) parts.push(`${canon.time.phase_label}${canon.time.clock ? `, ${canon.time.clock}` : ''}.`)
  if (canon.weather.label) parts.push(`Погода: ${canon.weather.label.toLocaleLowerCase('ru')}${canon.weather.summary ? ` — ${canon.weather.summary.toLocaleLowerCase('ru')}` : '.'}`)
  if (canon.indoors === true) parts.push('Под крышей.')
  else if (canon.indoors === false) parts.push('Под открытым небом.')
  if (canon.light.label) parts.push(`Свет: ${canon.light.label}.`)
  if (canon.surfaces.label) parts.push(`Поверхности: ${canon.surfaces.label}.`)
  if (canon.surfaces.water_nearby) parts.push('Рядом вода.')
  if (canon.surfaces.materials.length) parts.push(`Материалы вокруг: ${canon.surfaces.materials.join(', ')}.`)
  if (canon.location.name) parts.push(`Место: «${canon.location.name}»${canon.location.kind_label ? `; на карте мира — ${canon.location.kind_label}` : ''}.`)
  const present = [...canon.present.heroes, ...canon.present.npcs]
  if (present.length) parts.push(`На виду: ${present.join(', ')}.`)
  return parts.join(' ').replace(/\.\./gu, '.').slice(0, 900)
}

function assembleCanon({ time, weatherId, indoors, location, waterNearby, materials, present }) {
  const light = lightFor({ indoors, phase: time.phase, weather: weatherId })
  const surfaces = wetnessFor({ indoors, weather: weatherId, waterNearby })
  const canon = {
    version: SCENE_CANON_VERSION,
    location,
    time,
    weather: { id: weatherId, label: weatherConditionLabel(weatherId), summary: weatherConditionSummary(weatherId) },
    indoors,
    light,
    surfaces: { wetness: surfaces.wetness, label: surfaces.label, water_nearby: Boolean(waterNearby), materials },
    present,
  }
  canon.summary = canonSummary(canon)
  return canon
}

/**
 * Канон сцены для зрителя.
 *
 * @param {object} state — авторитетное состояние кампании
 * @param {{playerId?: string, actorId?: string}} [viewer] — чьими глазами; крыша
 *   считается по клетке его героя
 */
export function sceneCanonFor(state = {}, viewer = {}) {
  const who = viewerOf(viewer)
  const clock = worldClockForAgents(state, who.actorId || null)
  const scene = state?.scene ?? {}
  const node = worldLocationById(state?.worldMap, text(state?.worldMap?.currentLocationId, 120))
  const region = (Array.isArray(state?.worldMap?.regions) ? state.worldMap.regions : [])
    .find((entry) => text(entry?.id, 120) === text(node?.regionId, 120))
  const kind = text(node?.kind, 40)
  const name = text(scene.location || scene.title || node?.name, 160)
  const facts = mapSurfaceFacts(scene.map)
  const placeWords = [scene.location, scene.title, scene.theme, scene.mood, node?.name].map((value) => text(value, 300)).join(' ')
  const waterNearby = facts.water || kind === 'port' || WATER_PLACE_PATTERN.test(placeWords)
  const heroes = (Array.isArray(state?.players) ? state.players : [])
    .filter((hero) => hero && hero.alive !== false && recordVisibleTo(hero, who))
    .map((hero) => text(hero.character || hero.name, 80))
    .filter(Boolean)
    .slice(0, 8)
  let npcs = []
  try {
    npcs = presentSceneNpcs(state)
      .filter((npc) => recordVisibleTo(npc, who))
      .map((npc) => text(npc.name, 80))
      .filter(Boolean)
      .slice(0, 8)
  } catch { npcs = [] }
  const creatures = (Array.isArray(state?.enemies) ? state.enemies : [])
    .filter((enemy) => enemy && enemy.alive !== false && Number(enemy.hp ?? 1) > 0 && recordVisibleTo(enemy, who))
    .map((enemy) => text(enemy.name, 80))
    .filter(Boolean)
    .slice(0, 8)
  return assembleCanon({
    time: { day: clock.day, clock: clock.clock, phase: clock.time_of_day, phase_label: clock.time_of_day_label },
    weatherId: clock.weather,
    indoors: Boolean(clock.indoors),
    location: {
      name,
      kind,
      kind_label: LOCATION_KIND_LABELS[kind] ?? '',
      region: text(region?.name, 120),
      biome: text(region?.biome, 40),
    },
    waterNearby,
    materials: facts.materials,
    present: { heroes, npcs, creatures },
  })
}

/**
 * Канон из уже собранного `known_environment`. Нужен там, где brief построен
 * без `scene_canon` (старые точки сборки, тесты, трассы): `world_clock` в нём
 * есть с 2026-09, и этого хватает для времени суток, погоды и крыши.
 * Возвращает `null`, если в окружении нет даже часов.
 */
export function sceneCanonFromEnvironment(environment = {}) {
  const stored = environment?.scene_canon
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && stored.time && stored.weather) return stored
  const clock = environment?.world_clock
  if (!clock || typeof clock !== 'object' || !clock.time_of_day) return null
  const scene = environment?.scene ?? {}
  const areaIndoors = scene?.spatial_context?.current_area?.indoors
  const indoors = typeof areaIndoors === 'boolean' ? areaIndoors : Boolean(clock.indoors)
  const placeWords = [scene.location, scene.title, scene.theme, scene.mood].map((value) => text(value, 300)).join(' ')
  const story = environment?.story_context ?? {}
  return assembleCanon({
    time: {
      day: clock.day ?? null,
      clock: text(clock.clock, 8),
      phase: text(clock.time_of_day, 20),
      phase_label: text(clock.time_of_day_label, 40) || dayPhaseLabel(clock.time_of_day),
    },
    weatherId: text(clock.weather, 20),
    indoors,
    location: { name: text(scene.location || scene.title, 160), kind: '', kind_label: '', region: '', biome: '' },
    waterNearby: WATER_PLACE_PATTERN.test(placeWords),
    materials: [],
    present: {
      heroes: (Array.isArray(story.heroes) ? story.heroes : []).map((hero) => text(hero?.name, 80)).filter(Boolean).slice(0, 8),
      npcs: (Array.isArray(story.present_npcs) ? story.present_npcs : []).map((npc) => text(npc?.name, 80)).filter(Boolean).slice(0, 8),
      creatures: [],
    },
  })
}

/**
 * Стартовые часы кампании и небо первого дня — для автора кампании. Погода
 * зависит от климата края, а край стартовой локации автор выбирает сам,
 * поэтому сервер отдаёт таблицу «биом → небо первого утра» из той же функции,
 * которой небо потом посчитают часы (`weatherOnDay`).
 */
export function campaignStartCanon(seed = '') {
  const time = { day: 1, clock: '08:00', phase: 'morning', phase_label: dayPhaseLabel('morning') }
  const day = campaignDayOf(0)
  const weatherByBiome = Object.fromEntries(Object.keys(BIOME_WEATHER_WEIGHTS).map((biome) => {
    const id = weatherOnDay({ seed: text(seed, 120), day, biome })
    return [biome, { id, label: weatherConditionLabel(id), summary: weatherConditionSummary(id) }]
  }))
  return { time, weather_by_biome: weatherByBiome }
}

// ---------------------------------------------------------------------------
// Проверка противоречий
// ---------------------------------------------------------------------------

const L = '\\p{L}'
const W = `(?<!${L})`
const E = `(?!${L})`
const rx = (source) => new RegExp(source, 'giu')

/** Ночь как текущее состояние, а не как слово вообще: «ночью» и «полночь» не в счёт. */
const NIGHT_PATTERNS = [
  rx(`${W}ночь${E}\\s+(?:опуска${L}*|опустил${L}*|окутыва${L}*|окутал${L}*|накрыва${L}*|накрыл${L}*|встреча${L}*|сгуща${L}*|стоит|вступа${L}*|вступил${L}*|выдал${L}*|темн${L}*|тих${L}*|холодн${L}*|чёрн${L}*|черн${L}*|глух${L}*|глубок${L}*|густ${L}*|звёздн${L}*|звездн${L}*|безлунн${L}*|лунн${L}*|укрыва${L}*|укрыл${L}*|над${E})`),
  rx(`${W}(?:тёмн|темн|глух|глубок|безлунн|лунн|звёздн|звездн|туманн|дождлив|холодн|тих|душн|ветрен|непрогляд)${L}*\\s+ночь${E}`),
  rx(`${W}(?:в|посреди)\\s+ночи${E}`),
  rx(`${W}(?:наступ|опусти|опуска|спусти|спуска|пришла|приходит|царит|сгусти|сгуща|встреча|окутал|окутыва|накрыл|накрыва)${L}*\\s+(?:${L}+\\s+)?ночь${E}`),
  rx(`${W}ночн(?:ой|ая|ое|ые|ую|ым|ыми|ых|ом)\\s+(?:тьм|тиш|прохлад|мгл|темнот|мрак|неб|воздух|ветер|ветр|холод|сумрак|улиц|город|порт|причал|звёзд|звезд|огн|огон|фонар|тен|час|пор|сырост|свеж|бриз)${L}*`),
  rx(`${W}(?:темнот|тьм|мрак|мгл|тишин)${L}*\\s+ночи${E}`),
  rx(`${W}луна${E}\\s+(?:висит|светит|освеща${L}*|залива${L}*|стоит|выгляды${L}*|выглянул${L}*|серебр${L}*|плыв[её]т|поднимает${L}*|поднялась|встала|вста[её]т|сияет|проглядыва${L}*)`),
  rx(`${W}лунн(?:ый|ого|ым|ом|ая|ой|ую|ое|ые|ых|ыми)\\s+(?:свет|сиян|блик|дорожк|луч|отблеск|серебр)${L}*`),
  rx(`${W}(?:в|при|под)\\s+(?:свете|сиянии|лучах|светом)\\s+луны${E}`),
  rx(`${W}(?:звёзды|звезды)${E}\\s+(?:мерца${L}*|горят|светят|рассыпа${L}*|высыпал${L}*|сия${L}*|блест${L}*|дрож${L}*)`),
  rx(`${W}(?:звёздн|звездн)${L}*\\s+неб${L}*`),
  rx(`${W}под\\s+(?:звёздами|звездами|луной)${E}`),
]
/** Наступившая темнота: уместна вечером, но не утром и не днём. */
const DARKENING_PATTERNS = [
  rx(`${W}(?:стемнело|смеркалось|смеркается|сгустилась\\s+тьма|опустилась\\s+тьма)${E}`),
]
const DAY_PATTERNS = [
  rx(`${W}солнце${E}\\s+(?:светит|палит|слепит|печ[её]т|гре${L}*|сия${L}*|стоит|золот${L}*|залива${L}*|игра${L}*|бь[её]т|пробива${L}*|высоко|в\\s+зените|жж[её]т|отража${L}*)`),
  rx(`${W}(?:солнечн|полуденн|дневн)${L}*\\s+(?:свет|луч|блик|зайч|пятн|зно|жар|сиян)${L}*`),
  rx(`${W}(?:в|под)\\s+лучах\\s+(?:${L}+\\s+)?солнца${E}`),
  rx(`${W}под\\s+(?:палящим|жарким|ярким|полуденным|утренним|весенним|летним|осенним)\\s+солнцем${E}`),
  rx(`${W}(?:при\\s+свете\\s+дня|среди\\s+бела\\s+дня)${E}`),
  rx(`${W}(?:ясный|солнечный)\\s+день${E}`),
]
const MORNING_PATTERNS = [
  rx(`${W}рассветн${L}*`),
  rx(`${W}утренн(?:ее|ий|его|им|ем|яя|юю|ей|ие|их)\\s+(?:солнц|свет|луч|рос|прохлад|туман|воздух|тишин|холод|сумрак|дымк|зар)${L}*`),
  rx(`${W}солнце\\s+(?:вста[её]т|восходит|поднимается|взошло|встало)${E}`),
  rx(`${W}восходящ${L}*\\s+солнц${L}*`),
  rx(`${W}утро\\s+(?:встреча|выдал|наступ|разгора|стоит)${L}*`),
  rx(`${W}(?:рассвело|светает)${E}`),
]
const EVENING_PATTERNS = [
  rx(`${W}закатн${L}*`),
  rx(`${W}закат(?:а|ом|е)?${E}\\s+(?:окраш|догора|гор|але|пыла|залива|золот|багр)${L}*`),
  rx(`${W}солнце\\s+(?:садится|село|клонится|заходит|зашло|опускается|опустилось)${E}`),
  rx(`${W}заходящ${L}*\\s+солнц${L}*`),
  rx(`${W}вечерн(?:ий|его|им|ем|яя|ей|юю|ее|ие|их)\\s+(?:свет|сумрак|сумерк|солнц|туман|прохлад|тишин|воздух|тен|неб|зар|холод|мгл)${L}*`),
  rx(`${W}вечер\\s+(?:опуска|наступа|наступил|встреча|окутыва|сгуща|стоит|выдал)${L}*`),
  rx(`${W}сумерки\\s+(?:сгуща|опуска|окутыва|ложат|легли)${L}*`),
]

const RAIN_PATTERNS = [
  rx(`${W}дожд(?:ь|я|ю|ём|ем|е|и|ей|ям|ями|ях|лив${L}*)${E}`),
  rx(`${W}лив(?:ень|ня|ню|нем|нём|ни|ней|ням|нями)${E}`),
  rx(`${W}морос(?:ь|и|ью|ит|ят|ило|ящ${L}*)${E}`),
]
const HEAVY_RAIN_PATTERNS = [rx(`${W}лив(?:ень|ня|ню|нем|нём|ни|ней|ням|нями)${E}`)]
const STORM_PATTERNS = [
  rx(`${W}гроз(?:а|ы|у|е|ой|ою|ов(?:ой|ая|ое|ые|ых|ым|ую|ого|ом|ыми))${E}`),
  rx(`${W}гром(?:а|у|ом|ы)?${E}`),
  rx(`${W}громых${L}*`),
  rx(`${W}молни(?:я|и|ю|ей|ями|ях)${E}`),
]
const FOG_PATTERNS = [
  rx(`${W}туман(?:а|у|ом|е|ы|ов|ам|ами|ах)?${E}`),
]
const CLEAR_SKY_PATTERNS = [
  rx(`${W}безоблачн${L}*`),
  rx(`${W}(?:ясн|чист|голуб|лазурн)${L}*\\s+неб${L}*`),
  rx(`${W}ни\\s+(?:одного\\s+)?облачка${E}`),
  rx(`${W}(?:палящ|жарк|ярк)${L}*\\s+солнц${L}*`),
  rx(`${W}солнце\\s+(?:палит|печ[её]т|слепит|жж[её]т|сияет)${E}`),
  rx(`${W}(?:звёздн|звездн)${L}*\\s+неб${L}*`),
  rx(`${W}(?:звёзды|звезды)\\s+(?:мерца|горят|светят|сия)${L}*`),
  rx(`${W}лунн${L}*\\s+свет${L}*`),
]
/** Сухость под открытым небом. «В пыль» и «пыль веков» — обороты, а не поверхность. */
const DRY_PATTERNS = [
  rx(`${W}(?:пыльн|запылён|запылен|запыл)${L}*`),
  rx(`${W}покрыт${L}*\\s+(?:${L}+\\s+)?пылью${E}`),
  rx(`${W}пыль${E}\\s+(?:на|под|клубится|клубами|поднимается|оседает|лежит|висит|вь[её]тся|стелется|летит|столбом)${E}`),
  rx(`${W}(?:дорожн|сух|сер)${L}*\\s+пыл(?:ь|и|ью)${E}`),
  rx(`${W}(?:клубы|облако|облака|столб|слой|налёт|налет)\\s+пыли${E}`),
  rx(`${W}в\\s+пыли${E}`),
  rx(`${W}сух(?:ой|ая|ое|ие|ую|ом|их|ими|им)\\s+(?:земл|дорог|доск|камн|камен|мостов|трав|лист|песок|песк|настил|воздух|причал|палуб)${L}*`),
  rx(`${W}(?:зно(?:й|я|ю|ем|ём)|знойн${L}*|иссохш${L}*)${E}`),
]
/** Небо над головой при каноне «под крышей». */
const SKY_INDOOR_PATTERNS = [
  rx(`${W}под\\s+открытым\\s+небом${E}`),
  rx(`${W}над\\s+(?:головой|головами|ними|отрядом|героями|нами)\\s*[^.!?]{0,25}?(?:неб|звёзд|звезд|облак|туч|солнц|лун)${L}*`),
  rx(`${W}(?:небо|звёзды|звезды|облака|тучи|солнце|луна)\\s+над\\s+(?:головой|головами|ними|отрядом|героями)${E}`),
  rx(`${W}(?:солнце|ветер|дождь|ливень)\\s+(?:бь[её]т|хлещ${L}*|печ[её]т|сеч[её]т|треплет|рв[её]т|заливает|мочит|слепит)\\s+(?:в|по)\\s+(?:лиц|глаз|плеч|спин|голов|затыл|волос)${L}*`),
]

/** Фраза о другом времени, о возможном или о чужих словах. */
const SHIFTED_SENTENCE = new RegExp(`${W}(?:вчера${L}*|позавчера|накануне|прошл${L}*|минувш${L}*|давн${L}*|когда-то|некогда|раньше|прежде|помн${L}*|вспомина${L}*|вспомн${L}*|воспоминан${L}*|снил${L}*|снится|сне|сон|сны|снах|завтра|скоро|вскоре|позже|потом|будет|будут|станет|наступит|придёт|придет|ждать|жд[её]т|ожида${L}*|обеща${L}*|если|бы|словно|будто|точно|подобно|казалось|кажется|мерещ${L}*|рассказ${L}*|говорят|слух${L}*|легенд${L}*|песн${L}*|картин${L}*|гобелен${L}*|фреск${L}*|рисун${L}*|изображ${L}*|назад|ранее|недавн${L}*|прогноз${L}*|примет${L}*)${E}`, 'iu')
/** Отрицание или сравнение прямо перед словом. */
const NEGATED_PREFIX = /(?:^|[^\p{L}])(?:не|нет|ни|без|вместо|как|словно|будто|точно|никак\p{L}*|ничуть|нисколько)(?:\s+\p{L}+)?\s*$/iu
/** Слово о другом времени прямо перед упоминанием: «после ночи», «до заката». */
const SHIFTED_TIME_PREFIX = /(?:^|[^\p{L}])(?:после|до|к|ко|за|всю|целую|этой|той|прошлой|минувшей|вчерашн\p{L}*|с|со|через|позади|остат\p{L}*|конец|конца|исход\p{L}*|перед)(?:\s+\p{L}+)?\s*$/iu
/**
 * То же для неба, но короче: «за окном дождь» и «укрылись от дождя» — нынешняя
 * погода, а «после дождя» и «перед грозой» — другая. Запах и приметы
 * («пахнет дождём», «собирается гроза») обещают, а не утверждают.
 */
const SHIFTED_WEATHER_PREFIX = /(?:^|[^\p{L}])(?:после|до|к|перед|пахн\p{L}*|запах\p{L}*|аромат\p{L}*|предвещ\p{L}*|предчув\p{L}*|собира\p{L}*|грозит|сулит)(?:\s+\p{L}+)?\s*$/iu
/** «Туман рассеивается», «дождь кончился» — прошедшее, а не нынешнее небо. */
const ENDING_SUFFIX = /^[^.!?]{0,30}?(?<!\p{L})(?:кончил\p{L}*|закончил\p{L}*|прекратил\p{L}*|стих\p{L}*|утих\p{L}*|перестал\p{L}*|прош[её]л|прошла|прошли|прошло|рассе\p{L}*|отступ\p{L}*|ушёл|ушел|ушла|ушли|улёгся|улегся|развеял\p{L}*|раста\p{L}*|минова\p{L}*|позади|сменил\p{L}*|сменя\p{L}*|уступ\p{L}*|отош\p{L}*|кончается|заканчива\p{L}*|на\s+исходе|реде\p{L}*|тает|таял\p{L}*|схлынул\p{L}*|оставил\p{L}*)(?!\p{L})/iu
/** «Туман в голове», «как в тумане» — о сознании, не о погоде. */
const MIND_CONTEXT = /(?:голов|глаз|мысл|памят|сознан|душ|сердц)\p{L}*/iu
/** «Дождя нет», «тумана не видно» — отрицание после слова. */
const NEGATED_SUFFIX = /^\s*,?\s*(?:нет|не\s+было|не\s+видно|не\s+слышно|ни\s+капли)(?!\p{L})/iu
/**
 * «Ночной дождь съел края следов» в восемь утра — вчерашняя погода, а не
 * нынешняя: прилагательное времени суток при слове о небе, не совпадающее с
 * часами, переносит фразу в другое время.
 */
const WEATHER_TIME_ADJECTIVE = /(?:^|[^\p{L}])(ночн|утренн|дневн|вечерн|вчерашн|позавчерашн)\p{L}*\s*$/iu
const WEATHER_TIME_ADJECTIVE_PHASE = Object.freeze({ ночн: 'night', утренн: 'morning', дневн: 'day', вечерн: 'evening' })
/** «Дождь держится за морем», «гроза вдали» — небо не над отрядом. */
const FAR_WEATHER_CONTEXT = /(?<!\p{L})(?:за\s+(?:морем|холмами|рекой|лесом|горами|перевалом)|вдали|вдалеке|на\s+горизонте|далеко|над\s+(?:дальн|далёк|далек)\p{L}*)(?!\p{L})/iu
/** Пыль внутри ларца, комнаты или архива сухая при любой погоде. */
const ENCLOSED_DRY_CONTEXT = /(?<!\p{L})(?:ларц\p{L}*|ларец|сундук\p{L}*|шкатулк\p{L}*|ящик\p{L}*|комнат\p{L}*|чердак\p{L}*|подвал\p{L}*|кладов\p{L}*|полк\p{L}*|полок|внутри|склеп\p{L}*|архив\p{L}*|библиотек\p{L}*|зал\p{L}*|трактир\p{L}*|таверн\p{L}*)(?!\p{L})/iu
/** Окно, проём и выход объясняют небо, увиденное из-под крыши. */
const OPENING_CONTEXT = /(?<!\p{L})(?:окн\p{L}*|окон\p{L}*|витраж\p{L}*|проём\p{L}*|проем\p{L}*|щел\p{L}*|дыр\p{L}*|пролом\p{L}*|прорех\p{L}*|снаружи|улиц\p{L}*|двер\p{L}*|порог\p{L}*|выход\p{L}*|балкон\p{L}*|двор\p{L}*|крыльц\p{L}*|крыш\p{L}*)(?!\p{L})/iu

/**
 * Речь персонажей не утверждает канона: «— Ночь будет долгой» — слова NPC.
 * Кавычки и строки-реплики вырезаются целиком.
 */
function narratorVoiceOnly(value) {
  return String(value ?? '')
    .replace(/«[^»]{0,600}»/gu, ' ')
    .replace(/“[^”]{0,600}”/gu, ' ')
    .replace(/„[^“”]{0,600}[“”]/gu, ' ')
    .replace(/"[^"]{0,600}"/gu, ' ')
    .split(/\n/u)
    .map((line) => (/^\s*[—–-]\s/u.test(line) ? ' ' : line))
    .join('\n')
}

function sentencesOf(value) {
  return value.split(/(?<=[.!?…])\s+|\n+/u).map((sentence) => sentence.trim()).filter(Boolean)
}

function clockMinute(clock) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(clock ?? ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** У границы времени суток слова соседней фазы честны: в 05:10 ещё пахнет ночью. */
const PHASE_BOUNDARY_TOLERANCE_MINUTES = 45
function nearPhaseBoundary(clock) {
  const minute = clockMinute(clock)
  if (minute == null) return false
  return DAY_PHASES.some((phase) => {
    const distance = Math.abs(minute - phase.start_minute)
    return Math.min(distance, 1_440 - distance) <= PHASE_BOUNDARY_TOLERANCE_MINUTES
  })
}

const EVENT_SKIPS = Object.freeze({
  time: /TimeOfDayChanged|Rest|Travel|Journey|WorldTime|TimeAdvanced|Sleep|Wait|Arriv/iu,
  weather: /WeatherChanged|Travel|Journey|Arriv/iu,
})
const EVENT_TOPIC_SKIPS = Object.freeze({
  storm: /гром|молни|гроз|thunder|lightning|storm|шторм/iu,
  fog: /туман|fog|mist|облак|cloud/iu,
  rain: /дожд|rain|ливн|ливен|сотворение\s+воды|create.?water/iu,
  day: /daylight|sunbeam|sunburst|dawn|дневн|солнечн|солнц|рассвет/iu,
  night: /darkness|тьм|ночн|moonbeam|лунн/iu,
  dry: /пыл|dust|песок|sand|зно/iu,
})

function phaseRules(phase) {
  if (phase === 'morning') return [['night', NIGHT_PATTERNS, 'ночь'], ['night', DARKENING_PATTERNS, 'наступившую темноту'], ['evening', EVENING_PATTERNS, 'вечер и закат']]
  if (phase === 'day') return [['night', NIGHT_PATTERNS, 'ночь'], ['night', DARKENING_PATTERNS, 'наступившую темноту']]
  if (phase === 'evening') return [['morning', MORNING_PATTERNS, 'утро и рассвет']]
  if (phase === 'night') return [['day', DAY_PATTERNS, 'солнце и дневной свет'], ['morning', MORNING_PATTERNS, 'утро и рассвет'], ['evening', EVENING_PATTERNS, 'закатное солнце']]
  return []
}

function weatherRules(weather, indoors) {
  const rules = []
  if (weather === 'clear') rules.push(['rain', RAIN_PATTERNS, 'дождь'], ['storm', STORM_PATTERNS, 'грозу'], ['fog', FOG_PATTERNS, 'туман'])
  if (weather === 'overcast') rules.push(['rain', RAIN_PATTERNS, 'дождь'], ['storm', STORM_PATTERNS, 'грозу'], ['fog', FOG_PATTERNS, 'туман'])
  if (weather === 'rain') rules.push(['storm', STORM_PATTERNS, 'грозу'])
  if (weather === 'fog') rules.push(['storm', STORM_PATTERNS, 'грозу'], ['rain', HEAVY_RAIN_PATTERNS, 'ливень'])
  if (!indoors && ['overcast', 'rain', 'storm', 'fog'].includes(weather)) rules.push(['clear', CLEAR_SKY_PATTERNS, 'ясное небо'])
  if (!indoors && ['rain', 'storm', 'fog'].includes(weather)) rules.push(['dry', DRY_PATTERNS, 'сухость и пыль'])
  return rules
}

/** Пол и свод бывают только под крышей: «сухой сквозняк у пола» на причале — чужой якорь. */
const INDOOR_ONLY_ANCHOR = /(?<!\p{L})(?:пол|пола|полу|полом|потол\p{L}*|свод\p{L}*)(?!\p{L})/iu
/** Сухость в мокрую погоду под открытым небом. */
const DRY_ANCHOR = /(?<!\p{L})(?:сух\p{L}*|пыл\p{L}*|пыль)/iu

/**
 * Почему заранее заготовленное ощущение (сенсорный якорь) не подходит канону.
 * Строже проверки повествования: якорь — не текст модели, а подсказка сервера,
 * и выбросить сомнительную подсказку ничего не стоит. Пустой список — подходит.
 *
 * @param {string} anchor
 * @param {object|null} canon
 * @returns {string[]}
 */
export function sensoryAnchorConflicts(anchor, canon) {
  if (!canon) return []
  const reasons = sceneCanonContradictions(anchor, canon).map((found) => found.kind)
  if (canon.indoors === false && INDOOR_ONLY_ANCHOR.test(anchor)) reasons.push('indoor_detail_outdoors')
  if (canon.indoors === false && ['wet', 'damp'].includes(String(canon.surfaces?.wetness ?? '')) && DRY_ANCHOR.test(anchor)) reasons.push('dry_detail_in_wet_weather')
  return reasons
}

/**
 * Прямые противоречия текста канону сцены.
 *
 * @param {string} narration
 * @param {object|null} canon — результат `sceneCanonFor` / `sceneCanonFromEnvironment`
 * @param {{events?: object[]}} [options] — видимые события хода: смена часов,
 *   путь и заклинания с туманом или молнией законно говорят о другом небе
 * @returns {{code: string, kind: string, message: string, match: string}[]}
 */
export function sceneCanonContradictions(narration, canon, { events = [] } = {}) {
  if (!canon || typeof canon !== 'object') return []
  const phase = text(canon.time?.phase, 20)
  const weather = text(canon.weather?.id, 20)
  const indoors = canon.indoors === true
  const eventList = Array.isArray(events) ? events : []
  const eventTypes = eventList.map((event) => String(event?.event_type ?? event?.eventType ?? '')).join(' ')
  let eventText = ''
  try { eventText = JSON.stringify(eventList.map((event) => event?.payload ?? {})).slice(0, 20_000) } catch { eventText = '' }

  const rules = []
  if (phase && !EVENT_SKIPS.time.test(eventTypes) && !nearPhaseBoundary(canon.time?.clock)) {
    for (const [topic, patterns, label] of phaseRules(phase)) {
      rules.push({ kind: 'time_of_day', topic, patterns, message: `Канон сцены: ${text(canon.time?.phase_label, 20).toLocaleLowerCase('ru') || phase}${canon.time?.clock ? `, ${canon.time.clock}` : ''}, а текст описывает ${label}`, shiftedPrefix: SHIFTED_TIME_PREFIX })
    }
  }
  if (weather && !EVENT_SKIPS.weather.test(eventTypes)) {
    for (const [topic, patterns, label] of weatherRules(weather, indoors)) {
      rules.push({ kind: topic === 'dry' ? 'surface' : 'weather', topic, patterns, message: `Канон сцены: ${text(canon.weather?.label, 20).toLocaleLowerCase('ru') || weather}${indoors ? '' : ', под открытым небом'}, а текст описывает ${label}`, shiftedPrefix: SHIFTED_WEATHER_PREFIX })
    }
  }
  if (indoors) {
    rules.push({ kind: 'sky_indoors', topic: 'sky', patterns: SKY_INDOOR_PATTERNS, message: 'Канон сцены: под крышей, а текст ставит небо над головой', shiftedPrefix: null, needsNoOpening: true })
  }
  if (!rules.length) return []

  const found = []
  const seen = new Set()
  for (const [sentenceIndex, sentence] of sentencesOf(narratorVoiceOnly(narration)).entries()) {
    if (SHIFTED_SENTENCE.test(sentence)) continue
    for (const rule of rules) {
      if (EVENT_TOPIC_SKIPS[rule.topic]?.test(eventText)) continue
      if (rule.needsNoOpening && OPENING_CONTEXT.test(sentence)) continue
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0
        for (const match of sentence.matchAll(pattern)) {
          const before = sentence.slice(Math.max(0, match.index - 28), match.index)
          const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 40)
          if (NEGATED_PREFIX.test(before)) continue
          if (rule.shiftedPrefix && rule.shiftedPrefix.test(before)) continue
          if (ENDING_SUFFIX.test(after) || NEGATED_SUFFIX.test(after)) continue
          if (rule.topic === 'fog' && MIND_CONTEXT.test(`${before} ${after}`)) continue
          if (rule.kind === 'weather') {
            const adjective = WEATHER_TIME_ADJECTIVE.exec(before)?.[1]?.toLocaleLowerCase('ru')
            if (adjective && WEATHER_TIME_ADJECTIVE_PHASE[adjective] !== phase) continue
            if (FAR_WEATHER_CONTEXT.test(`${before} ${match[0]} ${after}`)) continue
          }
          if (rule.topic === 'dry' && ENCLOSED_DRY_CONTEXT.test(sentence)) continue
          // Одно предложение — одно нарушение каждого вида: «глубокая ночь
          // стоит» не должна считаться дважды.
          const key = `${rule.kind}:${sentenceIndex}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({ code: SCENE_CANON_CONTRADICTION, kind: rule.kind, message: rule.message, match: match[0].slice(0, 80) })
        }
      }
    }
  }
  return found
}
