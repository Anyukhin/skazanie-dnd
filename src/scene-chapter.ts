/** Авторский заголовок может называть главу или отдельную сюжетную линию. */
export function sceneChapter(title: string | null | undefined, fallback: number) {
  const authored = /^(?:Глава(?:\s+(\d+))?|Линия|Пролог|Финал|Эпилог)(?=\s|[·:—–.-]|$)/iu.exec((title ?? '').trim())
  return { number: authored ? Number(authored[1] ?? 0) : fallback, inTitle: Boolean(authored) }
}

export function journalChapterNumber(title: string, fallback: number) {
  const { number } = sceneChapter(title, fallback)
  return number > 0 ? String(number).padStart(2, '0') : ''
}
