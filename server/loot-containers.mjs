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
 */
import { createHash } from 'node:crypto'

import { levelKey, sceneLevelIndex, sceneLocationId } from './adventure-director.mjs'
import { normalizeItemInstance } from './item-instances.mjs'
import { carryingCapacity, inventoryWeight } from './item-lifecycle.mjs'
import { MAX_STOCK_QUANTITY, inventoryStackKey, normalizeInventoryItem } from './merchant-economy.mjs'
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
    containers: containers.slice(-MAX_LOOT_CONTAINERS),
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

export function lootContainerIdFor(kind, sourceIds = []) {
  const parts = [...sourceIds].map((value) => text(value, 160)).sort()
  return `loot:${text(kind, 20)}:${digest(kind, ...parts).slice(0, 24)}`
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
  const containerId = lootContainerIdFor(kind, sourceIds)
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
 */
export function lootCommitTouchesContainers(before = {}, events = []) {
  const hasLoot = (Array.isArray(before?.enemies) ? before.enemies : [])
    .some((enemy) => (Array.isArray(enemy?.loadout?.items) ? enemy.loadout.items : [])
      .some((item) => item?.lootable === true))
  if (!hasLoot) return false
  return (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'CaptiveTaken'
    || (event?.event_type === 'ParleySettled' && String(event?.payload?.outcome ?? '') === 'tribute')
    || event?.payload?.hp_after === 0)
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
  const existing = new Set(lootContainerList(after).map((container) => container.id))
  const minutes = campaignElapsedMinutes(after)
  const locationKey = sceneLootLocationKey(after)
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

function addLootedItem(inventory, incoming) {
  const current = Array.isArray(inventory) ? inventory : []
  const index = current.findIndex((item) => !item?.equipped && !item?.attuned_to
    && inventoryStackKey(item) === inventoryStackKey(incoming))
  if (index < 0) return [...current, clone(incoming)]
  return current.map((item, itemIndex) => itemIndex === index
    ? { ...item, quantity: Math.min(MAX_STOCK_QUANTITY, integer(item.quantity, 1) + integer(incoming.quantity, 1)) }
    : item)
}

/**
 * Применение событий контейнеров.
 *
 * Числа берутся **только** из payload: то же событие, применённое второй раз,
 * обязано давать тот же остаток и тот же инвентарь. Поэтому остаток контейнера
 * приезжает списком, а не досчитывается вычитанием по состоянию.
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
    state.loot_containers = withContainer(state, normalizeLootContainer({
      ...current,
      items: remaining,
      status: remaining.length ? 'available' : 'emptied',
    }))
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
 * `server/viewer-projection.mjs`). `base_price_cp` остаётся: цену вещи герой
 * читает по её виду, и оценка у него уже есть в инвентаре.
 */
export function lootItemForViewer(item = {}) {
  const snapshot = item?.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {}
  return {
    item_instance_id: text(item.item_instance_id, 160),
    catalog_id: text(item.catalog_id, 120),
    name: text(snapshot.name, 120) || 'Предмет',
    type: text(snapshot.type, 40),
    rarity: text(snapshot.rarity, 40),
    weight: Math.max(0, Number(snapshot.weight) || 0),
    quantity: Math.max(1, integer(item.quantity, 1)),
    description: text(snapshot.description, 1_000),
    mechanics_status: text(snapshot.mechanics_status, 40),
    base_price_cp: Math.max(0, integer(snapshot.base_price_cp, 0)),
    ...(snapshot.image ? { image: text(snapshot.image, 500) } : {}),
    ...(item.charges ? { charges: { current: Math.max(0, integer(item.charges.current, 0)), max: Math.max(0, integer(item.charges.max, 0)) } } : {}),
    ...(snapshot.requires_attunement === true ? { requires_attunement: true } : {}),
  }
}

/**
 * Публичная форма контейнера. Содержимое отдаётся **только** по защищённому
 * чтению: `withContents` ставит вызывающая сторона, доказав, что герой игрока
 * стоит рядом. Без этого карточка называет вид, место и число предметов — то,
 * что видно с другого конца зала, — и ничего больше.
 */
export function lootContainerForViewer(container = {}, { withContents = false } = {}) {
  const normalized = normalizeLootContainer(container)
  if (!normalized) return null
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    id: normalized.id,
    kind: normalized.kind,
    name: normalized.name,
    status: normalized.status,
    x: normalized.x,
    y: normalized.y,
    item_count: normalized.items.length,
    // Вес нужен, чтобы «унесу ли я это» решалось до броска, а не после отказа.
    total_weight: Math.round(normalized.items.reduce((total, item) => (
      total + Math.max(0, Number(item.snapshot?.weight) || 0) * Math.max(1, integer(item.quantity, 1))
    ), 0) * 100) / 100,
    can_inspect: withContents === true,
    ...(withContents ? { items: normalized.items.map((item) => lootItemForViewer(item)) } : {}),
  }
}

/**
 * Контейнеры для стола. Ведущий видит содержимое всегда; игрок — того
 * контейнера, до которого дотягивается его герой.
 */
export function lootContainersForViewer(state = {}, { actorId = '', isAdmin = false } = {}) {
  const actor = playerActor(state, actorId)
  return {
    schema_version: LOOT_CONTAINERS_SCHEMA_VERSION,
    reach_feet: LOOT_CONTAINER_REACH_FEET,
    containers: lootContainersInScene(state)
      .map((container) => lootContainerForViewer(container, {
        withContents: isAdmin === true || Boolean(actor) && reachable(state, actor, container),
      }))
      .filter(Boolean),
  }
}
