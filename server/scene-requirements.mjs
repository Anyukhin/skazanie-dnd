// @ts-check
/**
 * Обязательные объекты сцены: что текст сцены пообещал увидеть на карте.
 *
 * Зачем. Живая кампания 2026-10-02 открылась прологом про деревню с общим
 * навесом, ящиком с документами, тремя настилами и камнями на порогах, а
 * карта пришла из библиотеки — одинокий японский дом. Ни выбор библиотечной
 * карты, ни генератор описания сцены не читали, поэтому пообещанного на поле
 * не было, а жителей поставило на случайные клетки. Этот модуль — первый шаг:
 * сервер **без модели** вытаскивает из слов сцены, что обязано стоять на
 * карте, и список едет в самой сцене (`scene.map_requirements`).
 *
 * Как читает. Закрытый словарь: у каждого вида объекта — корни слов и
 * предметы реестра (`server/asset-registry.mjs`), которыми он воплощается на
 * карте. Границы слов — через `\p{L}`, а не `\b`: в JS `\b` знает только
 * латиницу. Отрицание рядом («без навеса», «нет колодца») объект снимает.
 * Числительное перед словом («три настила», «две бочки») задаёт количество.
 *
 * Чего модуль не умеет и не притворяется: он не отличает объект этой сцены
 * от упомянутого в чужой реплике («в соседней деревне есть колодец») и
 * метафору от предмета. Это узкая детерминированная эвристика: лишний
 * пункт списка стоит дешевле, чем обещание, которого нет на карте.
 *
 * Модуль — лист: ничего из `server/` не импортирует, состояния не хранит.
 * Replay от него не зависит — список записан в событие вместе со сценой.
 */

// v2 (2026-10-03, этап 1 плана `docs/map-generation-plan.md`): к списку
// добавлены центр сцены (`focus`) и посты жителей (`posts`). Сохранённые
// сцены v1 читаются как раньше — без центра и постов.
export const SCENE_REQUIREMENTS_VERSION = 'scene-requirements/v2'

/** Сколько видов объектов держит одна сцена и сколько штук одного вида. */
const MAX_ITEMS = 12
const MAX_COUNT = 6

/**
 * Вид объекта сцены.
 * @typedef {object} RequirementKind
 * @property {string} id
 * @property {string} label подпись по-русски
 * @property {RegExp} pattern слово в тексте; левая граница проверяется отдельно
 * @property {string[]} assets предметы реестра, которые воплощают объект; пустой
 *   список — у реестра такого предмета ещё нет, и карта обещание не выполнит
 */

/**
 * Окончания существительных сведены в явные списки, а не в `\p{L}*`: иначе
 * «навес» ловил бы «навеселе», а «стол» — «столицу».
 * @type {readonly RequirementKind[]}
 */
