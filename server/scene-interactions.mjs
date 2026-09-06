import { createHash } from 'node:crypto'
import { serverEncounterLoot } from './loot-tables.mjs'
import { igniteDefinitionFor, sceneHazardVerbsFor, toppleDefinitionFor } from './scene-hazards.mjs'

export const SCENE_INTERACTION_POLICY_ID = 'skazanie:scene-interactions-v1'

/**
 * Что сервер умеет делать с реквизитом сцены.
 *
 * Вид (`kind`) задаёт обычные операции и таблицы деталей; глаголы обстановки
 * (`topple`, `ignite`) добавляет справочник `scene-hazards.mjs` по тем же
 * `assetId`. Поэтому запись здесь — это единственный ключ, открывающий пропсу
 * доступ к движку: без неё `OperateSceneObject` отвечает `SCENE_OBJECT_UNSUPPORTED`,
 * какими бы тегами опасности предмет ни обладал.
 *
 * `furnishing` — обстановка: её осматривают, валят и жгут, но добычи и тайника
 * в ней нет. Отдельный вид, а не `lore`, именно потому, что записка в кровати
 * или под ковром была бы выдумкой сервера.
 */
const CATALOG = Object.freeze([
  // `lockpick` объявлен у контейнера безусловно, а не только у запертого, и это
  // осознанно: запертость выводится из сида (`sceneInteractionDefinition`), и
  // объяви её кнопка — игрок читал бы наличие замка с панели, не притронувшись
  // к сундуку. СЛ замка не объявляется тем более. Поэтому «Взломать» стоит у
  // всякого сундука, а ответ «замка на нём нет» приходит серверным отказом и
  // хода не стоит.
  Object.freeze({ kind: 'container', aliases: Object.freeze(['chest', 'barrel', 'crate', 'sarcophagus', 'urn', 'crypt_niche', 'reliquary', 'cupboard', 'wardrobe', 'basket', 'keg']), verbs: Object.freeze(['inspect', 'open', 'lockpick', 'take']) }),
  Object.freeze({ kind: 'relic', aliases: Object.freeze(['altar', 'rune', 'statue', 'roadside_shrine', 'brazier']), verbs: Object.freeze(['inspect', 'use']) }),
  Object.freeze({ kind: 'campfire', aliases: Object.freeze(['campfire']), verbs: Object.freeze(['inspect', 'use']) }),
  Object.freeze({ kind: 'lore', aliases: Object.freeze(['bookshelf', 'table', 'fallen_log', 'tree_stump', 'boulder', 'rubble_heap', 'stalagmite', 'milestone']), verbs: Object.freeze(['inspect']) }),
  Object.freeze({ kind: 'corpse', aliases: Object.freeze(['bones', 'bone_pile', 'grave', 'corpse']), verbs: Object.freeze(['inspect', 'take']) }),
  Object.freeze({
    kind: 'furnishing',
    aliases: Object.freeze([
      'bar_counter', 'bar_shelf', 'shelf_wall', 'pillar', 'cart', 'market_stall',
      'haystack', 'woodpile', 'firewood_stack', 'broom', 'cobweb',
      'banner', 'temple_banner', 'rug', 'bed', 'bunk_bed', 'bench', 'prayer_bench', 'chandelier',
    ]),
    verbs: Object.freeze(['inspect']),
  }),
])

