/**
 * Согласованность игры для сквозного прогона (eval): говорит ли рассказчик то
 * же, что стоит на карте и что записала механика, держится ли сказанное от
 * хода к ходу и построена ли карта сцены так, как обещает её текст.
 *
 * Только чистые функции: состояние комнаты и текст на входе, список
 * расхождений на выходе. Словари объектов и проверки карты — серверные
 * (`scene-requirements`, `map-quality`), чтобы прогон мерил тем же, чем
 * мерит себя игра. Сторож — `test/eval-consistency-checks.test.mjs`.
 *
 * Каждое расхождение — `{ code, severity, message, evidence }`. Проверки
 * намеренно осторожные: лучше пропустить спорный случай, чем завалить отчёт
 * ложными тревогами, — спорное разбирает судья с контекстом (`judgeContext`).
 */
import { auditTacticalMap, countPlatforms, programReport } from '../server/map-quality.mjs'
import { requirementLabel, requirementsCoverage, sceneRequirementsFromText } from '../server/scene-requirements.mjs'
import { cellAt, deserializeTacticalMap } from '../server/tactical-map.mjs'
import { worldClockForAgents } from '../server/weather.mjs'

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim()
const lower = (value) => clean(value).toLocaleLowerCase('ru')
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Тактическая карта сцены или `null`, если её нет или она не читается. */
export function sceneMap(state) {
  const raw = state?.scene?.map
  if (!raw || typeof raw !== 'object') return null
  try { return deserializeTacticalMap(raw) } catch { return null }
}

/** Счётчик предметов карты по `assetId` и число настилов — вход для словарных проверок. */
export function mapObjectCounts(map) {
  const props = {}
  for (const prop of map?.props ?? []) props[prop.assetId] = (props[prop.assetId] ?? 0) + 1
  return { props, terrain: { platform: map ? countPlatforms(map) : 0 } }
}

/**
 * Объекты словаря, которые текст называет, а карта не держит. Тот же словарь и
 * та же проверка покрытия, что у программы сцены: «колодец» в тексте без
 * колодца на карте — расхождение, которое игрок увидит своими глазами.
 */
export function objectsMissingOnMap(text, map) {
  if (!map) return []
  const mentioned = sceneRequirementsFromText(text).map((entry) => ({ ...entry, count: 1 }))
  if (!mentioned.length) return []
  const { props, terrain } = mapObjectCounts(map)
  const { missing } = requirementsCoverage(mentioned, props, terrain)
  return missing.map((id) => ({ id, label: requirementLabel(id) }))
}

/**
 * Рассказчик против карты. Расхождение `minor`: текст может честно говорить о
 * том, что за пределами поля («в порту», «за рекой»), — но если такие слова
 * идут ответ за ответом, игрок перестаёт верить карте.
 */
