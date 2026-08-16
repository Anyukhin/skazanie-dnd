/**
 * Чистые правила панели добычи.
 *
 * Отдельный `.mjs` рядом с `LootPanel.tsx` — по той же причине, по какой рядом
 * с `useGameSession.ts` лежит `tactical-command-guard.mjs`: корпус запускает
 * тесты обычным `node --test`, а всё, что живёт внутри `.tsx`, доезжает до
 * теста только через компиляцию и подмену `react/jsx-runtime`. Пока лестница
 * состояний кнопки и прогноз перегруза сидели в компоненте, единственным
 * сторожем у них был регулярочный обход исходника — он не ловит ни одной
 * поведенческой правки: `disabled: true → false` для «Подойдите ближе» текст
 * файла не меняет, а кнопка начинает слать команду, которую сервер отвергнет.
 *
 * Здесь нет ни одного собственного правила игры: досягаемость, футы, цена
 * обыска в экономике хода и предел переноски приезжают с сервера
 * (`server/loot-containers.mjs`, `inventoryLoadFor`), а эти функции только
 * складывают выбранное и называют словами то, что уже решено авторитетом.
 */

/**
 * Подписи видов контейнеров. Вид приходит с сервера
 * (`server/loot-containers.mjs`), а слова к нему — здесь: русский текст живёт в
 * интерфейсе, а не в payload события.
 */
export const LOOT_KIND_LABELS = {
  corpse: 'ТЕЛО',
  captive: 'ОРУЖИЕ ПЛЕННОГО',
  abandoned: 'БРОШЕНО',
  cache: 'СХРОН',
}

/** Чем подписан контейнер в сводке: «тело», «схрон» — счётным словом. */
export const LOOT_KIND_NOUNS = {
  corpse: 'тело',
  captive: 'оружие пленного',
  abandoned: 'брошенный тюк',
  cache: 'схрон',
}

export const LOOT_ITEM_TYPE_LABELS = {
  weapon: 'оружие',
  armor: 'доспех',
  consumable: 'расходник',
  tool: 'инструмент',
  quest: 'сюжетная вещь',
  treasure: 'ценность',
  document: 'бумаги',
  other: 'разное',
}

const round2 = (value) => Math.round(value * 100) / 100

/** Цена монетами, а не дробью: «1 зм 5 см» вместо «1,5 зм». */
export function lootPriceLabel(copper) {
  const cp = Math.max(0, Math.round(Number(copper) || 0))
  if (!cp) return ''
  const parts = []
  const gold = Math.floor(cp / 100)
  const silver = Math.floor((cp % 100) / 10)
  const rest = cp % 10
  if (gold) parts.push(`${gold} зм`)
  if (silver) parts.push(`${silver} см`)
  if (rest) parts.push(`${rest} мм`)
  return parts.join(' ')
}

/** Ключ выбора. Экземпляр уникален глобально, но контейнер в ключе оставлен
 *  намеренно: очистка после удачного обыска обязана касаться одной карточки. */
export const lootPickKey = (containerId, itemInstanceId) => `${containerId}::${itemInstanceId}`

export function lootPicksOf(container, picks) {
  return (container?.items ?? []).map((item) => ({
    item,
    quantity: Math.max(0, Math.min(item.quantity, Math.trunc(picks?.[lootPickKey(container.id, item.item_instance_id)] ?? 0))),
  }))
}

export function lootPickedWeight(picks) {
  return round2((picks ?? []).reduce((total, pick) => total + Math.max(0, pick.item.weight) * pick.quantity, 0))
}

/**
 * Прогноз «унесу ли». Нагрузка и предел героя считаются сервером
 * (`inventoryLoadFor`, `server/item-lifecycle.mjs`) и приезжают в `Player`;
 * здесь к ним только прибавляется выбранное. Отказ движка
 * (`CARRYING_CAPACITY_EXCEEDED`) наступает по тому же неравенству, поэтому
 * предупреждение не может обещать одно, а получить другое.
 */
