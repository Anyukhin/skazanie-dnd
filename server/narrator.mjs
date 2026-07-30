import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { eventSummary } from './rules-engine.mjs'
import { DeterministicNarrationVerifier, assertNarrationBrief, buildDataOnlyContext } from './security.mjs'

export const NARRATOR_PROMPT_VERSION = 'narrator/v4'
export const NARRATOR_RECENT_TEXT_LIMIT = 3
/**
 * Порог пересечения 3-грамм с недавним текстом, выше которого нарация считается
 * повтором и уходит на переспрос, а затем в детерминированный текст.
 *
 * Было 0.05, и это оказалось неестественно строго для прозы одной кампании: в
 * ней законно повторяются имена героев, названия мест и предметов. В собственном
 * эвале при таком пороге **все четыре** ответа модели были отсечены в шаблоны —
 * то есть «оригинальность» достигалась тем, что модель просто не попадала на
 * экран. Порог поднят так, чтобы отсекать настоящий самоповтор, а не общий
 * словарь сцены; фильтры клише и забытой памяти работают по-прежнему.
 */
export const NARRATOR_RECENT_3GRAM_OVERLAP_MAX = 0.14
/** Постоянный серверный текст: он и только он стоит снаружи блока данных. */
const REPAIR_INSTRUCTION = 'Исправь нарушения предыдущего варианта: они перечислены в секции narration_violations.'
const promptPath = fileURLToPath(new URL('../prompts/narrator/v4.txt', import.meta.url))
const narratorPrompt = readFileSync(promptPath, 'utf8')

const sceneText = (value, maximum = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const NARRATION_WORD_PATTERN = /[a-zа-яё0-9]+/giu

function narrationTrigrams(value) {
  const tokens = sceneText(value, 4_000).normalize('NFKC').toLocaleLowerCase('ru').match(NARRATION_WORD_PATTERN) ?? []
  const result = new Set()
  for (let index = 0; index + 3 <= tokens.length; index += 1) {
    result.add(tokens.slice(index, index + 3).join(' '))
  }
  return result
}

function trigramJaccard(leftText, rightText) {
  const left = narrationTrigrams(leftText)
  const right = narrationTrigrams(rightText)
  if (!left.size && !right.size) return { score: 0, shared: '' }
  let intersection = 0
  let shared = ''
  for (const item of left) {
    if (!right.has(item)) continue
    intersection += 1
    if (!shared) shared = item
  }
  return {
    score: intersection / Math.max(1, left.size + right.size - intersection),
    shared,
  }
}

function boundedRecentNarrations(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => sceneText(value, 4_000))
    .filter(Boolean)
    .slice(-NARRATOR_RECENT_TEXT_LIMIT)
}

function closestRecentNarration(value, recentNarrations) {
  let closest = { score: 0, shared: '' }
  for (const recent of boundedRecentNarrations(recentNarrations)) {
    const candidate = trigramJaccard(value, recent)
    if (candidate.score > closest.score) closest = candidate
  }
  return closest
}

const SUGGESTION_STOP_WORDS = new Set([
  'герой', 'героя', 'сцена', 'сцены', 'место', 'цель', 'дальше', 'снова',
  'проверить', 'осмотреть', 'осмотреться', 'узнать', 'спросить', 'уточнить',
  'поговорить', 'использовать', 'применить', 'предложить', 'продолжить',
  'the', 'and', 'with', 'from', 'into',
])

function suggestionRoot(token) {
  const value = String(token ?? '').toLocaleLowerCase('ru')
  const root = /^[а-яё]+$/u.test(value)
    ? value.replace(/(?:иями|ями|ами|ого|ему|ыми|ими|иях|ость|ости|ение|ений|ать|ять|ить|ешь|ете|ают|яют|ому|ей|ой|ий|ый|ая|яя|ое|ие|ам|ом|ую|ах|ях|ов|ев|ы|и|а|я|е|о|у)$/u, '')
    : value.replace(/(?:ations|ation|ments|ment|ingly|ing|edly|ed|ies|es|s)$/u, '')
  return root.length >= 3 ? root : value
}

function suggestionRoots(value) {
  return new Set((sceneText(value, 2_000).toLocaleLowerCase('ru').match(/[a-zа-яё0-9]+/giu) ?? [])
    .filter((token) => token.length >= 3 && !SUGGESTION_STOP_WORDS.has(token))
    .map(suggestionRoot))
}

function sharedRootCount(leftValues, rightValues) {
  const left = suggestionRoots((Array.isArray(leftValues) ? leftValues : [leftValues]).filter(Boolean).join(' '))
  const right = suggestionRoots((Array.isArray(rightValues) ? rightValues : [rightValues]).filter(Boolean).join(' '))
  let count = 0
  for (const root of left) if (right.has(root)) count += 1
  return count
}

