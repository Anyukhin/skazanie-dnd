function normalizedRequest(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase('ru')
    .trim().replace(/[.!]+$/u, '').trim().replace(/\s+/gu, ' ')
}

/** Только явная просьба продолжить историю; реплика NPC и вопрос не двигают мир. */
export function isAdventureContinuation(text, { npcId = '', requestKind = 'action' } = {}) {
  if (npcId || requestKind !== 'action') return false
  return /^(?:продолжим(?: приключение| историю)?|продолжаем(?: приключение| историю)?|продолжить (?:приключение|историю))$/u.test(normalizedRequest(text))
}

/** Именованное нападение и составная заявка остаются обычным действием героя. */
export function isEncounterRequest(text, { npcId = '', requestKind = 'action' } = {}) {
  if (npcId || requestKind !== 'action') return false
  return /^(?:мы )?(?:ищем бой|хочу бой|начать бой|начинаем бой)$/u.test(normalizedRequest(text))
}

/** Это лишь выбор клиентского маршрута. Сервер проверяет происхождение решения. */
export function isDirectorPartyDecision(interaction) {
  return interaction?.type === 'vote' && String(interaction?.id ?? '').startsWith('autonomy-')
}

/**
 * Решение отряда уже принято и ждёт только продолжения. Тогда «продолжим» в
 * строке ввода значит то же, что кнопка «Продолжить историю» на карточке:
 * плейтест 2026-10-03 — отряд проголосовал за дамбу, игрок написал
 * «продолжим», а ведущий ответил «пока ничего не меняется». Исполненное
 * решение сервер снимает, поэтому повторно оно не сработает.
 */
export function awaitsDecisionContinuation(interaction) {
  return interaction?.status === 'resolved' && Boolean(interaction?.resolvedOptionId)
    && !interaction?.questAbandonment && !interaction?.questAcceptance
}
