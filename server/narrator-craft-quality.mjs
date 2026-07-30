/**
 * Каталог составлен по сохранённому прогону
 * `eval/live-narrator-report.json` от 2026-07-28 и живому baseline Wave 1.
 * Это не абстрактный список «плохих слов»: у каждой записи, кроме двух
 * обязательных примеров из брифа, есть дословно наблюдавшийся фрагмент.
 *
 * Каталог принадлежит production craft-guard. Offline eval импортирует тот же
 * список, чтобы измерение и проверка ответа Рассказчика не расходились.
 */
export const NARRATOR_CLICHE_CATALOG = Object.freeze([
  { id: 'air-thickens', label: 'воздух густеет', source: 'обязательный пример из брифа S', pattern: 'воздух\\s+густе' },
  { id: 'silence-hangs', label: 'повисает тишина', source: 'обязательный пример из брифа S', pattern: 'повиса(?:ет|ла)\\s+тишин' },
  { id: 'moment-freeze', label: 'на мгновение замирает', source: 'на мгновение замирает', pattern: 'на\\s+(?:одно\\s+)?мгновени[ея]\\s+(?:замира|засты)' },
  { id: 'eyes-flash', label: 'в глазах мелькает', source: 'в глазах мелькает узнавание', pattern: 'в\\s+глазах\\s+(?:мелька|вспых)' },
  { id: 'pulls-together', label: 'берёт себя в руки', source: 'быстро берёт себя в руки', pattern: 'бер[её]т\\s+себя\\s+в\\s+руки' },
  { id: 'legs-buckle', label: 'ноги подкашиваются', source: 'ноги подкашиваются', pattern: 'ноги\\s+подкашива' },
  { id: 'world-swims', label: 'мир плывёт', source: 'мир плывёт', pattern: 'мир\\s+плыв[её]т' },
  { id: 'air-smells', label: 'в воздухе пахнет', source: 'в воздухе пахнет пылью и дымом', pattern: 'в\\s+воздухе\\s+пахн' },
  { id: 'sun-declines', label: 'солнце клонится к закату', source: 'солнце клонится к закату', pattern: 'солнце\\s+клонится\\s+к\\s+закату' },
  { id: 'crimson-sky', label: 'багровые тона', source: 'окрашивая небо в багровые тона', pattern: 'небо.{0,24}багров|багров.{0,24}небо' },
  { id: 'cuts-through-din', label: 'перекрывает гул', source: 'голос перекрывает гул трактира', pattern: 'перекрыва[ею]т\\s+гул' },
  { id: 'last-lunge', label: 'в последнем рывке', source: 'извернувшись в последнем рывке', pattern: 'в\\s+последн(?:ем|ий)\\s+рывк' },
  { id: 'wariness-melts', label: 'настороженность тает', source: 'Мирина настороженность тает', pattern: 'настороженн[а-яё]*\\s+та[её]т' },
  { id: 'casts-a-glance', label: 'бросает взгляд', source: 'бросает взгляд на Северные ворота', pattern: 'броса[а-яё]*\\s+взгляд' },
  { id: 'thought-spins', label: 'в голове крутится', source: 'в голове крутится та же синяя нить', pattern: 'в\\s+голове\\s+крут' },
  { id: 'silence-stands', label: 'тишина стоит такая', source: 'тишина стоит такая, будто телега растворилась', pattern: 'тишина\\s+стоит\\s+так' },
  { id: 'threads-one-knot', label: 'нити одного узла', source: 'две нити одного узла', pattern: 'нит[ьи]\\s+одного\\s+узла' },
])

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
