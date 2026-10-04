/**
 * Раскладка активных задач журнала: одна текущая цель и перенесённые нити.
 *
 * Плейтест 2026-10-04, QP-04: отряд ушёл из Вельдбурга, не закрыв нить главы
 * (`carry_unresolved`), и журнал показал три равные активные задачи, среди них
 * «Отряд покинул «Вельдбург», не закрыв прежнюю сюжетную нить». Какая из них
 * текущая, игрок не понимал.
 *
 * Это только представление. Серверные задания, их цели и часы не меняются, и
 * перенесённая нить не закрывается: уйти, не закрыв, — не то же, что
 * отказаться (`server/scene-memory.mjs`).
 *
 * - Текущая цель — задание главы, в которой отряд сейчас (`quest:chapter:N`),
 *   а без него — задание, одна из целей которого совпадает с целью сцены.
 * - Незавершённая нить — задание прежней главы, которое осталось активным:
 *   задание главы закрывается при переходе, только если цель достигнута или
 *   от неё отказались, а продолжение цели номер главы не меняет.
 */

const normalized = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru')

const CHAPTER_QUEST = /^quest:chapter:(\d+)$/u

const chapterOf = (quest) => Number(CHAPTER_QUEST.exec(String(quest?.id ?? ''))?.[1] ?? 0)

/**
 * @param {{ scene?: { objective?: unknown }, adventure?: { chapter?: unknown }, worldMemory?: { quests?: Array<Record<string, any>> } } | null | undefined} state
 * @returns {{ currentId: string, carriedIds: string[] }}
 */
export function journalQuestFocus(state) {
  const active = (Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : [])
    .filter((quest) => quest?.status === 'active' && quest.id)
  const chapter = Number(state?.adventure?.chapter) || 0
  const objective = normalized(state?.scene?.objective)
  const current = active.find((quest) => chapter > 0 && chapterOf(quest) === chapter)
    ?? (objective ? active.find((quest) => (Array.isArray(quest.objectives) ? quest.objectives : []).some((entry) => normalized(entry) === objective)) : undefined)
  const carried = active.filter((quest) => quest !== current && chapterOf(quest) > 0 && chapterOf(quest) < chapter)
  return { currentId: current ? String(current.id) : '', carriedIds: carried.map((quest) => String(quest.id)) }
}