export function narratorMemoryFocus(brief) {
  const environment = brief.known_environment ?? {}
  const scene = environment.scene ?? {}
  const story = environment.story_context ?? {}
  const sceneValues = [scene.title, scene.location, scene.objective]
  const factValues = (Array.isArray(environment.world_memory?.facts) ? environment.world_memory.facts : [])
    .flatMap((fact) => [fact?.subject, fact?.summary])
  const currentValues = [...sceneValues, ...factValues]

  const promises = (Array.isArray(story.open_promises) ? story.open_promises : [])
    .map((entry) => ({
      kind: 'promise',
      label: sceneText(entry?.npc || 'Открытое обещание', 120),
      cue: sceneText(entry?.text, 500),
      due_hint: sceneText(entry?.due_hint, 160),
      score: sharedRootCount([entry?.npc, entry?.text, entry?.due_hint], sceneValues),
    }))
    .filter((entry) => entry.cue)
    .sort((left, right) => right.score - left.score)
  if (promises[0]?.score >= 2) return promises[0]

  const interactions = (Array.isArray(story.recent_interactions) ? story.recent_interactions : [])
    .map((entry) => ({
      kind: 'interaction',
      label: sceneText(entry?.npc || 'NPC', 120),
      cue: sceneText(entry?.npc_reply, 500),
      player_message: sceneText(entry?.player_message, 240),
      score: sharedRootCount([entry?.npc, entry?.player_message, entry?.npc_reply], currentValues),
    }))
    .filter((entry) => entry.cue)
    .sort((left, right) => right.score - left.score)
  if (interactions[0]?.score >= 2) return interactions[0]

  const summaries = (Array.isArray(story.recent_summaries) ? story.recent_summaries : [])
    .map((entry, index) => ({
      kind: 'summary',
      label: sceneText(entry?.title || 'Прошлая сцена', 160),
      cue: sceneText(entry?.summary, 500),
      source_id: sceneText(entry?.id, 120),
      // При равной связи сохраняем более раннюю запись: при окне из двух сцен
      // это именно N-2, которую иначе постоянно вытесняет свежий пересказ N-1.
      order: index,
      score: sharedRootCount([entry?.title, entry?.summary], factValues),
    }))
    .filter((entry) => entry.cue)
    .sort((left, right) => (right.score - left.score) || (left.order - right.order))
  if (summaries[0]?.score >= 2) return summaries[0]

  const decisions = (Array.isArray(story.recent_decisions) ? story.recent_decisions : [])
    .map((entry) => ({
      kind: 'decision',
      label: sceneText(entry?.title || entry?.location || 'Прежнее решение', 160),
      cue: sceneText(entry?.outcome || entry?.objective, 500),
      score: sharedRootCount([entry?.title, entry?.location, entry?.objective, entry?.outcome], currentValues),
    }))
    .filter((entry) => entry.cue)
    .sort((left, right) => right.score - left.score)
  return decisions[0]?.score >= 1 ? decisions[0] : null
}

function briefForNarratorPrompt(brief) {
  const focus = narratorMemoryFocus(brief)
  if (!focus) return brief
  const { score: _score, order: _order, ...promptFocus } = focus
  const environment = brief.known_environment ?? {}
  return {
    ...brief,
    known_environment: {
      ...environment,
      story_context: {
        ...(environment.story_context ?? {}),
        memory_focus: promptFocus,
      },
    },
  }
}

function memoryFocusIsRecalled(narration, focus) {
  return !focus || sharedRootCount(narration, [focus.label, focus.cue]) >= 2
}

function memoryFocusReminder(focus, variant = 0) {
  if (!focus) return ''
  if (focus.kind === 'promise') {
    return [
      `Открытым остаётся обещание ${focus.label}: ${focus.cue}`,
      `${focus.label} всё ещё связан открытым обещанием: ${focus.cue}`,
      `Прежнее обещание от ${focus.label} не закрыто: ${focus.cue}`,
      `Нынешний шаг возвращает к обещанию ${focus.label}: ${focus.cue}`,
    ][variant % 4]
  }
  if (focus.kind === 'interaction') {
    const cue = focus.cue.replace(/[.!?]+$/u, '')
    return [
      `${focus.label} прежде говорил: «${cue}»`,
      `В прошлой беседе ${focus.label} оставил такую деталь: «${cue}»`,
      `Из прежних слов ${focus.label} важно одно: «${cue}»`,
      `Ответ ${focus.label} из прошлой встречи звучал так: «${cue}»`,
    ][variant % 4]
  }
  if (focus.kind === 'decision') {
    return [
      `Прежнее решение «${focus.label}» всё ещё важно: ${focus.cue}`,
      `К решению «${focus.label}» ведёт нынешняя деталь.`,
      `Сегодня отзывается выбор «${focus.label}».`,
      `Текущий след связан с решением «${focus.label}».`,
    ][variant % 4]
  }
  return [
    `С прошлой сценой «${focus.label}» это связывает одна деталь: ${focus.cue}`,
    `Нынешняя сцена прямо отсылает к эпизоду «${focus.label}».`,
    `Связанный эпизод называется «${focus.label}»; его деталь снова важна.`,
    `Из прошлого откликается сцена «${focus.label}» — нынешний факт связан с ней.`,
  ][variant % 4]
}

