/**
 * Согласованность игры для сквозного прогона (eval): говорит ли рассказчик то
 * же, что стоит на карте и что записала механика, держится ли сказанное от
 * хода к ходу и построена ли карта сцены так, как обещает её текст.
 *
 * Только чтение: состояние комнаты и текст на входе, список
 * расхождений на выходе. Словари объектов и проверки карты — серверные
 * (`scene-requirements`, `map-quality`), чтобы прогон мерил тем же, чем
 * мерит себя игра. План и словарь читает тестовая подкоманда Rust.
 *
 * Каждое расхождение — `{ code, severity, message, evidence }`. Проверки
 * намеренно осторожные: лучше пропустить спорный случай, чем завалить отчёт
 * ложными тревогами.
 */
import { serverBatch, serverCall } from '../test/kit/fixtures.mjs'

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim()
const lower = (value) => clean(value).toLocaleLowerCase('ru')
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Рассказчик против карты. Расхождение `minor`: текст может честно говорить о
 * том, что за пределами поля («в порту», «за рекой»), — но если такие слова
 * идут ответ за ответом, игрок перестаёт верить карте.
 */
function narrationVersusMap(objects, state) {
  return objects.map((entry) => ({
    code: 'NARRATION_OBJECT_NOT_ON_MAP', severity: 'minor',
    message: `рассказчик называет «${entry.label}», а на карте сцены «${state?.scene?.location ?? '?'}» его нет`,
    evidence: entry.id,
  }))
}

// `\b` в JavaScript знает только латиницу, поэтому границы слова — по буквам Unicode.
const SUCCESS_WORDS = /(?<![\p{L}])(?<!не )(?:удаётся|удалось|успешно|без труда|находит[её]?|находите|замечает|замечаете|обнаруживает|обнаруживаете)(?![\p{L}])/iu
const FAILURE_WORDS = /(?<![\p{L}])(?:не удаётся|не удалось|ничего не наход\p{L}*|ничего не замеча\p{L}*|безуспешно|провал\p{L}*|не выходит|не получается)(?![\p{L}])/iu

/**
 * Исход проверки против текста после броска: провал, описанный как удача, и
 * наоборот. Смотрит только на явные маркеры, частичный успех не трогает.
 */
export function narrationVersusCheck(text, check) {
  if (!check || typeof check.success !== 'boolean') return []
  const source = clean(text)
  if (!source) return []
  if (check.success === false && SUCCESS_WORDS.test(source) && !FAILURE_WORDS.test(source)) {
    return [{ code: 'NARRATION_CONTRADICTS_FAILED_CHECK', severity: 'major', message: `бросок «${check.label ?? check.skill ?? 'проверка'}» провален (${check.total} против ${check.difficulty}), а текст описывает удачу`, evidence: SUCCESS_WORDS.exec(source)?.[0] }]
  }
  if (check.success === true && FAILURE_WORDS.test(source) && !SUCCESS_WORDS.test(source)) {
    return [{ code: 'NARRATION_CONTRADICTS_PASSED_CHECK', severity: 'major', message: `бросок «${check.label ?? check.skill ?? 'проверка'}» успешен (${check.total} против ${check.difficulty}), а текст описывает неудачу`, evidence: FAILURE_WORDS.exec(source)?.[0] }]
  }
  return []
}

const DEATH_WORDS = '(?:погиб(?:ает|ла|ли)?|умира(?:ет|ют)|умер(?:ла|ли)?|мёртв(?:а|ы)?|мертв(?:а|ы)?|испуска(?:ет|ют) дух)'
const SPEECH_WORDS = '(?:отвечает|говорит|произносит|спрашивает|шепчет|кивает|усмехается|хмурится|бросает)'

/** Имя и первое слово имени — так текст обычно называет персонажа. */
function nameForms(name) {
  const full = clean(name)
  const first = full.split(' ')[0]
  return [...new Set([full, first].filter((entry) => entry.length >= 3))]
}

/**
 * Рассказчик против механики: живой герой объявлен погибшим; персонаж,
 * которого нет в этой сцене, отвечает репликой. Оба — `major`: первое
 * нарушает инвариант «рассказчик не объявляет смерть», второе ломает мир.
 */