const DETAIL_TABLE = Object.freeze({
  'container:0': Object.freeze({ id: 'scratched-mark', text: 'На внутренней стороне крышки вырезан знак прежнего владельца.' }),
  'container:1': Object.freeze({ id: 'false-bottom', text: 'Под грубой обивкой заметно неглубокое двойное дно.' }),
  'container:2': Object.freeze({ id: 'recently-moved', text: 'Пыль вокруг предмета нарушена совсем недавно.' }),
  'relic:0': Object.freeze({ id: 'old-consecration', text: 'Знаки указывают на старое защитное посвящение.' }),
  'relic:1': Object.freeze({ id: 'warning-glyph', text: 'Надпись предупреждает не тревожить печать без нужды.' }),
  'relic:2': Object.freeze({ id: 'pilgrim-sign', text: 'Символ оставлен паломниками и отмечает безопасный путь.' }),
  'campfire:0': Object.freeze({ id: 'safe-rest', text: 'Очаг можно безопасно использовать для короткого привала.' }),
  'lore:0': Object.freeze({ id: 'route-note', text: 'Среди записей найдено упоминание обходного пути.' }),
  'lore:1': Object.freeze({ id: 'name-in-margin', text: 'На полях несколько раз повторено одно и то же имя.' }),
  'lore:2': Object.freeze({ id: 'hurried-message', text: 'Короткая запись оставлена в спешке незадолго до событий сцены.' }),
  'corpse:0': Object.freeze({ id: 'cause-of-death', text: 'Следы позволяют определить вероятную причину гибели.' }),
  'corpse:1': Object.freeze({ id: 'travel-token', text: 'При останках сохранился знак, связанный с местным путём.' }),
  'corpse:2': Object.freeze({ id: 'defensive-wounds', text: 'Положение останков говорит о внезапном нападении.' }),
  'furnishing:0': Object.freeze({ id: 'dry-and-brittle', text: 'Вещь рассохлась и держится на честном слове.' }),
  'furnishing:1': Object.freeze({ id: 'recently-disturbed', text: 'Пыль вокруг сдвинута: обстановку здесь недавно трогали.' }),
  'furnishing:2': Object.freeze({ id: 'poorly-braced', text: 'Опора стоит косо — сильного толчка она не выдержит.' }),
})

const REWARD_KEYS = Object.freeze({
  container: Object.freeze(['generic-cache', 'traveler-cache', 'guard-cache']),
  relic: Object.freeze(['minor-ward']),
  campfire: Object.freeze(['short-rest']),
  lore: Object.freeze(['written-clue']),
  corpse: Object.freeze(['personal-effects']),
})

/**
 * Точкой интереса становится только то, где сервер действительно что-то
 * приготовил. Обстановка интерактивна, но приметной не объявляется: иначе
 * маркер «здесь что-то есть» висел бы над каждой скамьёй и перестал бы
 * значить хоть что-нибудь.
 */
const POINT_OF_INTEREST_KINDS = Object.freeze(Object.keys(REWARD_KEYS))