export function lootWeightForecast(recipient, addedWeight) {
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

/**
 * Состояние кнопки «Взять».
 *
 * Порядок ступеней повторяет порядок проверок правила
 * (`validateLootContainerCommand`): сначала «есть ли ещё что брать», потом
 * права и очередь, потом досягаемость, потом «выбрано ли хоть что-то»
 * (`LOOT_LINES_REQUIRED`) и лишь затем вес (`CARRYING_CAPACITY_EXCEEDED`).
 * Совпадение не косметическое: если бы кнопка объясняла отказ в другом порядке,
 * игрок узнавал бы про перегруз раньше, чем про то, что до тела вообще не
 * дойти, а уже перегруженный герой с пустым выбором читал бы «снимите часть
 * выбора» — при том, что снимать нечего.
 *
 * Последняя ступень — потраченное действие, и стоит она последней не по вкусу:
 * `ACTION_SPENT` движок бросает в `assertTurn` (`server/rules-engine.mjs`), а
 * туда команда доезжает **после** всего, что проверил `validateLootContainerCommand`.
 * Герой без действия, стоящий в другом конце зала, получит с сервера
 * `LOOT_CONTAINER_OUT_OF_REACH` — и кнопка обязана сказать ему то же самое.
 *
 * Ни одна ступень не выдумана в браузере: `takenBy` приходит из летописи,
 * `canInspect` и `distanceFeet` — из проекции, `actionCost` и `actionSpent` —
 * оттуда же (`lootContainersForViewer` читает ту самую `action_economy`, по
 * которой движок и отказывает), а `canAct` уже посчитан сервером как право
 * хода.
 */
export function lootTakeButtonState(input) {
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
    // `distance_feet` в проекции необязателен: сервер опускает поле, когда
    // мерить нечем (`server/loot-containers.mjs`). `Number(null) === 0` — число
    // конечное, поэтому без явной проверки на `null` подпись обещала бы
    // «Сейчас до неё null фт.».
    const known = input.distanceFeet != null && Number.isFinite(Number(input.distanceFeet))
    return {
      label: 'Подойдите ближе',
      title: `Обыскивают в пределах ${input.reachFeet} футов.${known ? ` Сейчас до неё ${input.distanceFeet} фт.` : ''}`,
      disabled: true,
      tone: 'far',
    }
  }
  if (input.chosenCount <= 0) {
    return { label: 'Выберите, что взять', title: 'Отметьте предметы в списке — набор уезжает одной командой', disabled: true, tone: 'empty' }
  }
  if (input.overloaded) {
    return { label: 'Не унести — перегруз', title: 'Получатель не унесёт столько: снимите часть выбора или выберите другого героя', disabled: true, tone: 'heavy' }
  }
  if (input.actionCost === 'action') {
    if (input.actionSpent) {
      return {
        label: 'Действие уже потрачено',
        title: 'Обыск в бою стоит действия, а его этот герой уже потратил в этом ходу — тело дождётся следующего',
        disabled: true,
        tone: 'spent',
      }
    }
    return { label: 'Взять — действие', title: 'В бою обыск одного контейнера стоит действия (правило стола)', disabled: false, tone: 'action' }
  }
  return { label: 'Взять', title: 'Вне боя обыск не стоит ни действия, ни хода', disabled: false, tone: 'ready' }
}

/**
 * Опустевший контейнер. В проекцию опустошённые не приезжают вовсе, поэтому
 * «его больше нет в списке» — это и есть ответ авторитета. Но пропасть из
 * проекции контейнер умеет и не опустев: отряд поднялся на другой ярус, и
 * список сцены пустеет целиком.
 *
 * Поэтому призрак заводится только по записи летописи `loot-taken`, у которой
 * сервер проставил `statusAfter: 'emptied'`. Одного лишь `loot-taken` мало:
 * ту же запись пишет и **неполный** обыск (`server/rules-engine.mjs`), и по ней
 * призрак врал бы «уже забрал такой-то» о теле, на котором этажом ниже осталось
 * ещё две вещи. Старые записи летописи признака не несут — и призрака не
 * заводят: молчание честнее выдуманного состояния.
 */
