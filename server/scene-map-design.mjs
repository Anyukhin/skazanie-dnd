import { createHash } from 'node:crypto'
import { normalizeLandmarks } from './scene-requirements.mjs'

const FIELDS = Object.freeze({
  topology: ['organic', 'linear', 'crossroads', 'market', 'courtyard', 'harbor', 'river', 'terraced', 'gate'],
  climate: ['temperate', 'arid', 'cold', 'wetland'],
  architecture: ['wood', 'stone', 'sand', 'metal', 'marble', 'ice'],
  density: ['sparse', 'mixed', 'dense'],
  building_use: ['dwelling', 'tavern', 'shop', 'manor', 'smithy', 'barracks', 'mill'],
  shape: ['rect', 'L', 'cross', 'round'],
  scale: ['village', 'town', 'city'],
})

const clean = (value, limit = 1600) => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ru').slice(0, limit)

/**
 * Только замысел места. Геометрия, проходимость и численные правила принадлежат генератору.
 * Якоря (`landmarks`, этап 2 `docs/map-generation-plan.md`) — виды из закрытого
 * словаря `server/scene-requirements.mjs` с ролью: что обязано стоять на карте.
 */
export function normalizeSceneMapDesign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const landmarks = normalizeLandmarks(value.landmarks)
  return {
    ...Object.fromEntries(Object.entries(FIELDS)
      .filter(([key, allowed]) => allowed.includes(value[key]))
      .map(([key]) => [key, value[key]])),
    ...(landmarks.length ? { landmarks } : {}),
  }
}

function seededChoice(values, seed, purpose) {
  const index = createHash('sha256').update(`${seed}:map-design/v1:${purpose}`).digest().readUInt32LE(0)
  return values[index % values.length]
}

function climateFrom(text) {
  /** @type {Array<[RegExp, string]>} */
  const patterns = [
    [/пустын|засушлив|бархан|песчан|\barid\b|\bdesert\b/u, 'arid'],
    // «Льд» — только с начала слова: в «Вельдбурге» те же буквы, и город
    // посреди умеренного края становился ледяным.
    [/снеж|снег|ледян|(?<![\p{L}\p{M}])льд|мерзлот|тундр|арктич|\btundra\b|\bice\b|\bsnow\b/u, 'cold'],
    [/болот|топ[ьи]|трясин|мангр|\bswamp\b|\bwetland\b|\bmarsh\b/u, 'wetland'],
  ]
  const climates = patterns.filter(([pattern]) => pattern.test(text)).map(([, climate]) => climate)
  // Упоминание нескольких регионов в общем описании мира не переносит один
  // из них на каждую локацию. Неоднозначный текст не сильнее местного канона.
  return climates.length === 1 ? climates[0] : ''
}

/**
 * Структурная заявка для нового места. Локальное описание сильнее общего
 * сеттинга; прошлое место и текст квеста здесь намеренно не используются.
 * @param {object} [input]
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.description]
 * @param {string} [input.worldDescription]
 * @param {string} [input.worldKind]
 * @param {string} [input.settlementType]
 * @param {string} [input.biome]
 * @param {Record<string, any>} [input.request]
 * @param {string} [input.seed]
 */