const ASSET_ALIASES_RU = Object.freeze({
  chest: Object.freeze(['сундук', 'ларец']),
  barrel: Object.freeze(['бочка', 'бочку', 'бочке']),
  crate: Object.freeze(['ящик', 'ящика', 'ящике']),
  sarcophagus: Object.freeze(['саркофаг', 'саркофага', 'саркофаге']),
  urn: Object.freeze(['урна', 'урну', 'урне']),
  crypt_niche: Object.freeze(['ниша', 'нишу', 'нише']),
  reliquary: Object.freeze(['ковчег', 'ковчега', 'ковчеге', 'реликварий']),
  altar: Object.freeze(['алтарь', 'алтаря']),
  rune: Object.freeze(['руна', 'руну', 'руне']),
  statue: Object.freeze(['статуя', 'статую', 'статуе']),
  roadside_shrine: Object.freeze(['святилище', 'святилища', 'святилище']),
  brazier: Object.freeze(['жаровня', 'жаровню', 'жаровне', 'чаша с огнём']),
  campfire: Object.freeze(['костёр', 'костер', 'очаг']),
  chandelier: Object.freeze(['люстра', 'люстру', 'люстре']),
  bookshelf: Object.freeze(['полка', 'полку', 'шкаф', 'книги']),
  table: Object.freeze(['стол', 'стола', 'столе']),
  fallen_log: Object.freeze(['бревно', 'бревна', 'бревне']),
  tree_stump: Object.freeze(['пень', 'пня', 'пне']),
  boulder: Object.freeze(['валун', 'валуна', 'валуне', 'камень', 'камня', 'камне']),
  rubble_heap: Object.freeze(['завал', 'завала', 'завале', 'обломки']),
  stalagmite: Object.freeze(['сталагмит', 'сталагмита', 'сталагмите', 'нарост']),
  milestone: Object.freeze(['верстовой столб', 'указатель', 'указателя']),
  bones: Object.freeze(['кости', 'останки', 'скелет']),
  bone_pile: Object.freeze(['кости', 'останки', 'скелет']),
  grave: Object.freeze(['могила', 'могилу', 'могиле']),
  corpse: Object.freeze(['труп', 'трупа', 'теле']),
  // Обстановка и хранение, открытые задачей 3.2b. Слова подобраны так, чтобы не
  // отбирать уже занятые: «полка», «шкаф» и «книги» остаются за bookshelf.
  cupboard: Object.freeze(['буфет', 'буфета', 'буфете']),
  wardrobe: Object.freeze(['платяной шкаф', 'гардероб', 'гардероба']),
  basket: Object.freeze(['корзина', 'корзину', 'корзине']),
  keg: Object.freeze(['бочонок', 'бочонка', 'бочонке']),
  bar_counter: Object.freeze(['стойка', 'стойку', 'стойке']),
  bar_shelf: Object.freeze(['полка за стойкой']),
  shelf_wall: Object.freeze(['стеллаж', 'стеллажа', 'стеллаже']),
  pillar: Object.freeze(['колонна', 'колонну', 'колонне']),
  cart: Object.freeze(['телега', 'телегу', 'телеге']),
  market_stall: Object.freeze(['лоток', 'лотка', 'прилавок']),
  haystack: Object.freeze(['сено', 'сена', 'стог', 'стога']),
  woodpile: Object.freeze(['поленница', 'поленницу', 'поленнице']),
  firewood_stack: Object.freeze(['дрова', 'дров', 'вязанка']),
  broom: Object.freeze(['метла', 'метлу', 'метле']),
  cobweb: Object.freeze(['паутина', 'паутину', 'паутине']),
  banner: Object.freeze(['полотнище', 'знамя', 'флаг']),
  temple_banner: Object.freeze(['храмовое полотнище']),
  rug: Object.freeze(['ковёр', 'ковер', 'ковра', 'ковре']),
  bed: Object.freeze(['кровать', 'кровати', 'постель', 'постели']),
  bunk_bed: Object.freeze(['койка', 'койку', 'койке', 'нары']),
  bench: Object.freeze(['скамья', 'скамью', 'скамье', 'скамейка', 'лавка']),
  prayer_bench: Object.freeze(['молитвенная скамья']),
})

/**
 * У чего молятся. Подмножество `relic`, а не весь вид, и это осознанно: руна и
 * жаровня — тоже реликвии каталога, но обращаться к ним как к святыне значило
 * бы обещать столу алтарь там, где стоит светильник. Статуя в списке есть:
 * изваяние в храме или у дороги — обычное место молитвы, и святыней его делает
 * не материал, а то, зачем к нему подходят.
 *
 * Список закрытый и серверный: глагол `pray` открывает пропсу доступ к молитве
 * (`server/blessings.mjs`), и подмешать в него ковчег или скамью клиент не может.
 */
const SHRINE_ALIASES = Object.freeze(['altar', 'roadside_shrine', 'statue'])

/** Святыня ли это. Единственный ответ на вопрос «можно ли здесь помолиться». */
export function isSceneShrineAsset(assetId) {
  const alias = assetAlias(assetId)
  return Boolean(alias && SHRINE_ALIASES.includes(alias))
}

/**
 * Глаголы святыни. Устроены как глаголы обстановки (`sceneHazardVerbsFor`):
 * справочник добавляет их к обычным операциям вида по тому же `assetId`, а не
 * заводит второй каталог. Пустой список — обычный пропс.
 */
