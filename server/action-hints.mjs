/**
 * Подсказки «что можно сделать» — задача 4.2 плана `docs/experience-upgrade-plan.md`.
 *
 * Состав игроков смешанный и плавающий: за столом регулярно сидит тот, кто
 * видит интерфейс впервые и не догадывается, что сундук можно осмотреть, а с
 * трактирщиком — заговорить. Подсказка отвечает ровно на это.
 *
 * Здесь **нет** ни модели, ни промпта, ни новой команды. Функция читает уже
 * спроецированную игроку комнату — ту самую, что и так уехала в браузер, — и
 * собирает из неё короткие строки. Поэтому раскрыть скрытое она не способна по
 * построению: чего нет в проекции, того нет и на входе. Это же и причина, по
 * которой подсказки строятся после проекции, а не до неё.
 *
 * В бою подсказок нет намеренно: там хотбар перечисляет доступные действия
 * точнее любой строки, и вторая подсказка рядом только мешала бы.
 */

import { sceneInteractionCatalogEntry, sceneInteractionRewardKinds, sceneObjectLabelFor } from './scene-interactions.mjs'

export const ACTION_HINTS_POLICY_ID = 'skazanie:action-hints-v1'

/** Больше четырёх строк — это уже не подсказка, а инструкция. */
export const MAX_ACTION_HINTS = 4

/**
 * Сколько строк подсказок отдаётся реквизиту.
 *
 * Интеракции открылись всей обстановке (задача 3.2b), и предметов на карте
 * таверны стало три десятка. Без этого потолка подсказки превращались в опись
 * мебели — «скамья, метла, сундук, паутина», — вытесняя единственные строки,
 * ради которых панель и заводилась: с кем говорить, куда идти и зачем.
 */
export const MAX_PROP_HINTS = 2

/**
 * Сколько строк достаётся добыче. Две — потому что после боя на полу лежит
 * столько же тел, сколько было противников, и опись трупов вытеснила бы всё
 * остальное ровно так же, как когда-то опись мебели.
 */
export const MAX_LOOT_HINTS = 2

/** Виды реквизита, за которыми сервер держит находку, тайник или знание. */
const REWARD_BEARING_KINDS = new Set(sceneInteractionRewardKinds())

