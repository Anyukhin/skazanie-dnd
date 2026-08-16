/**
 * Контейнеры добычи: куда девается вещь, когда её хозяин выбыл.
 *
 * До этого модуля инвентарь противника (`server/enemy-loadouts.mjs`) был вещью
 * в один конец: гоблин приходил в бой со скимитаром, гоблин погибал — и
 * скимитар исчезал вместе с записью `state.enemies[].loadout`. Награда после
 * встречи выдавалась отдельной таблицей (`server/loot-tables.mjs`) и с телом
 * никак не связана. Здесь замыкается середина: у выбывшего появляется
 * **контейнер**, и это единственное место, где отряд может взять именно то,
 * чем противник действительно дрался.
 *
 * ## Четыре решения, которые здесь нельзя обойти
 *
 * 1. **Контейнер создаётся в том же коммите, что и фиксация выбытия.** Не
 *    отдельной командой, не «после боя» и не по кнопке ведущего: между смертью
 *    и телом не должно быть окна, в котором инвентарь ещё у актора, а актора
 *    уже нет. Черновики собирает `planLootContainerDrafts` из пары состояний
 *    «до/после» и списка событий этой же фиксации, а вклеивает их в поток
 *    Rules Engine — там, где лежит команда и её `source_rule_ids`.
 *
 * 2. **Остаток переезжает, а не пересобирается.** В контейнер кладутся те же
 *    экземпляры (`server/item-instances.mjs`), которые лежали в инвентаре
 *    противника на момент выбытия, и из инвентаря они при этом убираются.
 *    Поэтому выпитое зелье не воскресает, а расстрелянный колчан приходит
 *    полупустым: количество и заряды — это остаток, а не запись шаблона.
 *
 * 3. **Клиент не называет вещь.** Команда `LootContainer` несёт только ключи:
 *    контейнер, идентификаторы экземпляров и количества. Название, вес, цена,
 *    механика и происхождение читаются из контейнера. Иначе «взять добычу»
 *    стало бы дверью для выдуманного предмета — ровно той, которую
 *    `assertEnemyLoadoutItem` закрывает на входе.
 *
 * 4. **Набор берётся целиком или не берётся вовсе.** Перегруз, исчезнувший
 *    экземпляр, чужой получатель — любая непройденная проверка отменяет всю
 *    команду и **не** тратит действие: события не выпускаются, а значит и
 *    экономику хода тратить нечем.
 *
 * ## Что такое «то же место»
 *
 * Контейнер живёт не в сцене, а в состоянии кампании, и помнит свой этаж:
 * ключ — `levelKey(sceneLocationId, sceneLevelIndex)`, тот же, которым
 * `rememberCurrentSceneMap` подписывает карту яруса. Поэтому невзятое
 * переживает и уход со сцены, и подъём на другой этаж: отряд вернётся и найдёт
 * тело там, где его оставил. Стэш жителей неактивного этажа
 * (`stashLevelEntities`, `rules-engine.mjs`) контейнеров не касается по
 * построению — они не «жители», а обстановка.
 *
 * ## Осознанные границы (решено, а не забыто)
 *
 * - **Пустой контейнер не создаётся.** Тело волка не носит ничего, и «Тело:
 *   Волк (пусто)» было бы мусором на доске и в состоянии.
 * - **Карман противника (`loadout.purse_cp`) сюда не переезжает.** Монеты
 *   встречи считает своя политика (`ENCOUNTER_COINS_POLICY_ID`), и второй
 *   источник тех же медяков означал бы двойную выплату.
 * - **`cache` объявлен, но никем не создаётся.** Схрон — это находка, которую
 *   кладёт архитектор области, а не следствие чьего-то выбытия; вид назван
 *   здесь, чтобы у будущего производителя не появилось второго словаря.
 * - **Вне боя получатель не обязан стоять у тела.** Пять футов меряются
 *   обыскивающему, а не тому, кому вещь достаётся: `TransferItem`
 *   (`server/item-lifecycle.mjs`) вне боя тоже не меряет расстояние между
 *   героями, и своё правило досягаемости здесь означало бы, что отдать вещь
 *   соратнику нельзя обыском, но можно следующей же командой передачи. В бою
 *   этот путь закрыт целиком (`LOOT_RECIPIENT_DURING_COMBAT`) — ровно там, где
 *   закрыт и сам `TransferItem`.
 * - **Цена в карточке — только каталожная.** `lootItemForViewer` показывает ту
 *   же цену, какую вещь получит в сумке героя, и молчит, когда её нет: снимок
 *   экземпляра несёт цену любой записи каталога, а инвентарь героя признаёт
 *   только торговый каталог (`resolveCatalogBasePriceCp`). Обещать за скимитар
 *   25 зм, которых движок потом не выдаст, хуже, чем не обещать ничего;
 *   оценка снятого с тела — отдельный шаг, и он ещё не сделан.
 */
import { createHash } from 'node:crypto'

import { levelKey, sceneLevelIndex, sceneLocationId } from './adventure-director.mjs'
import { normalizeItemInstance } from './item-instances.mjs'
import { carryingCapacity, inventoryWeight } from './item-lifecycle.mjs'
import { MAX_STOCK_QUANTITY, inventoryStackKey, normalizeInventoryItem, resolveCatalogBasePriceCp } from './merchant-economy.mjs'
import { campaignElapsedMinutes } from './npc-social.mjs'

export const LOOT_CONTAINERS_SCHEMA_VERSION = 1
export const LOOT_CONTAINERS_POLICY_ID = 'skazanie:loot-containers-v1'
export const LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION = 1
export const LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION = 1

/**
 * Виды контейнеров. `corpse` — тело, `captive` — снятое с пленного оружие,
 * `abandoned` — брошенное по уговору парлея, `cache` — схрон (см. границы выше).
 */
export const LOOT_CONTAINER_KINDS = Object.freeze(['corpse', 'captive', 'abandoned', 'cache'])
export const LOOT_CONTAINER_STATUSES = Object.freeze(['available', 'emptied'])

export const LOOT_CONTAINER_COMMAND_TYPES = Object.freeze(new Set(['LootContainer']))