export function sceneShrineVerbsFor(assetId) {
  return isSceneShrineAsset(assetId) ? ['pray'] : []
}

const FALLBACK_ASSETS = Object.freeze(['chest', 'altar', 'campfire', 'bookshelf', 'bone_pile'])
const ASSET_ALIAS_MATCHERS = Object.freeze(
  CATALOG.flatMap((entry) => entry.aliases)
    .sort((left, right) => right.length - left.length)
    .map((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return Object.freeze({
        alias,
        pattern: new RegExp(`(?:^|[\\/_-])${escaped}(?:$|[\\/_-])`, 'u'),
      })
    }),
)

export function sceneInteractionFallbackAssets() {
  return [...FALLBACK_ASSETS]
}

/**
 * Виды, за которыми сервер действительно держит находку, тайник или знание.
 *
 * Тот же список, по которому выбираются точки интереса. Он же — единственный
 * фильтр, которому позволено пускать предмет в подсказки игроку: «можно
 * осмотреть скамью» подсказкой не является.
 */
export function sceneInteractionRewardKinds() {
  return [...POINT_OF_INTEREST_KINDS]
}

export function sceneInteractionAssetIds() {
  return CATALOG.flatMap((entry) => [...entry.aliases])
}

function clean(value, maximum = 160) {
  return String(value ?? '').trim().slice(0, maximum)
}

function hashNumber(value) {
  return Number.parseInt(createHash('sha256').update(clean(value, 1_000)).digest('hex').slice(0, 8), 16)
}

function assetAlias(assetId) {
  const value = clean(assetId, 120).toLowerCase()
  return ASSET_ALIAS_MATCHERS.find(({ pattern }) => pattern.test(value))?.alias ?? null
}

/**
 * Русская подпись предмета по `assetId` — для любого текста, который увидит
 * игрок. Идентификаторы карты латинские (`bar_counter`, `crypt_niche`), и
 * показывать их нельзя ни при каких обстоятельствах: за столом это читается как
 * сбой, а не как предмет обстановки.
 *
 * Источников два, оба уже существуют: справочник опасностей знает подпись
 * точнее (`table_long` — «длинный стол», а не просто «стол»), словарь синонимов
 * покрывает остальное. Первым словом синонима стоит именительный падеж —
 * именно он и берётся.
 *
 * Пустая строка — законный ответ: подписи нет, значит, называть предмет игроку
 * нечем, и звать его следует не под латинским именем, а никак.
 */
export function sceneObjectLabelFor(assetId) {
  const hazard = clean(toppleDefinitionFor(assetId)?.mass, 60) || clean(igniteDefinitionFor(assetId)?.what, 60)
  if (hazard) return hazard
  const alias = assetAlias(assetId)
  return alias ? clean(ASSET_ALIASES_RU[alias]?.[0], 60) : ''
}

export function sceneInteractionCatalogEntry(assetId) {
  const alias = assetAlias(assetId)
  if (!alias) return null
  const entry = CATALOG.find((candidate) => candidate.aliases.includes(alias))
  return entry ? { kind: entry.kind, verbs: [...entry.verbs] } : null
}

function metadataVariant(mapSeed, prop, modulus = 3) {
  return hashNumber(`${clean(mapSeed)}:${clean(prop?.id)}:${clean(prop?.assetId)}`) % Math.max(1, modulus)
}

/**
 * Строит контракт одного пропа только из серверно подтверждённых полей карты.
 * Переданный клиентом `prop.interaction` намеренно не читается.
 */
