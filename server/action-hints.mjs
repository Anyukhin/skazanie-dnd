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

export const ACTION_HINTS_POLICY_ID = 'skazanie:action-hints-v1'

/** Больше четырёх строк — это уже не подсказка, а инструкция. */
export const MAX_ACTION_HINTS = 4

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

function propHints(room) {
  const props = Array.isArray(room?.scene?.map?.props) ? room.scene.map.props : []
  const hints = []
  for (const prop of props) {
    if (prop?.interactive !== true) continue
    const name = text(prop?.name ?? prop?.label ?? prop?.assetId, 60)
    if (!name) continue
    const verbs = Array.isArray(prop?.interaction?.verbs) ? prop.interaction.verbs.map(String) : []
    const verb = VERB_ORDER.find((candidate) => verbs.includes(candidate))
    if (!verb) continue
    hints.push({
      id: `prop:${text(prop?.id, 80)}:${verb}`,
      // Приметное — вперёд: точка интереса заметнее рядового ящика.
      priority: prop?.interaction?.pointOfInterest === true ? 0 : 1,
      text: `Можно ${VERB_PHRASES[verb]}: ${name}`,
    })
  }
  return hints
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
 * @param {Record<string, any> | null | undefined} room
 * @returns {Array<{ id: string, text: string }>}
 */
export function suggestedActionsFor(room) {
  if (!room || typeof room !== 'object') return []
  if (room?.mechanics?.combat?.active === true) return []
  const all = [...propHints(room), ...npcHints(room), ...objectiveHint(room), ...exitHints(room)]
  const seen = new Set()
  return all
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .filter((hint) => {
      if (!hint.text || seen.has(hint.text)) return false
      seen.add(hint.text)
      return true
    })
    .slice(0, MAX_ACTION_HINTS)
    .map((hint) => ({ id: hint.id, text: hint.text }))
}