export const SCENE_REQUIREMENT_KINDS = Object.freeze([
  { id: 'shelter', label: 'навес', pattern: /навес(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})/u, assets: ['market_awning'] },
  { id: 'platform', label: 'настил', pattern: /(?:настил|помост)(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})|мостк(?:и|ов|ам|ами|ах)(?!\p{L})/u, assets: [] },
  { id: 'threshold_stone', label: 'камни на пороге', pattern: /(?:камн(?:и|ей|ям|ями|ях)|камень|камнем|камня)\s+(?:у|на|перед|под)\s+порог\p{L}*|порожн\p{L}*\s+камн\p{L}*/u, assets: ['path_stone', 'ledge_step'] },
  { id: 'crate', label: 'ящик', pattern: /ящик(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})/u, assets: ['crate', 'crate_stack', 'chest'] },
  { id: 'chest', label: 'сундук', pattern: /сундук(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})|лар(?:ец|ца|цу|цом|це|цы|цов)(?!\p{L})|шкатулк\p{L}*/u, assets: ['chest'] },
  { id: 'campfire', label: 'костёр', pattern: /кост(?:ёр|ер|ра|ру|ром|ре|ры|ров|рам|рами|рах)(?!\p{L})|кострищ\p{L}*/u, assets: ['campfire'] },
  { id: 'hearth', label: 'очаг', pattern: /очаг(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})|камин(?:а|у|ом|е|ы|ов)?(?!\p{L})/u, assets: ['fireplace', 'hearth_fire'] },
  { id: 'well', label: 'колодец', pattern: /колод(?:ец|ца|цу|цем|це|цы|цев|цам|цами|цах)(?!\p{L})/u, assets: ['well'] },
  { id: 'statue', label: 'статуя', pattern: /стату(?:я|и|ю|ей|е|й|ям|ями|ях)(?!\p{L})|изваян\p{L}*|идол(?:а|у|ом|е|ы|ов)?(?!\p{L})/u, assets: ['statue'] },
  { id: 'altar', label: 'алтарь', pattern: /алтар(?:ь|я|ю|ём|ем|е|и|ей|ям|ями|ях)(?!\p{L})|жертвенник\p{L}*/u, assets: ['altar'] },
  { id: 'shrine', label: 'часовня', pattern: /часовн\p{L}*|божниц\p{L}*/u, assets: ['roadside_shrine', 'altar'] },
  { id: 'cart', label: 'телега', pattern: /телег\p{L}*|повозк\p{L}*|фургон(?:а|у|ом|е|ы|ов)?(?!\p{L})/u, assets: ['cart'] },
  { id: 'market_stall', label: 'прилавок', pattern: /прилав(?:ок|ка|ку|ком|ке|ки|ков|кам|ками|ках)(?!\p{L})|торгов\p{L}*\s+(?:палатк|лот[ок])\p{L}*/u, assets: ['market_stall'] },
  { id: 'haystack', label: 'стог', pattern: /стог(?:а|у|ом|е|и|ов)?(?!\p{L})|скирд\p{L}*/u, assets: ['haystack'] },
  { id: 'trough', label: 'поилка', pattern: /поилк\p{L}*|корыт(?:о|а|у|ом|е)(?!\p{L})/u, assets: ['water_trough'] },
  { id: 'fence', label: 'изгородь', pattern: /забор(?:а|у|ом|е|ы|ов)?(?!\p{L})|изгород\p{L}*|плет(?:ень|ня|ню|нём|нем|не|ни)(?!\p{L})|частокол\p{L}*/u, assets: ['village_fence', 'rail_fence'] },
  { id: 'barrels', label: 'бочки', pattern: /бо(?:чк|чек|чонок|чонк)\p{L}*/u, assets: ['barrel', 'barrel_stack', 'keg'] },
  { id: 'signpost', label: 'указатель', pattern: /указател(?:ь|я|ю|ем|е|и|ей)(?!\p{L})/u, assets: ['signpost'] },
  { id: 'milestone', label: 'верстовой камень', pattern: /верстов\p{L}*\s+(?:столб|камн|камен)\p{L}*/u, assets: ['milestone'] },
  { id: 'lantern', label: 'фонарь', pattern: /фонар(?:ь|я|ю|ём|ем|е|и|ей|ям|ями|ях)(?!\p{L})/u, assets: ['lamp_post', 'lantern_wall'] },
  { id: 'grave', label: 'могила', pattern: /могил(?:а|ы|е|у|ой|ам|ами|ах)?(?!\p{L})|надгроби\p{L}*/u, assets: ['grave'] },
  { id: 'table', label: 'стол', pattern: /стол(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})/u, assets: ['table_small', 'table_round', 'table_long', 'table_royal'] },
  { id: 'bench', label: 'скамья', pattern: /скам(?:ья|ьи|ье|ью|ьёй|ьей|ей|ьям|ьями|ьях)(?!\p{L})/u, assets: ['bench', 'prayer_bench'] },
  { id: 'brazier', label: 'жаровня', pattern: /жаровн\p{L}*/u, assets: ['brazier'] },
  { id: 'cauldron', label: 'котёл', pattern: /кот(?:ёл|ел|ла|лу|лом|ле|лы|лов)(?!\p{L})/u, assets: ['cauldron'] },
  { id: 'oak', label: 'дуб', pattern: /дуб(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})/u, assets: ['tree_oak'] },
  { id: 'notice_board', label: 'доска объявлений', pattern: /доск(?:а|и|е|у|ой)\s+(?:объявлений|указов|приказов|вестей)(?!\p{L})/u, assets: ['notice_board'] },
  { id: 'forge', label: 'кузница', pattern: /кузн(?:ица|ицы|ице|ицу|ицей|ечн\p{L}*)(?!\p{L})|наковальн\p{L}*/u, assets: ['forge', 'anvil'] },
])

