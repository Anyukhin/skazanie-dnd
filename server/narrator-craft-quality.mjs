/**
 * Каталог составлен по сохранённому прогону
 * `eval/live-narrator-report.json` от 2026-07-28 и живому baseline Wave 1.
 * Это не абстрактный список «плохих слов»: у каждой записи, кроме двух
 * обязательных примеров из брифа, есть дословно наблюдавшийся фрагмент.
 *
 * Каталог принадлежит production craft-guard. Offline eval импортирует тот же
 * список, чтобы измерение и проверка ответа Рассказчика не расходились.
 */
import catalog from '../data/narrator-cliches-v1.json' with { type: 'json' }

export const NARRATOR_CLICHE_CATALOG = Object.freeze(catalog)

const CLICHE_MATCHERS = Object.freeze(NARRATOR_CLICHE_CATALOG.map((entry) => ({
  entry,
  matcher: new RegExp(entry.pattern, 'iu'),
})))

export function findNarratorCliches(value) {
  const text = String(value ?? '').normalize('NFKC')
  const matches = []
  for (const { entry, matcher } of CLICHE_MATCHERS) {
    const match = matcher.exec(text)
    if (match) matches.push({ ...entry, match: match[0] })
  }
  return matches
}
