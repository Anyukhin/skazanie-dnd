/**
 * Добыча: панель обыска, метка тела на доске и послебоевая сводка.
 *
 * Отдельный модуль, а не ещё один кусок `DungeonMap.tsx`, — решение, а не вкус.
 * Доска и так держит две с половиной тысячи строк и семь панелей; добыче нужны
 * собственное состояние выбора, собственный прогноз веса и лестница состояний
 * кнопки, и внутри монолита всё это немедленно смешалось бы с боевой экономикой
 * хода. Здесь у панели один вход (`LootPanel`), одна метка (`LootCellMarker`) и
 * одна сводка (`PostCombatLootSummary`) — доска только размещает их.
 *
 * ## Чего здесь нет и не будет
 *
 * **Локального оптимизма.** Ни одна кнопка не перерисовывает контейнер «как
 * будто взяли»: список приезжает проекцией (`server/loot-containers.mjs`,
 * `lootContainersForViewer`), и после ответа сервера карточка показывает то, что
 * сервер прислал. Отказ не убирает вещь из контейнера и не тратит выбор.
 *
 * **Второй геометрии доски.** Досягаемость решает сервер (`can_inspect`), футы
 * до контейнера тоже приезжают готовыми (`distance_feet`), цена обыска в
 * экономике хода — `action_cost`. Браузер их не пересчитывает: две таблицы одних
 * и тех же правил однажды разойдутся, и разойдутся молча.
 *
 * **Своей цены и своего веса вещи.** Всё, что показывает карточка, лежит в
 * проекции ровно в том виде, в каком попадёт в сумку героя.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes, MapPin, Package, PackageOpen, PackageX, Skull, Sparkles, Weight, X,
} from 'lucide-react'

import { itemCountLabel } from './app-shared'
import { itemImageFor } from './item-images'
import type { BattleEvent, Enemy, LootContainerCard, LootItemCard, Player } from './types'
import type { CommandOutcome } from './useGameSession'

/**
 * Подписи видов контейнеров. Вид приходит с сервера
 * (`server/loot-containers.mjs`), а слова к нему — здесь: русский текст живёт в
 * интерфейсе, а не в payload события.
 */
export const LOOT_KIND_LABELS: Record<string, string> = {
  corpse: 'ТЕЛО',
  captive: 'ОРУЖИЕ ПЛЕННОГО',
  abandoned: 'БРОШЕНО',
  cache: 'СХРОН',
}

/** Чем подписан контейнер в сводке: «тело», «схрон» — счётным словом. */
export const LOOT_KIND_NOUNS: Record<string, string> = {
  corpse: 'тело',
  captive: 'оружие пленного',
  abandoned: 'брошенный тюк',
  cache: 'схрон',
}

const LOOT_ITEM_TYPE_LABELS: Record<string, string> = {
  weapon: 'оружие',
  armor: 'доспех',
  consumable: 'расходник',
  tool: 'инструмент',
  quest: 'сюжетная вещь',
  treasure: 'ценность',
  document: 'бумаги',
  other: 'разное',
}

const round2 = (value: number) => Math.round(value * 100) / 100