export function narrationVersusMap(text, state) {
  return objectsMissingOnMap(text, sceneMap(state)).map((entry) => ({
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
export function narrationVersusClock(text, state) {
  let clock
  try { clock = worldClockForAgents(state) } catch { return [] }
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
    const match = new RegExp(`(?<![\\p{L}])(?:в|во|на|из|к|ко|у|до|от|по)\\s+${escape(name)}(?![\\p{L}»])`, 'iu').exec(source)
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
export function narrationConsistency(text, state, { check = null } = {}) {
  return [
    ...narrationVersusMap(text, state),
    ...narrationVersusCheck(text, check),
    ...narrationVersusState(text, state),
    ...narrationVersusClock(text, state),
    ...undeclinedPlaceNames(text, state),
    ...truncatedText(text),
  ]
}

/**
 * Карта сцены: построена ли играбельно (аудит `map-quality`) и держит ли
 * то, что обещают текст сцены и её программа. Проблемы аудита — `major`,
 * предупреждения и обещания текста — `minor`.
 */
export function sceneMapConsistency(state) {
  const map = sceneMap(state)
  const scene = state?.scene ?? {}
  if (!map) return [{ code: 'SCENE_WITHOUT_MAP', severity: 'major', message: `у сцены «${scene.location ?? '?'}» нет тактической карты`, evidence: '' }]
  const found = []
  // Аудит `map-quality` — тот же, что у `pnpm maps:preview --audit`: проходы,
  // двери наружу, мебель в проёмах, досягаемость, бедность обстановки.
  let audit = null
  try { audit = auditTacticalMap(map) } catch { audit = null }
  // Одна находка на вид проблемы: аудит называет каждую клетку, и проход
  // длиной в двадцать клеток иначе давал двадцать одинаковых строк.
  const byCode = new Map()
  for (const problem of audit?.problems ?? []) {
    const entry = byCode.get(problem.code) ?? { count: 0, details: [] }
    entry.count += 1
    if (problem.detail && entry.details.length < 4) entry.details.push(problem.detail)
    byCode.set(problem.code, entry)
  }
  for (const [code, entry] of byCode) found.push({ code: `MAP_${code}`, severity: 'major', message: `карта «${scene.location}»: ${code} ×${entry.count}${entry.details.length ? ` (${entry.details.join('; ')})` : ''}`, evidence: entry.details[0] ?? '' })
  if (scene.map_requirements) {
    try {
      const report = programReport(map, scene.map_requirements)
      for (const problem of report.problems) found.push({ code: `PROGRAM_${problem.code}`, severity: 'major', message: `программа сцены «${scene.location}»: ${problem.code}${problem.detail ? ` — ${requirementLabel(problem.detail) || problem.detail}` : ''}`, evidence: problem.detail ?? '' })
    } catch { /* программа старого формата */ }
  }
  // Текст самой сцены — заголовок, цель, описание — обещает объекты: игрок
  // читает «у колодца» и ищет колодец на карте.
  const promised = objectsMissingOnMap([scene.title, scene.objective, scene.description, scene.summary].filter(Boolean).join('. '), map)
  for (const entry of promised) found.push({ code: 'SCENE_TEXT_OBJECT_NOT_ON_MAP', severity: 'minor', message: `текст сцены «${scene.location}» обещает «${entry.label}», на карте его нет`, evidence: entry.id })
  const props = map.props?.length ?? 0
  let passable = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.passable) passable += 1
  if (passable >= 150 && props === 0) found.push({ code: 'MAP_EMPTY', severity: 'minor', message: `карта «${scene.location}» без единого предмета на ${passable} клетках`, evidence: '' })
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

/**
 * Контекст для судьи: что на самом деле есть в сцене в момент ответа. С ним
 * судья ловит то, что словарь не видит, — противоречия прошлому, выдуманных
 * людей, предметы, которых нет.
 */
export function judgeContext(state, { check = null, recentNarrations = [] } = {}) {
  const map = sceneMap(state)
  const { props } = mapObjectCounts(map)
  const objects = Object.entries(props).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([asset, count]) => `${asset}×${count}`).join(', ')
  const sceneLocation = lower(state?.scene?.location)
  const npcsHere = (state?.social?.npcs ?? []).filter((npc) => !npc.location || lower(npc.location) === sceneLocation || npc.placement).map((npc) => npc.name).slice(0, 10)
  let clock = null
  try { clock = worldClockForAgents(state) } catch { clock = null }
  return [
    `Место: ${state?.scene?.location ?? '?'} — «${state?.scene?.title ?? ''}». Цель сцены: ${state?.scene?.objective ?? '—'}.`,
    `Время: ${clock ? `${clock.time_of_day_label ?? clock.time_of_day}, ${clock.clock}, ${clock.indoors ? 'под крышей' : `погода: ${clock.weather_label ?? '—'}`}` : '—'}.`,
    `Предметы на карте: ${objects || 'нет'}.`,
    `Персонажи в сцене: ${npcsHere.join(', ') || 'никого'}. Герои: ${(state?.players ?? []).map((hero) => `${hero.character} (${hero.hp}/${hero.maxHp} ОЗ)`).join(', ')}.`,
    check ? `Бросок: ${check.label ?? check.skill} ${check.total} против ${check.difficulty} — ${check.success ? 'успех' : 'провал'}.` : '',
    recentNarrations.length ? `Перед этим ведущий говорил: ${recentNarrations.map((entry) => `«${clean(entry).slice(0, 220)}»`).join(' ')}` : '',
  ].filter(Boolean).join('\n')
}
