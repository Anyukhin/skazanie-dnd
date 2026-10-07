import { createHash } from 'node:crypto'

import { campaignArcPlan } from './campaign-loop-policy.mjs'
import { gmSecretFact, normalizeGmSecrets, normalizeWorldMemory } from './world-memory.mjs'
import { campaignModeFor } from './campaign-stories.mjs'

const clone = (value) => structuredClone(value)
const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const chapterNumber = (value, fallback = 1) => Number.isSafeInteger(Number(value))
  ? Math.max(1, Math.min(999, Number(value)))
  : fallback

function stableId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => clean(part, 1_000)).join('\0')).digest('hex').slice(0, 24)
  return `${namespace}:${digest}`
}

function locationEntity(memory, name) {
  const normalized = clean(name, 160).toLocaleLowerCase('ru')
  return memory.entities.find((entity) => entity.kind === 'location' && entity.name.toLocaleLowerCase('ru') === normalized) ?? null
}

function canonicalLocation(memory, name, summary = '') {
  const locationName = clean(name, 160) || 'Unknown location'
  const existing = locationEntity(memory, locationName)
  return {
    id: existing?.id || stableId('location', locationName.toLocaleLowerCase('ru')),
    kind: 'location',
    name: locationName,
    summary: clean(summary || existing?.summary, 1_000),
    aliases: existing?.aliases ?? [],
    visibility: existing?.visibility === 'public' ? 'public' : 'party',
    tags: [...new Set([...(existing?.tags ?? []), 'visited'])].slice(0, 20),
  }
}

// Цель сцены — призыв к действию («Продолжить квест «X»»), а заголовок квеста — сама
// цель X. Без снятия обёртки заголовок выводился из уже обёрнутой цели, а следующий
// призыв оборачивал его снова: каждая глава добавляла слой «Продолжить квест «…».
const OBJECTIVE_WRAPPERS = Object.freeze([
  /^Продолжить квест «(.+)»$/u,
  /^Развить последствия победы в квесте «(.+)» и приблизить развязку$/u,
  /^Ответить на последствия провала квеста «(.+)» и найти новый путь$/u,
])

/** Восстанавливает исходную цель из призыва к действию любой вложенности. */
export function questTitleFromObjective(value) {
  let title = clean(value, 300)
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = OBJECTIVE_WRAPPERS.reduce((found, pattern) => found ?? pattern.exec(title), null)
    if (!inner) break
    title = clean(inner[1], 300)
  }
  return title
}

function sceneQuest({ chapter, scene, adventure, locationId, clockMax = 4 }) {
  const objective = clean(scene?.objective, 300)
  const hook = clean(adventure?.currentHook, 1_000)
  return {
    id: `quest:chapter:${chapterNumber(chapter)}`,
    title: clean(questTitleFromObjective(objective) || scene?.title || `Chapter ${chapterNumber(chapter)}`, 180),
    summary: hook || objective,
    status: 'active',
    visibility: 'party',
    entity_ids: locationId ? [locationId] : [],
    objectives: objective ? [objective] : [],
    clock: { current: 0, max: Math.max(1, Number(clockMax) || 4), label: 'Цель сцены', triggered: false },
  }
}

/** Migrates a campaign with only scene/adventure fields into the canonical memory model. */
export function ensureSceneWorldMemory(input, state = {}) {
  const memory = normalizeWorldMemory(input)
  const clockMax = campaignArcPlan(state)?.chapter_clock_max ?? 4
  const locationName = clean(state.scene?.location || state.scene?.title, 160)
  if (!locationName) return memory

  const location = canonicalLocation(memory, locationName, state.scene?.mood)
  if (!memory.entities.some((entity) => entity.id === location.id)) memory.entities.push(location)

  const chapter = chapterNumber(state.adventure?.chapter, 1)
  const questId = `quest:chapter:${chapter}`
  if (campaignModeFor(state) !== 'persistent' && !memory.quests.some((quest) => quest.id === questId) && clean(state.scene?.objective, 300)) {
    memory.quests.push(sceneQuest({ chapter, scene: state.scene, adventure: state.adventure, locationId: location.id, clockMax }))
  }
  return normalizeWorldMemory(memory)
}