const text = (value, maximum = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/**
 * Глаголы взаимодействия и то, как они звучат за столом. Список закрыт:
 * подсказка обязана называть то, что сервер действительно исполнит, а не
 * «что-нибудь ещё». Незнакомый глагол молча пропускается.
 */
const VERB_PHRASES = Object.freeze({
  inspect: 'осмотреть',
  open: 'открыть',
  take: 'забрать',
  use: 'использовать',
  topple: 'опрокинуть',
  ignite: 'поджечь',
})

/** Порядок предпочтения глаголов: осмотр безопаснее поджога. */
const VERB_ORDER = Object.freeze(['inspect', 'open', 'take', 'use', 'topple', 'ignite'])

/** «сундук» → «Сундук». Подсказка — начало фразы, а не середина. */
function capitalized(value) {
  return value ? value[0].toLocaleUpperCase('ru-RU') + value.slice(1) : ''
}

/**
 * Подсказки по реквизиту сцены — самая узкая часть панели.
 *
 * Три ограничения, и каждое поставлено по живому зонду:
 *
 * 1. Вид предмета решает каталог по `assetId`, а не присланное поле, и в
 *    подсказки пускаются только виды с наградой, тайником или знанием.
 *    Обстановка (`furnishing`) не попадает сюда вовсе: клик по доске её и так
 *    показывает, а строкой «можно осмотреть метлу» панель обесценивается.
 * 2. Подпись берётся из каталога подписей. Латинского идентификатора игрок не
 *    увидит никогда: без русской подписи предмет молча пропускается.
 * 3. Порядок детерминирован — приметное вперёд, дальше по идентификатору.
 */
function propHints(room) {
  const props = Array.isArray(room?.scene?.map?.props) ? room.scene.map.props : []
  const hints = []
  for (const prop of props) {
    if (prop?.interactive !== true) continue
    const catalog = sceneInteractionCatalogEntry(prop?.assetId)
    if (!catalog || !REWARD_BEARING_KINDS.has(catalog.kind)) continue
    const label = text(capitalized(sceneObjectLabelFor(prop?.assetId)), 60)
    if (!label) continue
    const verbs = Array.isArray(prop?.interaction?.verbs) ? prop.interaction.verbs.map(String) : catalog.verbs
    const verb = VERB_ORDER.find((candidate) => verbs.includes(candidate))
    if (!verb) continue
    hints.push({
      id: `prop:${text(prop?.id, 80)}:${verb}`,
      // Приметное — вперёд: точка интереса заметнее рядового ящика.
      priority: prop?.interaction?.pointOfInterest === true ? 0 : 1,
      text: `Можно ${VERB_PHRASES[verb]}: ${label}`,
    })
  }
  return hints
}

/**
 * Как зовётся обыск каждого вида контейнера. Глагол нужен свой: «обыскать
 * оружие пленного» — это не по-русски, а «Можно обыскать: Тело: Разбойник» из
 * первой редакции ставило двоеточие дважды подряд, потому что вид уже стоял в
 * имени контейнера.
 */
const LOOT_HINT_PHRASES = Object.freeze({
  corpse: 'обыскать тело',
  captive: 'забрать оружие пленного',
  abandoned: 'разобрать брошенное',
  cache: 'вскрыть схрон',
})

/**
 * Добыча в сцене. Идёт первой строкой не по вкусу: свежее тело — то, из-за чего
 * новичок чаще всего уходит со сцены ни с чем, потому что не догадался, что
 * снять с него что-то вообще можно.
 *
 * Подсказка честна про досягаемость: пока герой не дотянулся, сервер не отдал
 * содержимое, и обещать «можно обыскать» было бы неправдой — строка зовёт
 * подойти. Числа при этом не выдумываются: `item_count` уже в проекции, и
 * закрытым он не является.
 */
function lootHints(room) {
  const containers = Array.isArray(room?.loot_containers?.containers) ? room.loot_containers.containers : []
  return containers
    .filter((container) => container?.status !== 'emptied' && Number(container?.item_count) > 0)
    .slice(0, MAX_LOOT_HINTS)
    .flatMap((container) => {
      const name = text(container?.name, 60)
      if (!name) return []
      const phrase = LOOT_HINT_PHRASES[String(container?.kind ?? '')] ?? 'обыскать добычу'
      // Имя контейнера уже начинается с вида («Тело: Разбойник»), поэтому в
      // строку идёт только то, что после двоеточия, — иначе вид повторится.
      const subject = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : ''
      const target = subject ? `${phrase}: ${subject}` : phrase
      return [{
        id: `loot:${text(container?.id, 80)}`,
        priority: 0,
        text: container?.can_inspect === true
          ? `Можно ${target}`
          : `Можно ${target} — надо подойти вплотную`,
      }]
    })
}

function npcHints(room) {
  const npcs = Array.isArray(room?.scene_npcs) ? room.scene_npcs : []
  return npcs
    .filter((npc) => npc?.alive !== false && npc?.stance !== 'hostile')
    .map((npc) => {
      const name = text(npc?.name, 60)
      if (!name) return null
      const role = text(npc?.role, 40)
      return {
        id: `npc:${text(npc?.id, 80)}`,
        priority: 2,
        text: role ? `Можно заговорить с кем-то из местных: ${name} (${role})` : `Можно заговорить: ${name}`,
      }
    })
    .filter(Boolean)
}

function objectiveHint(room) {
  const objective = text(room?.scene?.objective, 90)
  return objective ? [{ id: 'objective', priority: 3, text: `Цель отряда: ${objective}` }] : []
}

/**
 * Выход из сцены. Дверь на публичной карте уже отфильтрована по раскрытым
 * клеткам, поэтому подсказка не выдаёт проход, которого игрок ещё не видел.
 */
function exitHints(room) {
  const doors = Array.isArray(room?.scene?.map?.doors) ? room.scene.map.doors : []
  if (!doors.length) return []
  return [{ id: 'exit', priority: 4, text: 'Можно уйти из этого места через дверь' }]
}

/**
 * Подсказки для одной комнаты. Вход — **уже спроецированная** игроку комната.
 *
 * Порядок детерминирован: сначала объявленный приоритет вида подсказки, затем
 * идентификатор. Иначе одна и та же сцена давала бы разный список от запроса к
 * запросу, а игрок читал бы это как изменение мира.
 *
 * Реквизит забирает только тот остаток строк, который не нужен собеседникам,
 * цели и выходу, и не больше `MAX_PROP_HINTS`. Место в списке предметы всё ещё
 * получают первое — приметное вперёд, — но получают его не за чужой счёт.
 *
 * @param {Record<string, any> | null | undefined} room
 * @returns {Array<{ id: string, text: string }>}
 */
export function suggestedActionsFor(room) {
  if (!room || typeof room !== 'object') return []
  if (room?.mechanics?.combat?.active === true) return []
  const seen = new Set()
  const ordered = (hints) => hints
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .filter((hint) => {
      if (!hint.text || seen.has(hint.text)) return false
      seen.add(hint.text)
      return true
    })
  // Сначала занимают места те, кого вытеснять нельзя: добыча, собеседники,
  // цель, выход. Добыча стоит первой строкой — см. `lootHints`.
  const reserved = ordered([...lootHints(room), ...npcHints(room), ...objectiveHint(room), ...exitHints(room)])
  const budget = Math.min(MAX_PROP_HINTS, Math.max(0, MAX_ACTION_HINTS - reserved.length))
  const props = ordered(propHints(room)).slice(0, budget)
  return [...props, ...reserved]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .slice(0, MAX_ACTION_HINTS)
    .map((hint) => ({ id: hint.id, text: hint.text }))
}