export function narrationVersusState(text, state) {
  const source = clean(text)
  if (!source) return []
  const found = []
  for (const hero of state?.players ?? []) {
    const dead = state?.mechanics?.death?.heroes?.[hero.id]?.status === 'dead'
    if (dead) continue
    for (const form of nameForms(hero.character ?? hero.name)) {
      const match = new RegExp(`(?<![\\p{L}])${escape(form)}[^.!?]{0,40}?\\s${DEATH_WORDS}(?![\\p{L}])`, 'iu').exec(source)
      if (match && !/почти|чуть не|едва не|не\s+(?:погиб|умер)/iu.test(match[0])) {
        found.push({ code: 'NARRATION_DECLARES_DEATH', severity: 'major', message: `текст объявляет смерть героя ${hero.character}, а механика считает его живым`, evidence: match[0] })
        break
      }
    }
  }
  const sceneLocation = lower(state?.scene?.location)
  for (const npc of state?.social?.npcs ?? []) {
    if (!npc?.name || npc.dead === true) continue
    const here = !npc.location || lower(npc.location) === sceneLocation || npc.placement || npc.present === true
    if (here) continue
    for (const form of nameForms(npc.name)) {
      const match = new RegExp(`(?<![\\p{L}])${escape(form)}\\s+${SPEECH_WORDS}(?![\\p{L}])`, 'iu').exec(source)
      if (match) {
        found.push({ code: 'ABSENT_NPC_SPEAKS', severity: 'major', message: `${npc.name} отвечает в сцене «${state.scene.location}», хотя находится в «${npc.location}»`, evidence: match[0] })
        break
      }
    }
  }
  return found
}

const NIGHT_WORDS = /(?<![\p{L}])(?:ночь|ночью|ночное|ночная|ночной|полночь|луна|лунный|лунном|звёзды|звёздное)(?![\p{L}])/iu
const DAY_WORDS = /(?<![\p{L}])(?:полдень|полуденн\p{L}*|палящее солнце|ярким солнцем|солнце в зените)(?![\p{L}])/iu

/** Время суток в тексте против часов мира. Под крышей не проверяется. */
function narrationVersusClock(text, clock) {
  if (!clock || clock.indoors) return []
  const source = clean(text)
  const phase = String(clock.time_of_day ?? '')
  if (['day', 'morning'].includes(phase) && NIGHT_WORDS.test(source)) {
    return [{ code: 'NARRATION_WRONG_TIME_OF_DAY', severity: 'minor', message: `на часах ${clock.time_of_day_label ?? phase} (${clock.clock}), а текст описывает ночь`, evidence: NIGHT_WORDS.exec(source)?.[0] }]
  }
  if (phase === 'night' && DAY_WORDS.test(source)) {
    return [{ code: 'NARRATION_WRONG_TIME_OF_DAY', severity: 'minor', message: `на часах ночь (${clock.clock}), а текст описывает полдень`, evidence: DAY_WORDS.exec(source)?.[0] }]
  }
  return []
}

/**
 * Название места без склонения после предлога: «в Пепельная застава»,
 * «из Штормберг» склоняется, «Пепельная» — нет. Ловит только составные
 * названия с прилагательным в именительном падеже — их видно сразу.
 */
export function undeclinedPlaceNames(text, state) {
  const source = clean(text)
  const names = (state?.worldMap?.locations ?? []).map((location) => clean(location.name)).filter((name) => /^[А-ЯЁ]\p{L}+(?:ая|ый|ий|ое|ое) /u.test(name))
  const found = []
  for (const name of names) {
    // В кавычках название как имя собственное допустимо и в именительном («идём в «Пепельная застава»»).
    // У мужского и среднего рода винительный неодушевлённого совпадает с
    // именительным: «ходил в Дикий лес» верно, поэтому после «в»/«на» ловится
    // только женский род («в Пепельная застава»).
    const prepositions = /^[А-ЯЁ]\p{L}+ая /u.test(name) ? 'в|во|на|из|к|ко|у|до|от|по' : 'из|к|ко|у|до|от|по'
    const match = new RegExp(`(?<![\\p{L}])(?:${prepositions})\\s+${escape(name)}(?![\\p{L}»])`, 'iu').exec(source)
    if (match) found.push({ code: 'PLACE_NAME_NOT_DECLINED', severity: 'minor', message: `название места без склонения: «${match[0]}»`, evidence: match[0] })
  }
  return found
}

/** Обрыв на полуслове: текст кончается буквой без точки после длинного куска. */
export function truncatedText(text) {
  const source = clean(text)
  if (source.length < 60) return []
  return /[а-яё]$/iu.test(source) && !/[.!?…»)"]$/u.test(source)
    ? [{ code: 'TEXT_TRUNCATED', severity: 'minor', message: `текст обрывается на полуслове: «…${source.slice(-40)}»`, evidence: source.slice(-20) }]
    : []
}

