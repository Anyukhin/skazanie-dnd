/**
 * Содержимое сводки завершённой сцены — задача 2.1 плана
 * `docs/experience-upgrade-plan.md`.
 *
 * Уточнение к брифу: сводки **не были** мёртвым механизмом. Команды
 * `RecordNarrativeSummary` действительно никто не звал, но событие
 * `NarrativeSummaryRecorded` пишет сам обработчик `AdvanceScene` в
 * `rules-engine.mjs`. Мёртвым было содержимое: в сводку уходил `scene_args.outcome`
 * — одна дежурная фраза Архитектора вроде «Отряд покинул X, не закрыв нить», —
 * либо прежняя цель сцены. Ни одного реального события кампании там не было.
 *
 * Поэтому здесь не заводится вторая сводка, а собирается текст для существующей:
 * `scene_args.scene_summary`. Сборка **детерминированная, без модели**. Сводка это
 * провенанс, а не проза: она станет источником рекапа «в прошлой серии», и
 * придуманная моделью деталь превратилась бы в ложное воспоминание кампании.
 *
 * Текст отвечает на три вопроса: где были, что заметного случилось, куда и
 * почему ушли.
 */

const SCENE_SUMMARY_NOTABLE_LIMIT = 5
const NOTABLE_TEXT_LIMIT = 200

const clean = (value, maximum = 240) => String(value ?? '')
  .normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** Точка с запятой в конце фразы мешает склеивать перечисление. */
const trimTail = (value) => clean(value, NOTABLE_TEXT_LIMIT).replace(/[;,.\s]+$/u, '')

/**
 * События текущей сцены — всё, что произошло после последнего перехода.
 * У первой сцены кампании перехода ещё не было, поэтому берётся весь поток.
 */
export function eventsSinceSceneStart(events = []) {
  const list = Array.isArray(events) ? events : []
  let lastTransition = -1
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]?.event_type === 'SceneAdvanced') lastTransition = index
  }
  return list.slice(lastTransition + 1)
}

/**
 * Заметные моменты сцены. Список закрытый и намеренно узкий: сводка должна
 * помнить то, что меняет мир или отношения, а не каждый бросок. Шум здесь хуже
 * пустоты — он вытеснит настоящее событие из окна рекапа.
 */
export function notableSceneMoments(events = []) {
  const moments = []
  const add = (text) => {
    const value = trimTail(text)
    if (value && !moments.includes(value)) moments.push(value)
  }
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event?.payload ?? {}
    switch (event?.event_type) {
      // Материальные последствия импровизации: сожжённая таверна остаётся
      // сожжённой. Эти факты пишет свободное действие (задача 2.1-B).
      case 'WorldFactRecorded': {
        if (payload.fact?.predicate === 'scene_change') add(payload.fact.summary || payload.fact.object)
        break
      }
      case 'EncounterOutcomeRecorded': {
        if (payload.outcome) add(`столкновение завершилось: ${payload.outcome}`)
        break
      }
      case 'EncounterEnded': {
        add(`бой окончен (${payload.reason || payload.outcome || 'исход подтверждён'})`)
        break
      }
      case 'RulingRecorded': {
        // Только действия с объявленными ставками: авто-успех без броска это
        // бытовое действие, и в память сцены оно не идёт.
        const ruling = payload.ruling ?? {}
        if (!ruling.stakes || !ruling.question) break
        add(`${ruling.question} — ${ruling.outcome === 'success' ? 'удалось' : 'не вышло'}`)
        break
      }
      case 'NpcPromiseRecorded': {
        if (payload.promise?.text) add(`дано обещание: ${payload.promise.text}`)
        break
      }
      case 'QuestResolved': {
        add(`квест завершён: ${payload.summary || payload.outcome}`)
        break
      }
      case 'MerchantPurchaseCompleted': {
        const name = payload.item?.name || payload.catalog_id
        if (name) add(`куплено: ${name}${payload.quantity > 1 ? ` ×${payload.quantity}` : ''}`)
        break
      }
      default: break
    }
  }
  return moments.slice(0, SCENE_SUMMARY_NOTABLE_LIMIT)
}

/**
 * Текст сводки. Все части необязательны: сцена без заметных событий честно
 * описывается как проходная, а не дополняется выдумкой.
 */
export function buildSceneSummaryText({ state = {}, events = [], decision = '', destinationHint = '', destination = '' } = {}) {
  const scene = state.scene ?? {}
  const location = clean(scene.location, 160)
  const title = clean(scene.title, 160) || location || 'Сцена без названия'
  const moments = notableSceneMoments(events)
  const where = location
    ? `Отряд был в локации «${location}»${title && title !== location ? ` (${title})` : ''}.`
    : `Сцена «${title}».`
  const what = moments.length
    ? `Заметное: ${moments.join('; ')}.`
    : 'Ничего, что изменило бы мир, здесь не произошло.'
  const target = clean(destination, 160) || clean(destinationHint, 160)
  const reason = clean(decision, 300)
  const why = target && reason
    ? `Отряд ушёл в «${target}»: ${reason}.`
    : target
      ? `Отряд ушёл в «${target}».`
      : reason
        ? `Отряд двинулся дальше: ${reason}.`
        : 'Отряд двинулся дальше.'
  return { title, summary: `${where} ${what} ${why}` }
}

/**
 * Значение для `scene_args.scene_summary` — либо пустая строка, если сцена не
 * дала ни одного события и сводке было бы неоткуда взяться. Пустую строку
 * движок игнорирует и оставляет прежнее поведение (`outcome` Архитектора),
 * поэтому вызывающему не нужно ветвиться.
 *
 * Заголовок сводки движок берёт сам из покидаемой сцены — здесь только текст.
 */
export function sceneSummaryFor({
  state = {},
  events = [],
  decision = '',
  destinationHint = '',
  destination = '',
} = {}) {
  const sceneEvents = eventsSinceSceneStart(events)
  if (!sceneEvents.length) return ''
  return buildSceneSummaryText({ state, events: sceneEvents, decision, destinationHint, destination }).summary
}