/** Цена монетами, а не дробью: «1 зм 5 см» вместо «1,5 зм». */
export function lootPriceLabel(copper?: number) {
  const cp = Math.max(0, Math.round(Number(copper) || 0))
  if (!cp) return ''
  const parts: string[] = []
  const gold = Math.floor(cp / 100)
  const silver = Math.floor((cp % 100) / 10)
  const rest = cp % 10
  if (gold) parts.push(`${gold} зм`)
  if (silver) parts.push(`${silver} см`)
  if (rest) parts.push(`${rest} мм`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Чистые правила интерфейса
// ---------------------------------------------------------------------------

export type LootPickMap = Record<string, number>

/** Ключ выбора. Экземпляр уникален глобально, но контейнер в ключе оставлен
 *  намеренно: очистка после удачного обыска обязана касаться одной карточки. */
export const lootPickKey = (containerId: string, itemInstanceId: string) => `${containerId}::${itemInstanceId}`

export type LootPick = { item: LootItemCard; quantity: number }

export function lootPicksOf(container: LootContainerCard, picks: LootPickMap): LootPick[] {
  return (container.items ?? []).map((item) => ({
    item,
    quantity: Math.max(0, Math.min(item.quantity, Math.trunc(picks[lootPickKey(container.id, item.item_instance_id)] ?? 0))),
  }))
}

export function lootPickedWeight(picks: readonly LootPick[]) {
  return round2(picks.reduce((total, pick) => total + Math.max(0, pick.item.weight) * pick.quantity, 0))
}

/**
 * Прогноз «унесу ли». Нагрузка и предел героя считаются сервером
 * (`inventoryLoadFor`, `server/item-lifecycle.mjs`) и приезжают в `Player`;
 * здесь к ним только прибавляется выбранное. Отказ движка
 * (`CARRYING_CAPACITY_EXCEEDED`) наступает по тому же неравенству, поэтому
 * предупреждение не может обещать одно, а получить другое.
 */
export function lootWeightForecast(recipient: Player | null | undefined, addedWeight: number) {
  const capacity = Math.max(0, Number(recipient?.inventoryLoad?.capacity ?? 0))
  const carried = Math.max(0, Number(recipient?.inventoryLoad?.weight ?? 0))
  const after = round2(carried + Math.max(0, addedWeight))
  return {
    capacity: round2(capacity),
    carried: round2(carried),
    after,
    known: capacity > 0,
    overloaded: capacity > 0 && after > capacity,
    remaining: capacity > 0 ? round2(Math.max(0, capacity - after)) : 0,
  }
}

export type LootTakeTone = 'ready' | 'action' | 'far' | 'blocked' | 'gone' | 'heavy' | 'empty'

export type LootTakeState = { label: string; title: string; disabled: boolean; tone: LootTakeTone }

/**
 * Состояние кнопки «Взять».
 *
 * Порядок ступеней повторяет порядок проверок правила
 * (`validateLootContainerCommand`): сначала «есть ли ещё что брать», потом
 * права и очередь, потом досягаемость, и лишь затем вес и выбор. Совпадение не
 * косметическое: если бы кнопка объясняла отказ в другом порядке, игрок узнавал
 * бы про перегруз раньше, чем про то, что до тела вообще не дойти.
 *
 * Ни одна ступень не выдумана в браузере: `takenBy` приходит из летописи,
 * `canInspect` и `distanceFeet` — из проекции, `actionCost` — оттуда же, а
 * `canAct` уже посчитан сервером как право хода.
 */
export function lootTakeButtonState(input: {
  takenBy?: string | null
  canAct: boolean
  busy: boolean
  narrating: boolean
  canInspect: boolean
  distanceFeet?: number | null
  reachFeet: number
  actionCost?: 'action' | null
  overloaded: boolean
  chosenCount: number
}): LootTakeState {
  if (input.takenBy) {
    return {
      label: `Уже забрал ${input.takenBy}`,
      title: 'Контейнер опустошён другим героем — сервер прислал свежий список',
      disabled: true,
      tone: 'gone',
    }
  }
  if (!input.canAct) {
    return { label: 'Не ваш ход', title: 'Сейчас этот герой не может действовать', disabled: true, tone: 'blocked' }
  }
  if (input.narrating || input.busy) {
    return {
      label: 'Подождите',
      title: input.narrating ? 'Дождитесь ответа Рассказчика' : 'Дождитесь завершения текущего действия',
      disabled: true,
      tone: 'blocked',
    }
  }
  if (!input.canInspect) {
    const distance = Number.isFinite(Number(input.distanceFeet)) ? ` Сейчас до неё ${input.distanceFeet} фт.` : ''
    return {
      label: 'Подойдите ближе',
      title: `Обыскивают в пределах ${input.reachFeet} футов.${distance}`,
      disabled: true,
      tone: 'far',
    }
  }
  if (input.overloaded) {
    return { label: 'Не унести — перегруз', title: 'Получатель не унесёт столько: снимите часть выбора или выберите другого героя', disabled: true, tone: 'heavy' }
  }
  if (input.chosenCount <= 0) {
    return { label: 'Выберите, что взять', title: 'Отметьте предметы в списке — набор уезжает одной командой', disabled: true, tone: 'empty' }
  }
  if (input.actionCost === 'action') {
    return { label: 'Взять — действие', title: 'В бою обыск одного контейнера стоит действия (правило стола)', disabled: false, tone: 'action' }
  }
  return { label: 'Взять', title: 'Вне боя обыск не стоит ни действия, ни хода', disabled: false, tone: 'ready' }
}

/**
 * Опустевший контейнер. В проекцию опустошённые не приезжают вовсе, поэтому
 * «его больше нет в списке» — это и есть ответ авторитета. Чтобы не выдать за
 * обыск уход со сцены (там список пустеет целиком), призрак заводится только
 * тогда, когда в летописи есть подтверждающая запись `loot-taken`.
 */
export type LootGhost = {
  id: string
  name: string
  kind: string
  x: number | null
  y: number | null
  takenBy: string
  at: number
}

export function vanishedLootFrom(
  previous: readonly LootContainerCard[],
  current: readonly LootContainerCard[],
  battleLog: readonly BattleEvent[],
  actorName: (id?: string) => string,
  now = Date.now(),
): LootGhost[] {
  if (!previous.length) return []
  const alive = new Set(current.map((container) => container.id))
  return previous.flatMap((container) => {
    if (alive.has(container.id)) return []
    const record = [...battleLog].reverse().find((event) => event.type === 'loot-taken' && event.containerId === container.id)
    if (!record) return []
    return [{
      id: container.id,
      name: container.name,
      kind: container.kind,
      x: container.x,
      y: container.y,
      takenBy: actorName(record.recipientId ?? record.actorId) || 'кто-то из отряда',
      at: now,
    }]
  })
}

/**
 * Призраки опустевших контейнеров на несколько секунд. Нужны ровно для двух
 * вещей: метка на доске гаснет, а не исчезает рывком, и тот, кто проиграл гонку,
 * читает «уже забрал такой-то» вместо молча пропавшей карточки.
 */
export function useVanishedLoot(
  containers: readonly LootContainerCard[],
  battleLog: readonly BattleEvent[] | undefined,
  actorName: (id?: string) => string,
  ttlMs = 4_000,
) {
  const previous = useRef<readonly LootContainerCard[]>(containers)
  const naming = useRef(actorName)
  naming.current = actorName
  const [ghosts, setGhosts] = useState<LootGhost[]>([])
  useEffect(() => {
    const gone = vanishedLootFrom(previous.current, containers, battleLog ?? [], (id) => naming.current(id))
    previous.current = containers
    if (!gone.length) return
    const goneIds = new Set(gone.map((ghost) => ghost.id))
    setGhosts((current) => [...current.filter((ghost) => !goneIds.has(ghost.id)), ...gone])
  }, [containers, battleLog])
  useEffect(() => {
    if (!ghosts.length) return
    // Таймер перевзводится при каждом изменении списка, поэтому очередной опрос
    // комнаты не может оставить призрака висеть навсегда.
    const timer = window.setTimeout(() => {
      setGhosts((current) => current.filter((ghost) => Date.now() - ghost.at < ttlMs))
    }, ttlMs)
    return () => window.clearTimeout(timer)
  }, [ghosts, ttlMs])
  return ghosts
}

/** Что осталось на полу после боя. Считает только по проекции сцены. */
export function lootAftermath(containers: readonly LootContainerCard[]) {
  const bodies = containers.filter((container) => container.kind === 'corpse')
  const caches = containers.filter((container) => container.kind === 'cache' || container.kind === 'abandoned')
  const captiveGear = containers.filter((container) => container.kind === 'captive')
  return {
    bodies,
    caches,
    captiveGear,
    itemCount: containers.reduce((total, container) => total + Math.max(0, container.item_count), 0),
    weight: round2(containers.reduce((total, container) => total + Math.max(0, container.total_weight), 0)),
    empty: containers.length === 0,
  }
}

/** Клетка контейнера человеческими числами: доска нумеруется с единицы. */
export function lootCellLabel(container: { x: number | null; y: number | null }) {
  return container.x == null || container.y == null ? '' : `клетка ${container.x + 1}:${container.y + 1}`
}

// ---------------------------------------------------------------------------
// Метка на доске
// ---------------------------------------------------------------------------

/**
 * Метка тела и добычи в клетке.
 *
 * Слой тот же, что у прочих отметок доски: обычный DOM-узел внутри клетки рядом
 * с фишками и следом (`.cell-footprint`). В `board-render.ts` ничего не
 * добавляется намеренно — холст рисует местность и массовые подсветки, а
 * штучная отметка с кнопкой, подсказкой и фокусом клавиатуры на холсте
 * потребовала бы собственного попадания указателя и собственной доступности.
 *
 * Павший показан затемнённой фишкой ровно столько, сколько с него есть что
 * снять: тело — это место, к которому надо подойти, и пока подходить есть зачем,
 * оно обязано быть видно там, где упало. Опустевший контейнер гаснет вместе с
 * фишкой — поле боя не должно навсегда зарастать отметками, по которым уже
 * нечего делать.
 */
export function LootCellMarker({ container, ghost, fallen, selected, onSelect }: {
  container?: LootContainerCard
  ghost?: LootGhost
  fallen?: { name: string; image?: string }
  selected?: boolean
  onSelect?: (containerId: string) => void
}) {
  const kind = container?.kind ?? ghost?.kind ?? 'corpse'
  const title = container
    ? `${container.name}: ${itemCountLabel(container.item_count)}${container.can_inspect ? '' : ' · надо подойти вплотную'}`
    : ghost
      ? `${ghost.name}: уже забрал ${ghost.takenBy}`
      : ''
  return <span className={`loot-cell-mark kind-${kind}${ghost && !container ? ' spent' : ''}${selected ? ' selected' : ''}`}>
    {fallen && <span
      className="fallen-token"
      aria-hidden="true"
      title={`${fallen.name}: повержен`}
      style={fallen.image ? { backgroundImage: `url(${fallen.image})` } : undefined}
    >{fallen.image ? null : <Skull size={13} />}</span>}
    {container
      ? <button
          type="button"
          className="loot-pin"
          aria-label={title}
          title={title}
          aria-pressed={Boolean(selected)}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onSelect?.(container.id) }}
        >
          <Package size={12} aria-hidden="true" />
          <i>{container.item_count}</i>
        </button>
      : <span className="loot-pin" role="img" aria-label={title} title={title}><PackageOpen size={12} aria-hidden="true" /></span>}
  </span>
}