const escapePattern = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const CURRENT_REACTION_VERBS = [
  'кива(?:ет|ют|л[аио]?)', 'перелист(?:ывает|ывают|нул[аио]?)',
  'отодвига(?:ет|ют|л[аио]?)', 'убира(?:ет|ют|л[аио]?)',
  'смотр(?:ит|ят)', 'гляд(?:ит|ят)', 'переглядыва(?:ется|ются)',
  'улыба(?:ется|ются)', 'вздыха(?:ет|ют)', 'жестикулиру(?:ет|ют)',
  'открыва(?:ет|ют)', 'бер[её]т', 'клад[её]т',
  'говорит', 'отвеча(?:ет|ют)', 'произнос(?:ит|ят)', 'спрашива(?:ет|ют)',
  'отворачива(?:ется|ются)', 'поворачива(?:ется|ются)',
  'уход(?:ит|ят)', 'покида(?:ет|ют)', 'выход(?:ит|ят)', 'вход(?:ит|ят)',
  'подход(?:ит|ят)', 'отход(?:ит|ят)', 'отступа(?:ет|ют)',
  'вста(?:[её]т|ют)', 'сад(?:ится|ятся)',
  'отпира(?:ет|ют)', 'запира(?:ет|ют)', 'закрыва(?:ет|ют)',
  'доста[её]т', 'переда[её]т', 'поднима(?:ет|ют)', 'опуска(?:ет|ют)',
].join('|')
const PERMITTED_REACTION_PHRASES = [
  'встревожен\\w*', 'принима(?:ет|ют)\\s+довод\\w*',
  'оста[её]тся\\s+при\\s+сво[её]м', 'молча\\s+наблюда(?:ет|ют)',
  'держится\\s+(?:приветлив\\w*|насторож\\w*|холодн\\w*)',
  'наблюда(?:ет|ют)', 'след(?:ит|ят)',
].join('|')
const NPC_REACTION_MARKERS = `(?:${CURRENT_REACTION_VERBS}|${PERMITTED_REACTION_PHRASES})`
const NPC_REACTION_MATCHERS = Object.freeze({
  alarmed: /(?:встревож|тревож|вздрог|испуг)/iu,
  persuaded: /(?:принима\w*\s+довод|соглаша|убежд)/iu,
  unconvinced: /(?:оста[её]тся\s+при\s+сво[её]м|не\s+соглаша|не\s+убежд|отверга)/iu,
  welcoming: /(?:держится\s+приветлив|приветлив|радуш|доброжел)/iu,
  attentive: /(?:молча[^.!?]{0,24}(?:наблюда|смотр)|вниматель[^.!?]{0,24}(?:наблюда|смотр|слуша)|наблюда\w*\s+за\s+разговор)/iu,
  watchful: /(?:держится\s+насторож|настороже|насторожен|следит)/iu,
  cold: /(?:держится\s+холодн|холодно|отстран|сухо)/iu,
})
const HERO_AGENCY_VERBS = [
  'подход(?:ит|ят)', 'приседа(?:ет|ют)', 'склоня(?:ется|ются)',
  'наклоня(?:ется|ются)', 'проверя(?:ет|ют)', 'сравнива(?:ет|ют)',
  'складыва(?:ет|ют)', 'дума(?:ет|ют)', 'реша(?:ет|ют)',
  'осматрива(?:ет|ют)', 'каса(?:ется|ются)', 'трога(?:ет|ют)',
  'перебира(?:ет|ют)', 'ловит', 'вспомина(?:ет|ют)',
  'отпира(?:ет|ют)', 'запира(?:ет|ют)', 'открыва(?:ет|ют)', 'закрыва(?:ет|ют)',
  'уход(?:ит|ят)', 'покида(?:ет|ют)', 'вход(?:ит|ят)', 'выход(?:ит|ят)',
  'поворачива(?:ется|ются)', 'отворачива(?:ется|ются)',
  'вста(?:[её]т|ют)', 'сад(?:ится|ятся)',
  'бер[её]т', 'клад[её]т', 'доста[её]т', 'переда[её]т',
  'поднима(?:ет|ют)', 'опуска(?:ет|ют)',
].join('|')
const MECHANICAL_TERM = '(?:брос\\w*|выпал\\w*|итог\\w*|СЛ|HP|ОЗ|КД|урон\\w*|лечен\\w*|цен\\w*|монет\\w*|фт\\.?|фут\\w*|метр\\w*|минут\\w*|час\\w*|ресурс\\w*|заряд\\w*|ячейк\\w*)'
const MECHANICAL_NUMBER_PATTERN = new RegExp(`(?:${MECHANICAL_TERM})[^.!?\\d]{0,24}\\d|\\d[^.!?]{0,24}(?:${MECHANICAL_TERM})`, 'iu')
const OPEN_PROMISE_RESOLUTION_PATTERN = /обещан\w*[^.!?]{0,50}(?:на\s+месте|лежит|видне|торчит|найден|нашл|получен|передан|забра|доста)/iu
const PROMISED_OBJECT_STATE_PATTERN = /(?:леж(?:ит|ат|ал[аои]?|али)|наход(?:ит(?:ся)?|ятся|ился|илась|илось|ились)|видне(?:ется|ются|лся|лась|лись)|торч(?:ит|ат|ал[аои]?|али)|спрятан\w*|оставлен\w*|готов\w*|жд[её]т|найден\w*|на\s+месте)/iu
const PROMISE_GENERIC_ROOT_PREFIXES = [
  'обещ', 'остав', 'принес', 'покаж', 'показ', 'переда', 'получ',
  'исполн', 'выполн', 'сдерж', 'слов', 'открыт', 'прежн',
]