export function sceneWorldMemoryEventId(commandId) {
  return stableId('scene-event', commandId)
}

/**
 * Derives bounded canonical memory updates from an already validated scene transition.
 * It never accepts a free-form memory payload from the model. Единственный текст
 * модели здесь — заготовки ведущего (`secrets`): они проходят тот же
 * `normalizeGmSecrets`, что и стартовые, и пишутся только скрытыми фактами.
 */
export function sceneWorldMemoryEvents(state, transition, { commandId = '', sourceEventId = '', secrets = [], scenarioSecrets = [] } = {}) {
  const memory = ensureSceneWorldMemory(state.worldMemory, state)
  const clockMax = campaignArcPlan(state)?.chapter_clock_max ?? 4
  const previousScene = state.scene ?? {}
  const nextScene = transition?.scene ?? {}
  const nextAdventure = transition?.adventure ?? {}
  const previousChapter = chapterNumber(state.adventure?.chapter, Math.max(1, chapterNumber(nextAdventure.chapter, 2) - 1))
  const nextChapter = chapterNumber(nextAdventure.chapter, previousChapter + 1)
  const history = Array.isArray(nextAdventure.history) ? nextAdventure.history : []
  const outcome = history.at(-1) ?? {}

  const previousLocation = canonicalLocation(memory, previousScene.location || previousScene.title, previousScene.mood)
  const memoryWithPrevious = normalizeWorldMemory({ ...memory, entities: [...memory.entities.filter((entity) => entity.id !== previousLocation.id), previousLocation] })
  const nextLocation = canonicalLocation(memoryWithPrevious, nextScene.location || nextScene.title, nextScene.mood)
  const events = []
  const add = (event_type, payload, visibility = 'party', target_ids = []) => events.push({ event_type, payload, visibility, target_ids })

  for (const entity of [previousLocation, nextLocation]) {
    const existing = memory.entities.find((candidate) => candidate.id === entity.id)
    if (!existing || JSON.stringify(existing) !== JSON.stringify(entity)) add('WorldEntityUpserted', { entity })
  }

  const previousQuestId = `quest:chapter:${previousChapter}`
  const previousQuest = memory.quests.find((quest) => quest.id === previousQuestId)
    ?? sceneQuest({ chapter: previousChapter, scene: previousScene, adventure: state.adventure, locationId: previousLocation.id, clockMax })
  const previousStatus = outcome.status === 'abandoned' ? 'abandoned' : outcome.status === 'completed' ? 'completed' : 'active'
  // Цель продолжается в новом месте (`continued`): то же задание главы, те же
  // часы, но цель — её остаток, и новое место становится сущностью задания,
  // чтобы находки здесь засчитывались как продвижение. Второе задание с тем же
  // номером главы перезаписало бы часы с нуля.
  const continued = outcome.status === 'continued'
  if (campaignModeFor(state) !== 'persistent') add('QuestUpserted', { quest: continued
    ? {
      ...clone(previousQuest),
      status: 'active',
      objectives: clean(nextScene.objective, 300) ? [clean(nextScene.objective, 300)] : clone(previousQuest.objectives ?? []),
      entity_ids: [...new Set([...(previousQuest.entity_ids ?? []), nextLocation.id])],
    }
    : {
      ...clone(previousQuest),
      summary: clean(outcome.outcome || previousQuest.summary, 1_000),
      status: previousStatus,
    } })

  // Та же формулировка живёт и в стартовом задании кампании (его цель — цель
  // первой сцены). Иначе журнал продолжал звать «добраться до дамбы», когда
  // отряд уже стоит на ней. Меняется только эта цель, а не задание целиком.
  if (continued && clean(nextScene.objective, 300)) {
    const before = clean(previousScene.objective, 300)
    for (const quest of memory.quests) {
      if (quest.id === previousQuest.id || quest.status !== 'active' || !(quest.objectives ?? []).some((objective) => clean(objective, 300) === before)) continue
      add('QuestUpserted', { quest: {
        ...clone(quest),
        objectives: (quest.objectives ?? []).map((objective) => clean(objective, 300) === before ? clean(nextScene.objective, 300) : objective),
      } }, quest.visibility === 'gm_only' ? 'gm_only' : 'party')
    }
  }

  if (!continued && campaignModeFor(state) !== 'persistent' && clean(nextScene.objective, 300)) {
    const nextQuest = sceneQuest({ chapter: nextChapter, scene: nextScene, adventure: nextAdventure, locationId: nextLocation.id, clockMax })
    add('QuestUpserted', { quest: nextQuest })
  }

  const provenance = sourceEventId ? [sourceEventId] : []
  const transitionFact = {
    id: stableId('fact', 'scene-transition', commandId, previousLocation.id, nextLocation.id),
    subject_id: previousLocation.id,
    predicate: 'party_traveled_to',
    object: nextLocation.name,
    summary: clean(transition?.transition || outcome.outcome || `${previousLocation.name} -> ${nextLocation.name}`, 1_000),
    visibility: 'party',
    source_event_ids: provenance,
    source_command_id: clean(commandId, 160),
    supersedes_fact_id: '',
    status: 'active',
  }
  const arrivalFact = {
    id: stableId('fact', 'scene-arrival', commandId, nextLocation.id),
    subject_id: nextLocation.id,
    predicate: 'party_arrived',
    object: clean(transition?.arrival || nextLocation.name, 1_000),
    summary: clean(transition?.arrival || `The party arrived at ${nextLocation.name}.`, 1_000),
    visibility: 'party',
    source_event_ids: provenance,
    source_command_id: clean(commandId, 160),
    supersedes_fact_id: '',
    status: 'active',
  }
  if (!memory.facts.some((fact) => fact.id === transitionFact.id)) add('WorldFactRecorded', { fact: transitionFact })
  if (!memory.facts.some((fact) => fact.id === arrivalFact.id)) add('WorldFactRecorded', { fact: arrivalFact })
  // Заготовки ведущего новой области (map_architect/v7): скрытые факты места,
  // которые открывает удачный поиск. Событие и факт — gm_only: игрок узнаёт
  // тайну только находкой. Без этого в каждой области после первой удачная
  // проверка открывала разве что знающего собеседника.
  for (const [index, secret] of normalizeGmSecrets(secrets, { limit: 3 }).entries()) {
    const fact = gmSecretFact({ ...secret, holder: '' }, {
      subjectId: nextLocation.id,
      salt: `scene:${clean(commandId, 160)}:${nextLocation.id}`,
      index,
      sourceCommandId: clean(commandId, 160),
    })
    if (!memory.facts.some((existing) => existing.id === fact.id)) add('WorldFactRecorded', { fact }, 'gm_only')
  }
  // Тайны сценария (`server/campaign-scenario.mjs`): id стабилен, поэтому узел
  // сюжета узнаёт находку, а возвращение в место не заводит тайну второй раз.
  for (const secret of scenarioSecrets) {
    const fact = {
      ...gmSecretFact({ clue: secret.clue, topic: secret.topic, skills: secret.skills, holder: '' }, {
        subjectId: nextLocation.id,
        salt: secret.fact_id,
        index: 0,
        sourceCommandId: clean(commandId, 160),
      }),
      id: secret.fact_id,
    }
    if (!memory.facts.some((existing) => existing.id === fact.id)) add('WorldFactRecorded', { fact }, 'gm_only')
  }
  return events
}
