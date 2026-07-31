import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { eventSummary } from './rules-engine.mjs'
import { DeterministicNarrationVerifier, assertNarrationBrief, buildDataOnlyContext } from './security.mjs'
import {
  currentNarratorGenerationParameters,
  currentNarratorStyle,
  currentNarratorStyleInstruction,
} from './campaign-ai-context.mjs'
import { findNarratorCliches } from './narrator-craft-quality.mjs'
import { npcDossiersForNarrator } from './npc-social.mjs'

export const NARRATOR_PROMPT_VERSION = 'narrator/v6'
export const NARRATOR_FEW_SHOT_VERSION = 'narrator-few-shot/v1'
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
/** Сколько уже написанных моделью клише напоминать ей на следующем ходу. */
export const NARRATOR_CLICHE_REMINDER_LIMIT = 6
export const NARRATOR_FEEDBACK_MEMORY_LIMIT = 128
export const NARRATOR_ARC_RECAP_MEMORY_LIMIT = 128
export const NARRATOR_STREAM_MAX_BYTES = 12 * 1024
const NARRATOR_ARC_RECAP_OVERRIDE = Symbol('narrator-arc-recap-override')
const promptPath = fileURLToPath(new URL('../prompts/narrator/v6.txt', import.meta.url))
const narratorPrompt = readFileSync(promptPath, 'utf8')
const fewShotPath = fileURLToPath(new URL('../prompts/narrator/few-shot-v1.json', import.meta.url))
const fewShotDocument = JSON.parse(readFileSync(fewShotPath, 'utf8'))

if (fewShotDocument?.version !== NARRATOR_FEW_SHOT_VERSION || !Array.isArray(fewShotDocument?.examples)) {
  throw new TypeError(`Некорректный корпус ${NARRATOR_FEW_SHOT_VERSION}`)
}

export const NARRATOR_FEW_SHOT_CORPUS = Object.freeze(fewShotDocument.examples.map((example) => Object.freeze({
  id: String(example?.id ?? ''),
  style: String(example?.style ?? ''),
  moment: String(example?.moment ?? ''),
  tones: Object.freeze((Array.isArray(example?.tones) ? example.tones : []).map(String)),
  text: String(example?.text ?? ''),
})))

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

/**
 * Клише, которые модель уже написала в этой кампании. Каталог целиком в промпт
 * не уезжает — иначе он снова начнёт их подсказывать (задача 46). Уходят только
 * дословные фрагменты собственного недавнего текста модели, то есть ровно тот
 * вердикт прошлого хода, который craft-guard записал в трассу.
 */
export function recentClicheReminders(recentNarrations) {
  const seen = new Map()
  for (const recent of boundedRecentNarrations(recentNarrations)) {
    // `label` — читаемая форма оборота; `match` бывает обрезком шаблона вроде
    // «воздух густе», и в напоминании он только сбивал бы модель с толку.
    for (const cliche of findNarratorCliches(recent)) {
      if (!seen.has(cliche.id)) seen.set(cliche.id, sceneText(cliche.label, 60))
    }
  }
  return [...seen.values()].slice(0, NARRATOR_CLICHE_REMINDER_LIMIT)
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

const MOMENT_EVENT_PATTERNS = Object.freeze([
  ['transition', /Scene|Travel|Location|Area|CampaignArc/i],
  ['combat', /Attack|Damage|Healing|Combat|Turn|SavingThrow|Concentration|Death|Knockout/i],
  ['discovery', /Reveal|Discover|Inspect|Search|WorldFact|Lore/i],
  ['social', /Npc|Relationship|Promise|Conversation|Dialogue/i],
])

export function narratorMomentFor(brief) {
  const events = Array.isArray(brief?.visible_events) ? brief.visible_events : []
  for (const [moment, pattern] of MOMENT_EVENT_PATTERNS) {
    if (events.some((event) => pattern.test(String(event?.event_type ?? '')))) return moment
  }
  if ((brief?.permitted_npc_reactions ?? []).length) return 'social'
  const scene = brief?.known_environment?.scene ?? {}
  if (scene.transition || scene.arrival) return 'transition'
  return events.length ? 'action' : 'quiet'
}

const TONE_PATTERNS = Object.freeze([
  ['tense', /напряж|опас|тревог|угроз|страх|мрач|жестк|tense|danger|grim|dark/iu],
  ['mysterious', /тайн|загад|мист|неизвест|скрыт|myst|secret/iu],
  ['somber', /печал|траур|скорб|безысход|суров|somber|tragic/iu],
  ['warm', /тёпл|уют|друж|добро|светл|warm|friendly/iu],
  ['hopeful', /надеж|героич|ободр|hope|heroic/iu],
  ['triumphant', /триумф|побед|торжеств|triumph|victor/iu],
])

function narratorToneTags(brief) {
  const premise = brief?.known_environment?.campaign_premise ?? {}
  const scene = brief?.known_environment?.scene ?? {}
  const source = [premise.tone, premise.themes, scene.mood, scene.theme].filter(Boolean).join(' ')
  const tags = TONE_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([tag]) => tag)
  return tags.length ? tags : ['grounded']
}

export function selectNarratorFewShotExamples(brief, {
  style = currentNarratorStyle(),
  count = 3,
} = {}) {
  const selectedStyle = ['neutral', 'formal', 'ironic'].includes(String(style)) ? String(style) : 'neutral'
  const moment = narratorMomentFor(brief)
  const tones = new Set(narratorToneTags(brief))
  const maximum = Math.max(2, Math.min(3, Number(count) || 3))
  return NARRATOR_FEW_SHOT_CORPUS
    .filter((example) => example.style === selectedStyle)
    .map((example) => ({
      ...example,
      score: (example.moment === moment ? 10 : 0)
        + example.tones.reduce((total, tone) => total + (tones.has(tone) ? 2 : 0), 0),
    }))
    .sort((left, right) => (right.score - left.score) || left.id.localeCompare(right.id))
    .slice(0, maximum)
    .map(({ score: _score, ...example }) => example)
}