function normalizedActorName(value) {
  return sceneText(value, 120).toLocaleLowerCase('ru').replace(/[«»"'’.,:;!?()[\]{}]/gu, '').trim()
}

function actorReactionClauses(text, actor) {
  const name = sceneText(actor, 120)
  if (!name) return []
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapePattern(name)}(?![\\p{L}\\p{N}_])[^.!?]{0,56}(?:${NPC_REACTION_MARKERS})`,
    'giu',
  )
  return [...text.matchAll(pattern)].map((match) => match[0])
}

function reactionMatchesPermit(clause, permit) {
  const reaction = String(permit?.reaction ?? '').trim()
  const matcher = NPC_REACTION_MATCHERS[reaction]
  if (matcher?.test(clause)) return true
  return sharedRootCount(clause, permit?.description) >= 2
}

function promiseHasResolutionEvent(brief, promise) {
  const events = (brief.visible_events ?? []).filter((event) => event?.event_type === 'NpcPromiseResolved')
  if (!events.length) return false
  const promiseId = String(promise?.id ?? '').trim()
  if (!promiseId) return true
  return events.some((event) => String(event?.payload?.promise_id ?? '') === promiseId)
}

function promiseAnchorMatches(sentence, promise) {
  const actorRoots = suggestionRoots(promise?.npc)
  const anchors = [...suggestionRoots(promise?.text)].filter((root) => (
    !actorRoots.has(root)
    && !PROMISE_GENERIC_ROOT_PREFIXES.some((prefix) => root.startsWith(prefix))
  ))
  const sentenceRoots = suggestionRoots(sentence)
  if (anchors.length) return anchors.some((root) => sentenceRoots.has(root))
  return sharedRootCount(sentence, [promise?.npc, promise?.text]) >= 2
}

export function verifyNarratorCraft(narration, brief, verification, recentNarrations = []) {
  const text = String(narration ?? '')
  const story = brief.known_environment?.story_context ?? {}
  const violations = [...(verification.violations ?? [])]
  const add = (code, message, match = '') => {
    if (!violations.some((entry) => entry.code === code)) violations.push({ code, message, match: sceneText(match, 120) })
  }
  if (MECHANICAL_NUMBER_PATTERN.test(text)) {
    add('VISIBLE_MECHANICAL_NUMBER', 'Повествование повторяет механическое число, уже показанное интерфейсом')
  }

  const heroNames = (Array.isArray(story.heroes) ? story.heroes : []).map((hero) => hero?.name).filter(Boolean)
  if (heroNames.length) {
    const heroAgency = new RegExp(`(?:${heroNames.map(escapePattern).join('|')})[^.!?]{0,48}(?:${HERO_AGENCY_VERBS})`, 'iu')
    if (heroAgency.test(text)) {
      add('HERO_AGENCY_NOT_IN_BRIEF', 'Рассказчик приписал герою новое действие, мысль или решение', heroAgency.exec(text)?.[0])
    }
  }

  const permits = Array.isArray(brief.permitted_npc_reactions) ? brief.permitted_npc_reactions : []
  const permitsByName = new Map(permits
    .map((entry) => [normalizedActorName(entry?.name), entry])
    .filter(([name]) => name))
  const npcNames = (Array.isArray(story.present_npcs) ? story.present_npcs : [])
    .map((npc) => npc?.name)
    .filter(Boolean)
  const genericActors = ['стража', 'стражи', 'посетители', 'толпа', 'люди']
  const currentActors = [...new Set([...npcNames, ...permits.map((entry) => entry?.name), ...genericActors].filter(Boolean))]
  for (const actor of currentActors) {
    const clauses = actorReactionClauses(text, actor)
    if (!clauses.length) continue
    const permit = permitsByName.get(normalizedActorName(actor))
    if (!permit) {
      add('NPC_REACTION_NOT_PERMITTED', 'Повествование добавило текущую реакцию NPC вне allowlist', clauses[0])
      continue
    }
    if (clauses.some((clause) => !reactionMatchesPermit(clause, permit))) {
      add('NPC_REACTION_MISMATCH', 'Текущая реакция NPC не соответствует подтверждённому описанию allowlist', clauses.find((clause) => !reactionMatchesPermit(clause, permit)))
    }
  }

  const knownActors = new Set([
    ...currentActors.map(normalizedActorName),
    ...heroNames.map(normalizedActorName),
  ])
  const unconfirmedNamedReaction = new RegExp(
    `(?<![\\p{L}\\p{N}_])([А-ЯЁ][а-яё'’\\-]{1,50}(?:\\s+[А-ЯЁ][а-яё'’\\-]{1,50}){0,2})\\s+(?:${NPC_REACTION_MARKERS})`,
    'gu',
  )
  for (const match of text.matchAll(unconfirmedNamedReaction)) {
    if (!knownActors.has(normalizedActorName(match[1]))) {
      add('NPC_REACTION_NOT_PERMITTED', 'Повествование добавило реакцию неподтверждённого персонажа', match[0])
      break
    }
  }

  const openPromises = (Array.isArray(story.open_promises) ? story.open_promises : [])
    .filter((promise) => !promiseHasResolutionEvent(brief, promise))
  const promiseStateAssertion = (text.match(/[^.!?]+[.!?]?/gu) ?? []).find((sentence) => (
    PROMISED_OBJECT_STATE_PATTERN.test(sentence)
    && openPromises.some((promise) => promiseAnchorMatches(sentence, promise))
  ))
  if (openPromises.length && (OPEN_PROMISE_RESOLUTION_PATTERN.test(text) || promiseStateAssertion)) {
    add('PROMISE_RESOLUTION_NOT_IN_BRIEF', 'Рассказчик объявил обещанное полученным или находящимся на месте без события')
  }

  const focus = narratorMemoryFocus(brief)
  if (!memoryFocusIsRecalled(narration, focus)) {
    add(
      'LINKED_MEMORY_OMITTED',
      'Рассказчик пропустил наиболее тесно связанную видимую деталь прошлого',
      focus?.label,
    )
  }
  const repetition = closestRecentNarration(narration, recentNarrations)
  if (repetition.score > NARRATOR_RECENT_3GRAM_OVERLAP_MAX) {
    add(
      'RECENT_NARRATION_REPETITION',
      `Пересечение 3-грамм с недавним текстом превышает ${Math.round(NARRATOR_RECENT_3GRAM_OVERLAP_MAX * 100)}%`,
      repetition.shared,
    )
  }
  return {
    ...verification,
    valid: violations.length === 0,
    violations,
  }
}

/**
 * Обрамление сцены для детерминированного текста.
 *
 * Оно не добавляет ни одного факта: место, настроение, имена присутствующих
 * NPC и заголовок активного квеста уже лежат в NarrationBrief и уже прошли
 * фильтр видимости. Функция чистая — тот же brief даёт тот же текст, поэтому
 * replay остаётся идентичным.
 *
 * Смысл правки: когда провайдер недоступен, игрок видел голую строку вида
 * «Проверка Харизмы: 15 против СЛ 12» — механику без единого признака места и
 * происходящего. Отказ модели не должен выглядеть как отказ игры.
 */
function deterministicNarrationVariant(brief) {
  const ability = String(
    brief.visible_events.find((event) => event?.payload?.ability || event?.payload?.skill)?.payload?.ability
      ?? brief.visible_events.find((event) => event?.payload?.ability || event?.payload?.skill)?.payload?.skill
      ?? '',
  ).toLocaleLowerCase('en')
  const abilityVariants = new Map([
    ['str', 0], ['strength', 0],
    ['dex', 1], ['dexterity', 1],
    ['con', 2], ['constitution', 2],
    ['int', 3], ['intelligence', 3],
    ['wis', 0], ['wisdom', 0],
    ['cha', 1], ['charisma', 1],
  ])
  if (abilityVariants.has(ability)) return abilityVariants.get(ability)
  return 0
}

function deterministicFraming(brief, variant = 0) {
  const environment = brief.known_environment ?? {}
  const scene = environment.scene ?? {}
  const story = environment.story_context ?? {}
  const location = sceneText(scene.location || scene.title)
  const mood = sceneText(scene.mood, 60)
  const names = (Array.isArray(story.present_npcs) ? story.present_npcs : [])
    .map((npc) => sceneText(npc?.name, 60)).filter(Boolean).slice(0, 2)
  const opening = []
  if (location) {
    const locationVariants = mood
      ? [
          `${location}, ${mood}.`,
          `${location}.`,
          `${location}; обстановка — ${mood}.`,
          `${location}.`,
        ]
      : [`${location}.`, `${location}.`, `${location}.`, `${location}.`]
    opening.push(locationVariants[variant % 4])
  }
  if (names.length) {
    const reversedNames = [...names].reverse()
    opening.push([
      `Рядом ${names.join(' и ')}.`,
      `В сцене присутствуют ${reversedNames.join(', ')}.`,
      `Присутствующие: ${names.join('; ')}.`,
      `Здесь есть ${reversedNames.join(' и ')}.`,
    ][variant % 4])
  }
  const quests = Array.isArray(story.active_quests) ? story.active_quests : []
  return { opening: opening.join(' '), quest: sceneText(quests[0]?.title) }
}

/**
 * Имена участников из самого brief.
 *
 * Оркестратор передаёт резолвер только на части путей, а `Narrator` вызывает
 * запасной текст без него — и игрок видел служебный идентификатор:
 * «hero выбывает из боя» вместо «Ада выбывает из боя». Brief несёт нужные
 * пары id→имя сам: состав отряда и присутствующих NPC в `story_context`,
 * участники схватки — в `participants` критического момента.
 */
function briefNameResolver(brief) {
  const environment = brief.known_environment ?? {}
  const story = environment.story_context ?? {}
  const participants = environment.participants ?? {}
  const names = new Map()
  const remember = (list) => {
    for (const entry of Array.isArray(list) ? list : []) {
      const id = sceneText(entry?.id, 120)
      const name = sceneText(entry?.name, 120)
      if (id && name) names.set(id, name)
    }
  }
  remember(story.heroes)
  remember(story.present_npcs)
  remember(participants.heroes)
  remember(participants.enemies)
  return (id) => names.get(sceneText(id, 120)) ?? id
}

function confirmedOutcome(payload, field = 'success') {
  if (payload?.[field] === true) return 'успехом'
  if (payload?.[field] === false) return 'неудачей'
  if (Number.isFinite(Number(payload?.total)) && Number.isFinite(Number(payload?.difficulty))) {
    return Number(payload.total) >= Number(payload.difficulty) ? 'успехом' : 'неудачей'
  }
  return 'подтверждённым исходом'
}

/**
 * Механические числа уже показаны интерфейсом. Запасной рассказчик сохраняет
 * подтверждённый смысл события, но не превращается во второй боевой лог.
 */
function qualitativeEventSummary(event, resolveName) {
  const payload = event?.payload ?? {}
  const named = (id, fallback) => sceneText(id ? resolveName(id) : fallback, 120)
  const actor = named(event?.actor_id, 'Участник')
  const target = named((event?.target_ids ?? [])[0], 'Цель')
  switch (event?.event_type) {
    case 'DieRolled':
      return 'Бросок завершён'
    case 'AbilityCheckResolved':
      return `Проверка ${sceneText(payload.skill || payload.ability || 'способности', 48)} завершилась ${confirmedOutcome(payload)}`
    case 'SavingThrowResolved':
      return `Спасбросок ${actor} завершился ${confirmedOutcome(payload, payload.saved == null ? 'success' : 'saved')}`
    case 'SpellSavingThrowResolved':
      return `Спасбросок ${target} от ${sceneText(payload.spell_name || payload.spell_id || 'заклинания', 64)} завершился ${confirmedOutcome(payload, 'saved')}`
    case 'ConcentrationSavingThrowResolved':
      return payload.saved === true ? `${actor} сохраняет концентрацию` : `${actor} теряет концентрацию`
    case 'AttackResolved':
      return payload.hit === true ? `${actor} поражает ${target}` : `${actor} не достигает цели атакой`
    case 'AreaAttackResolved':
      return `${sceneText(payload.item_name || 'Атака', 64)} поражает указанную область`
    case 'DamageApplied':
      return payload.death_ward_triggered
        ? `Защита от смерти удерживает ${target} в бою`
        : `${target} получает подтверждённый урон`
    case 'HealingApplied':
      return `${target} получает подтверждённое лечение`
    case 'HitPointMaximumReduced':
      return `Запас сил ${target} ограничен`
    case 'ActorMoved':
      return `${actor} меняет позицию`
    case 'TravelResolved':
      return `Отряд завершает путь из ${sceneText(payload.from || 'прежнего места', 72)} в ${sceneText(payload.to || 'новое место', 72)}`
    case 'DowntimeResolved':
      return 'Передышка завершена'
    case 'MerchantItemAppraised':
      return `Торговец оценивает предмет «${sceneText(payload.item_name || payload.item_id || 'предмет', 64)}»`
    case 'MerchantPurchaseCompleted':
      return `Покупка «${sceneText(payload.item?.name || payload.catalog_id || 'предмета', 64)}» завершена`
    case 'MerchantServicePurchased':
      return `Услуга «${sceneText(payload.service_name || payload.service_id || 'торговца', 64)}» оплачена`
    case 'MerchantSaleCompleted':
      return `Продажа «${sceneText(payload.item?.name || payload.catalog_id || 'предмета', 64)}» завершена`
    case 'ResourceSpent':
      return `${actor} расходует ${sceneText(payload.resource || 'ресурс', 64)}`
    case 'DeathSavingThrowRolled':
      return `Спасбросок от смерти ${target} завершился ${confirmedOutcome(payload)}`
    case 'DeathSaveFailureRecorded':
      return `${target} получает провал спасброска от смерти`
    case 'KnockoutRecoveryProgressed':
    case 'StableRecoveryProgressed':
      return `Восстановление ${target} продолжается`
    case 'StableRecoveryScheduled':
      return `${target} стабилизирован и начинает восстанавливаться`
    case 'CombatStarted':
      return 'Бой начинается; порядок действий определён'
    case 'TurnStarted':
      return `Начинается ход ${target}`
    case 'NpcRelationshipAdjusted':
      return `Отношение NPC меняется с ${sceneText(payload.tier_before || 'нейтрального', 32)} на ${sceneText(payload.tier_after || 'новое', 32)}`
    case 'QuestClockAdvanced':
      return `Развитие квеста ${sceneText(payload.quest_id || 'отряда', 72)} продвинулось`
    case 'WorldFactRevealed':
      return 'Отряду открывается подтверждённый факт'
    default:
      return eventSummary(event, resolveName)
  }
}

function withoutVisibleNumbers(value) {
  return String(value ?? '')
    .replace(/[+−-]?\d+(?:[.,]\d+)?/gu, '')
    .replace(/\b(?:HP|ОЗ|КД|СЛ)\b/giu, '')
    .replace(/\s*(?:→|->)\s*/gu, ' ')
    .replace(/\(\s*\)/gu, '')
    .replace(/:\s*(?=[,.;]|$)/gu, '')
    .replace(/\s+([,.;:])/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

function deterministicNarrationCandidate(brief, resolve, variant) {
  const summaries = brief.visible_events
    .map((event) => withoutVisibleNumbers(qualitativeEventSummary(event, resolve)))
    .filter(Boolean)
  const { opening, quest } = deterministicFraming(brief, variant)
  const memory = withoutVisibleNumbers(memoryFocusReminder(narratorMemoryFocus(brief), variant))
  const body = summaries.length
    ? `${summaries.slice(0, 4).join('. ').replace(/\.+$/u, '')}.`
    : quest
      ? [
          `Пока ничего не меняется: «${quest}» ждёт решения отряда.`,
          `Решение по линии «${quest}» пока остаётся за отрядом.`,
          `В задаче «${quest}» ещё нет нового подтверждённого исхода.`,
          `События не изменились; следующий выбор по «${quest}» делает партия.`,
        ][variant % 4]
      : [
          'Пока ничего не меняется: следующий шаг за отрядом.',
          'Нового подтверждённого исхода нет; решение остаётся за отрядом.',
          'Состояние сцены прежнее, и партия выбирает следующий шаг.',
          'Мир не изменился; дальнейшее намерение определяет отряд.',
        ][variant % 4]
  const memorySentence = memory ? `${memory.replace(/\.+$/u, '')}.` : ''
  const orders = [
    [opening, body, memorySentence],
    [body, opening, memorySentence],
    [opening, memorySentence, body],
    [memorySentence, opening, body],
  ]
  return orders[variant % 4].filter(Boolean).join(' ')
}

export function deterministicNarration(brief, resolveName, { recentNarrations = [] } = {}) {
  assertNarrationBrief(brief)
  const resolve = resolveName ?? briefNameResolver(brief)
  const baseVariant = deterministicNarrationVariant(brief)
  const variants = [baseVariant, ...[0, 1, 2, 3].filter((variant) => variant !== baseVariant)]
  let narration = deterministicNarrationCandidate(brief, resolve, variants[0])
  let overlap = closestRecentNarration(narration, recentNarrations).score
  for (const variant of variants.slice(1)) {
    const candidate = deterministicNarrationCandidate(brief, resolve, variant)
    const candidateOverlap = closestRecentNarration(candidate, recentNarrations).score
    if (candidateOverlap >= overlap) continue
    narration = candidate
    overlap = candidateOverlap
  }
  return {
    narration,
  }
}

export class Narrator {
  constructor({ llmClient = null, verifier = new DeterministicNarrationVerifier(), maxAttempts = 2 } = {}) {
    this.llmClient = llmClient
    this.verifier = verifier
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || 2))
  }

  async render(brief, {
    knownRuleIds = [],
    style = 'Кратко и конкретно',
    timeoutMs = null,
    recentNarrations = [],
  } = {}) {
    assertNarrationBrief(brief)
    const recent = boundedRecentNarrations(recentNarrations)
    if (!this.llmClient) {
      const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
      return {
        ...fallback,
        verification: verifyNarratorCraft(
          fallback.narration,
          brief,
          this.verifier.verify(fallback.narration, brief, { knownRuleIds }),
          recent,
        ),
        prompt_version: NARRATOR_PROMPT_VERSION,
        provider: 'deterministic',
      }
    }

    const requestedTimeout = Number(timeoutMs)
    const deadlineController = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? new AbortController()
      : null
    const deadline = deadlineController
      ? setTimeout(() => {
          const error = new Error('Истекло время на необязательное повествование')
          error.code = 'NARRATION_DEADLINE'
          deadlineController.abort(error)
        }, requestedTimeout)
      : null
    try {
      let lastVerification = null
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        // Перечень нарушений несёт куски предыдущего ответа модели: `match`
        // приходит из её же текста. Модель — недоверенный генератор, поэтому
        // сам перечень уходит отдельной секцией внутрь UNTRUSTED_DATA, а
        // снаружи остаётся только постоянная серверная фраза.
        const violations = lastVerification?.violations?.length ? lastVerification.violations : null
        const repair = violations ? `\n${REPAIR_INSTRUCTION}` : ''
        let output
        try {
          output = await this.llmClient.completeJson({
            messages: [
              { role: 'system', content: narratorPrompt },
              {
                role: 'user',
                content: `${buildDataOnlyContext({
                  narration_brief: briefForNarratorPrompt(brief),
                  style,
                  ...(violations ? { narration_violations: violations } : {}),
                })}${repair}`,
              },
            ],
            temperature: 0.55,
            jsonExpected: 'object',
            signal: deadlineController?.signal,
          })
        } catch (error) {
          const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
          return {
            ...fallback,
            verification: {
              ...verifyNarratorCraft(
                fallback.narration,
                brief,
                this.verifier.verify(fallback.narration, brief, { knownRuleIds }),
                recent,
              ),
              ...(lastVerification?.violations?.length
                ? { repaired_from: lastVerification.violations }
                : {}),
              provider_error: String(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR').slice(0, 80),
            },
            prompt_version: NARRATOR_PROMPT_VERSION,
            provider: 'deterministic-provider-fallback',
          }
        }
        const result = { narration: String(output?.narration || '').trim() }
        lastVerification = verifyNarratorCraft(
          result.narration,
          brief,
          this.verifier.verify(result.narration, brief, { knownRuleIds }),
          recent,
        )
        if (lastVerification.valid && result.narration) {
          return { ...result, verification: lastVerification, prompt_version: NARRATOR_PROMPT_VERSION, provider: this.llmClient.constructor?.name ?? 'llm' }
        }
      }

      const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
      return {
        ...fallback,
        verification: {
          ...verifyNarratorCraft(
            fallback.narration,
            brief,
            this.verifier.verify(fallback.narration, brief, { knownRuleIds }),
            recent,
          ),
          repaired_from: lastVerification?.violations ?? [],
        },
        prompt_version: NARRATOR_PROMPT_VERSION,
        provider: 'deterministic-fallback',
      }
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
}