export function interactionMetadataForProp({ mapSeed = '', prop, pointOfInterest = false } = {}) {
  const catalog = sceneInteractionCatalogEntry(prop?.assetId)
  const propId = clean(prop?.id, 120)
  if (!catalog || !propId) return null
  const detailVariants = catalog.kind === 'campfire' ? 1 : 3
  const detailKey = `${catalog.kind}:${metadataVariant(mapSeed, prop, detailVariants)}`
  const rewards = REWARD_KEYS[catalog.kind] ?? []
  const rewardKey = rewards.length ? `${catalog.kind}:${rewards[metadataVariant(`${mapSeed}:reward`, prop, rewards.length)]}` : ''
  // Глаголы обстановки объявляются здесь же, а не только в разборе команды:
  // affordance пропса едет игроку картой, и кнопка «Опрокинуть» появляется
  // ровно потому, что сервер её назвал. Клиент рисует то, что ему прислали.
  const hazardVerbs = sceneHazardVerbsFor(prop?.assetId).filter((verb) => !catalog.verbs.includes(verb))
  // Молитва объявляется здесь же и по той же причине: affordance пропса едет
  // игроку картой, и кнопка «Помолиться» появляется ровно потому, что сервер её
  // назвал.
  const shrineVerbs = sceneShrineVerbsFor(prop?.assetId).filter((verb) => !catalog.verbs.includes(verb))
  return {
    kind: catalog.kind,
    verbs: [...catalog.verbs, ...hazardVerbs, ...shrineVerbs],
    pointOfInterest: pointOfInterest === true,
    detailKey,
    rewardKey,
  }
}

/**
 * Помечает ровно 2–4 поддержанных объекта (или все, если их меньше двух).
 *
 * Поддержанных объектов на карте стало заметно больше (задача 3.2b), поэтому
 * кандидатом в точку интереса считается не всякий из них, а только тот, за
 * которым стоит server-owned находка или знание. Обстановка остаётся
 * интерактивной, но приметной не объявляется.
 */
export function sceneInteractionMetadata({ mapSeed = '', props = [] } = {}) {
  const supported = (Array.isArray(props) ? props : [])
    .filter((prop) => clean(prop?.id, 120) && sceneInteractionCatalogEntry(prop?.assetId))
    .map((prop) => ({
      prop,
      kind: sceneInteractionCatalogEntry(prop?.assetId).kind,
      score: hashNumber(`${clean(mapSeed)}:poi:${clean(prop.id)}:${clean(prop.assetId)}`),
    }))
    .sort((left, right) => left.score - right.score || clean(left.prop.id).localeCompare(clean(right.prop.id)))
  const candidates = supported.filter((candidate) => POINT_OF_INTEREST_KINDS.includes(candidate.kind))
  const desired = candidates.length
    ? Math.min(candidates.length, 2 + (hashNumber(`${clean(mapSeed)}:poi-count`) % 3))
    : 0
  const diverse = []
  const selectedAssets = new Set()
  for (const candidate of candidates) {
    const assetId = clean(candidate.prop.assetId, 120)
    if (selectedAssets.has(assetId)) continue
    diverse.push(candidate)
    selectedAssets.add(assetId)
    if (diverse.length >= desired) break
  }
  const selectedEntries = [...diverse]
  const selectedIds = new Set(selectedEntries.map(({ prop }) => clean(prop.id, 120)))
  for (const candidate of candidates) {
    if (selectedEntries.length >= desired) break
    const propId = clean(candidate.prop.id, 120)
    if (selectedIds.has(propId)) continue
    selectedEntries.push(candidate)
    selectedIds.add(propId)
  }
  const selected = new Set(selectedEntries.map(({ prop }) => clean(prop.id, 120)))
  return new Map(supported.map(({ prop }) => [
    clean(prop.id, 120),
    interactionMetadataForProp({ mapSeed, prop, pointOfInterest: selected.has(clean(prop.id, 120)) }),
  ]))
}