function narratorPromptWithExamples(examples) {
  const fragments = examples.map((example, index) => (
    `${index + 1}. [${example.style}; ${example.moment}; ${example.tones.join(', ')}] ${example.text}`
  ))
  const marker = '\nВерни только готовое повествование обычным текстом.'
  const exampleSection = `\nCURATED_STYLE_EXAMPLES (${NARRATOR_FEW_SHOT_VERSION}):\n${fragments.join('\n')}\n`
  return narratorPrompt.includes(marker)
    ? narratorPrompt.replace(marker, `${exampleSection}${marker}`)
    : `${narratorPrompt}${exampleSection}`
}

export function narratorContentDirectives(brief) {
  const premise = brief?.known_environment?.campaign_premise ?? {}
  return {
    tone: sceneText(premise.tone, 500),
    themes: sceneText(premise.themes, 800),
    boundaries: sceneText(premise.boundaries, 1_000),
  }
}

function arcRecapIdentity(brief, recap) {
  const premise = brief?.known_environment?.campaign_premise ?? {}
  return [
    sceneText(premise.preset, 160),
    sceneText(premise.premise, 400),
    Number(recap?.arc_number) || 0,
    sceneText(recap?.title, 160),
    sceneText(recap?.epilogue, 1_200),
  ].join('\u001f')
}

function arcRecapSeen(recap, recentNarrations) {
  return boundedRecentNarrations(recentNarrations).some((narration) => (
    /в\s+прошл(?:ый|ую)\s+раз/iu.test(narration)
    && sharedRootCount(narration, [recap.title, recap.epilogue]) >= 2
  ))
}

function withArcRecapOverride(brief, recap) {
  const result = { ...brief }
  Object.defineProperty(result, NARRATOR_ARC_RECAP_OVERRIDE, {
    configurable: false,
    enumerable: false,
    value: recap,
    writable: false,
  })
  return result
}

/**
 * Источником recap всегда остаётся эпилог закрытой арки из `arc_history`.
 * Он нужен на самом событии перехода либо на первом вызове Narrator в первой
 * главе новой арки — второй критерий закрывает автономный переход, событие
 * которого не обязано попасть в следующий обычный narration brief.
 */
export function narratorArcRecap(brief, {
  includeOpeningArc = false,
  recentNarrations = [],
  recappedArcKeys = null,
} = {}) {
  if (Object.hasOwn(brief ?? {}, NARRATOR_ARC_RECAP_OVERRIDE)) {
    return brief[NARRATOR_ARC_RECAP_OVERRIDE]
  }
  const transition = (Array.isArray(brief?.visible_events) ? brief.visible_events : [])
    .find((event) => event?.event_type === 'CampaignArcCompleted')
  const premise = brief?.known_environment?.campaign_premise ?? {}
  const currentArc = Number(premise.current_arc_number)
  const currentChapter = Number(premise.current_chapter)
  const openingNewArc = Number.isSafeInteger(currentArc) && currentArc > 1
    && currentChapter === 1
  if (!transition && !(includeOpeningArc && openingNewArc)) return null
  const closedFromEvent = Number(transition?.payload?.closed_arc?.arc_number)
  const closedArc = Number.isSafeInteger(closedFromEvent) && closedFromEvent > 0
    ? closedFromEvent
    : Number.isSafeInteger(currentArc) && currentArc > 1
      ? currentArc - 1
      : null
  const history = Array.isArray(premise.arc_history) ? premise.arc_history : []
  const entry = [...history].reverse().find((candidate) => (
    closedArc == null || Number(candidate?.arc_number) === closedArc
  ))
  const epilogue = sceneText(entry?.epilogue, 1_200)
  if (!epilogue) return null
  const recap = {
    heading: 'В прошлый раз',
    arc_number: Number(entry?.arc_number) || closedArc,
    title: sceneText(entry?.title, 160),
    epilogue,
  }
  const recapKey = arcRecapIdentity(brief, recap)
  if (!transition && (
    arcRecapSeen(recap, recentNarrations)
    || (recappedArcKeys && typeof recappedArcKeys.has === 'function' && recappedArcKeys.has(recapKey))
  )) {
    return null
  }
  return recap
}

const SENSORY_PALETTES = Object.freeze({
  tavern: Object.freeze({
    smell: ['тёплый запах хлебной корки', 'дым очага с пряной горечью', 'запах дерева и пролитого эля'],
    sound: ['негромкий звон посуды', 'потрескивание поленьев', 'скрип половиц под редкими шагами'],
    light: ['медовый свет очага', 'неровное пламя настенных свечей', 'янтарные полосы света из окон'],
    touch: ['гладкое дерево, натёртое ладонями', 'тепло от очага на одной стороне лица', 'прохладная медь дверной скобы'],
  }),
  forest: Object.freeze({
    smell: ['смолистый запах хвои', 'сырой запах мха и коры', 'горечь раздавленных листьев'],
    sound: ['шорох ветвей над тропой', 'редкий треск сухих сучьев', 'приглушённый свист ветра между стволами'],
    light: ['пятнистый свет под кронами', 'узкие серые лучи между стволами', 'зелёный полумрак под ветвями'],
    touch: ['влажная кора под пальцами', 'мягкая хвоя под сапогами', 'холодные капли с нижних ветвей'],
  }),
  cavern: Object.freeze({
    smell: ['минеральная сырость камня', 'запах холодной воды', 'слабая горечь пещерной пыли'],
    sound: ['мерная капель в глубине', 'долгое эхо каждого шага', 'тихий ток воды за стеной'],
    light: ['свет, дробящийся на влажном камне', 'узкий отблеск на своде', 'густая тень за пределом огня'],
    touch: ['холодная шероховатость стены', 'скользкая каменная крошка', 'сырой воздух на коже'],
  }),
  temple: Object.freeze({
    smell: ['сухой запах ладана', 'воск и холодный камень', 'пыль старых тканей'],
    sound: ['долгое эхо под сводом', 'тихий звон подвесок', 'шелест воздуха в высоких нишах'],
    light: ['бледные полосы из верхних окон', 'ровное сияние на плитах', 'цветные пятна от витража'],
    touch: ['гладкий камень перил', 'прохлада плит под ладонью', 'сухая пыль на резьбе'],
  }),
  settlement: Object.freeze({
    smell: ['дым печей и влажная древесина', 'запах сена у дворов', 'смесь дорожной пыли и горячего железа'],
    sound: ['стук колёс по камню', 'далёкий лай за оградой', 'голоса из соседних дворов'],
    light: ['свет из низких окон', 'длинные тени между домами', 'бледное небо над крышами'],
    touch: ['пыль на деревянных перилах', 'шероховатый камень мостовой', 'прохлада железной скобы'],
  }),
  dungeon: Object.freeze({
    smell: ['застоявшаяся сырость', 'каменная пыль и старое железо', 'холодный запах подземного сквозняка'],
    sound: ['глухой отклик шагов', 'скрежет цепи где-то впереди', 'редкая капля за стеной'],
    light: ['тусклый отблеск на кладке', 'резкая граница света и тьмы', 'дрожащая тень в проёме'],
    touch: ['крошка раствора под пальцами', 'холод ржавой решётки', 'влажный камень стены'],
  }),
  generic: Object.freeze({
    smell: ['запах влажного камня', 'сухая пыль старого дерева', 'прохладный воздух с горечью дыма'],
    sound: ['тихий скрип где-то рядом', 'ровный шум ветра снаружи', 'короткое эхо шагов'],
    light: ['мягкий боковой свет', 'длинные неподвижные тени', 'тусклый отблеск на ближайшей поверхности'],
    touch: ['прохлада ближайшей стены', 'шероховатая поверхность под ладонью', 'сухой сквозняк у пола'],
  }),
})