export function sceneMapDesignFor({
  location = '', theme = '', description = '', worldDescription = '',
  worldKind = '', settlementType = '', biome = '', request = {}, seed = 'scene',
} = {}) {
  const explicit = normalizeSceneMapDesign(request.design)
  const local = clean(`${location} ${theme} ${description} ${biome}`)
  const world = clean(worldDescription, 2400)
  const kind = clean(worldKind || settlementType, 40)
  const cityKind = ['city', 'capital', 'port', 'town'].includes(kind)
  const rural = kind === 'village' || !cityKind && /деревн|(?<![\p{L}\p{M}])сел[оау](?![\p{L}\p{M}])|хутор|слобод/u.test(local)
  const urban = cityKind || kind !== 'village' && /город|столиц|квартал/u.test(local)
  const climate = climateFrom(local) || explicit.climate || climateFrom(world) || 'temperate'
  const dryWatercourse = /(?:пересох|высох)[^.!?]{0,40}(?:рек|русл|канал)|без (?:реки|канала|воды)/u.test(local)
  const river = !dryWatercourse && /речн|междуреч|дельт|\b(?:river|canal)\b|(?<![\p{L}\p{M}])рек(?:а|и|у|е|ой|ою|ам|ах)?(?![\p{L}\p{M}])|канал|двух берег|два берег/u.test(local)
  let topology
  if (river) topology = 'river'
  // Дамба, плотина, шлюз, набережная — тоже край воды: плейтест 2026-10-02,
  // «Смотровая дамба над соляными полями» строилась сухой деревней.
  else if (kind === 'port' || /(?<![\p{L}\p{M}])порт(?:а|у|ом|е|ы|ов[а-яё]*|ами|ах)?(?![\p{L}\p{M}])|гаван|пристан|верф|причал|морск.*берег|(?<![\p{L}\p{M}])(?:дамб|плотин|шлюз|набережн|волнолом)|\b(?:harbou?r|port)\b/u.test(local)) topology = 'harbor'
  else if (/(?<![\p{L}\p{M}])(?:ворот|врат)|застав|приврат/u.test(local)) topology = 'gate'
  else if (/террас|горн|склон|кряж|на скал|\bmountains\b/u.test(local)) topology = 'terraced'
  else if (/рыноч|рынок|базар|торгов[а-яё]* площад/u.test(local)) topology = 'market'
  else if (/вокруг двор|внутренн[а-яё]* двор|замкнут[а-яё]* двор/u.test(local)) topology = 'courtyard'
  else if (/вдоль дорог|вдоль тракт|дорожн[а-яё]* деревн|одна улица/u.test(local)) topology = 'linear'
  else topology = explicit.topology || seededChoice(rural
    ? ['organic', 'linear', 'crossroads']
    : urban ? ['market', 'courtyard', 'crossroads', 'linear']
      : ['organic', 'crossroads', 'courtyard'], seed, 'topology')

  let architecture = /саман|глинобит|сырцов/u.test(local) ? 'sand'
    : /деревян|бревен|сруб|дощат/u.test(local) ? 'wood'
      : /мрамор/u.test(local) ? 'marble'
        : /металлическ|стальн|железн[а-яё]* (?:дом|город|башн)/u.test(local) ? 'metal'
          : /ледян[а-яё]* (?:дом|дворец|город)|изо? льда/u.test(local) ? 'ice'
            : /каменн|кирпич|белокамен/u.test(local) ? 'stone'
              : explicit.architecture
  if (!architecture) architecture = climate === 'arid' ? 'sand' : urban || kind === 'fortress' ? 'stone' : 'wood'
  const density = /редк[а-яё]* (?:дом|застрой)|разбросан|маленьк[а-яё]* деревн|хутор/u.test(local) ? 'sparse'
    : /тесн|густ[а-яё]* застрой|плотн[а-яё]* застрой|многолюд|столиц/u.test(local) ? 'dense'
      // Деревня по умолчанию — обычная застройка: «редкая» давала четыре-пять
      // дворов на карте 36×32. Редкой остаётся хутор, выселки и деревня в пустыне.
      : explicit.density || (rural ? (climate === 'arid' ? 'sparse' : 'mixed') : urban ? 'dense' : 'mixed')
  const buildingUse = /кузн|кузниц/u.test(local) ? 'smithy'
    : /казарм|караульн|гарнизон|сторожев[а-яё]* башн|дозорн[а-яё]* башн/u.test(local) ? 'barracks'
      : /башн/u.test(local) ? 'manor'
      : /мельниц/u.test(local) ? 'mill'
        : /таверн|трактир|постоял|корчм|гостиниц/u.test(local) ? 'tavern'
    : /лавк|магазин|мастерск|склад|торгов[а-яё]* ряд|рыночн[а-яё]* набережн/u.test(local) ? 'shop'
      : /особняк|усадьб|дворец|крепост|замок|цитадел|галере|тронн[а-яё]* зал/u.test(local) || kind === 'fortress' || request.pattern === 'keep' ? 'manor'
        : explicit.building_use || 'dwelling'
  // Форма корпуса — по словам места: башня и ротонда круглые, «Г-образный»
  // и «крестообразный» говорят сами за себя. Без слов форму выберет генератор.
  const shape = /кругл[а-яё]* (?:башн|зал|дом|здани)|ротонд|башн[яиюе]/u.test(local) ? 'round'
    : /г-образн|углом|буквой г/u.test(local) ? 'L'
    : /крестообразн|крестом/u.test(local) ? 'cross'
      : explicit.shape
  // Масштаб поселения: деревня, город, столица. От него зависят размер
  // карты и число построек — город из четырёх домов городом не выглядит.
  const scale = kind === 'capital' || /столиц|мегаполис|великий город/u.test(local) ? 'city'
    : cityKind || urban ? 'town'
      : rural ? 'village'
        : explicit.scale
  // Дом мага или алхимика: гостиная и кабинет становятся лабораторией.
  // «Маг» — отдельным словом: в «магазине» те же буквы.
  const arcane = /(?<![\p{L}\p{M}])маг(?:а|у|ом|е|и|ов|ам|ами|ах)?(?![\p{L}\p{M}])|магическ|магии|чароде|колдун|волшебник|алхими|лаборатор|чернокниж|некромант|\b(?:wizard|mage|alchemist)\b/u.test(local)
  return {
    topology, climate, architecture, density, building_use: buildingUse,
    ...(shape ? { shape } : {}),
    ...(scale ? { scale } : {}),
    ...(arcane ? { arcane: true } : {}),
  }
}

/** Публичное описание именно выбранной точки карты мира. */
export function worldLocationDesignContext(worldMap, locationId, location = '') {
  const node = (worldMap?.locations ?? []).find((entry) => String(entry.id) === String(locationId))
    ?? (worldMap?.locations ?? []).find((entry) => clean(entry.name) === clean(location))
  if (!node || node.known === false || node.hidden === true || node.visibility === 'gm_only') return { description: '', biome: '' }
  const region = (worldMap?.regions ?? []).find((entry) => String(entry.id) === String(node.regionId ?? node.region_id))
  return {
    description: [node.summary, node.history].filter((value) => typeof value === 'string').join(' ').slice(0, 1600),
    biome: String(node.biome ?? region?.biome ?? '').slice(0, 80),
  }
}