export function sceneInteractionDefinition({ mapSeed = '', props = [], propId = '' } = {}) {
  const prop = (Array.isArray(props) ? props : []).find((candidate) => clean(candidate?.id, 120) === clean(propId, 120))
  if (!prop) return null
  const metadata = sceneInteractionMetadata({ mapSeed, props }).get(clean(prop.id, 120))
  if (!metadata) return null
  const alias = assetAlias(prop.assetId)
  const seed = `${clean(mapSeed)}:${clean(prop.id)}:${clean(prop.assetId)}`
  const difficulty = 10 + (hashNumber(`${seed}:dc`) % 3) * 2
  const locked = metadata.kind === 'container' && hashNumber(`${seed}:locked`) % 3 === 0
  const trapped = metadata.kind === 'container' && hashNumber(`${seed}:trap`) % 4 === 0
  const detail = DETAIL_TABLE[metadata.detailKey] ?? DETAIL_TABLE[`${metadata.kind}:0`]
  // Глаголы обстановки добавляются к обычным операциям, а не заменяют их:
  // стеллаж по-прежнему осматривают, но теперь его ещё можно опрокинуть.
  // Список объявляет сервер — клиент рисует кнопки по нему как и раньше.
  const hazardVerbs = sceneHazardVerbsFor(prop.assetId)
  const shrineVerbs = sceneShrineVerbsFor(prop.assetId)
  return {
    ...metadata,
    verbs: [
      ...metadata.verbs,
      ...hazardVerbs.filter((verb) => !metadata.verbs.includes(verb)),
      ...shrineVerbs.filter((verb) => !metadata.verbs.includes(verb) && !hazardVerbs.includes(verb)),
    ],
    shrine: isSceneShrineAsset(prop.assetId),
    topple: toppleDefinitionFor(prop.assetId),
    ignite: igniteDefinitionFor(prop.assetId),
    alias,
    initialState: metadata.kind === 'container' ? (locked ? 'locked' : 'closed') : 'idle',
    check: metadata.kind === 'relic'
      ? { ability: 'int', skill: alias === 'altar' || alias === 'statue' ? 'religion' : 'arcana', dc: difficulty, purpose: `scene-object:${metadata.kind}:inspect` }
      : metadata.kind === 'lore' || metadata.kind === 'corpse'
        ? { ability: 'wis', skill: 'investigation', dc: difficulty, purpose: `scene-object:${metadata.kind}:inspect` }
        : null,
    lock: locked ? { ability: 'dex', skill: 'sleight_of_hand', dc: difficulty, purpose: 'scene-object:container:lock' } : null,
    trap: trapped ? {
      notice: { ability: 'wis', skill: 'perception', dc: difficulty, purpose: 'scene-object:container:trap' },
      damage: { expression: '1d4', type: 'piercing', purpose: 'scene-object:container:trap-damage' },
    } : null,
    detail: detail ? { id: detail.id, text: detail.text } : null,
    effect: metadata.kind === 'relic' ? { id: 'minor-ward', temporary_hp: 1 } : null,
  }
}

export function sceneObjectLoot({ mapSeed = '', prop } = {}) {
  const item = serverEncounterLoot({
    theme: 'generic',
    difficulty: 'easy',
    encounterId: `scene:${clean(mapSeed)}:${clean(prop?.id)}:${clean(prop?.assetId)}`,
  })[0]
  if (!item) return []
  return [{
    ...item,
    id: `scene-loot-${clean(prop?.id, 80)}-1`,
    quantity: Math.max(1, Number(item.quantity) || 1),
    equipped: false,
    // Вещь из сундука, бочки или тайника — найденное. Ни купленным, ни снятым
    // с тела оно не является, и «неизвестно» здесь было бы отпиской: сервер
    // знает источник точно.
    origin: 'found',
  }]
}