/**
 * Что может быть центром сцены: место, вокруг которого собираются люди и
 * идёт действие. Центр — первое по тексту из этих мест.
 */
const FOCUS_KINDS = Object.freeze(['shelter', 'well', 'campfire', 'market_stall', 'statue', 'altar', 'shrine', 'hearth', 'notice_board', 'oak', 'table'])

/** Глава общины стоит в центре сцены. */
const LEADER_ROLE = /(?<!\p{L})(?:старост\p{L}*|старейшин\p{L}*|вожд\p{L}*|вождь|(?:голов|глав)(?:а|ы|е|у|ой)\s+(?:деревни|общины|посёлка|поселка|совета|скита))(?!\p{L})/u

/** Роль жителя называет его рабочее место. */
const ROLE_KINDS = /** @type {ReadonlyArray<[RegExp, string]>} */ (Object.freeze([
  [/(?<!\p{L})(?:хранител\p{L}*\s+(?:записей|архива|документов|бумаг|грамот)|архивариус\p{L}*|писар\p{L}*|летописц\p{L}*)/u, 'chest'],
  [/(?<!\p{L})кузнец\p{L}*/u, 'forge'],
  [/(?<!\p{L})(?:торгов(?:ец|ка|цы)|лавочни\p{L}*|продав\p{L}*|купе(?:ц|чих)\p{L}*)/u, 'market_stall'],
  [/(?<!\p{L})(?:жрец\p{L}*|жриц\p{L}*|священник\p{L}*|настоятел\p{L}*|монах\p{L}*|послушни\p{L}*)/u, 'altar'],
  [/(?<!\p{L})мастер\p{L}*\s+(?:настил|помост|мостк)\p{L}*/u, 'platform'],
]))

/**
 * Рабочее место жителя: предмет из его собственного описания («стоит у
 * запертого ящика»), иначе — из роли («кузнец» — кузница), а у главы общины —
 * центр сцены. `null` — жителю пост не положен, и его ставят как раньше.
 *
 * @param {{ name?: unknown, role?: unknown, summary?: unknown }} npc
 * @param {string|null} focus
 * @returns {string|null}
 */
function postKindFor(npc, focus) {
  const own = sceneRequirementsFromText([String(npc?.summary ?? '')])[0]?.id
  if (own) return own
  const role = clean(npc?.role)
  for (const [pattern, kind] of ROLE_KINDS) if (pattern.test(role)) return kind
  return focus && LEADER_ROLE.test(role) ? focus : null
}

const KINDS_BY_ID = new Map(SCENE_REQUIREMENT_KINDS.map((kind) => [kind.id, kind]))

/** Числительные, которые задают количество. «Пара» — тоже два. */
const NUMERALS = /** @type {Record<string, number>} */ (Object.freeze({
  один: 1, одна: 1, одно: 1, одного: 1, одной: 1,
  два: 2, две: 2, двух: 2, пара: 2, пару: 2, оба: 2, обе: 2,
  три: 3, трёх: 3, трех: 3, четыре: 4, четырёх: 4, четырех: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, восемь: 8,
}))