export function vanishedLootFrom(previous, current, battleLog, actorName, now = Date.now()) {
  if (!previous?.length) return []
  const alive = new Set((current ?? []).map((container) => container.id))
  return previous.flatMap((container) => {
    if (alive.has(container.id)) return []
    const record = [...(battleLog ?? [])].reverse().find((event) => event.type === 'loot-taken'
      && event.containerId === container.id
      && (event.statusAfter === 'emptied' || event.remainingCount === 0))
    if (!record) return []
    return [{
      id: container.id,
      name: container.name,
      kind: container.kind,
      x: container.x,
      y: container.y,
      // Туман переезжает вместе с клеткой: призрак печатается той же подписью,
      // что и живая карточка, и без признака он проговорил бы место тела,
      // которое обобрал соратник в неразведанной части зала.
      cell_revealed: container.cell_revealed !== false,
      takenBy: actorName(record.recipientId ?? record.actorId) || 'кто-то из отряда',
      at: now,
    }]
  })
}

/**
 * Летопись плюс запись, приложенная к отказу.
 *
 * Гонку за один кинжал проигравший узнаёт из двух источников сразу: свежий
 * список контейнеров говорит «этого тела больше нет», а имя успевшего лежит
 * только в летописи — и она доезжает до браузера **следующим** опросом комнаты.
 * До этой функции кадр отказа переписывал список первым, `vanishedLootFrom`
 * искал запись, не находил её и призрака не заводил; карточка просто молча
 * пропадала, а пришедшая через секунду запись объясняла уже исчезнувшее.
 *
 * Поэтому сервер прикладывает запись к самому отказу (`server/index.mjs`) — он
 * и так знает, кто забрал, — а здесь она встаёт в летопись на своё место. Ключ
 * записи детерминирован (`eventJournalId`), поэтому та же запись из следующего
 * опроса комнаты не задваивается. Предел в полсотни записей — тот же, которым
 * летопись подрезана на сервере.
 */
export function withLootTakenRecord(battleLog, record) {
  const log = Array.isArray(battleLog) ? battleLog : []
  if (!record || record.type !== 'loot-taken' || !record.containerId) return log
  if (log.some((entry) => String(entry?.id ?? '') === String(record.id ?? ''))) return log
  return [...log, record].slice(-50)
}

/** Что осталось на полу после боя. Считает только по проекции сцены. */
export function lootAftermath(containers) {
  const list = containers ?? []
  const bodies = list.filter((container) => container.kind === 'corpse')
  const caches = list.filter((container) => container.kind === 'cache' || container.kind === 'abandoned')
  const captiveGear = list.filter((container) => container.kind === 'captive')
  return {
    bodies,
    caches,
    captiveGear,
    itemCount: list.reduce((total, container) => total + Math.max(0, container.item_count), 0),
    weight: round2(list.reduce((total, container) => total + Math.max(0, container.total_weight), 0)),
    empty: list.length === 0,
  }
}

/**
 * Клетка контейнера человеческими числами: доска нумеруется с единицы.
 *
 * Под туманом клетки нет — не потому, что её нет в проекции (координаты там
 * есть и нужны доске), а потому, что печатать её нельзя: метка добычи на карте
 * гаснет вместе с нераскрытой клеткой (`cell.revealed && lootHere`,
 * `src/DungeonMap.tsx`), и карточка, называющая «клетка 3:2», выдавала бы
 * словами разведку, которой отряд не делал. Признак решает сервер
 * (`cell_revealed`, `server/loot-containers.mjs`) — своей карты видимости у
 * панели нет.
 */
export function lootCellLabel(container) {
  if (container?.cell_revealed === false) return ''
  return container?.x == null || container?.y == null ? '' : `клетка ${container.x + 1}:${container.y + 1}`
}

/**
 * Сколько футов до контейнера — по той же границе, что и клетка. Расстояние до
 * нераскрытой клетки читается как та же разведка: «30 фт до героя» вместе с
 * направлением взгляда сужает угол зала не хуже координаты.
 */
export function lootDistanceFeet(container) {
  if (container?.cell_revealed === false) return null
  const distance = container?.distance_feet
  return distance != null && Number.isFinite(Number(distance)) ? Number(distance) : null
}