// ---------------------------------------------------------------------------
// Панель «Добыча»
// ---------------------------------------------------------------------------

/** Кнопка «Взять» одной формой: и у живого контейнера, и у опустевшего. */
function LootTakeButton({ state, suffix = '', onTake }: { state: LootTakeState; suffix?: string; onTake?: () => void }) {
  return <button
    className={`loot-take tone-${state.tone}`}
    type="button"
    disabled={state.disabled}
    title={state.title}
    onClick={onTake}
  >{state.label}{suffix}</button>
}

function LootItemArtwork({ item }: { item: LootItemCard }) {
  const image = itemImageFor({ catalog_id: item.catalog_id, type: item.type, image: item.image })
  return <span className={`loot-item-art${image ? '' : ' neutral'}`} aria-hidden="true">
    {image ? <img src={image} alt="" /> : <Boxes size={15} />}
  </span>
}

function LootSourcePortrait({ container, enemy }: { container: LootContainerCard; enemy?: Enemy }) {
  if (enemy?.image) {
    return <span className="loot-source-portrait" role="img" aria-label={`Павший: ${enemy.name}`} style={{ backgroundImage: `url(${enemy.image})` }} />
  }
  return <span className={`loot-source-portrait neutral kind-${container.kind}`} role="img" aria-label={container.name}>
    {container.kind === 'corpse' ? <Skull size={17} /> : container.kind === 'cache' ? <Sparkles size={17} /> : <Package size={17} />}
  </span>
}