/** Отрицание прямо перед словом снимает объект: «без навеса», «нет ни одного колодца». */
const NEGATION_BEFORE = /(?<!\p{L})(?:без|нет|ни|лишён\p{L}*|лишен\p{L}*)(?:\s+(?:ни|одного|одной|даже|какого-либо|никакого|никакой|\p{L}+(?:ого|ей|ых)))*\s+$/u

/** Прилагательное между числительным и объектом: «три старых дощатых настила». */
const ADJECTIVE = /\p{L}{2,}(?:ых|их|ые|ие|ый|ий|ой|ая|яя|ое|ее|ую|юю|ого|его|ому|ему|ым|им)$/u

/** @param {unknown} value */
const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('ru')

/**
 * Количество из числительного прямо перед объектом; между ними допускаются
 * только прилагательные. «В двух шагах от колодца» — один колодец, а не два.
 *
 * @param {string} before текст перед словом
 * @returns {number}
 */
function countBefore(before) {
  const words = before.trimEnd().split(' ').slice(-3)
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const raw = words[index]
    // Конец фразы между числом и объектом разрывает связь.
    if (/[.!?;:,—]$/u.test(raw)) return 1
    const word = raw.replace(/[^\p{L}\d]/gu, '')
    const digits = Number(word)
    if (/^\d{1,2}$/u.test(word) && digits > 0) return Math.min(MAX_COUNT, digits)
    if (NUMERALS[word]) return Math.min(MAX_COUNT, NUMERALS[word])
    if (!ADJECTIVE.test(word)) return 1
  }
  return 1
}

/**
 * Обязательные объекты по словам сцены.
 *
 * @param {Array<unknown>|string} texts описания сцены: пролог, прибытие,
 *   название, настроение, цель. Только то, что видит игрок: секреты ведущего
 *   сюда не передаются — иначе карта выдала бы спрятанное.
 * @returns {Array<{ id: string, count: number }>} в порядке первого упоминания
 */
export function sceneRequirementsFromText(texts) {
  const source = (Array.isArray(texts) ? texts : [texts])
    .filter((value) => typeof value === 'string' && value.trim())
    .map(clean)
    .join(' . ')
    .slice(0, 8000)
  if (!source) return []
  /** @type {Map<string, { id: string, count: number, at: number }>} */
  const found = new Map()
  for (const kind of SCENE_REQUIREMENT_KINDS) {
    const pattern = new RegExp(kind.pattern.source, 'gu')
    for (const match of source.matchAll(pattern)) {
      const at = match.index ?? 0
      if (at > 0 && /\p{L}/u.test(source[at - 1])) continue
      const before = source.slice(Math.max(0, at - 64), at)
      if (NEGATION_BEFORE.test(before)) continue
      const count = countBefore(before)
      const previous = found.get(kind.id)
      found.set(kind.id, { id: kind.id, count: Math.max(previous?.count ?? 1, count), at: Math.min(previous?.at ?? at, at) })
    }
  }
  return [...found.values()]
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
    .slice(0, MAX_ITEMS)
    .map(({ id, count }) => ({ id, count }))
}

/**
 * Поле сцены со списком или `null`, когда обещать нечего: сцена без
 * объектов поля не получает, и сохранённые кампании читаются как раньше.
 *
 * Программа сцены: кроме обещанного списка — центр (`focus`, место, вокруг
 * которого идёт действие) и посты жителей (`posts`). Пост тянет свой предмет в
 * обещанное: хранитель записей без ящика на карте стоял бы где попало
 * (живая кампания 2026-10-02 — жители у края поля без якоря).
 *
 * @param {Array<unknown>|string} texts
 * @param {{ npcs?: Array<{ name?: unknown, role?: unknown, summary?: unknown }> }} [options]
 *   жители, которые стоят в этой сцене
 * @returns {{ version: string, items: Array<{ id: string, count: number }>, focus?: string, posts?: Array<{ npc: string, id: string }> }|null}
 */