const sensoryAnchorCache = new Map()

function stableTextHash(value) {
  let hash = 2166136261
  for (const character of String(value ?? '')) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function sensoryPaletteFor(scene) {
  const source = [scene?.title, scene?.location, scene?.theme, scene?.material].filter(Boolean).join(' ')
  if (/трактир|таверн|постоял|inn|tavern/iu.test(source)) return 'tavern'
  if (/лес|роща|чащ|дерев|хво|forest|wood/iu.test(source)) return 'forest'
  if (/пещер|грот|каверн|cave|cavern/iu.test(source)) return 'cavern'
  if (/храм|святилищ|часовн|temple|shrine/iu.test(source)) return 'temple'
  if (/город|деревн|посел|улиц|ворот|village|town|city/iu.test(source)) return 'settlement'
  if (/подзем|склеп|темниц|руин|dungeon|crypt|ruin/iu.test(source)) return 'dungeon'
  return 'generic'
}

function normalizedSensoryAnchors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const anchors = {
    smell: sceneText(value.smell, 180),
    sound: sceneText(value.sound, 180),
    light: sceneText(value.light, 180),
    touch: sceneText(value.touch, 180),
  }
  return Object.values(anchors).filter(Boolean).length >= 3 ? anchors : null
}

export function sensoryAnchorsFor(brief) {
  const scene = brief?.known_environment?.scene ?? {}
  const explicit = normalizedSensoryAnchors(scene.sensory_anchors)
  if (explicit) return explicit
  const key = sceneText(scene.id || scene.location || scene.title, 240)
  if (!key) return Object.freeze({})
  const cached = sensoryAnchorCache.get(key)
  if (cached) return cached
  const palette = SENSORY_PALETTES[sensoryPaletteFor(scene)]
  const seed = stableTextHash(key)
  const anchors = Object.freeze({
    smell: palette.smell[seed % palette.smell.length],
    sound: palette.sound[(seed >>> 5) % palette.sound.length],
    light: palette.light[(seed >>> 10) % palette.light.length],
    touch: palette.touch[(seed >>> 15) % palette.touch.length],
  })
  sensoryAnchorCache.set(key, anchors)
  while (sensoryAnchorCache.size > 256) sensoryAnchorCache.delete(sensoryAnchorCache.keys().next().value)
  return anchors
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
  const environment = brief.known_environment ?? {}
  const story = environment.story_context ?? {}
  const { npc_dossiers: _rawNpcDossiers, ...promptStory } = story
  const viewerHeroes = (Array.isArray(story.heroes) ? story.heroes : []).filter((hero) => hero?.is_viewer)
  const viewerIds = new Set(viewerHeroes.map((hero) => String(hero?.id ?? '')).filter(Boolean))
  const viewerNames = new Set(viewerHeroes.map((hero) => sceneText(hero?.name, 120).toLocaleLowerCase('ru')).filter(Boolean))
  const visibleSocialRecord = (record) => {
    if (['gm_only', 'gmOnly', 'npc_private', 'npcPrivate'].includes(String(record?.visibility ?? ''))) return false
    if (record?.visibility !== 'specific_player') return true
    return viewerIds.has(String(record?.hero_id ?? ''))
      || viewerNames.has(sceneText(record?.hero, 120).toLocaleLowerCase('ru'))
  }
  const promptBrief = {
    ...brief,
    known_environment: {
      ...environment,
      story_context: {
        ...promptStory,
        present_npcs: (Array.isArray(story.present_npcs) ? story.present_npcs : []).map((npc) => ({
          id: sceneText(npc?.id, 120),
          name: sceneText(npc?.name, 120),
          role: sceneText(npc?.role, 120),
          public_summary: sceneText(npc?.public_summary, 300),
          voice: sceneText(npc?.voice, 200),
          speech_profile: {
            pace: sceneText(npc?.speech_profile?.pace, 100),
            lexicon: sceneText(npc?.speech_profile?.lexicon, 180),
            mannerism: sceneText(npc?.speech_profile?.mannerism, 180),
          },
          relationship: sceneText(npc?.relationship, 40),
        })),
        open_promises: (Array.isArray(story.open_promises) ? story.open_promises : [])
          .filter(visibleSocialRecord)
          .map((promise) => ({
            id: sceneText(promise?.id, 120),
            npc: sceneText(promise?.npc, 120),
            hero_id: sceneText(promise?.hero_id, 120),
            direction: sceneText(promise?.direction, 40),
            text: sceneText(promise?.text, 280),
            due_hint: sceneText(promise?.due_hint, 160),
            source_conversation_id: sceneText(promise?.source_conversation_id, 120),
          })),
        recent_interactions: (Array.isArray(story.recent_interactions) ? story.recent_interactions : [])
          .filter(visibleSocialRecord)
          .map((interaction) => ({
            npc: sceneText(interaction?.npc, 120),
            hero: sceneText(interaction?.hero, 120),
            hero_id: sceneText(interaction?.hero_id, 120),
            player_message: sceneText(interaction?.player_message, 240),
            npc_reply: sceneText(interaction?.npc_reply, 320),
            stance: sceneText(interaction?.stance, 40),
          })),
      },
    },
  }
  if (!focus) return promptBrief
  const { score: _score, order: _order, ...promptFocus } = focus
  promptBrief.known_environment.story_context.memory_focus = promptFocus
  return promptBrief
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

const CONTENT_BOUNDARY_CATEGORIES = Object.freeze([
  {
    id: 'sexual-violence',
    declared: /сексуальн\w*\s+насили|изнасил|sexual\s+violence|rape/iu,
    forbidden: /сексуальн\w*\s+насили|изнасил|rape/iu,
  },
  {
    id: 'torture',
    declared: /пыт|истязан|torture/iu,
    forbidden: /пыт|истязан|tortur/iu,
  },
  {
    id: 'graphic-gore',
    declared: /натуралистич\w*\s+(?:насили|кров)|подробност\w*\s+(?:насили|ран)|расчлен|gore|graphic\s+violence/iu,
    forbidden: /расчлен|выпущенн\w*\s+киш|оторванн\w*\s+(?:рук|ног|голов)|gore/iu,
  },
  {
    id: 'harm-to-children',
    declared: /насили\w*\s+над\s+деть|вред\w*\s+дет|harm\s+to\s+children/iu,
    forbidden: /(?:убива|пыта|калеч)\w*[^.!?]{0,24}(?:реб[её]н|дет)|(?:реб[её]н|дет)[^.!?]{0,24}(?:убит|замуч|искалеч)/iu,
  },
])

function explicitBoundaryCategories(boundaries) {
  const text = String(boundaries ?? '')
  return CONTENT_BOUNDARY_CATEGORIES.filter((category) => category.declared.test(text))
}

function boundaryMatchIsNegated(text, index) {
  const prefix = text.slice(Math.max(0, index - 32), index)
  return /(?:без|никак(?:их|ого)?|не\s+показыва\w*|не\s+описыва\w*|избега\w*)\s*$/iu.test(prefix)
}

function contentBoundaryViolations(narration, directives) {
  const text = String(narration ?? '')
  const result = []
  for (const category of explicitBoundaryCategories(directives.boundaries)) {
    const match = category.forbidden.exec(text)
    if (!match || boundaryMatchIsNegated(text, match.index)) continue
    result.push({
      code: 'CONTENT_BOUNDARY_VIOLATION',
      category: category.id,
      message: `Повествование нарушает явную границу контента: ${category.id}`,
      match: sceneText(match[0], 120),
    })
  }
  return result
}

// Художественный verdict не пытается угадывать смысл произвольной прозы.
// Он признаёт только bounded server-owned профили: явное совпадение, явное
// противоречие либо честное отсутствие достаточных свидетельств.
const TONE_ALIGNMENT_PROFILES = Object.freeze([
  Object.freeze({
    id: 'warm',
    cues: Object.freeze(['тёпл', 'уют', 'дружелюб', 'добр', 'забот', 'нежн', 'сочувств', 'warm', 'cozy', 'friendly', 'kind', 'gentle', 'compassion']),
    opposites: Object.freeze(['холодн', 'враждеб', 'жесток', 'безжалост', 'ледян', 'cold', 'hostile', 'cruel', 'merciless']),
  }),
  Object.freeze({
    id: 'hopeful',
    cues: Object.freeze(['надежд', 'ободр', 'героич', 'спасен', 'hope', 'hopeful', 'encourag', 'heroic']),
    opposites: Object.freeze(['безнадёж', 'безысход', 'обреч', 'тщет', 'hopeless', 'despair', 'doomed', 'futile']),
  }),
  Object.freeze({
    id: 'somber',
    cues: Object.freeze(['мрачн', 'печал', 'траур', 'скорб', 'суров', 'grim', 'somber', 'tragic', 'bleak', 'mourning']),
    opposites: Object.freeze(['беззабот', 'празднич', 'весел', 'радост', 'carefree', 'festive', 'cheerful', 'jolly']),
  }),
  Object.freeze({
    id: 'tense',
    cues: Object.freeze(['напряж', 'опас', 'тревог', 'угроз', 'страх', 'насторож', 'tense', 'danger', 'alarm', 'threat', 'fear', 'wary']),
    opposites: Object.freeze(['безопасн', 'спокойн', 'безмятеж', 'расслаб', 'safe', 'calm', 'serene', 'relaxed']),
  }),
  Object.freeze({
    id: 'mysterious',
    cues: Object.freeze(['тайн', 'загад', 'мист', 'неизвест', 'скрыт', 'mystery', 'mysterious', 'secret', 'unknown', 'hidden']),
    opposites: Object.freeze(['очевидн', 'разгадан', 'полностью-ясн', 'obvious', 'solved', 'fully-clear']),
  }),
  Object.freeze({
    id: 'triumphant',
    cues: Object.freeze(['триумф', 'побед', 'торжеств', 'triumph', 'victor']),
    opposites: Object.freeze(['поражен', 'разгром', 'унижен', 'defeat', 'rout', 'humiliat']),
  }),
])

const THEME_GENERIC_ROOTS = new Set([
  'тем', 'кампан', 'истор', 'сюжет', 'сцен', 'геро', 'персонаж', 'приключен',
  'отношен', 'эмоц', 'чувств', 'выбор', 'последств', 'theme', 'campaign',
  'story', 'plot', 'scene', 'hero', 'character', 'adventur', 'emotion',
  'choice', 'consequenc', 'межд', 'через', 'посл', 'перед', 'вокруг',
  'против', 'котор', 'этот', 'потом', 'когда', 'пока', 'about', 'between',
  'through', 'after', 'before', 'around', 'against', 'which', 'this', 'that',
  'then', 'when', 'while', 'their',
])

const THEME_CONCEPT_PROFILES = Object.freeze([
  Object.freeze({
    id: 'memory',
    cues: Object.freeze(['памят', 'помн', 'воспомин', 'прошл', 'memory', 'remember', 'recollect', 'past$']),
    dismissals: Object.freeze([
      /(?:забыть|забуд\w*|отринуть)\s+(?:всё\s+)?(?:прошл\w*|память|воспоминан\w*)/iu,
      /(?:memory|the\s+past)\s+(?:means|matters)\s+nothing|forget\s+(?:all\s+)?(?:memory|the\s+past)/iu,
    ]),
  }),
  Object.freeze({
    id: 'duty',
    cues: Object.freeze(['долг$', 'обязан', 'клятв', 'служен', 'duty', 'obligat', 'oath', 'responsib']),
    dismissals: Object.freeze([
      /(?:долг|обязательств\w*)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)|нет\s+никак\w*\s+(?:долга|обязательств)/iu,
      /(?:duty|obligations?)\s+(?:means?|matters?)\s+nothing|no\s+(?:duty|obligations?)/iu,
    ]),
  }),
  Object.freeze({
    id: 'trust',
    cues: Object.freeze(['довер', 'верност', 'предан', 'союз', 'trust', 'loyal', 'faith']),
    dismissals: Object.freeze([
      /никому\s+нельзя\s+доверять|доверие[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)/iu,
      /never\s+trust\s+anyone|trust\s+(?:means?|matters?)\s+nothing|trust\s+is\s+meaningless/iu,
    ]),
  }),
  Object.freeze({
    id: 'hope',
    cues: Object.freeze(['надежд', 'hope']),
    dismissals: Object.freeze([
      /(?:надежд\w*)\s+(?:нет|не\s+остал\w*|бессмыслен\w*)/iu,
      /(?:there\s+is\s+)?no\s+hope|hope\s+is\s+meaningless/iu,
    ]),
  }),
  Object.freeze({
    id: 'justice',
    cues: Object.freeze(['справедлив', 'правосуд', 'justice']),
    dismissals: Object.freeze([
      /(?:справедливост\w*|правосудие)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)/iu,
      /justice\s+(?:means?|matters?)\s+nothing|justice\s+is\s+meaningless/iu,
    ]),
  }),
  Object.freeze({
    id: 'freedom',
    cues: Object.freeze(['свобод', 'воля$', 'freedom', 'liberty']),
    dismissals: Object.freeze([
      /свобод\w*[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)/iu,
      /(?:freedom|liberty)\s+(?:means?|matters?)\s+nothing|(?:freedom|liberty)\s+is\s+meaningless/iu,
    ]),
  }),
  Object.freeze({
    id: 'truth',
    cues: Object.freeze(['истин', 'правд', 'truth']),
    dismissals: Object.freeze([
      /(?:истин\w*|правда)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)/iu,
      /truth\s+(?:means?|matters?)\s+nothing|truth\s+is\s+meaningless/iu,
    ]),
  }),
])