export function sceneObjectOperationFromText(text) {
  const normalized = clean(text, 1_000).toLowerCase()
  if (!normalized) return null
  // Молитва стоит первой ветвью: «помолиться у алтаря» содержит «алтарь», но не
  // содержит ни одного глагола обычных операций, а «вознести молитву и осмотреть
  // изваяние» — это всё-таки молитва. Своего слова у неё нет ни у одной другой
  // ветки, поэтому первенство не отнимает у них ничего.
  //
  // Отмычка стоит сразу за молитвой и обязана стоять **до** силового
  // «взломать»: слово в русском одно на два разных действия, и без этого
  // порядка «вскрыть замок отмычкой» уезжало бы движку как «разбить сундук
  // плечом». Своих слов у отмычки достаточно — инструмент, замок или
  // ковыряние, — и ни одно из них другим веткам не принадлежит.
  // Классы букв заданы явно кириллицей: `\w` в JavaScript — это латиница,
  // цифры и подчёркивание, поэтому «ковыр\w*» не покрывает ни одного русского
  // окончания и молча не срабатывает.
  const lockpick = /(?:отмычк|(?:вскры|взлома|слома)[а-яё]*\s+замок|ковыр[а-яё]*\s+(?:в\s+)?замк|подобра[а-яё]*\s+ключ)/u.test(normalized)
  const intent = /(?:помолит|помолюсь|молит[ьв]|молюсь|вознес.{0,3} молитв|преклонить колен)/u.test(normalized)
    ? 'pray'
    : lockpick
      ? 'lockpick'
      : /(?:взять|забрать|поднять|обыскать)/u.test(normalized)
        ? 'take'
        : /(?:использовать|активировать|отдохнуть|привал)/u.test(normalized)
          ? 'use'
          : /(?:открыть|разбить|сломать|взломать|выломать)/u.test(normalized)
            ? 'open'
            : /(?:осмотреть|изучить|прочитать|проверить|обыскать)/u.test(normalized)
              ? 'inspect'
              : null
  if (!intent) return null
  // Подход силовой ровно там, где ломают. У отмычки он «рукой» независимо от
  // слова «взломать» в реплике: инструмент и плечо — разные способы, и
  // серверная ветка у них тоже разная.
  const approach = !lockpick && /(?:разбить|сломать|взломать|выломать|ударить|топор)/u.test(normalized) ? 'force' : 'hand'
  const aliases = Object.entries(ASSET_ALIASES_RU)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([alias]) => alias)
  return { intent, approach, aliases }
}

function propCells(prop) {
  if (Array.isArray(prop?.footprint) && prop.footprint.length) {
    return prop.footprint
      .map((cell) => ({ x: Number(cell?.x), y: Number(cell?.y) }))
      .filter((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y))
  }
  const x = Math.floor(Number(prop?.x))
  const y = Math.floor(Number(prop?.y))
  return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
}

export function sceneObjectDistance(prop, actorPosition) {
  const at = { x: Number(actorPosition?.x), y: Number(actorPosition?.y) }
  if (!Number.isSafeInteger(at.x) || !Number.isSafeInteger(at.y)) return Number.POSITIVE_INFINITY
  return Math.min(...propCells(prop).map((cell) => Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y))), Number.POSITIVE_INFINITY)
}

export function nearestSceneObjectCommand({ props = [], actorPosition, text } = {}) {
  const operation = sceneObjectOperationFromText(text)
  if (!operation) return null
  const candidates = (Array.isArray(props) ? props : [])
    .filter((prop) => sceneInteractionCatalogEntry(prop?.assetId))
    // Молиться можно только святыне. Без этого фильтра «помолюсь» у ближайшего
    // сундука уезжало бы движку командой, которую он же и отвергнет: слово
    // молитвы своё, а ближайший поддержанный пропс — какой угодно.
    .filter((prop) => operation.intent !== 'pray' || isSceneShrineAsset(prop?.assetId))
    // Замок бывает только у контейнера. Без этого фильтра «вскрыть замок»
    // уезжало бы движку с ближайшей скамьёй в поле `prop_id`: слово отмычки
    // своё, а ближайший поддержанный пропс — какой угодно.
    .filter((prop) => operation.intent !== 'lockpick' || sceneInteractionCatalogEntry(prop?.assetId)?.kind === 'container')
    .filter((prop) => {
      if (!operation.aliases.length) return true
      const alias = assetAlias(prop.assetId)
      return alias && operation.aliases.includes(alias)
    })
    .map((prop) => ({ prop, distance: sceneObjectDistance(prop, actorPosition) }))
    .sort((left, right) => left.distance - right.distance || clean(left.prop.id).localeCompare(clean(right.prop.id)))
  const selected = candidates[0]?.prop
  return selected ? {
    command_type: 'OperateSceneObject',
    prop_id: clean(selected.id, 120),
    intent: operation.intent,
    approach: operation.approach,
  } : null
}