/** Обыскивают вытянутой рукой: своя клетка или соседняя. */
export const LOOT_CONTAINER_REACH_FEET = 5

export const MAX_LOOT_CONTAINERS = 60
export const MAX_LOOT_CONTAINER_ITEMS = 24
export const MAX_LOOT_LINES = 12
/** Столько предметов держит инвентарь героя — та же граница, что у награды встречи. */
export const MAX_LOOT_RECIPIENT_INVENTORY_ITEMS = 200

export class LootContainerError extends Error {
  constructor(message, code = 'LOOT_CONTAINER_INVALID') {
    super(message)
    this.name = 'LootContainerError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function reject(message, code) {
  throw new LootContainerError(message, code)
}

function actorIdOf(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function coordinate(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

/**
 * Приведение одного контейнера. Вход недоверенный: он приезжает и из
 * сохранения, и из payload события, и из административного импорта состояния.
 *
 * @param {Record<string, any>} [value]
 * @returns {Record<string, any> | null} `null` — запись не является контейнером
 */
export function normalizeLootContainer(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const id = text(source.id, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id)) return null
  const kind = LOOT_CONTAINER_KINDS.includes(source.kind) ? String(source.kind) : ''
  if (!kind) return null
  const items = (Array.isArray(source.items) ? source.items : [])
    .slice(0, MAX_LOOT_CONTAINER_ITEMS)
    .map((item) => normalizeItemInstance(item))
    .filter(Boolean)
  const seen = new Set()
  const unique = items.filter((item) => {
    const key = String(item.item_instance_id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    policy_id: LOOT_CONTAINERS_POLICY_ID,
    id,
    kind,
    source_enemy_id: text(source.source_enemy_id ?? source.sourceEnemyId, 120),
    source_enemy_ids: [...new Set((Array.isArray(source.source_enemy_ids) ? source.source_enemy_ids : [])
      .map((entry) => text(entry, 120)).filter(Boolean))].slice(0, 12),
    encounter_id: text(source.encounter_id ?? source.encounterId, 160),
    name: text(source.name, 160) || 'Добыча',
    location_id: text(source.location_id ?? source.locationId, 180),
    location_name: text(source.location_name ?? source.locationName, 180),
    x: coordinate(source.x),
    y: coordinate(source.y),
    // Пустой контейнер — всегда опустошённый, каким бы ни был сохранённый
    // статус: иначе повреждённая запись висела бы на доске приманкой.
    status: unique.length === 0
      ? 'emptied'
      : LOOT_CONTAINER_STATUSES.includes(source.status) ? String(source.status) : 'available',
    created_at_minutes: Math.max(0, integer(source.created_at_minutes ?? source.createdAtMinutes, 0)),
    items: unique,
  }
}

/**
 * Кого вытеснить, когда реестр перерос бюджет.
 *
 * Порядок здесь — это правило, а не оптимизация. Обычный `slice(-N)` режет по
 * возрасту, и невзятое тело разбойника исчезало бы молча, освобождая место
 * шестидесяти уже обобранным. Опустошённый контейнер — часть пейзажа: он не
 * виден на доске, не обыскивается и ничего не хранит, поэтому уходит первым.
 * Невзятое уступает место последним и только друг другу — по возрасту.
 */
function evictLootOverflow(containers) {
  if (containers.length <= MAX_LOOT_CONTAINERS) return containers
  const doomed = new Set()
  let excess = containers.length - MAX_LOOT_CONTAINERS
  for (const status of ['emptied', 'available']) {
    for (let index = 0; index < containers.length && excess > 0; index += 1) {
      if (doomed.has(index) || containers[index].status !== status) continue
      doomed.add(index)
      excess -= 1
    }
  }
  return containers.filter((_, index) => !doomed.has(index))
}

export function normalizeLootContainersState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const containers = []
  const seen = new Set()
  for (const raw of Array.isArray(source.containers) ? source.containers : []) {
    const container = normalizeLootContainer(raw)
    if (!container || seen.has(container.id)) continue
    seen.add(container.id)
    containers.push(container)
  }
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    containers: evictLootOverflow(containers),
  }
}

export function lootContainerList(state = {}) {
  return normalizeLootContainersState(state?.loot_containers).containers
}

export function lootContainerFor(state = {}, containerId) {
  const expected = text(containerId, 120)
  return lootContainerList(state).find((container) => container.id === expected) ?? null
}

/** Ключ яруса, на котором сейчас стоит отряд. Тот же, которым подписана карта. */
export function sceneLootLocationKey(state = {}) {
  return levelKey(sceneLocationId(state), sceneLevelIndex(state))
}

/**
 * Контейнеры текущего яруса. Опустошённые скрыты: взятое тело — это уже часть
 * пейзажа, а не предложение.
 */
export function lootContainersInScene(state = {}, { includeEmptied = false } = {}) {
  const key = sceneLootLocationKey(state)
  return lootContainerList(state)
    .filter((container) => container.location_id === key)
    .filter((container) => includeEmptied || container.status === 'available')
}

/**
 * Идентификатор контейнера.
 *
 * В свёртку идёт не только «кто выбыл», но и **где, в какой встрече и на какой
 * минуте**. Причина конкретна: id противника — чистая функция сида встречи
 * (`enemyFrom`, `server/encounter-assembler.mjs` строит его из `proposalHash`),
 * а сид ведущий вправе прислать в `/encounters/assemble` явно. Тот же сид, тот
 * же зал, тот же отряд — те же id противников; без места и времени в свёртке
 * второе тело получило бы идентификатор первого и село бы поверх него.
 *
 * Воспроизводимость от этого не страдает: id уезжает в payload события целиком,
 * и реплей читает его оттуда, а не пересчитывает.
 */
export function lootContainerIdFor(kind, sourceIds = [], scope = {}) {
  const parts = [...sourceIds].map((value) => text(value, 160)).sort()
  const place = [
    text(scope.encounterId, 160),
    text(scope.locationKey, 180),
    String(Math.max(0, integer(scope.minutes, 0))),
  ]
  return `loot:${text(kind, 20)}:${digest(kind, ...place, ...parts).slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// Создание вместе с фиксацией выбытия
// ---------------------------------------------------------------------------

const CONTAINER_TITLES = Object.freeze({
  corpse: 'Тело',
  captive: 'Оружие пленного',
  abandoned: 'Брошенная добыча',
  cache: 'Схрон',
})

function containerName(kind, enemyName) {
  const title = CONTAINER_TITLES[kind] ?? 'Добыча'
  const name = text(enemyName, 100)
  return kind === 'abandoned' || !name ? title : `${title}: ${name}`
}

function lootableItemsOf(enemy, { weaponsOnly = false } = {}) {
  return (Array.isArray(enemy?.loadout?.items) ? enemy.loadout.items : [])
    .map((item) => normalizeItemInstance(item))
    .filter(Boolean)
    .filter((item) => item.lootable === true)
    .filter((item) => !weaponsOnly || String(item.snapshot?.type ?? '') === 'weapon')
}

/**
 * Экземпляр меняет владельца. `origin` не переписывается намеренно: откуда
 * вещь взялась — это её история, и после переезда в контейнер она не
 * становится «ничьей находкой».
 */
function itemForContainer(item, containerId) {
  return normalizeItemInstance({
    ...clone(item),
    equipped: false,
    owner: { kind: 'container', actor_id: containerId },
  })
}

function positionOf(state, actorId) {
  const stored = state?.mechanics?.positions?.[String(actorId ?? '')]
  return { x: coordinate(stored?.x), y: coordinate(stored?.y) }
}

function containerDraft({ kind, enemies, sourceIds, state, minutes, locationKey, locationName, encounterId, weaponsOnly = false, anchorId }) {
  const containerId = lootContainerIdFor(kind, sourceIds, { encounterId, locationKey, minutes })
  const items = enemies
    .flatMap((enemy) => lootableItemsOf(enemy, { weaponsOnly }))
    .slice(0, MAX_LOOT_CONTAINER_ITEMS)
    .map((item) => itemForContainer(item, containerId))
  // Пустой контейнер не создаётся: см. границы в шапке модуля.
  if (!items.length) return null
  const anchor = positionOf(state, anchorId)
  return {
    event_type: 'LootContainerCreated',
    event_schema_version: LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION,
    payload: {
      schema_version: LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION,
      policy_id: LOOT_CONTAINERS_POLICY_ID,
      container: normalizeLootContainer({
        id: containerId,
        kind,
        source_enemy_id: sourceIds.length === 1 ? sourceIds[0] : '',
        source_enemy_ids: sourceIds,
        encounter_id: encounterId,
        name: containerName(kind, enemies.length === 1 ? enemies[0]?.name : ''),
        location_id: locationKey,
        location_name: locationName,
        x: anchor.x,
        y: anchor.y,
        status: 'available',
        created_at_minutes: minutes,
        items,
      }),
    },
    target_ids: sourceIds,
    visibility: 'party',
  }
}

/**
 * Может ли эта фиксация вообще породить контейнер.
 *
 * Дешёвый гейт перед дорогим шагом: `planLootContainerDrafts` сравнивает
 * состояния «до/после», а «после» — это повторное проигрывание всего потока.
 * Платить за него на каждой команде нельзя: переход между этажами тащит карту
 * в десять тысяч клеток, и лишний replay съедал бюджет перехода целиком.
 *
 * Проверяется ровно то, без чего контейнера быть не может: есть ли у кого
 * отбирать и случилось ли в потоке событие, способное вывести противника из
 * боя. Обнуление ОЗ ловится по самому payload (`hp_after: 0`), а не по списку
 * типов событий: писать ОЗ умеют несколько разных событий, а поле у них одно.
 *
 * Обнулиться при этом может кто угодно, и герой падает в бою куда чаще, чем
 * гибнет вооружённый противник. Поэтому мало найти `hp_after: 0` — нужно, чтобы
 * ноль принадлежал тому, у кого есть что отбирать: имя пострадавшего лежит в
 * `target_ids` события, и сверка с ним стоит один проход по короткому списку
 * вместо полного `replayEvents` на каждом падении героя.
 */
export function lootCommitTouchesContainers(before = {}, events = []) {
  const lootable = new Set((Array.isArray(before?.enemies) ? before.enemies : [])
    .filter((enemy) => (Array.isArray(enemy?.loadout?.items) ? enemy.loadout.items : [])
      .some((item) => item?.lootable === true))
    .map((enemy) => actorIdOf(enemy))
    .filter(Boolean))
  if (!lootable.size) return false
  return (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'CaptiveTaken'
    || (event?.event_type === 'ParleySettled' && String(event?.payload?.outcome ?? '') === 'tribute')
    || (event?.payload?.hp_after === 0
      && (Array.isArray(event?.target_ids) ? event.target_ids : []).some((id) => lootable.has(String(id)))))
}

/**
 * Черновики контейнеров для одной фиксации.
 *
 * @param {Record<string, any>} before состояние до команды
 * @param {Record<string, any>} after состояние после применения событий команды
 * @param {Array<Record<string, any>>} events события этой же фиксации
 * @returns {Array<Record<string, any>>} черновики `LootContainerCreated`
 */
export function planLootContainerDrafts(before = {}, after = {}, events = []) {
  const eventList = Array.isArray(events) ? events : []
  const minutes = campaignElapsedMinutes(after)
  const locationKey = sceneLootLocationKey(after)
  // Сторожем дублей служит не весь реестр кампании, а только то, что новый
  // контейнер способен собой стереть: `withContainer` заменяет запись по id, и
  // потерять можно ровно невзятое на этом же ярусе. Опустошённые и чужие ярусы
  // из списка убраны намеренно — иначе однажды обобранное тело навсегда
  // запрещало бы контейнер с тем же идентификатором, а идентификатор
  // повторяется: id противника — функция сида встречи (см. `lootContainerIdFor`).
  const existing = new Set(lootContainerList(after)
    .filter((container) => container.location_id === locationKey && container.status === 'available')
    .map((container) => container.id))
  const locationName = text(after?.scene?.location ?? after?.scene?.title, 180)
  const encounterId = text(after?.mechanics?.encounter?.id ?? after?.mechanics?.encounter?.encounter_id, 160)
  const enemiesBefore = new Map((Array.isArray(before?.enemies) ? before.enemies : []).map((enemy) => [actorIdOf(enemy), enemy]))
  const enemiesAfter = new Map((Array.isArray(after?.enemies) ? after.enemies : []).map((enemy) => [actorIdOf(enemy), enemy]))

  // Плен фиксируется собственным событием и в том же коммите: разоружение
  // обязано ехать рядом с ним, а не «когда-нибудь потом».
  const captured = new Set(eventList
    .filter((event) => event?.event_type === 'CaptiveTaken')
    .map((event) => String(event?.payload?.captive?.actor_id ?? ''))
    .filter(Boolean))

  // «Уйти, оставив добычу» — исход парлея `tribute`. Уговор про монеты уже
  // исполнен самим событием; вещи уходящих остаются полю боя.
  const tribute = eventList.find((event) => event?.event_type === 'ParleySettled' && String(event?.payload?.outcome ?? '') === 'tribute')
  const tributeIds = new Set((Array.isArray(tribute?.payload?.enemy_ids) ? tribute.payload.enemy_ids : []).map(String))

  const drafts = []
  const abandoned = []
  for (const [enemyId, enemyBefore] of [...enemiesBefore.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const enemyAfter = enemiesAfter.get(enemyId)
    // Противника заменили новым составом встречи в этом же коммите — тела на
    // этой доске уже нет, и выдумывать его здесь нельзя.
    if (!enemyAfter) continue
    // Плен проверяется **до** «был ли жив»: сдавшийся перестал быть боевым
    // актором ещё в момент сдачи (`alive: false` у условия `surrendered`), а в
    // плен переходит на конце боя, отдельным коммитом. Требуй здесь живого — и
    // разоружение не случилось бы ни разу.
    if (captured.has(enemyId)) {
      const draft = containerDraft({
        kind: 'captive',
        enemies: [enemyAfter],
        sourceIds: [enemyId],
        state: before,
        minutes,
        locationKey,
        locationName,
        encounterId,
        weaponsOnly: true,
        anchorId: enemyId,
      })
      if (draft && !existing.has(draft.payload.container.id)) drafts.push(draft)
      continue
    }
    if (tributeIds.has(enemyId)) {
      abandoned.push(enemyAfter)
      continue
    }
    // Тело появляется на переходе «были ОЗ — не осталось». Сравнение идёт по
    // очкам, а не по флагу `alive`: сдавшийся и сбежавший тоже носят
    // `alive: false`, и по флагу их тела появлялись бы посреди живого боя.
    if (Math.max(0, integer(enemyBefore.hp, 0)) > 0 && Math.max(0, integer(enemyAfter.hp, 0)) === 0) {
      const draft = containerDraft({
        kind: 'corpse',
        enemies: [enemyAfter],
        sourceIds: [enemyId],
        state: before,
        minutes,
        locationKey,
        locationName,
        encounterId,
        anchorId: enemyId,
      })
      if (draft && !existing.has(draft.payload.container.id)) drafts.push(draft)
    }
  }
  if (abandoned.length) {
    const sourceIds = abandoned.map(actorIdOf).sort()
    const draft = containerDraft({
      kind: 'abandoned',
      enemies: abandoned,
      sourceIds,
      state: before,
      minutes,
      locationKey,
      locationName,
      encounterId,
      anchorId: sourceIds[0],
    })
    if (draft && !existing.has(draft.payload.container.id)) drafts.push(draft)
  }
  return drafts
}

// ---------------------------------------------------------------------------
// Команда обыска
// ---------------------------------------------------------------------------

/**
 * Поля команды. Список закрыт по той же причине, что и у действий с предметом
 * (`assertPlainCommand`, `server/item-lifecycle.mjs`): лишнее поле — это чужой
 * вес, чужая цена или чужая механика, приехавшие мимо контейнера.
 *
 * `merchant_id`, `stock_id`, `action_id`, `item_id` и `quantity` нужны не сами
 * по себе — их проставляет каждой команде `normalizeCommand`, и без них
 * закрытый список падал бы на собственном нормализаторе.
 */
const LOOT_COMMAND_FIELDS = new Set([
  'command_type', 'command_id', 'campaign_id', 'actor_id', 'target_id', 'target_ids',
  'container_id', 'lines', 'recipient_id',
  'merchant_id', 'stock_id', 'action_id', 'item_id', 'quantity',
  'expected_state_version', 'source_rule_ids', 'house_rule_id', 'ruling_id', 'visibility',
  'request_fingerprint', 'server_authoritative',
])

export function normalizeLootLines(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, MAX_LOOT_LINES).flatMap((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return []
    const itemInstanceId = text(line.item_instance_id ?? line.itemInstanceId, 160)
    if (!itemInstanceId) return []
    return [{ item_instance_id: itemInstanceId, quantity: integer(line.quantity, 1) }]
  })
}

function playerActor(state, id) {
  return (Array.isArray(state?.players) ? state.players : [])
    .find((candidate) => actorIdOf(candidate) === String(id ?? '')) ?? null
}

function inPartyWith(state, id) {
  const ids = (Array.isArray(state?.partyMemberIds) && state.partyMemberIds.length
    ? state.partyMemberIds
    : (state?.players ?? []).map(actorIdOf)).map(String)
  return ids.includes(String(id))
}

function reachable(state, actor, container) {
  // У контейнера без клетки досягаемость проверяется только сценой: так бывает
  // у противника, которого на доске не было вовсе. Придумывать ему координату
  // нельзя — тогда «в пяти футах» стало бы неправдой в обе стороны.
  if (container.x == null || container.y == null) return true
  const position = positionOf(state, actorIdOf(actor))
  if (position.x == null || position.y == null) return false
  const distance = Math.max(Math.abs(position.x - container.x), Math.abs(position.y - container.y)) * 5
  return distance <= LOOT_CONTAINER_REACH_FEET
}

/**
 * Экземпляр контейнера → запись инвентаря героя.
 *
 * На вход идёт **снимок экземпляра**, а не запись каталога: имя, вес, боевые
 * числа и остаток зарядов переезжают ровно те, что лежали на теле. Дальше
 * работает общий нормализатор инвентаря, и цену он по-прежнему разрешает своей
 * политикой — как у любой другой вещи героя; заводить второй порядок цен ради
 * добычи было бы расхождением, а не строгостью.
 *
 * Практическое следствие названо честно: торговый каталог
 * (`SRD_EQUIPMENT_CATALOG`) — это двенадцать записей, и большая часть снятого с
 * тел оружия приходит в сумку без `base_price_cp` и с пустым
 * `price_provenance`. Карточка контейнера показывает ровно ту же цену, поэтому
 * расхождения «обещали — не выдали» здесь нет; появится оценка добычи —
 * появится и цена, одним шагом в обоих местах.
 */
export function inventoryItemFromInstance(instance, { id, quantity }) {
  const snapshot = instance?.snapshot && typeof instance.snapshot === 'object' ? instance.snapshot : {}
  return normalizeInventoryItem({
    ...clone(snapshot),
    id,
    quantity,
    equipped: false,
    // `properties` в снимке нет намеренно (см. `SNAPSHOT_FIELDS`,
    // `server/item-instances.mjs`): там лежал байт-в-байт дубль описания, и
    // события несли его вечно. Карточке инвентаря поле нужно, и она получает
    // ровно то же, что у купленной вещи, — описание записи каталога.
    properties: text(snapshot.description, 500),
    ...(instance?.charges ? { charges: clone(instance.charges) } : {}),
  })
}

function lootedItemId(commandId, containerId, itemInstanceId) {
  return `loot:${digest(commandId, containerId, itemInstanceId).slice(0, 24)}`
}

/**
 * Проверка команды обыска. Возвращает обогащённую команду — с уже собранным
 * набором того, что переедет, и с ценой в экономике хода.
 *
 * Порядок проверок — от прав к физике: сначала «имеет ли право», потом «может
 * ли дотянуться», и только потом «поместится ли». Любой отказ отменяет всю
 * команду целиком, поэтому частично взятого набора не существует.
 */
export function validateLootContainerCommand(command, state, context = {}) {
  if (!LOOT_CONTAINER_COMMAND_TYPES.has(command?.command_type)) return command
  const unexpected = Object.keys(command).filter((key) => !LOOT_COMMAND_FIELDS.has(key))
  if (unexpected.length) {
    reject(`Команда обыска содержит запрещённые поля: ${unexpected.join(', ')}`, 'LOOT_COMMAND_UNKNOWN_FIELD')
  }
  const ownerId = text(command.actor_id, 120)
  const owner = playerActor(state, ownerId)
  if (!owner) reject('Обыскивать может только герой отряда', 'ACTOR_FORBIDDEN')
  if (!inPartyWith(state, ownerId)) reject('Обыскивать может только герой отряда', 'ACTOR_FORBIDDEN')
  const allowed = context?.isAdmin === true
    || (Array.isArray(context?.allowedActorIds) ? context.allowedActorIds.map(String) : []).includes(ownerId)
  if (!allowed) reject('Обыскивать можно только своим героем', 'ACTOR_FORBIDDEN')
  if (owner.alive === false || Math.max(0, integer(owner.hp, 0)) <= 0) {
    reject('Герой без сознания не обыскивает', 'ACTOR_DEFEATED')
  }

  const container = lootContainerFor(state, command.container_id)
  if (!container) reject('Контейнер добычи не найден', 'LOOT_CONTAINER_NOT_FOUND')
  if (container.status !== 'available') reject('Здесь уже ничего не осталось', 'LOOT_CONTAINER_EMPTY')
  if (container.location_id !== sceneLootLocationKey(state)) {
    reject('Этот контейнер остался в другом месте', 'LOOT_CONTAINER_NOT_IN_SCENE')
  }
  if (!reachable(state, owner, container)) {
    reject('До добычи надо дойти: обыскивают в пределах пяти футов', 'LOOT_CONTAINER_OUT_OF_REACH')
  }

  const lines = normalizeLootLines(command.lines)
  if (!lines.length) reject('Не выбрано ни одного предмета', 'LOOT_LINES_REQUIRED')
  if (new Set(lines.map((line) => line.item_instance_id)).size !== lines.length) {
    reject('Один и тот же предмет указан дважды', 'LOOT_LINE_DUPLICATE')
  }
  const byInstanceId = new Map(container.items.map((item) => [String(item.item_instance_id), item]))
  const taken = lines.map((line) => {
    const instance = byInstanceId.get(line.item_instance_id)
    if (!instance) reject('Этого предмета в контейнере уже нет', 'LOOT_ITEM_GONE')
    const available = Math.max(0, integer(instance.quantity, 1))
    if (line.quantity < 1 || line.quantity > available) {
      reject('Недопустимое количество предметов', 'LOOT_QUANTITY_INVALID')
    }
    return { instance, quantity: line.quantity }
  })

  const recipientId = text(command.recipient_id, 120) || ownerId
  const recipient = playerActor(state, recipientId)
  if (!recipient || !inPartyWith(state, recipientId)) {
    reject('Получатель должен быть героем этого отряда', 'LOOT_RECIPIENT_INVALID')
  }
  // В бою добыча уходит только тому, кто нагнулся: передавать её через полполя
  // посреди боя — это уже `TransferItem`, и он в бою запрещён.
  //
  // Вне боя расстояние до получателя не меряется, и это решение, а не пропуск:
  // `TransferItem` вне боя тоже не меряет его между героями, поэтому своё
  // правило досягаемости здесь означало бы только лишний шаг — отказ обыском и
  // немедленное разрешение следующей же командой передачи. Граница названа в
  // шапке модуля рядом с «пятью футами» обыскивающего.
  if (state?.mechanics?.combat?.active === true && recipientId !== ownerId) {
    reject('В бою добыча достаётся тому, кто обыскивает', 'LOOT_RECIPIENT_DURING_COMBAT')
  }

  const items = taken.map(({ instance, quantity }) => inventoryItemFromInstance(instance, {
    id: lootedItemId(command.command_id, container.id, instance.item_instance_id),
    quantity,
  }))
  const inventory = Array.isArray(recipient.inventory) ? recipient.inventory : []
  const existingIds = new Set((state?.players ?? []).flatMap((player) => (
    (player?.inventory ?? []).map((item) => String(item?.id ?? '')).filter(Boolean)
  )))
  if (items.some((item) => existingIds.has(String(item.id)))) {
    reject('Идентификатор поднятой вещи уже занят', 'LOOT_ITEM_ID_COLLISION')
  }
  const merged = items.filter((item) => inventory.some((candidate) => !candidate.equipped && !candidate.attuned_to
    && inventoryStackKey(candidate) === inventoryStackKey(item))).length
  if (inventory.length + items.length - merged > MAX_LOOT_RECIPIENT_INVENTORY_ITEMS) {
    reject('Инвентарь получателя заполнен', 'LOOT_INVENTORY_CAPACITY_EXCEEDED')
  }
  for (const item of items) {
    const stacked = inventory
      .filter((candidate) => !candidate.equipped && !candidate.attuned_to
        && inventoryStackKey(candidate) === inventoryStackKey(item))
      .reduce((total, candidate) => total + Math.max(1, integer(candidate.quantity, 1)), 0)
    if (stacked + Math.max(1, integer(item.quantity, 1)) > MAX_STOCK_QUANTITY) {
      reject('Стопка предметов получателя превысит допустимый размер', 'LOOT_STACK_LIMIT_EXCEEDED')
    }
  }
  const addedWeight = items.reduce((total, item) => (
    total + Math.max(0, Number(item.weight) || 0) * Math.max(1, integer(item.quantity, 1))
  ), 0)
  if (inventoryWeight(recipient) + addedWeight > carryingCapacity(recipient)) {
    reject('Получатель не унесёт столько', 'CARRYING_CAPACITY_EXCEEDED')
  }

  const remaining = container.items
    .map((item) => {
      const line = taken.find((entry) => entry.instance.item_instance_id === item.item_instance_id)
      return line ? { ...clone(item), quantity: Math.max(0, integer(item.quantity, 1) - line.quantity) } : clone(item)
    })
    .filter((item) => integer(item.quantity, 0) > 0)

  return {
    ...command,
    actor_id: ownerId,
    container_id: container.id,
    recipient_id: recipientId,
    lines: lines.map((line) => ({ ...line })),
    target_ids: [...new Set([ownerId, recipientId])],
    visibility: 'party',
    loot_container: container,
    loot_items: items,
    loot_remaining: remaining,
    // В бою обыск стоит действия — правило стола, а не редакции SRD; просмотр
    // при этом бесплатен и проходит проекцией, а не командой.
    loot_combat_action: state?.mechanics?.combat?.active === true ? 'action' : null,
  }
}

export function lootContainerCommandEvents(command) {
  if (!LOOT_CONTAINER_COMMAND_TYPES.has(command?.command_type)) return []
  const container = command.loot_container
  const remaining = Array.isArray(command.loot_remaining) ? command.loot_remaining : []
  return [{
    event_type: 'LootContainerTaken',
    event_schema_version: LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION,
    payload: {
      schema_version: LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION,
      policy_id: LOOT_CONTAINERS_POLICY_ID,
      container_id: container.id,
      container_kind: container.kind,
      container_name: container.name,
      actor_id: command.actor_id,
      recipient_id: command.recipient_id,
      lines: (command.lines ?? []).map((line) => ({ ...line })),
      items: clone(command.loot_items ?? []),
      remaining_items: clone(remaining),
      remaining_count: remaining.length,
      status_after: remaining.length ? 'available' : 'emptied',
      combat_action: command.loot_combat_action ?? null,
      request_fingerprint: command.request_fingerprint ?? null,
    },
    target_ids: [...new Set([String(command.actor_id), String(command.recipient_id)])],
    visibility: 'party',
  }]
}

// ---------------------------------------------------------------------------
// Редьюсеры
// ---------------------------------------------------------------------------

function withContainer(state, container) {
  const current = lootContainerList(state)
  const next = current.some((entry) => entry.id === container.id)
    ? current.map((entry) => entry.id === container.id ? container : entry)
    : [...current, container]
  return normalizeLootContainersState({ containers: next })
}

/**
 * Вещь ложится в сумку. Идентификатор поднятого детерминирован
 * (`lootedItemId(command_id, container_id, instance_id)`), поэтому «эта вещь уже
 * лежит» — проверяемый факт, а не догадка: повторное применение того же события
 * его не создаёт заново, а узнаёт и пропускает.
 */
function addLootedItem(inventory, incoming) {
  const current = Array.isArray(inventory) ? inventory : []
  const incomingId = String(incoming?.id ?? '')
  if (incomingId && current.some((item) => String(item?.id ?? '') === incomingId)) return current
  const index = current.findIndex((item) => !item?.equipped && !item?.attuned_to
    && inventoryStackKey(item) === inventoryStackKey(incoming))
  if (index < 0) return [...current, clone(incoming)]
  return current.map((item, itemIndex) => itemIndex === index
    ? { ...item, quantity: Math.min(MAX_STOCK_QUANTITY, integer(item.quantity, 1) + integer(incoming.quantity, 1)) }
    : item)
}

/** Остаток контейнера числами: экземпляр → количество. */
function instanceQuantities(items) {
  return new Map((Array.isArray(items) ? items : [])
    .map((item) => [String(item?.item_instance_id ?? ''), Math.max(0, integer(item?.quantity, 1))]))
}

function sameInstanceQuantities(left, right) {
  const first = instanceQuantities(left)
  const second = instanceQuantities(right)
  if (first.size !== second.size) return false
  for (const [id, quantity] of first) if (second.get(id) !== quantity) return false
  return true
}

/**
 * Применение событий контейнеров.
 *
 * Числа берутся **только** из payload: то же событие, применённое второй раз,
 * обязано давать тот же остаток и тот же инвентарь. Поэтому остаток контейнера
 * приезжает списком, а не досчитывается вычитанием по состоянию.
 *
 * Инвентарь получателя держит то же обещание двумя сторожами. Первый — сам
 * контейнер: если он уже стоит ровно на `remaining_items`, обыск состоялся, и
 * второе применение обязано пройти мимо сумки. Второй — детерминированный `id`
 * поднятой вещи: он один и тот же у любого повтора события, поэтому уже
 * лежащую в сумке вещь `addLootedItem` узнаёт и не складывает в стопку второй
 * раз. Живой путь всё равно закрыт транспортом (`assertLootIdempotency`,
 * `server/index.mjs`), но обещание шапки держится и без него.
 *
 * @returns {string[]} ID героев, чьи производные поля инвентаря надо обновить
 */
export function applyLootContainerEvent(state, event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  if (event?.event_type === 'LootContainerCreated'
    && Number(event.event_schema_version) === LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION
    && Number(payload.schema_version) === LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION) {
    const container = normalizeLootContainer(payload.container)
    if (!container) return []
    state.loot_containers = withContainer(state, container)
    // Вещь переезжает, а не копируется: инвентарь противника теряет ровно те
    // экземпляры, которые легли в контейнер.
    const movedIds = new Set(container.items.map((item) => String(item.item_instance_id)))
    const sourceIds = new Set([container.source_enemy_id, ...container.source_enemy_ids].filter(Boolean).map(String))
    if (sourceIds.size && Array.isArray(state.enemies)) {
      state.enemies = state.enemies.map((enemy) => {
        if (!sourceIds.has(actorIdOf(enemy))) return enemy
        const items = (Array.isArray(enemy?.loadout?.items) ? enemy.loadout.items : [])
          .filter((item) => !movedIds.has(String(item?.item_instance_id)))
        return { ...enemy, loadout: { ...(enemy.loadout ?? {}), items } }
      })
    }
    return []
  }
  if (event?.event_type === 'LootContainerTaken'
    && Number(event.event_schema_version) === LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION
    && Number(payload.schema_version) === LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION) {
    const containerId = text(payload.container_id, 120)
    const current = lootContainerFor(state, containerId)
    if (!current) return []
    const remaining = (Array.isArray(payload.remaining_items) ? payload.remaining_items : [])
      .map((item) => normalizeItemInstance(item))
      .filter(Boolean)
    // Контейнер уже стоит на остатке этого события — значит, обыск состоялся, и
    // вещи давно в сумке. Проверка идёт до `withContainer`: тот приведёт
    // состояние к тому же самому, а вот выдавать добычу второй раз нельзя.
    const alreadyApplied = sameInstanceQuantities(current.items, remaining)
    state.loot_containers = withContainer(state, normalizeLootContainer({
      ...current,
      items: remaining,
      status: remaining.length ? 'available' : 'emptied',
    }))
    if (alreadyApplied) return []
    const recipientId = text(payload.recipient_id, 120)
    const items = (Array.isArray(payload.items) ? payload.items : [])
      .map((item) => normalizeInventoryItem(item, { preserveUnknown: true }))
    if (!recipientId || !items.length) return []
    let applied = false
    state.players = (Array.isArray(state.players) ? state.players : []).map((player) => {
      if (actorIdOf(player) !== recipientId) return player
      applied = true
      return {
        ...player,
        inventory: items.reduce((inventory, item) => addLootedItem(inventory, item), Array.isArray(player.inventory) ? player.inventory : []),
      }
    })
    return applied ? [recipientId] : []
  }
  return []
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/**
 * Публичная форма экземпляра в контейнере.
 *
 * Снимается всё, что принадлежит закрытому учёту: `owner` и `origin` — это
 * ключи инвентаря противника и **`template_id` его стат-блока**, то есть ровно
 * то, что отряд получает только опознанием врага (`publicEnemyFor`,
 * `server/viewer-projection.mjs`).
 *
 * Цена считается **той же политикой, что и у вещи в сумке**, а не берётся из
 * снимка. Снимок несёт каталожную цену любой записи, а `normalizeInventoryItem`
 * признаёт только торговый каталог (`resolveCatalogBasePriceCp`), и снятый с
 * тела скимитар приходит в инвентарь без цены вовсе. Карточка, обещавшая за
 * него 25 зм, обещала бы то, чего движок не выдаст; поэтому цены здесь ровно
 * столько же, сколько её будет после обыска, — а чаще её нет совсем. Оценка
 * добычи — отдельный шаг (`server/item-appraisal.mjs`), и он ещё не сделан.
 */
export function lootItemForViewer(item = {}) {
  const snapshot = item?.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {}
  const catalogId = text(item.catalog_id, 120)
  const basePriceCp = Math.max(0, integer(resolveCatalogBasePriceCp({ catalog_id: catalogId }), 0))
  return {
    item_instance_id: text(item.item_instance_id, 160),
    catalog_id: catalogId,
    name: text(snapshot.name, 120) || 'Предмет',
    type: text(snapshot.type, 40),
    rarity: text(snapshot.rarity, 40),
    weight: Math.max(0, Number(snapshot.weight) || 0),
    quantity: Math.max(1, integer(item.quantity, 1)),
    description: text(snapshot.description, 1_000),
    mechanics_status: text(snapshot.mechanics_status, 40),
    ...(basePriceCp > 0 ? { base_price_cp: basePriceCp } : {}),
    ...(snapshot.image ? { image: text(snapshot.image, 500) } : {}),
    ...(item.charges ? { charges: { current: Math.max(0, integer(item.charges.current, 0)), max: Math.max(0, integer(item.charges.max, 0)) } } : {}),
    ...(snapshot.requires_attunement === true ? { requires_attunement: true } : {}),
  }
}

/**
 * Сколько футов от героя до контейнера. `null` — «померить нечем»: у контейнера
 * нет клетки (противника не было на доске) или герой сам ещё не встал на карту.
 * Ровно этот случай `reachable` считает досягаемым, и подпись обязана совпадать
 * с решением, а не спорить с ним.
 */
function distanceFeetTo(state, actor, container) {
  if (!actor || container?.x == null || container?.y == null) return null
  const position = positionOf(state, actorIdOf(actor))
  if (position.x == null || position.y == null) return null
  return Math.max(Math.abs(position.x - container.x), Math.abs(position.y - container.y)) * 5
}

/**
 * Публичная форма контейнера. Содержимое отдаётся **только** по защищённому
 * чтению: `withContents` ставит вызывающая сторона, доказав, что герой игрока
 * стоит рядом. Без этого карточка называет вид, место и число предметов — то,
 * что видно с другого конца зала, — и ничего больше.
 *
 * `distance_feet` приезжает готовым числом не ради красоты: браузер не должен
 * заводить вторую геометрию доски. Досягаемость решает сервер (`can_inspect`),
 * а расстояние объясняет игроку, почему решение именно такое.
 *
 * `cell_revealed` — тот же туман, которым закрыта клетка доски. Метка добычи на
 * карте уже гаснет вместе с клеткой (`cell.revealed && lootHere`,
 * `src/DungeonMap.tsx`), а карточка панели печатала «клетка 3:2 · 30 фт до
 * героя» и для тела в неразведанном углу зала — то есть проговаривала словами
 * ровно то, что доска честно прячет. Признак решает сервер по той же сетке,
 * которая уезжает игроку (`publicCellsFor`, `server/viewer-projection.mjs`):
 * второй таблицы видимости в браузере не заводится.
 */
export function lootContainerForViewer(container = {}, { withContents = false, distanceFeet = null, cellRevealed = true } = {}) {
  const normalized = normalizeLootContainer(container)
  if (!normalized) return null
  const distance = Number.isFinite(Number(distanceFeet)) && Number(distanceFeet) >= 0
    ? Math.round(Number(distanceFeet))
    : null
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    id: normalized.id,
    kind: normalized.kind,
    name: normalized.name,
    status: normalized.status,
    // Кем был контейнер: по этому ключу интерфейс находит портрет павшего в уже
    // известном ему списке противников. Имя врага и так стоит в `name`, поэтому
    // ключ ничего нового не открывает — в отличие от `origin.template_id`,
    // который снимается вместе с остальным закрытым учётом.
    source_enemy_id: normalized.source_enemy_id,
    x: normalized.x,
    y: normalized.y,
    cell_revealed: cellRevealed !== false,
    item_count: normalized.items.length,
    // Вес нужен, чтобы «унесу ли я это» решалось до броска, а не после отказа.
    total_weight: Math.round(normalized.items.reduce((total, item) => (
      total + Math.max(0, Number(item.snapshot?.weight) || 0) * Math.max(1, integer(item.quantity, 1))
    ), 0) * 100) / 100,
    can_inspect: withContents === true,
    ...(distance == null ? {} : { distance_feet: distance }),
    ...(withContents ? { items: normalized.items.map((item) => lootItemForViewer(item)) } : {}),
  }
}

/**
 * Раскрытые клетки сцены. Набор строится один раз на проекцию: карта области —
 * это до десяти тысяч клеток, и линейный поиск на каждый из шестидесяти
 * контейнеров превратил бы подпись карточки в обход сетки.
 *
 * Сцена без клеток тумана не имеет вовсе (лагерь, разговор в трактире), и
 * прятать в ней нечего: пустой набор означал бы «всё под туманом» и молча съел
 * бы клетку у контейнера, который игрок и так видит.
 */
function revealedCellKeys(state) {
  const cells = Array.isArray(state?.scene?.cells) ? state.scene.cells : []
  if (!cells.length) return null
  const keys = new Set()
  for (const cell of cells) {
    if (cell?.revealed === true) keys.add(`${integer(cell.x, -1)},${integer(cell.y, -1)}`)
  }
  return keys
}

/**
 * Контейнеры для стола. Ведущий видит содержимое всегда; игрок — того
 * контейнера, до которого дотягивается его герой.
 *
 * `action_cost` — цена обыска в экономике хода, и решает её тот же признак, что
 * и `validateLootContainerCommand`: идёт бой — обыск стоит действия. Кнопка
 * обязана называть цену **до** нажатия, и вычислять её второй раз в браузере
 * означало бы две таблицы правил, которые однажды разойдутся.
 *
 * `action_spent` — вторая половина той же цены, и без неё первая была неполной.
 * Объявленная цена ничего не говорит о том, есть ли чем платить: герой, уже
 * потративший действие в этом ходу, читал бодрое «Взять — действие», нажимал и
 * получал отказ `ACTION_SPENT` (`assertTurn`, `server/rules-engine.mjs`).
 * Признак читается из той же `action_economy`, по которой движок и отказывает,
 * поэтому кнопка не может обещать одно, а получить другое.
 */
export function lootContainersForViewer(state = {}, { actorId = '', isAdmin = false } = {}) {
  const actor = playerActor(state, actorId)
  const combatActive = state?.mechanics?.combat?.active === true
  const containers = lootContainersInScene(state)
  // Сетку видимости обходить незачем, пока прятать нечего: у ведущего туман не
  // спрашивают вовсе, а сцена без единого контейнера с клеткой — обычный случай
  // (проекция комнаты собирается на каждый опрос, а карта области — это десять
  // тысяч клеток).
  const revealed = isAdmin !== true && containers.some((container) => container.x != null && container.y != null)
    ? revealedCellKeys(state)
    : null
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    reach_feet: LOOT_CONTAINER_REACH_FEET,
    action_cost: combatActive ? 'action' : null,
    action_spent: combatActive
      && Boolean(actor)
      && state?.mechanics?.combat?.action_economy?.[String(actorId)]?.action === false,
    containers: containers
      .map((container) => lootContainerForViewer(container, {
        withContents: isAdmin === true || Boolean(actor) && reachable(state, actor, container),
        distanceFeet: distanceFeetTo(state, actor, container),
        // Ведущему туман не мешает по построению: он и так видит содержимое
        // каждого контейнера сцены, и прятать от него клетку означало бы отнять
        // единственный способ сказать столу, где именно лежит невзятое.
        cellRevealed: revealed == null || container.x == null || container.y == null
          || revealed.has(`${container.x},${container.y}`),
      }))
      .filter(Boolean),
  }
}