function alignmentCueIsNegated(text, index) {
  const prefix = text.slice(Math.max(0, index - 56), index)
  return /(?:^|[^\p{L}])(?:без|не|никак\w*|избега\w*|without|not|never|no)\s+(?:[\p{L}'’\-]+\s+){0,2}$/iu.test(prefix)
}

function cueMatchesToken(token, cue) {
  return cue.endsWith('$') ? token === cue.slice(0, -1) : token.startsWith(cue)
}

function alignmentCueEvidence(value, cues, maximum = 4_000) {
  const text = sceneText(value, maximum).normalize('NFKC').toLocaleLowerCase('ru')
  const result = []
  const seen = new Set()
  for (const match of text.matchAll(/[a-zа-яё][a-zа-яё'’\-]*/giu)) {
    const cue = cues.find((candidate) => cueMatchesToken(match[0], candidate))
    if (!cue || seen.has(cue) || alignmentCueIsNegated(text, match.index ?? 0)) continue
    seen.add(cue)
    result.push({ cue, match: match[0] })
  }
  return result
}

function meaningfulThemeRoots(value) {
  return [...suggestionRoots(sceneText(value, 800))]
    .filter((root) => root.length >= 4 && ![...THEME_GENERIC_ROOTS]
      .some((generic) => root === generic || root.startsWith(generic)))
    .slice(0, 24)
}

function themeRootOverlap(themeRoots, narration) {
  const narrationRoots = meaningfulThemeRoots(sceneText(narration, 4_000))
  return themeRoots.find((root) => narrationRoots.includes(root)) ?? ''
}

function staticPatternEvidence(value, patterns, maximum = 4_000) {
  const text = sceneText(value, maximum)
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return sceneText(match[0], 120)
  }
  return ''
}

function toneAlignmentVerdict(narration, toneDirective) {
  const tone = sceneText(toneDirective, 500)
  if (!tone) return { status: 'not-configured' }
  const expected = TONE_ALIGNMENT_PROFILES.filter((profile) => (
    alignmentCueEvidence(tone, profile.cues, 500).length > 0
  ))
  if (!expected.length) return { status: 'insufficient-evidence' }
  if (expected.some((profile) => alignmentCueEvidence(narration, profile.cues).length > 0)) {
    return { status: 'passed' }
  }
  const oppositeEvidence = []
  const seen = new Set()
  for (const profile of expected) {
    for (const evidence of alignmentCueEvidence(narration, profile.opposites)) {
      if (seen.has(evidence.cue)) continue
      seen.add(evidence.cue)
      oppositeEvidence.push(evidence.match)
    }
  }
  return oppositeEvidence.length >= 2
    ? { status: 'violation', match: oppositeEvidence.slice(0, 4).join(', ') }
    : { status: 'insufficient-evidence' }
}

function themeAlignmentVerdict(narration, themeDirective) {
  const themes = sceneText(themeDirective, 800)
  if (!themes) return { status: 'not-configured' }
  const expectedConcepts = THEME_CONCEPT_PROFILES.filter((profile) => (
    alignmentCueEvidence(themes, profile.cues, 800).length > 0
  ))
  const themeRoots = meaningfulThemeRoots(themes)
  if (!expectedConcepts.length && !themeRoots.length) return { status: 'insufficient-evidence' }

  const dismissals = expectedConcepts
    .map((profile) => staticPatternEvidence(narration, profile.dismissals))
    .filter(Boolean)
  if (dismissals.length) {
    return { status: 'violation', match: dismissals.slice(0, 2).join(' · ') }
  }
  if (expectedConcepts.some((profile) => alignmentCueEvidence(narration, profile.cues).length > 0)) {
    return { status: 'passed' }
  }
  const sharedRoot = themeRootOverlap(themeRoots, narration)
  return sharedRoot
    ? { status: 'passed', match: sharedRoot }
    : { status: 'insufficient-evidence' }
}

function arcRecapIsPresent(narration, recap) {
  return !recap || (
    /в\s+прошл(?:ый|ую)\s+раз/iu.test(String(narration ?? ''))
    && sharedRootCount(narration, [recap.title, recap.epilogue]) >= 2
  )
}

function currentNarrationSegment(narration, brief, recentNarrations = []) {
  if (!narratorArcRecap(brief, { recentNarrations })) return String(narration ?? '')
  const separated = /^\s*В\s+прошл(?:ый|ую)\s+раз:\s*[\s\S]*?\bТеперь:\s*([\s\S]*)$/iu
    .exec(String(narration ?? ''))
  return separated?.[1] ?? String(narration ?? '')
}

/**
 * Синхронная fail-closed граница. Здесь остаются только нарушения фактов,
 * полномочий героя/NPC и явных стоп-тем: они не могут ждать следующего хода.
 * Художественные замечания вычисляет `verifyNarratorFeedback` после ответа.
 */
export function verifyNarratorCraft(narration, brief, verification, recentNarrations = []) {
  const text = String(narration ?? '')
  const currentText = currentNarrationSegment(text, brief, recentNarrations)
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
    if (heroAgency.test(currentText)) {
      add('HERO_AGENCY_NOT_IN_BRIEF', 'Рассказчик приписал герою новое действие, мысль или решение', heroAgency.exec(currentText)?.[0])
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
    const clauses = actorReactionClauses(currentText, actor)
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
  for (const match of currentText.matchAll(unconfirmedNamedReaction)) {
    if (!knownActors.has(normalizedActorName(match[1]))) {
      add('NPC_REACTION_NOT_PERMITTED', 'Повествование добавило реакцию неподтверждённого персонажа', match[0])
      break
    }
  }

  const openPromises = (Array.isArray(story.open_promises) ? story.open_promises : [])
    .filter((promise) => !promiseHasResolutionEvent(brief, promise))
  const promiseStateAssertion = (currentText.match(/[^.!?]+[.!?]?/gu) ?? []).find((sentence) => (
    PROMISED_OBJECT_STATE_PATTERN.test(sentence)
    && openPromises.some((promise) => promiseAnchorMatches(sentence, promise))
  ))
  if (openPromises.length && (OPEN_PROMISE_RESOLUTION_PATTERN.test(currentText) || promiseStateAssertion)) {
    add('PROMISE_RESOLUTION_NOT_IN_BRIEF', 'Рассказчик объявил обещанное полученным или находящимся на месте без события')
  }

  for (const violation of contentBoundaryViolations(text, narratorContentDirectives(brief))) {
    add(violation.code, violation.message, violation.match)
  }
  const arcRecap = narratorArcRecap(brief, { recentNarrations })
  if (!arcRecapIsPresent(text, arcRecap)) {
    add(
      'ARC_RECAP_OMITTED',
      'Первое повествование новой арки не содержит recap из эпилога предыдущей арки',
      arcRecap?.title || `арка ${arcRecap?.arc_number ?? ''}`,
    )
  }

  return {
    ...verification,
    valid: violations.length === 0,
    violations,
  }
}

function sensoryAnchorIsPresent(narration, sensoryAnchors) {
  return Object.values(sensoryAnchors ?? {})
    .filter(Boolean)
    .some((anchor) => sharedRootCount(narration, anchor) >= 2)
}

/**
 * Асинхронный по месту вызова verdict качества. Он ничего не переписывает в
 * текущем абзаце: результат хранится в памяти Narrator, попадает в eval и
 * подмешивается в UNTRUSTED_DATA следующего хода.
 */
export function verifyNarratorFeedback(narration, brief, {
  recentNarrations = [],
  sensoryAnchors = sensoryAnchorsFor(brief),
  contentDirectives = narratorContentDirectives(brief),
} = {}) {
  const text = sceneText(narration, 4_000)
  const directives = {
    tone: sceneText(contentDirectives?.tone, 500),
    themes: sceneText(contentDirectives?.themes, 800),
    boundaries: sceneText(contentDirectives?.boundaries, 1_000),
  }
  const violations = []
  const add = (code, message, match = '') => {
    if (!violations.some((entry) => entry.code === code)) {
      violations.push({ code, message, match: sceneText(match, 120) })
    }
  }
  const craftNotes = findNarratorCliches(text).map((cliche) => ({
    code: 'NARRATOR_CLICHE',
    message: `Повествование использует клише из production-каталога: «${cliche.label}»`,
    match: sceneText(cliche.match, 120),
  }))
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
  if (Object.values(sensoryAnchors ?? {}).filter(Boolean).length >= 3
    && !sensoryAnchorIsPresent(text, sensoryAnchors)) {
    add(
      'SENSORY_ANCHOR_OMITTED',
      'Повествование не переиспользовало ни один закреплённый сенсорный признак локации',
    )
  }
  const toneAlignment = toneAlignmentVerdict(text, directives.tone)
  if (toneAlignment.status === 'violation') {
    add(
      'NARRATOR_TONE_MISMATCH',
      `Абзац использует явные маркеры тона, противоположного настройке кампании «${sceneText(directives.tone, 120)}»`,
      toneAlignment.match,
    )
  }
  const themeAlignment = themeAlignmentVerdict(text, directives.themes)
  if (themeAlignment.status === 'violation') {
    add(
      'NARRATOR_THEME_UNALIGNED',
      `Абзац явно отбрасывает заявленные темы кампании «${sceneText(directives.themes, 160)}»; в следующем ходе верни их в повествование`,
      themeAlignment.match,
    )
  }
  for (const violation of contentBoundaryViolations(text, directives)) {
    add(violation.code, violation.message, violation.match)
  }
  return {
    valid: violations.length === 0,
    violations,
    ...(craftNotes.length ? { craft_notes: craftNotes } : {}),
    content_alignment: {
      tone: toneAlignment.status,
      themes: themeAlignment.status,
      boundaries: directives.boundaries
        ? (violations.some((entry) => entry.code === 'CONTENT_BOUNDARY_VIOLATION') ? 'violation' : 'passed')
        : 'not-configured',
    },
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
  const sensoryAnchors = sensoryAnchorsFor(brief)
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
  const sensory = [
    sensoryAnchors.sound,
    sensoryAnchors.light,
    sensoryAnchors.smell,
    sensoryAnchors.touch,
  ][variant % 4]
  if (sensory) opening.push(`${sensory[0].toLocaleUpperCase('ru')}${sensory.slice(1)}.`)
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
    case 'CampaignArcCompleted':
      return 'Завершённая история уступает место новой арке'
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

function deterministicNarrationCandidate(brief, resolve, variant, arcRecap) {
  const summaries = brief.visible_events
    .map((event) => withoutVisibleNumbers(qualitativeEventSummary(event, resolve)))
    .filter(Boolean)
  const { opening, quest } = deterministicFraming(brief, variant)
  const memory = withoutVisibleNumbers(memoryFocusReminder(narratorMemoryFocus(brief), variant))
  const recapText = withoutVisibleNumbers(sceneText(arcRecap?.epilogue, 480))
  const recap = recapText
    ? `В прошлый раз: ${recapText.replace(/[.!?]+$/u, '')}. Теперь:`
    : ''
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
  return [recap, ...orders[variant % 4]].filter(Boolean).join(' ')
}

export function deterministicNarration(brief, resolveName, { recentNarrations = [] } = {}) {
  assertNarrationBrief(brief)
  const resolve = resolveName ?? briefNameResolver(brief)
  const baseVariant = deterministicNarrationVariant(brief)
  const variants = [baseVariant, ...[0, 1, 2, 3].filter((variant) => variant !== baseVariant)]
  const arcRecap = narratorArcRecap(brief, { recentNarrations })
  let narration = deterministicNarrationCandidate(brief, resolve, variants[0], arcRecap)
  let overlap = closestRecentNarration(narration, recentNarrations).score
  for (const variant of variants.slice(1)) {
    const candidate = deterministicNarrationCandidate(brief, resolve, variant, arcRecap)
    const candidateOverlap = closestRecentNarration(candidate, recentNarrations).score
    if (candidateOverlap >= overlap) continue
    narration = candidate
    overlap = candidateOverlap
  }
  return {
    narration,
  }
}

function completeSentencePrefix(value) {
  const text = String(value ?? '')
  let end = 0
  for (const match of text.matchAll(/[.!?…](?:["»')\]]+)?(?=\s|$)/gu)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end ? text.slice(0, end).trim() : ''
}

function provisionalNarrationIsSafe(text, brief, verifier, knownRuleIds, recentNarrations) {
  const verification = verifyNarratorCraft(
    text,
    brief,
    verifier.verify(currentNarrationSegment(text, brief, recentNarrations), brief, { knownRuleIds }),
    recentNarrations,
  )
  return verification.violations.every((violation) => violation.code === 'ARC_RECAP_OMITTED')
}

function narrationProgressBuffer({
  brief,
  verifier,
  knownRuleIds,
  recentNarrations,
  onProgress,
}) {
  let raw = ''
  let emitted = ''
  let blocked = false
  return (delta) => {
    const next = `${raw}${String(delta ?? '')}`
    if (Buffer.byteLength(next, 'utf8') > NARRATOR_STREAM_MAX_BYTES) {
      const error = new Error(`Narration stream exceeds ${NARRATOR_STREAM_MAX_BYTES} bytes`)
      error.code = 'NARRATION_STREAM_TOO_LARGE'
      throw error
    }
    raw = next
    if (blocked || typeof onProgress !== 'function') return
    const prefix = completeSentencePrefix(raw)
    if (!prefix || prefix === emitted) return
    if (!provisionalNarrationIsSafe(prefix, brief, verifier, knownRuleIds, recentNarrations)) {
      blocked = true
      return
    }
    emitted = prefix
    // Граница намеренно синхронная: непроверенный префикс не должен попасть в
    // асинхронную транспортную очередь до возврата из этого вызова.
    onProgress(prefix)
  }
}

export class Narrator {
  constructor({
    llmClient = null,
    verifier = new DeterministicNarrationVerifier(),
    feedbackVerifier = verifyNarratorFeedback,
    asyncFeedback = true,
    // Сохранён для совместимости с прежними точками сборки. Горячий путь v6
    // всегда делает ровно одну генерацию и не использует repair-attempt.
    maxAttempts: _legacyMaxAttempts = 1,
  } = {}) {
    this.llmClient = llmClient
    this.verifier = verifier
    this.feedbackVerifier = feedbackVerifier
    this.asyncFeedback = asyncFeedback !== false
    this.feedbackMemory = new Map()
    this.arcRecapMemory = new Set()
    this.maxAttempts = 1
  }

  _scheduleFeedback(narration, brief, options) {
    if (!this.asyncFeedback || typeof this.feedbackVerifier !== 'function') return null
    const text = sceneText(narration, 4_000)
    if (!text) return null
    const task = Promise.resolve()
      .then(() => this.feedbackVerifier(text, structuredClone(brief), structuredClone(options)))
      .then((feedback) => ({
        valid: feedback?.valid === true,
        violations: Array.isArray(feedback?.violations) ? feedback.violations : [],
        ...(Array.isArray(feedback?.craft_notes) && feedback.craft_notes.length
          ? { craft_notes: feedback.craft_notes }
          : {}),
        ...(feedback?.content_alignment ? { content_alignment: feedback.content_alignment } : {}),
      }))
      .catch((error) => ({
        valid: false,
        violations: [{
          code: 'NARRATOR_ASYNC_VERIFIER_ERROR',
          message: 'Асинхронная проверка качества не завершилась',
          match: '',
        }],
        verifier_error: String(error?.code ?? error?.name ?? 'NARRATOR_ASYNC_VERIFIER_ERROR').slice(0, 80),
      }))
    this.feedbackMemory.delete(text)
    this.feedbackMemory.set(text, { task, consumed: false })
    while (this.feedbackMemory.size > NARRATOR_FEEDBACK_MEMORY_LIMIT) {
      this.feedbackMemory.delete(this.feedbackMemory.keys().next().value)
    }
    return task
  }

  async awaitFeedback(narration) {
    const entry = this.feedbackMemory.get(sceneText(narration, 4_000))
    return entry ? entry.task : null
  }

  async drainFeedback() {
    const entries = [...this.feedbackMemory.entries()]
    return Promise.all(entries.map(async ([narration, entry]) => ({
      narration,
      feedback: await entry.task,
      consumed: entry.consumed,
    })))
  }

  async _consumeRecentFeedback(recentNarrations) {
    const feedback = []
    for (const narration of [...recentNarrations].reverse()) {
      const entry = this.feedbackMemory.get(narration)
      if (!entry || entry.consumed) continue
      entry.consumed = true
      feedback.push(await entry.task)
    }
    return feedback
  }

  _result({
    narration,
    brief,
    recent,
    sensoryAnchors,
    contentDirectives,
    verification,
    priorFeedback,
    examples,
    provider,
  }) {
    const arcRecap = narratorArcRecap(brief, { recentNarrations: recent })
    if (arcRecap) {
      this.arcRecapMemory.add(arcRecapIdentity(brief, arcRecap))
      while (this.arcRecapMemory.size > NARRATOR_ARC_RECAP_MEMORY_LIMIT) {
        this.arcRecapMemory.delete(this.arcRecapMemory.values().next().value)
      }
    }
    this._scheduleFeedback(narration, brief, {
      recentNarrations: recent,
      sensoryAnchors,
      contentDirectives,
    })
    return {
      narration,
      verification: {
        ...verification,
        feedback_mode: this.asyncFeedback ? 'async-next-turn' : 'disabled',
        feedback_pending: this.asyncFeedback,
        ...(priorFeedback.length ? { feedback_applied: priorFeedback } : {}),
        style_example_ids: examples.map((example) => example.id),
        ...(arcRecap ? {
          arc_recap: {
            source: 'campaign_premise.arc_history',
            arc_number: arcRecap.arc_number,
          },
        } : {}),
      },
      prompt_version: NARRATOR_PROMPT_VERSION,
      few_shot_version: NARRATOR_FEW_SHOT_VERSION,
      provider,
    }
  }

  async render(brief, {
    knownRuleIds = [],
    style = 'Кратко и конкретно',
    timeoutMs = null,
    recentNarrations = [],
    onProgress = null,
  } = {}) {
    assertNarrationBrief(brief)
    const campaignStyle = currentNarratorStyleInstruction()
    if (campaignStyle) style = `${campaignStyle}\n${style}`
    const recent = boundedRecentNarrations(recentNarrations)
    const priorFeedback = await this._consumeRecentFeedback(recent)
    const arcRecap = narratorArcRecap(brief, {
      includeOpeningArc: true,
      recentNarrations: recent,
      recappedArcKeys: this.arcRecapMemory,
    })
    brief = withArcRecapOverride(brief, arcRecap)
    const sensoryAnchors = sensoryAnchorsFor(brief)
    const contentDirectives = narratorContentDirectives(brief)
    const npcDossiers = npcDossiersForNarrator(brief)
    const examples = selectNarratorFewShotExamples(brief)
    if (!this.llmClient) {
      const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
      return this._result({
        narration: fallback.narration,
        brief,
        recent,
        sensoryAnchors,
        contentDirectives,
        verification: verifyNarratorCraft(
          fallback.narration,
          brief,
          this.verifier.verify(currentNarrationSegment(fallback.narration, brief, recent), brief, { knownRuleIds }),
          recent,
        ),
        priorFeedback,
        examples,
        provider: 'deterministic',
      })
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
      const avoidCliches = recentClicheReminders(recent)
      const generation = currentNarratorGenerationParameters()
      const request = {
        messages: [
          { role: 'system', content: narratorPromptWithExamples(examples) },
          {
            role: 'user',
            content: buildDataOnlyContext({
              narration_brief: briefForNarratorPrompt(brief),
              style,
              content_preferences: contentDirectives,
              sensory_anchors: sensoryAnchors,
              ...(npcDossiers.length ? { npc_dossiers: npcDossiers } : {}),
              ...(arcRecap ? { previous_arc_recap: arcRecap } : {}),
              ...(avoidCliches.length ? { avoid_repeated_phrases: avoidCliches } : {}),
              ...(priorFeedback.length ? { previous_narration_feedback: priorFeedback } : {}),
            }),
          },
        ],
        ...generation,
        signal: deadlineController?.signal,
      }
      let narration = ''
      try {
        if (typeof this.llmClient.complete === 'function') {
          const completion = await this.llmClient.complete({
            ...request,
            onDelta: narrationProgressBuffer({
              brief,
              verifier: this.verifier,
              knownRuleIds,
              recentNarrations: recent,
              onProgress,
            }),
          })
          narration = String(completion?.content ?? '').trim()
        } else {
          // Совместимость с узкими тестовыми fake-клиентами старого контракта.
          const output = await this.llmClient.completeJson({
            ...request,
            jsonExpected: 'object',
          })
          narration = String(output?.narration ?? '').trim()
        }
      } catch (error) {
        const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
        return this._result({
          narration: fallback.narration,
          brief,
          recent,
          sensoryAnchors,
          contentDirectives,
          verification: {
            ...verifyNarratorCraft(
              fallback.narration,
              brief,
              this.verifier.verify(currentNarrationSegment(fallback.narration, brief, recent), brief, { knownRuleIds }),
              recent,
            ),
            provider_error: String(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR').slice(0, 80),
          },
          priorFeedback,
          examples,
          provider: 'deterministic-provider-fallback',
        })
      }
      const safetyVerification = verifyNarratorCraft(
        narration,
        brief,
        this.verifier.verify(currentNarrationSegment(narration, brief, recent), brief, { knownRuleIds }),
        recent,
      )
      if (safetyVerification.valid && narration) {
        return this._result({
          narration,
          brief,
          recent,
          sensoryAnchors,
          contentDirectives,
          verification: safetyVerification,
          priorFeedback,
          examples,
          provider: this.llmClient.constructor?.name ?? 'llm',
        })
      }
      const fallback = deterministicNarration(brief, undefined, { recentNarrations: recent })
      return this._result({
        narration: fallback.narration,
        brief,
        recent,
        sensoryAnchors,
        contentDirectives,
        verification: {
          ...verifyNarratorCraft(
            fallback.narration,
            brief,
            this.verifier.verify(currentNarrationSegment(fallback.narration, brief, recent), brief, { knownRuleIds }),
            recent,
          ),
          repaired_from: safetyVerification.violations,
        },
        priorFeedback,
        examples,
        provider: 'deterministic-fallback',
      })
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
}