export function sceneInteractionNarration(events = []) {
  const batch = Array.isArray(events) ? events : []
  const relevant = batch.filter((event) => String(event?.event_type ?? '').startsWith('SceneObject')
    || event?.event_type === 'RestCompleted'
    || event?.event_type === 'LockpickNoticed'
    || (event?.event_type === 'DamageApplied' && event?.payload?.reason === 'scene-object-trap'))
  if (!relevant.length) return ''
  // Шум у замка называется первым: это единственное последствие взлома, о
  // котором игрок обязан узнать сразу, — на возню обернулись, и дальше сцена
  // пойдёт иначе. СЛ замка строка не выдаёт ни в одном исходе.
  const noticed = relevant.find((event) => event.event_type === 'LockpickNoticed')
  if (noticed) {
    return noticed.payload?.reason === 'trace'
      ? 'Замок вскрыт тихо, но сорванная дужка бросается в глаза: на неё уже смотрят.'
      : noticed.payload?.severity === 'major'
        ? 'Отмычка срывается с громким лязгом — в сцене оборачиваются на звук.'
        : 'Замок не поддаётся и предательски звякает: возню у него слышали.'
  }
  const knowledge = relevant.find((event) => event.event_type === 'SceneObjectKnowledgeRevealed')
  if (knowledge?.payload?.text) return clean(knowledge.payload.text, 500)
  const loot = relevant.find((event) => event.event_type === 'SceneObjectLootGranted')
  if (loot) {
    const names = (Array.isArray(loot.payload?.loot) ? loot.payload.loot : [])
      .map((item) => clean(item?.name, 120))
      .filter(Boolean)
    return names.length ? `Находка забрана: ${names.join(', ')}.` : 'Находка забрана.'
  }
  const trap = relevant.find((event) => event.event_type === 'DamageApplied' && event.payload?.reason === 'scene-object-trap')
  if (trap) return `Сработала ловушка: ${Math.max(0, Number(trap.payload?.applied_amount) || 0)} урона.`
  const revealed = relevant.find((event) => event.event_type === 'SceneObjectLootRevealed')
  if (revealed) {
    const names = (Array.isArray(revealed.payload?.loot) ? revealed.payload.loot : [])
      .map((item) => clean(item?.name, 120))
      .filter(Boolean)
    return names.length ? `Внутри обнаружено: ${names.join(', ')}.` : 'Внутри обнаружена находка.'
  }
  const rest = relevant.find((event) => event.event_type === 'RestCompleted' && event.payload?.source_prop_id)
  if (rest) return 'У костра завершён короткий привал.'
  const state = [...relevant].reverse().find((event) => event.event_type === 'SceneObjectStateChanged')
  if (state?.payload?.success === false) {
    return state.payload.intent === 'lockpick'
      ? 'Замок не поддался отмычке.'
      : 'Попытка не удалась; состояние объекта не изменилось.'
  }
  if (state?.payload?.state === 'open') {
    return state.payload.intent === 'lockpick' ? 'Замок поддался отмычке, крышка откинута.' : 'Объект открыт.'
  }
  if (state?.payload?.state === 'taken') return 'Содержимое объекта забрано.'
  if (state?.payload?.state === 'used') return 'Эффект объекта использован.'
  const inspected = relevant.find((event) => event.event_type === 'SceneObjectInspected')
  if (inspected) return inspected.payload?.success === false
    ? 'Осмотр не дал уверенного ответа.'
    : 'Объект осмотрен.'
  return 'Взаимодействие с объектом завершено.'
}