export function sceneMapRequirementsFor(texts, { npcs = [] } = {}) {
  const items = sceneRequirementsFromText(texts)
  const focus = items.find((item) => FOCUS_KINDS.includes(item.id))?.id ?? null
  /** @type {Array<{ npc: string, id: string }>} */
  const posts = []
  for (const npc of Array.isArray(npcs) ? npcs : []) {
    const name = String(npc?.name ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    const kind = name ? postKindFor(npc, focus) : null
    if (!kind || posts.some((post) => post.npc === name)) continue
    posts.push({ npc: name, id: kind })
    if (!items.some((item) => item.id === kind) && items.length < MAX_ITEMS) items.push({ id: kind, count: 1 })
  }
  if (!items.length) return null
  return {
    version: SCENE_REQUIREMENTS_VERSION,
    items,
    ...(focus ? { focus } : {}),
    ...(posts.length ? { posts } : {}),
  }
}

/**
 * Посты жителей из сохранённой сцены; v1 и мусор дают пустой список.
 * @param {unknown} value `scene.map_requirements`
 * @returns {Array<{ npc: string, id: string }>}
 */
export function normalizeScenePosts(value) {
  const posts = value && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).posts) ? /** @type {any} */ (value).posts : []
  /** @type {Array<{ npc: string, id: string }>} */
  const result = []
  for (const post of posts) {
    const npc = String(post?.npc ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    const id = String(post?.id ?? '')
    if (!npc || !KINDS_BY_ID.has(id) || result.some((entry) => entry.npc === npc)) continue
    result.push({ npc, id })
    if (result.length >= MAX_ITEMS) break
  }
  return result
}

/**
 * Список из сохранённой сцены: незнакомые виды и мусор отбрасываются.
 * @param {unknown} value `scene.map_requirements`
 * @returns {Array<{ id: string, count: number }>}
 */
export function normalizeSceneRequirements(value) {
  const items = Array.isArray(value) ? value
    : value && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).items) ? /** @type {any} */ (value).items
      : []
  /** @type {Map<string, number>} */
  const result = new Map()
  for (const item of items) {
    const id = String(item?.id ?? '')
    if (!KINDS_BY_ID.has(id) || result.has(id)) continue
    const count = Number(item?.count)
    result.set(id, Number.isSafeInteger(count) && count > 0 ? Math.min(MAX_COUNT, count) : 1)
    if (result.size >= MAX_ITEMS) break
  }
  return [...result].map(([id, count]) => ({ id, count }))
}

/**
 * Предметы реестра, которыми воплощается вид объекта.
 * @param {string} id
 * @returns {string[]}
 */
export function requirementAssets(id) {
  return [...(KINDS_BY_ID.get(id)?.assets ?? [])]
}

/**
 * Подпись вида объекта по-русски.
 * @param {string} id
 * @returns {string}
 */
export function requirementLabel(id) {
  return KINDS_BY_ID.get(id)?.label ?? id
}

/**
 * Какие обещания карта выполняет по счётчику своих предметов.
 * Количество сверяется: три настила — это три предмета, а не один.
 *
 * @param {Array<{ id: string, count: number }>} requirements
 * @param {Record<string, number>} props счётчик `assetId → штук`
 * @returns {{ met: string[], missing: string[] }}
 */
export function requirementsCoverage(requirements, props) {
  /** @type {string[]} */
  const met = []
  /** @type {string[]} */
  const missing = []
  for (const requirement of requirements) {
    const have = requirementAssets(requirement.id).reduce((sum, assetId) => sum + (Number(props?.[assetId]) || 0), 0)
    if (have >= Math.max(1, requirement.count)) met.push(requirement.id)
    else missing.push(requirement.id)
  }
  return { met, missing }
}