/** Всё, что проверяется по одному ответу рассказчика. */
export async function narrationConsistency(text, state, { check = null } = {}) {
  const [map, clock] = await serverBatch([
    ['inspectSceneMap', state?.scene?.map, text],
    ['worldClockForAgents', state],
  ])
  return [
    ...narrationVersusMap(map?.missingObjects ?? [], state),
    ...narrationVersusCheck(text, check),
    ...narrationVersusState(text, state),
    ...narrationVersusClock(text, clock),
    ...undeclinedPlaceNames(text, state),
    ...truncatedText(text),
  ]
}

/**
 * Карта сцены: построена ли играбельно (аудит `map-quality`) и держит ли
 * то, что обещают текст сцены и её программа. Проблемы аудита — `major`,
 * предупреждения и обещания текста — `minor`.
 */
export async function sceneMapConsistency(state) {
  const scene = state?.scene ?? {}
  const sceneText = [scene.title, scene.objective, scene.description, scene.summary].filter(Boolean).join('. ')
  const map = await serverCall('inspectSceneMap', scene.map, sceneText, scene.map_requirements, true)
  if (!map) return [{ code: 'SCENE_WITHOUT_MAP', severity: 'major', message: `у сцены «${scene.location ?? '?'}» нет тактической карты`, evidence: '' }]
  const found = []
  // Аудит Rust проверяет проходы,
  // двери наружу, мебель в проёмах, досягаемость, бедность обстановки.
  // Одна находка на вид проблемы: аудит называет каждую клетку, и проход
  // длиной в двадцать клеток иначе давал двадцать одинаковых строк.
  const byCode = new Map()
  for (const problem of map.problems) {
    const entry = byCode.get(problem.code) ?? { count: 0, details: [] }
    entry.count += 1
    if (problem.detail && entry.details.length < 4) entry.details.push(problem.detail)
    byCode.set(problem.code, entry)
  }
  for (const [code, entry] of byCode) found.push({ code: `MAP_${code}`, severity: 'major', message: `карта «${scene.location}»: ${code} ×${entry.count}${entry.details.length ? ` (${entry.details.join('; ')})` : ''}`, evidence: entry.details[0] ?? '' })
  for (const problem of map.programProblems) found.push({ code: `PROGRAM_${problem.code}`, severity: 'major', message: `программа сцены «${scene.location}»: ${problem.code}${problem.detail ? ` — ${problem.label || problem.detail}` : ''}`, evidence: problem.detail ?? '' })
  for (const entry of map.missingObjects) found.push({ code: 'SCENE_TEXT_OBJECT_NOT_ON_MAP', severity: 'minor', message: `текст сцены «${scene.location}» обещает «${entry.label}», на карте его нет`, evidence: entry.id })
  if (map.passableCells >= 150 && map.propCount === 0) found.push({ code: 'MAP_EMPTY', severity: 'minor', message: `карта «${scene.location}» без единого предмета на ${map.passableCells} клетках`, evidence: '' })
  return found
}

/**
 * Согласованность во времени: одно и то же место под разными именами,
 * имя-заглушка вместо названия, место сцены не на карте мира.
 */
export function sceneContinuity(state, previous = null) {
  const scene = state?.scene ?? {}
  const found = []
  if (/^(?:След|Сцена|Локация|Глава)\s+\d+$/u.test(clean(scene.location)) || /^(?:След|Сцена|Локация)\s+\d+$/u.test(clean(scene.title))) {
    found.push({ code: 'PLACEHOLDER_SCENE_NAME', severity: 'major', message: `новая сцена называется заглушкой «${scene.location}»: ни игрок, ни рассказчик не знают, где они`, evidence: scene.location })
  }
  const currentId = state?.worldMap?.currentLocationId
  const current = (state?.worldMap?.locations ?? []).find((location) => location.id === currentId)
  if (previous && current && previous.locationId === currentId && previous.location && previous.location !== scene.location
    && lower(previous.location) !== lower(current.name) && lower(scene.location) !== lower(current.name)) {
    found.push({ code: 'LOCATION_RENAMED', severity: 'minor', message: `точка карты мира «${current.name}» в сцене зовётся то «${previous.location}», то «${scene.location}»`, evidence: scene.location })
  }
  return found
}
