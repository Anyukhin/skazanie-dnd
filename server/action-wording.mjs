/** Оставляет собственное утвердительное действие героя: слова в цитате и отрицания не исполняются. */
export function affirmativeActionText(message = '') {
  return String(message ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 2_000).toLocaleLowerCase('ru')
    .replace(/«[^»]*»|"[^"]*"|'[^']*'/gu, ' ')
    .replace(/(?:^|\s)(?:не|ни|без|никогда)\s+(?!только(?:\s|$))(?:буду|хочу|собираюсь)\s+(?:(?:его|её|их|это|так|себя)\s+)?\p{L}+/giu, ' ')
    .replace(/(?:^|\s)(?:не|ни|без|никогда)\s+(?!только(?:\s|$))\p{L}+/giu, ' ')
}