export function LootPanel({
  containers, ghosts, reachFeet, actionCost, players, actorId, enemies,
  canAct, busy, narrating, combatActive, focusedId, onFocus, onLoot,
}: {
  containers: readonly LootContainerCard[]
  ghosts: readonly LootGhost[]
  reachFeet: number
  actionCost: 'action' | null
  players: readonly Player[]
  /** Герой этого браузера: он обыскивает и он же получатель по умолчанию. */
  actorId: string
  enemies: readonly Enemy[]
  canAct: boolean
  busy: boolean
  narrating: boolean
  combatActive: boolean
  focusedId: string | null
  onFocus: (containerId: string | null) => void
  onLoot: (containerId: string, lines: Array<{ item_instance_id: string; quantity: number }>, recipientId?: string) => Promise<CommandOutcome>
}) {
  // Что отряд собирается вынести и кому. Обе величины живут только в браузере:
  // авторитетно решает сервер, здесь они лишь собирают набор до отправки.
  const [picks, setPicks] = useState<LootPickMap>({})
  const [recipientId, setRecipientId] = useState('')
  // Отказ сервера показывается на той карточке, где нажали, и не трогает выбор:
  // «взять» либо прошло целиком, либо не прошло вовсе.
  const [refusals, setRefusals] = useState<Record<string, string>>({})
  const cards = useRef(new Map<string, HTMLElement | null>())

  useEffect(() => {
    if (!focusedId) return
    cards.current.get(focusedId)?.scrollIntoView({ block: 'nearest' })
  }, [focusedId])

  const recipient = useMemo(
    () => players.find((player) => player.id === (combatActive ? actorId : recipientId || actorId)) ?? null,
    [players, combatActive, actorId, recipientId],
  )
  const enemyById = useMemo(() => new Map(enemies.map((enemy) => [enemy.id, enemy])), [enemies])

  const setPick = (containerId: string, item: LootItemCard, quantity: number) => {
    const bounded = Math.max(0, Math.min(item.quantity, Math.floor(Number(quantity) || 0)))
    setPicks((current) => ({ ...current, [lootPickKey(containerId, item.item_instance_id)]: bounded }))
  }
  const togglePick = (containerId: string, item: LootItemCard) => {
    const key = lootPickKey(containerId, item.item_instance_id)
    setPicks((current) => ({ ...current, [key]: current[key] > 0 ? 0 : item.quantity }))
  }
  const selectWhole = (container: LootContainerCard, everything: boolean) => {
    setPicks((current) => ({
      ...current,
      ...Object.fromEntries((container.items ?? []).map((item) => [
        lootPickKey(container.id, item.item_instance_id),
        everything ? item.quantity : 0,
      ])),
    }))
  }
  const take = async (container: LootContainerCard, chosen: readonly LootPick[]) => {
    const lines = chosen.map((pick) => ({ item_instance_id: pick.item.item_instance_id, quantity: pick.quantity }))
    if (!lines.length) return
    // Набор уезжает одной командой: сервер возьмёт его целиком или откажет
    // целиком, и частично взятого набора не существует.
    const outcome = await onLoot(container.id, lines, combatActive ? undefined : recipientId || undefined)
    if (outcome.ok) {
      setRefusals((current) => {
        if (!current[container.id]) return current
        const next = { ...current }
        delete next[container.id]
        return next
      })
      setPicks((current) => {
        const next = { ...current }
        for (const line of lines) delete next[lootPickKey(container.id, line.item_instance_id)]
        return next
      })
      return
    }
    setRefusals((current) => ({ ...current, [container.id]: outcome.error }))
  }

  const liveIds = new Set(containers.map((container) => container.id))
  const shownGhosts = ghosts.filter((ghost) => !liveIds.has(ghost.id))
  if (!containers.length && !shownGhosts.length) return null

  return <section className="loot-panel" aria-label="Добыча в сцене">
    <header>
      <Package size={15} />
      <span>
        <small>ДОБЫЧА · {containers.length}</small>
        <strong>{actionCost === 'action' ? 'В бою обыск стоит действия' : 'Смотреть и брать — свободно'}</strong>
      </span>
    </header>
    {containers.map((container) => {
      const picked = lootPicksOf(container, picks)
      const chosen = picked.filter((pick) => pick.quantity > 0)
      const chosenWeight = lootPickedWeight(chosen)
      const forecast = lootWeightForecast(recipient, chosenWeight)
      const button = lootTakeButtonState({
        canAct,
        busy,
        narrating,
        canInspect: container.can_inspect,
        distanceFeet: container.distance_feet ?? null,
        reachFeet,
        actionCost,
        overloaded: forecast.overloaded,
        chosenCount: chosen.length,
      })
      // Выбор запирается только тем, что мешает нажать вообще: очередь, занятость
      // и недосягаемость. «Ничего не отмечено» и «не унесёт» запирать нельзя —
      // именно набор и правят, чтобы выйти из этих двух состояний.
      const picksLocked = !canAct || busy || narrating || !container.can_inspect
      const everythingChosen = (container.items ?? []).length > 0 && chosen.length === (container.items ?? []).length
      const refusal = refusals[container.id]
      const sourceEnemy = container.source_enemy_id ? enemyById.get(container.source_enemy_id) : undefined
      const cell = lootCellLabel(container)
      return <article
        key={container.id}
        ref={(node) => { cards.current.set(container.id, node) }}
        className={`loot-card kind-${container.kind}${focusedId === container.id ? ' focused' : ''}`}
        onPointerEnter={() => onFocus(container.id)}
        onPointerLeave={() => onFocus(null)}
      >
        <header>
          <LootSourcePortrait container={container} enemy={sourceEnemy} />
          <span className="loot-card-title">
            <i className="loot-tag">{LOOT_KIND_LABELS[container.kind] ?? 'ДОБЫЧА'}</i>
            <b>{container.name}</b>
            <small>
              {itemCountLabel(container.item_count)} · {container.total_weight} фнт
              {cell ? ` · ${cell}` : ''}
              {container.distance_feet == null ? '' : ` · ${container.distance_feet} фт до героя`}
            </small>
          </span>
        </header>
        {!container.can_inspect && <p className="loot-far">
          Отсюда не дотянуться: обыскивают в пределах {reachFeet} футов. Подойдите — и станет видно, что внутри.
        </p>}
        {container.can_inspect && <>
          <ul className="loot-items">
            {picked.map(({ item, quantity }) => <li key={item.item_instance_id} className={quantity > 0 ? 'picked' : ''}>
              <button
                type="button"
                disabled={picksLocked}
                title={[item.description || item.name, item.requires_attunement ? 'Требует настройки' : '', lootPriceLabel(item.base_price_cp)].filter(Boolean).join(' · ')}
                onClick={() => togglePick(container.id, item)}
              >
                <LootItemArtwork item={item} />
                <span className="loot-item-info">
                  <b>{item.name}</b>
                  <small>
                    {LOOT_ITEM_TYPE_LABELS[item.type ?? 'other'] ?? 'разное'}
                    {item.quantity > 1 ? ` · ×${item.quantity}` : ''}
                    {' · '}{item.weight} фнт
                    {item.charges ? ` · заряды ${item.charges.current}/${item.charges.max}` : ''}
                  </small>
                </span>
                {item.rarity ? <i className={`rarity ${item.rarity.replace(/\s+/gu, '-')}`}>{item.rarity}</i> : null}
              </button>
              {item.quantity > 1 && <input
                type="number"
                min={0}
                max={item.quantity}
                value={quantity}
                disabled={picksLocked}
                aria-label={`Сколько взять: ${item.name}`}
                onChange={(event) => setPick(container.id, item, Number(event.target.value))}
              />}
            </li>)}
          </ul>
          <div className={`loot-load${forecast.overloaded ? ' overloaded' : ''}`}>
            <Weight size={13} />
            <span>
              <b>{chosenWeight} фнт выбрано</b>
              <small>{forecast.known
                ? forecast.overloaded
                  ? `${recipient?.character ?? 'герой'} не унесёт: ${forecast.after} из ${forecast.capacity} фнт`
                  : `${recipient?.character ?? 'герой'}: ${forecast.after} из ${forecast.capacity} фнт, останется ${forecast.remaining}`
                : 'предел переноски героя ещё не посчитан сервером'}</small>
            </span>
          </div>
        </>}
        {/* Строка действий стоит и у далёкого контейнера: кнопка обязана
            называть, почему взять нельзя, а не пропадать вместе с содержимым. */}
        <div className="loot-actions">
          {container.can_inspect && !combatActive && players.length > 1 && <label className="loot-recipient">
            Кому:
            <select
              value={recipientId || actorId}
              disabled={!canAct || busy || narrating}
              onChange={(event) => setRecipientId(event.target.value)}
            >
              {players.map((player) => <option key={player.id} value={player.id}>{player.character}</option>)}
            </select>
          </label>}
          {container.can_inspect && <button
            type="button"
            disabled={picksLocked || !(container.items ?? []).length}
            title={everythingChosen ? 'Снять весь выбор' : 'Отметить всё содержимое'}
            onClick={() => selectWhole(container, !everythingChosen)}
          >{everythingChosen ? 'Снять выбор' : 'Выбрать всё'}</button>}
          <LootTakeButton
            state={button}
            suffix={button.tone === 'ready' || button.tone === 'action' ? ` · ${chosenWeight} фнт` : ''}
            onTake={() => { void take(container, chosen) }}
          />
        </div>
        {refusal && <p className="loot-refusal" role="status">{refusal}</p>}
      </article>
    })}
    {shownGhosts.map((ghost) => <article key={ghost.id} className={`loot-card kind-${ghost.kind} taken`}>
      <header>
        <span className="loot-source-portrait neutral spent" role="img" aria-label={ghost.name}><PackageX size={17} /></span>
        <span className="loot-card-title">
          <i className="loot-tag">ПУСТО</i>
          <b>{ghost.name}</b>
          <small>{lootCellLabel(ghost) || 'на сцене'}</small>
        </span>
      </header>
      <p className="loot-far">Сервер прислал свежий список — здесь больше ничего нет.</p>
      <div className="loot-actions">
        {/* Ту же лестницу состояний проходит и опустевший контейнер: подпись
            «уже забрал такой-то» — её верхняя ступень, а не отдельный текст. */}
        <LootTakeButton state={lootTakeButtonState({
          takenBy: ghost.takenBy,
          canAct,
          busy,
          narrating,
          canInspect: false,
          reachFeet,
          actionCost,
          overloaded: false,
          chosenCount: 0,
        })} />
      </div>
    </article>)}
  </section>
}

// ---------------------------------------------------------------------------
// Послебоевая сводка
// ---------------------------------------------------------------------------

/**
 * «Что осталось на полу» после победы.
 *
 * Карточка появляется один раз на бой и закрывается рукой: отряд уходит с этажа
 * целиком, и невзятое тело потом ищется по всей карте. Ни одного собственного
 * числа здесь нет — всё, что показано, приехало проекцией сцены.
 */
export function PostCombatLootSummary({ containers, onClose, onFocus }: {
  containers: readonly LootContainerCard[]
  onClose: () => void
  onFocus: (containerId: string | null) => void
}) {
  const aftermath = lootAftermath(containers)
  if (aftermath.empty) return null
  return <section className="loot-aftermath" aria-label="Что осталось после боя" aria-live="polite">
    <header>
      <Sparkles size={15} />
      <span><small>ПОБЕДА · ЧТО ОСТАЛОСЬ</small><strong>{itemCountLabel(aftermath.itemCount)} на {aftermath.weight} фнт</strong></span>
      <button type="button" onClick={onClose} aria-label="Закрыть сводку добычи"><X size={15} /></button>
    </header>
    <dl className="loot-aftermath-counts">
      <div><dt>Тел не обыскано</dt><dd>{aftermath.bodies.length}</dd></div>
      {aftermath.captiveGear.length > 0 && <div><dt>Оружие пленных</dt><dd>{aftermath.captiveGear.length}</dd></div>}
      {aftermath.caches.length > 0 && <div><dt>Тайники и тюки</dt><dd>{aftermath.caches.length}</dd></div>}
    </dl>
    <ul className="loot-aftermath-list">
      {containers.map((container) => <li key={container.id}>
        <button type="button" onClick={() => onFocus(container.id)} title="Показать на доске и в панели добычи">
          <b>{container.name}</b>
          <small>
            {LOOT_KIND_NOUNS[container.kind] ?? 'добыча'} · {itemCountLabel(container.item_count)} · {container.total_weight} фнт
          </small>
          {lootCellLabel(container) ? <em><MapPin size={11} />{lootCellLabel(container)}</em> : null}
        </button>
      </li>)}
    </ul>
    <p>Уйдёте с этажа — невзятое останется лежать здесь и дождётся возвращения.</p>
  </section>
}
