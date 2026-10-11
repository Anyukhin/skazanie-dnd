import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ensureNpcSocialState, implicitSecretHolderIds, npcBehaviorPolicy, npcKnownFactIds, npcProfileAtWorldTime, npcSecretMeta, relationshipTier,
} from './npc-social.mjs'
import { agentContextMetadata, boundedSelectionMetadata, campaignConceptForAgent, heroCardForAgent, sceneCanonFor, sceneContextForAgent } from './agent-context.mjs'
import { NPC_SOCIAL_RESPONSE_JSON_SCHEMA } from './llm-json-schemas.mjs'
import { promptForModelRole } from './model-style-profiles.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { tavernTableMood } from './tavern-life.mjs'
import { publicWorldMapFor } from './viewer-projection.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

export const NPC_SOCIAL_PROMPT_VERSION = 'npc_controller/social-v8'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/npc_controller/social_v8.txt', import.meta.url)), 'utf8')
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
const DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])
export const NPC_SOCIAL_MEMORY_LIMIT = 8
/** Публичных зацепок о собеседнике в брифе не больше этого числа. */
export const NPC_PUBLIC_HOOK_LIMIT = 4
/** Зацепок «кто ещё знает, где искать» в брифе не больше этого числа. */
export const NPC_LEAD_LIMIT = 3
/** Сколько последних реплик NPC (любому герою) сверяется с новой на повтор. */
export const NPC_REPEAT_WINDOW = 12
/** Сколько своих последних реплик NPC видит в брифе как `already_said`. */
export const NPC_ALREADY_SAID_LIMIT = 6
/** Подряд одинаковых слов, после которых предложение считается повтором. */
const REPEAT_WORD_RUN = 6

const NPC_SOCIAL_RESPONSE_FIELDS = new Set([
  'npc_id', 'reply', 'stance', 'disclosed_fact_ids', 'disclosed_claim_ids',
  'relationship_delta', 'promise', 'confidence',
])

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function structurallyValidSocialResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !NPC_SOCIAL_RESPONSE_FIELDS.has(key))) return false
  if (typeof value.reply !== 'string' || value.reply.trim() === '') return false
  if (Object.hasOwn(value, 'npc_id') && typeof value.npc_id !== 'string') return false
  if (Object.hasOwn(value, 'stance') && !STANCES.has(value.stance)) return false
  for (const key of ['disclosed_fact_ids', 'disclosed_claim_ids']) {
    if (Object.hasOwn(value, key) && (!Array.isArray(value[key]) || !value[key].every((entry) => typeof entry === 'string'))) return false
  }
  if (Object.hasOwn(value, 'relationship_delta')
    && (typeof value.relationship_delta !== 'number' || !Number.isFinite(value.relationship_delta))) return false
  if (Object.hasOwn(value, 'confidence')
    && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))) return false
  if (Object.hasOwn(value, 'promise') && value.promise !== null) {
    const promise = value.promise
    if (!promise || typeof promise !== 'object' || Array.isArray(promise)
      || Object.keys(promise).some((key) => !['direction', 'text', 'due_hint'].includes(key))
      || !DIRECTIONS.has(promise.direction)
      || typeof promise.text !== 'string' || promise.text.trim() === ''
      || typeof promise.due_hint !== 'string' || promise.due_hint.trim() === '') return false
  }
  return true
}

function selectionFields(metadata, prefix) {
  return {
    [`${prefix}_scope`]: metadata.scope,
    [`${prefix}_status`]: metadata.status,
    [`${prefix}_availability`]: metadata.availability,
    [`${prefix}_complete_within_scope`]: metadata.complete_within_scope,
    ...(metadata.truncation_reason ? { [`${prefix}_truncation_reason`]: metadata.truncation_reason } : {}),
  }
}

function stableId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => clean(part, 1_000)).join('\0')).digest('hex').slice(0, 24)
  return `${namespace}:${digest}`
}

/**
 * Факты, которые NPC знает и может произнести. До 2026-10-10 сюда шли все
 * факты отряда, и любой собеседник пересказывал чужие находки (плейтест
 * «Серый Причал»: хозяин таверны дословно повторил находку на пирсе). Граница
 * знания — `npcKnownFactIds` (`server/npc-social.mjs`): своё, публичное,
 * увиденное самим NPC и заготовки, где он хранитель.
 */
function npcSpeakableFactRecords(state, profile) {
  const allowedIds = npcKnownFactIds(state, profile)
  return (state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active' && allowedIds.has(String(fact.id)))
}

function npcSpeakableClaimRecords(state, profile) {
  return (state.worldMemory?.epistemic_claims ?? [])
    .filter((claim) => String(claim.holder_entity_id) === String(profile.id))
}

function retrievalMemory(state, { facts = [], claims = [] } = {}) {
  return {
    ...(state.worldMemory ?? {}),
    facts,
    relationships: [],
    quests: [],
    threads: [],
    epistemic_claims: claims,
    summaries: [],
  }
}

// Запасной ответ берёт из факта одно предложение, поэтому читает факт целиком:
// при обрезке до 500 знаков последнее предложение пролога отбрасывалось как
// оборванное, и король на вопрос о Саргате «не сообщал ничего нового», хотя
// пролог кончается его просьбой остановить Саргата (прогон Асстохана, 2026-10-06).
function npcFacts(state, profile, message = '', { summaryLimit = 500, spokenAloud = false } = {}) {
  // Пролог — проза рассказчика, а не знание собеседника. Модель читает его как
  // фон, но запасной ответ произносит факт вслух дословно: перевозчик в
  // Митглайде на любой вопрос говорил «Перед ним три донесения…» (прогон
  // Асстохана 2026-10-07). Вслух пролог не звучит ни у кого.
  const speakable = npcSpeakableFactRecords(state, profile)
    .filter((fact) => !spokenAloud || fact.predicate !== 'opening_narration')
  const allowedIds = new Set(speakable.map((fact) => String(fact.id)))
  const records = retrieveWorldMemory(retrievalMemory(state, { facts: speakable }), { isAdmin: true }, {
    query: clean(message, 1_000), limit: NPC_SOCIAL_MEMORY_LIMIT,
  })
  return records.filter((record) => record.kind === 'fact' && allowedIds.has(String(record.fact?.id))).map((record) => ({
    id: String(record.fact.id),
    subject: clean(record.entity?.name, 160),
    summary: clean(record.fact.summary || record.fact.object, summaryLimit),
    // Тайна, которую знает только этот собеседник: её не говорят первому
    // встречному. Модель видит пометку, запасной ответ такой факт не зачитывает.
    ...(['public', 'party'].includes(String(record.fact.visibility)) ? {} : { guarded: true }),
  }))
}

function npcClaims(state, profile, message = '') {
  const speakable = npcSpeakableClaimRecords(state, profile)
  const allowedIds = new Set(speakable.map((claim) => String(claim.id)))
  const records = retrieveWorldMemory(retrievalMemory(state, { claims: speakable }), { isAdmin: true }, {
    query: clean(message, 1_000), limit: NPC_SOCIAL_MEMORY_LIMIT,
  })
  return records.filter((record) => ['belief', 'rumor'].includes(record.kind) && allowedIds.has(String(record.claim?.id))).map((record) => ({
    id: String(record.claim.id),
    kind: record.claim.kind === 'rumor' ? 'rumor' : 'belief',
    summary: clean(record.claim.summary || record.claim.claim, 500),
    truth_status: ['confirmed', 'refuted'].includes(record.claim.truth_status) ? record.claim.truth_status : 'unknown',
  }))
}

/** Слова без регистра и «ё»: «Мара Трижды-Мерная» → ['мара', 'трижды', 'мерная']. */
function plainWords(value, maximum = 2_000) {
  return clean(value, maximum).toLocaleLowerCase('ru').replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) ?? []
}

const NAME_ENDING_RE = /(?:ой|ей|ою|ею|ом|ем|ым|им|ую|юю|ая|яя|ов|ев|а|я|у|ю|е|ы|и|о|ь|й)$/u

/**
 * Слово текста — форма слова из имени: «Мерную» к «Мерная», «Сестрой» к
 * «Сестра». Короткая основа («мир» у «Мира») префиксом не сравнивается:
 * «мире» — не имя, поэтому такое слово должно совпасть целиком.
 */
function wordNamesPart(word, namePart) {
  if (word === namePart) return true
  const stem = namePart.replace(NAME_ENDING_RE, '')
  return stem.length >= 4 && word.startsWith(stem) && word.length - stem.length <= 3
}

/**
 * Предложение говорит о собеседнике в третьем лице: начинается с «он/она» или
 * называет его любым словом имени. Такое предложение NPC о себе не произносит.
 */
function sentenceDescribesNpc(words, profile) {
  if (/^(?:он|она)$/u.test(words[0] ?? '')) return true
  const nameParts = plainWords(profile?.name, 200).filter((part) => part.length >= 3)
  return nameParts.some((part) => words.some((word) => wordNamesPart(word, part)))
}

/** Текст называет собеседника, если в нём есть каждое слово его имени. */
function textNamesNpc(text, profile) {
  const nameParts = plainWords(profile?.name, 200).filter((part) => part.length >= 3)
  if (!nameParts.length) return false
  const words = plainWords(text)
  return nameParts.every((part) => words.some((word) => wordNamesPart(word, part)))
}

/**
 * Публичные зацепки карты мира и плана города, где этот NPC назван по имени.
 *
 * Плейтест 2026-10-04, QP-01: на плане города стояло «Смотрительница Мара
 * Трижды-Мерная обнаружила подменённую мерную рейку», а сама Мара дважды
 * ответила, что о подмене не знает. Зацепки — строки без привязки к `npc_id`,
 * и в бриф собеседника они не попадали вовсе: модель честно не знала того, что
 * игрок уже прочёл на карте.
 *
 * Источник — ровно та проекция карты, которую видит игрок
 * (`publicWorldMapFor`): места, которые отряд не знает, отсюда не берутся, и
 * скрытое через этот путь не утекает. Заготовки ведущего здесь не участвуют —
 * они живут фактами `gm_secret` и раскрываются только своим хранителем.
 *
 * @returns {{ place: string, text: string }[]}
 */
function publicHooksNamingNpc(state, profile) {
  const worldMap = state.worldMap && typeof state.worldMap === 'object' && !Array.isArray(state.worldMap)
    ? publicWorldMapFor(state.worldMap)
    : null
  const hooks = []
  const seen = new Set()
  const take = (place, value) => {
    const text = clean(value, 320)
    const key = text.toLocaleLowerCase('ru')
    if (!text || seen.has(key) || !textNamesNpc(text, profile)) return
    seen.add(key)
    hooks.push({ place: clean(place, 240), text })
  }
  for (const location of worldMap?.locations ?? []) {
    for (const hook of location.storyHooks ?? []) take(location.name, hook)
    for (const district of location.cityOverview?.districts ?? []) {
      for (const hook of district.storyHooks ?? []) take(`${location.name} · ${district.name}`, hook)
    }
    for (const place of location.cityOverview?.places ?? []) {
      for (const hook of place.storyHooks ?? []) take(`${location.name} · ${place.name}`, hook)
    }
  }
  return hooks
}

/**
 * Ответ раскрыл скрытое: в нём названа тайна или слух, которые знает только
 * этот NPC. Раньше реплика становилась личной, если скрытый факт просто был
 * среди кандидатов брифа, даже не прозвучав, — и второй герой не видел ни её,
 * ни того, что NPC это уже говорил, и слышал ту же фразу заново (плейтест
 * 2026-10-10). Теперь решает то, что действительно сказано.
 */
function privateKnowledgeDisclosed(state, profile, disclosedFactIds = [], disclosedClaimIds = []) {
  const privateFactIds = new Set(npcSpeakableFactRecords(state, profile)
    .filter((fact) => !['public', 'party'].includes(fact.visibility))
    .map((fact) => String(fact.id)))
  const privateClaimIds = new Set(npcSpeakableClaimRecords(state, profile)
    .filter((claim) => !['public', 'party'].includes(claim.visibility))
    .map((claim) => String(claim.id)))
  return disclosedFactIds.some((factId) => privateFactIds.has(String(factId)))
    || disclosedClaimIds.some((claimId) => privateClaimIds.has(String(claimId)))
}

/** Общие слова, по которым отзвук скрытого не узнаётся. */
const ECHO_STOP_WORDS = new Set([
  'этот', 'этого', 'этом', 'этой', 'эти', 'чтобы', 'когда', 'только', 'здесь', 'знаю', 'знает', 'может', 'тебе',
  'тебя', 'меня', 'тоже', 'потом', 'сейчас', 'теперь', 'тогда', 'очень', 'никто', 'ничего', 'было', 'была', 'были',
  'есть', 'буду', 'будет', 'если', 'хотя', 'даже', 'опять', 'снова', 'уже', 'ещё', 'еще', 'всех', 'весь', 'всего',
  'который', 'которая', 'которые', 'своей', 'свой', 'своих', 'нужно', 'надо', 'просто', 'сказал', 'сказала',
])

/** Основы значимых слов (от четырёх букв, без падежного окончания) для сверки отзвука. */
function echoStems(value) {
  return new Set(plainWords(value, 4_000)
    .filter((word) => word.length >= 4 && !ECHO_STOP_WORDS.has(word) && !FALLBACK_QUESTION_STOP_WORDS.has(word))
    .map(wordStem))
}

/**
 * Основа слова без падежного окончания: «Чайкой» и «Чайка» → «чайк»,
 * «баркаса» → «баркас». Короче четырёх букв основа не бывает — тогда слово
 * целиком.
 */
function wordStem(word) {
  const stem = word.replace(QUESTION_ENDING_RE, '')
  return stem.length >= 4 ? stem : word
}

/** Сколько основ запроса нашлось в теме: равные основы или одна продолжает другую. */
function stemOverlap(query, topic) {
  let score = 0
  for (const stem of query) {
    if (topic.has(stem) || [...topic].some((other) => (stem.length >= 5 && other.startsWith(stem)) || (other.length >= 5 && stem.startsWith(other)))) score += 1
  }
  return score
}

/**
 * Реплика повторяет личное: два и больше значимых слова из скрытого материала
 * (тайна, слух, личная беседа с этим героем), которых нет в открытом контексте
 * разговора. Это страховка на случай, когда модель пересказала тайну, не
 * отметив её id; основную границу держит `disclosed_fact_ids`.
 */
function replyEchoesPrivateMaterial(reply, privateTexts, baselineText) {
  const replyStems = echoStems(reply)
  if (!replyStems.size) return false
  const baseline = echoStems(baselineText)
  return privateTexts.some((text) => [...echoStems(text)].filter((stem) => replyStems.has(stem) && !baseline.has(stem)).length >= 2)
}

function heroName(state, heroId) {
  const expected = String(heroId ?? '')
  const hero = (state.players ?? []).find((player) => String(player?.id ?? '') === expected)
  return clean(hero?.character || hero?.name, 120) || expected
}

function conversationVisibleTo(entry, playerId) {
  return entry.visibility === 'party'
    || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId))
}

function memoryTerms(value) {
  return new Set(clean(value, 1_000).toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{4,}/gu) ?? [])
}

function relevantNpcMemory(social, profile, playerId, message) {
  const query = memoryTerms(message)
  const score = (text) => [...memoryTerms(text)].filter((term) => query.has(term)).length
  const conversations = social.conversations
    .filter((entry) => entry.npc_id === profile.id && conversationVisibleTo(entry, playerId))
    .map((entry, index) => ({ entry, relevance: score(`${entry.player_message} ${entry.npc_reply}`), recency: index }))
  const dossiers = (profile.dossier ?? [])
    .filter((entry) => entry.visibility === 'party' || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId)))
    .map((entry, index) => ({ entry, relevance: score(entry.summary), recency: index, dossier: true }))
  return [...conversations, ...dossiers].sort((a, b) => b.relevance - a.relevance || b.recency - a.recency).slice(0, 8).map(({ entry, dossier }) => dossier
    ? { kind: 'dossier', id: entry.id, hero_id: entry.hero_id, summary: entry.summary, stance: entry.stance }
    : { kind: 'conversation', id: entry.id, hero_id: entry.hero_id, player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance })
}

/**
 * Скрытый материал, который мог попасть в реплику: тайны собеседника из брифа,
 * его слухи, личные беседы и досье с этим героем.
 */
function privateMaterialTexts(state, social, profile, playerId, facts) {
  const texts = facts.filter((fact) => fact.guarded).map((fact) => fact.summary)
  for (const claim of npcSpeakableClaimRecords(state, profile)) {
    if (!['public', 'party'].includes(claim.visibility)) texts.push(clean(claim.summary || claim.claim, 1_000))
  }
  for (const entry of social.conversations) {
    if (entry.npc_id === profile.id && String(entry.hero_id) === String(playerId) && entry.visibility === 'specific_player') {
      texts.push(`${clean(entry.player_message, 1_000)} ${clean(entry.npc_reply, 1_000)}`)
    }
  }
  for (const entry of profile.dossier ?? []) {
    if (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId)) texts.push(clean(entry.summary, 1_000))
  }
  return texts.filter(Boolean)
}

/** Открытый контекст разговора: совпадение с ним тайной не считается. */
function openConversationText(state, social, profile, playerId, message, facts, hooks) {
  return [
    message, profile.name, profile.role, profile.public_summary, profile.voice,
    state.scene?.title, state.scene?.location, state.scene?.objective,
    ...facts.filter((fact) => !fact.guarded).map((fact) => fact.summary),
    ...hooks.map((hook) => hook.text),
    ...social.conversations
      .filter((entry) => entry.npc_id === profile.id && entry.visibility === 'party')
      .slice(-NPC_REPEAT_WINDOW)
      .map((entry) => `${entry.player_message} ${entry.npc_reply}`),
    JSON.stringify(heroCardForAgent(state, playerId) ?? {}),
  ].map((value) => clean(value, 2_000)).join(' ')
}

// ── Антиповтор ──────────────────────────────────────────────────────────────
//
// Плейтест 2026-10-10: рыбачка трижды сказала одну и ту же фразу. Правило в
// промпте («не повторяй…») модель нарушала, а сервер реплику с прежними не
// сравнивал. Теперь предложения новой реплики сверяются с последними репликами
// этого NPC любому герою: шесть одинаковых слов подряд или почти тот же набор
// слов — повтор, и он вырезается.

/** «Да. Баркас Борса.» → ['Да.', 'Баркас Борса.'] */
function replySentences(text) {
  return clean(text, 2_000).split(/(?<=[.!?…])\s+/u).map((part) => part.trim()).filter(Boolean)
}

function wordRuns(words, size = REPEAT_WORD_RUN) {
  const runs = new Set()
  for (let index = 0; index + size <= words.length; index += 1) runs.add(words.slice(index, index + size).join(' '))
  return runs
}

function earlierReplyIndex(replies) {
  const runs = new Set()
  const sentences = []
  const stems = []
  for (const reply of replies) {
    for (const run of wordRuns(plainWords(reply, 2_000))) runs.add(run)
    for (const sentence of replySentences(reply)) {
      sentences.push(new Set(plainWords(sentence)))
      stems.push(contentStems(sentence))
    }
  }
  return { runs, sentences, stems }
}

/** Служебные слова не делают предложение новым и не делают его повтором. */
const REPEAT_STOP_WORDS = new Set([
  'это', 'этот', 'эта', 'эти', 'того', 'тому', 'тоже', 'было', 'была', 'были', 'будет', 'есть', 'когда', 'тогда',
  'потом', 'только', 'чтобы', 'если', 'даже', 'ещё', 'еще', 'всего', 'всех', 'свой', 'своя', 'свои', 'меня', 'тебя',
  'тебе', 'мне', 'него', 'неё', 'нее', 'него', 'ними', 'здесь', 'там', 'тут', 'вот', 'так', 'как', 'что', 'кто', 'где',
  'уже', 'может', 'знаю', 'знаешь', 'скажу', 'говорю', 'видела', 'видел',
])

/** Основы содержательных слов: «баркаса без огней» и «баркас без огня» — одно. */
function contentStems(text) {
  return new Set(plainWords(text).filter((word) => word.length >= 4 && !REPEAT_STOP_WORDS.has(word)).map((word) => word.slice(0, 4)))
}

/**
 * Предложение повторяет сказанное раньше: шесть слов подряд совпали с прежней
 * репликой, или его слова почти целиком (от 80 %) лежат в одном прежнем
 * предложении сопоставимой длины. Короткие «Да.» и «Ну что ж.» не сверяются.
 */
function sentenceRepeats(sentence, index) {
  const words = plainWords(sentence)
  if (words.length >= REPEAT_WORD_RUN && [...wordRuns(words)].some((run) => index.runs.has(run))) return true
  if (words.length < 3) return false
  const own = new Set(words)
  if (index.sentences.some((earlier) => {
    if (earlier.size < 3) return false
    let shared = 0
    for (const word of own) if (earlier.has(word)) shared += 1
    return shared / own.size >= 0.8 && shared / earlier.size >= 0.5
  })) return true
  // Пересказ другими формами тех же слов: «баркас без огней у маяка, стража
  // отворачивалась» пять раз подряд в разных падежах (замеры 27–29).
  const stems = contentStems(sentence)
  if (stems.size < 4) return false
  return (index.stems ?? []).some((earlier) => {
    if (earlier.size < 3) return false
    let shared = 0
    for (const stem of stems) if (earlier.has(stem)) shared += 1
    return shared / stems.size >= 0.65
  })
}

/** Просьба повторить сказанное — повтор и есть ответ: «Напомни сигнал». */
const REMIND_REQUEST = /(?<![\p{L}\p{M}])(?:напомн\p{L}*|повтор\p{L}*|ещё\s+раз|еще\s+раз|снова\s+скаж\p{L}*)(?![\p{L}\p{M}])/iu

const REFERRAL_VERB = /(?<![\p{L}\p{M}])(?:спрос\p{L}*|спраш\p{L}*|расспрос\p{L}*|поговор\p{L}*|обратись|обратитесь|узна(?:й|йте)\s+у|загляни|загляните|иди(?:те)?\s+к|ступай(?:те)?\s+к)(?![\p{L}\p{M}])/iu

/**
 * Отсылка «спроси N», когда отряд уже говорил с N, — круг: Мара шлёт к Тавену,
 * Тавен — к Маре, Мара снова к Тавену (замеры 15–17, 2026-10-11). Такое
 * предложение вырезается, если после него в реплике остаётся что сказать;
 * «знает больше, чем сказал» по-прежнему можно — это не отсылка.
 *
 * @param {string} reply
 * @param {Record<string, any>} social — `ensureNpcSocialState`
 * @param {Record<string, any>} profile — кто говорит
 * @returns {string}
 */
/**
 * Последние общие реплики других NPC этого же места — то, что собеседник
 * слышал сам. Личные беседы наедине сюда не входят.
 *
 * @returns {Array<{ npc: string, npc_reply: string }>}
 */
export function othersSaidNearby(state = {}, social = {}, profile = {}) {
  const here = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  const byId = new Map((social.npcs ?? []).map((npc) => [String(npc?.id ?? ''), npc]))
  return (social.conversations ?? [])
    .filter((entry) => entry?.visibility !== 'specific_player' && String(entry?.npc_id ?? '') !== String(profile?.id ?? ''))
    .map((entry) => ({ npc: byId.get(String(entry?.npc_id ?? '')), reply: clean(entry?.npc_reply, 400) }))
    .filter(({ npc, reply }) => npc && reply && (!here || !npc.location || clean(npc.location, 180).toLocaleLowerCase('ru') === here))
    .slice(-4)
    .map(({ npc, reply }) => ({ npc: clean(npc.name, 120), npc_reply: reply }))
}

export function withoutCircularReferral(reply, social = {}, profile = {}) {
  const asked = new Set((social.conversations ?? []).map((entry) => String(entry?.npc_id ?? '')).filter(Boolean))
  const names = (social.npcs ?? [])
    .filter((npc) => asked.has(String(npc?.id)) && String(npc?.id) !== String(profile?.id ?? ''))
    .map((npc) => clean(npc.name, 120).split(/\s+/u)[0]?.toLocaleLowerCase('ru').replace(/ё/gu, 'е') ?? '')
    .filter((name) => name.length >= 3)
  if (!names.length) return reply
  const sentences = replySentences(reply)
  const circular = (sentence) => {
    if (!REFERRAL_VERB.test(sentence)) return false
    const words = (sentence.toLocaleLowerCase('ru').replace(/ё/gu, 'е').match(/\p{L}+/gu) ?? [])
    return names.some((name) => words.some((word) => word.startsWith(name.slice(0, Math.max(3, name.length - 1))) && word.length <= name.length + 3))
  }
  const kept = sentences.filter((sentence) => !circular(sentence))
  if (kept.length === sentences.length || plainWords(kept.join(' ')).length < 4) return reply
  return kept.join(' ')
}

/**
 * Новая часть реплики: предложения-повторы вырезаны. Пустая строка — нового не
 * осталось (меньше двух слов).
 *
 * @returns {{ text: string, dropped: number }}
 */
export function freshReplyText(reply, earlierReplies = []) {
  const sentences = replySentences(reply)
  if (!earlierReplies.length) return { text: sentences.join(' '), dropped: 0 }
  const index = earlierReplyIndex(earlierReplies)
  const kept = sentences.filter((sentence) => !sentenceRepeats(sentence, index))
  const text = kept.join(' ')
  const dropped = sentences.length - kept.length
  // Короткий ответ без повторов — это ответ («Слушаю.»); пустым считается
  // только остаток после вырезанных повторов.
  return { text: !dropped || plainWords(text).length >= 2 ? text : '', dropped }
}

/**
 * Последние реплики NPC, с которыми сверяется новая. Сверка идёт со всеми
 * героями — и с общими, и с личными беседами: иначе второй герой слышал фразу,
 * сказанную первому наедине, слово в слово. Исключение одно: если эта реплика
 * раскрывает герою тайну, личные беседы с другими героями не мешают её сказать.
 */
function npcEarlierReplies(social, profile, playerId, { includeOtherPrivate = true } = {}) {
  return social.conversations
    .filter((entry) => entry.npc_id === profile.id)
    .filter((entry) => includeOtherPrivate || conversationVisibleTo(entry, playerId))
    .slice(-NPC_REPEAT_WINDOW)
    .map((entry) => clean(entry.npc_reply, 2_000))
    .filter(Boolean)
}

/** Свои последние реплики, которые видит этот герой: бриф не несёт чужих личных бесед. */
function alreadySaidForBrief(social, profile, playerId) {
  return social.conversations
    .filter((entry) => entry.npc_id === profile.id && conversationVisibleTo(entry, playerId))
    .slice(-NPC_ALREADY_SAID_LIMIT)
    .map((entry) => clean(entry.npc_reply, 300))
    .filter(Boolean)
}

// ── Зацепки вместо тупика ───────────────────────────────────────────────────
//
// Плейтест 2026-10-10: NPC раз за разом отказывались назвать владельца
// баркаса, и отказ никуда не вёл. Живой ведущий держит правило трёх улик: если
// этот человек не знает или не скажет — он укажет, кто знает, где искать или
// чего хочет взамен. Сервер собирает такие зацепки из того, на что безопасно
// указать: имя и место хранителя нераскрытой заготовки по теме разговора,
// место заготовки без хранителя и публичные зацепки карты. Текст самой тайны в
// бриф не идёт никогда — только её тема (`about`).

const LEAD_STOP_WORDS = new Set(['знаешь', 'знаете', 'скажи', 'скажите', 'расскажи', 'расскажите', 'кто-нибудь', 'что-нибудь'])

function leadStems(value, profile = null) {
  const nameParts = plainWords(profile?.name, 200)
  return new Set(plainWords(clean(value, 2_000).replace(ADDRESS_PREFIX_RE, ''))
    .filter((word) => word.length >= 4 && !FALLBACK_QUESTION_STOP_WORDS.has(word) && !LEAD_STOP_WORDS.has(word))
    .filter((word) => !nameParts.some((part) => wordNamesPart(word, part)))
    .map(wordStem))
}

function revealedFactIds(state) {
  const memory = state.worldMemory ?? {}
  return new Set([...(memory.knowledge_ledger ?? []), ...(memory.knowledge_revealed ?? [])]
    .map((entry) => String(entry?.fact_id ?? '')).filter(Boolean))
}

/**
 * Зацепки для разговора: кто ещё знает (`person`), где искать (`place`), что
 * говорят открыто (`hook`) и `self` — ответ знает сам собеседник, это его тайна
 * и его цена. `match`: `question` — по словам героя, `objective` — по цели
 * сцены, `nearby` — не по вопросу, но рядом (на случай, если ответить нечего).
 *
 * @returns {Array<{ kind: 'person'|'place'|'hook'|'self', match: 'question'|'objective'|'nearby', name?: string, role?: string, where?: string, about?: string, text?: string }>}
 */
export function conversationLeads(state = {}, profile = {}, message = '', social = ensureNpcSocialState(state.social, state)) {
  const asked = leadStems(message, profile)
  const objective = leadStems(state.scene?.objective, profile)
  const sceneKey = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  const locations = new Map((state.worldMemory?.entities ?? [])
    .filter((entity) => entity?.kind === 'location' && entity.id)
    .map((entity) => [String(entity.id), clean(entity.name, 180)]))
  const revealed = revealedFactIds(state)
  const implicit = implicitSecretHolderIds(state, social)
  const npcByName = new Map(social.npcs.map((npc) => [clean(npc.name, 160).toLocaleLowerCase('ru'), npc]))
  const knownBy = new Map()
  for (const npc of social.npcs) for (const factId of npc.known_fact_ids ?? []) if (!knownBy.has(factId)) knownBy.set(factId, npc)
  // Кого отряд уже расспрашивал: отсылка к нему как к новому знатоку ходила
  // по кругу — «спроси Ивена» у Мары, «спроси Мару» у Ивена (плейтест
  // 2026-10-10). Такой знаток уходит вниз списка и помечается: собеседник
  // скажет, что тот знает больше, чем сказал, а не пошлёт к нему заново.
  const askedBefore = new Set((social.conversations ?? [])
    .filter((entry) => entry?.visibility === 'party' || entry?.hero_id)
    .map((entry) => String(entry?.npc_id ?? '')).filter(Boolean))
  const candidates = []
  for (const fact of state.worldMemory?.facts ?? []) {
    if (fact?.predicate !== 'gm_secret' || fact.status !== 'active' || revealed.has(String(fact.id))) continue
    const meta = npcSecretMeta(fact)
    const topic = leadStems(`${meta.topic} ${fact.summary ?? ''}`)
    const questionScore = stemOverlap(asked, topic)
    const objectiveScore = stemOverlap(objective, topic)
    const where = locations.get(String(fact.subject_id ?? '')) ?? ''
    const nearby = Boolean(where) && where.toLocaleLowerCase('ru') === sceneKey
    if (!questionScore && !objectiveScore && !nearby) continue
    const holder = (meta.holder && npcByName.get(meta.holder.toLocaleLowerCase('ru')))
      || knownBy.get(String(fact.id))
      || social.npcs.find((npc) => npc.id === implicit.get(String(fact.id)))
      || null
    const match = questionScore ? 'question' : objectiveScore ? 'objective' : 'nearby'
    const score = questionScore * 4 + objectiveScore * 2 + (nearby ? 1 : 0)
    const about = clean(meta.topic, 100)
    if (holder?.id === profile.id) {
      candidates.push({ score: score + 1, lead: { kind: 'self', match, ...(about ? { about } : {}) } })
    } else if (holder && holder.visibility !== 'gm_only') {
      const current = npcProfileAtWorldTime(holder, state)
      const holderPlace = clean(current.location || holder.location, 180)
      // Уже расспрошенный знаток — не новая отсылка: круг «спроси его — спроси
      // её» не исчезал от понижения в списке. Такой человек остаётся в брифе
      // только меткой `asked_before` и только последним.
      const asked = askedBefore.has(String(holder.id))
      candidates.push({ score: asked ? score - 6 : score, lead: {
        kind: 'person', match, name: clean(holder.name, 120),
        ...(clean(holder.role, 120) ? { role: clean(holder.role, 120) } : {}),
        ...(holderPlace ? { where: holderPlace } : {}),
        ...(about ? { about } : {}),
        ...(asked ? { asked_before: true } : {}),
      } })
    } else if (where) {
      candidates.push({ score, lead: { kind: 'place', match, where, ...(about ? { about } : {}) } })
    }
  }
  const worldMap = state.worldMap && typeof state.worldMap === 'object' && !Array.isArray(state.worldMap)
    ? publicWorldMapFor(state.worldMap)
    : null
  const takeHook = (place, value) => {
    const text = clean(value, 240)
    if (!text || textNamesNpc(text, profile)) return
    const score = stemOverlap(asked, leadStems(text))
    if (score) candidates.push({ score: score * 3, lead: { kind: 'hook', match: 'question', where: clean(place, 240), text } })
  }
  for (const location of worldMap?.locations ?? []) {
    for (const hook of location.storyHooks ?? []) takeHook(location.name, hook)
    for (const district of location.cityOverview?.districts ?? []) for (const hook of district.storyHooks ?? []) takeHook(`${location.name} · ${district.name}`, hook)
    for (const place of location.cityOverview?.places ?? []) for (const hook of place.storyHooks ?? []) takeHook(`${location.name} · ${place.name}`, hook)
  }
  const seen = new Set()
  const fresh = candidates.filter((entry) => !entry.lead?.asked_before)
  return (fresh.length ? fresh : candidates)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.lead)
    .filter((lead) => {
      const key = `${lead.kind}:${lead.name ?? lead.text ?? lead.where ?? ''}`.toLocaleLowerCase('ru')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, NPC_LEAD_LIMIT)
}

/** Зацепка одной фразой для запасного ответа: только имя, роль и место. */
function leadLine(lead) {
  if (lead?.kind === 'person') {
    return `Об этом больше знает ${lead.name}${lead.role ? `, ${lead.role}` : ''}${lead.where ? ` — ищите там: ${lead.where}` : ''}.`
  }
  if (lead?.kind === 'place') return `Если где и искать, то там: ${lead.where}.`
  if (lead?.kind === 'hook') return `Слышали, что говорят? ${lead.text}`
  return ''
}

/** Реплика-признание, когда всё новое в ответе оказалось повтором. */
function repeatAcknowledgement(leads = []) {
  const lead = leads.find((entry) => entry.kind !== 'self')
  const self = leads.find((entry) => entry.kind === 'self')
  if (lead) return `Всё, что знаю, вы уже слышали. ${leadLine(lead)}`
  if (self) return 'Всё, что можно сказать задаром, вы уже слышали. Остальное — не бесплатно.'
  return 'Всё, что знаю, вы уже слышали.'
}

/**
 * Что отряд уже знает: находки, открытые за игру (`discovery`, видимые
 * отряду), — последние восемь. Свои тайны NPC видит отдельно, в
 * `speakable_facts`; здесь только то, что за столом уже прозвучало.
 *
 * @param {Record<string, any>} state
 * @returns {string[]}
 */
function partyKnownFacts(state) {
  return (state.worldMemory?.facts ?? [])
    .filter((fact) => fact?.predicate === 'discovery' && fact.visibility === 'party' && fact.status !== 'superseded')
    .map((fact) => clean(fact.summary, 240))
    .filter(Boolean)
    .slice(-8)
}

function briefFor(state, profile, playerId, message, checkOutcome = null, { leads = [], repeatRetry = false, repeatedLines = [], justSeen = '' } = {}) {
  const social = ensureNpcSocialState(state.social, state)
  const alreadySaid = alreadySaidForBrief(social, profile, playerId)
  const alreadySaidCandidates = social.conversations
    .filter((entry) => entry.npc_id === profile.id && conversationVisibleTo(entry, playerId)).length
  const heroCard = heroCardForAgent(state, playerId)
  const currentConversation = social.conversations
    .filter((entry) => entry.npc_id === profile.id
      && entry.hero_id === playerId
      && conversationVisibleTo(entry, playerId))
  const partyConversation = social.conversations
    .filter((entry) => entry.npc_id === profile.id
      && entry.hero_id !== playerId
      && conversationVisibleTo(entry, playerId))
  const openPromises = social.promises
    .filter((entry) => entry.npc_id === profile.id && entry.hero_id === playerId && entry.status === 'open')
  const relevantMemory = relevantNpcMemory(social, profile, playerId, message)
  const speakableFacts = npcFacts(state, profile, message)
  const speakableClaims = npcClaims(state, profile, message)
  const publicHooks = publicHooksNamingNpc(state, profile)
  const relevantMemoryCandidateCount = currentConversation.length
    + (profile.dossier ?? []).filter((entry) => entry.visibility === 'party'
      || (entry.visibility === 'specific_player' && String(entry.hero_id) === String(playerId))).length
  const speakableFactCount = npcSpeakableFactRecords(state, profile).length
  const speakableClaimCount = npcSpeakableClaimRecords(state, profile).length
  const factSelection = boundedSelectionMetadata({ scope: 'facts_known_to_npc_and_available_for_dialogue', candidateCount: speakableFactCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  const claimSelection = boundedSelectionMetadata({ scope: 'claims_held_by_npc_and_available_for_dialogue', candidateCount: speakableClaimCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  const promiseSelection = boundedSelectionMetadata({ scope: 'open_promises_between_npc_and_active_hero', candidateCount: openPromises.length, limit: 10 })
  const conversationSelection = boundedSelectionMetadata({ scope: 'visible_conversation_with_active_hero', candidateCount: currentConversation.length, limit: 6 })
  const partyConversationSelection = boundedSelectionMetadata({ scope: 'party_visible_conversation_with_other_heroes', candidateCount: partyConversation.length, limit: 4 })
  const memorySelection = boundedSelectionMetadata({ scope: 'visible_relevant_npc_memory', candidateCount: relevantMemoryCandidateCount, limit: NPC_SOCIAL_MEMORY_LIMIT })
  const publicHookSelection = boundedSelectionMetadata({ scope: 'party_visible_world_hooks_naming_npc', candidateCount: publicHooks.length, limit: NPC_PUBLIC_HOOK_LIMIT })
  return {
    context_metadata: agentContextMetadata(state, { role: 'npc_social', actorId: playerId, targetId: profile.id, contractVersion: NPC_SOCIAL_PROMPT_VERSION }),
    campaign_premise: campaignConceptForAgent(state),
    // NPC знает, где идёт разговор: сцена делает реплику местной, а не общей.
    scene: {
      title: clean(state.scene?.title, 160),
      location: clean(state.scene?.location, 180),
      mood: clean(state.scene?.mood, 160),
      spatial_context: sceneContextForAgent(state, playerId).spatial_context,
    },
    // Канон сцены и то, что стол уже узнал: NPC не меняет установленного
    // («баркас вошёл этой ночью») и не пересказывает найденное, а говорит
    // новое — прежде двое NPC по кругу твердили одну находку (замеры 20–24).
    scene_canon: sceneCanonFor(state),
    table_knows: partyKnownFacts(state),
    // Цели и убеждения профиля намеренно не передаются: всё, что уходит в
    // модель, может дословно оказаться в реплике перед игроком, поэтому бриф
    // держит только party-видимые поля. Характер выражают voice и summary.
    npc: {
      id: profile.id, name: profile.name, role: profile.role,
      public_summary: profile.public_summary, voice: profile.voice,
      speech_profile: profile.speech_profile,
      behavior_policy: npcBehaviorPolicy(profile, social.relationships[profile.id]?.[playerId] ?? 0),
    },
    relationship: {
      score: social.relationships[profile.id]?.[playerId] ?? 0,
      tier: relationshipTier(social.relationships[profile.id]?.[playerId] ?? 0),
    },
    // Кто перед собеседником: имя, класс, предыстория и привязанности героя
    // (лист героя виден отряду). Живой NPC слышит личное за вопросом — сестру,
    // пропавшую в море, или прежнюю службу у маяка (плейтест 2026-10-10).
    ...(heroCard ? { speaking_hero: heroCard } : {}),
    // Застолье собеседник видит: перед ним человек с кружкой, и разговор от
    // этого другой. Данными, а не числом в СЛ — проверку это не подменяет, её
    // считает Rules Engine той же прибавкой, что показал ручной бросок.
    table: tavernTableMood(state, playerId),
    open_promises: openPromises
      .slice(-10)
      .map((entry) => ({ id: entry.id, direction: entry.direction, text: entry.text, due_hint: entry.due_hint })),
    recent_conversation: currentConversation
      .slice(-6)
      .map((entry) => ({ player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance, ...(entry.check ? { check: { skill: entry.check.skill, success: entry.check.success, degree: entry.check.degree } } : {}) })),
    // NPC помнит отряд, а не одно лицо: последние разговоры с другими героями
    // видимы группе (visibility: party) и приходят с именем собеседника.
    recent_party_conversation: partyConversation
      .slice(-4)
      .map((entry) => ({ hero: heroName(state, entry.hero_id), player_message: entry.player_message, npc_reply: entry.npc_reply, stance: entry.stance })),
    // Релевантный архив дополняет короткое окно последних реплик; visibility
    // проверяется до ранжирования, поэтому чужая личная беседа не просачивается.
    relevant_memory: relevantMemory,
    speakable_facts: speakableFacts,
    speakable_claims: speakableClaims,
    // Что о собеседнике открыто сказано на карте (плейтест 2026-10-04, QP-01):
    // он это знает. Солгать или уклониться модель может, изобразить незнание —
    // нет (social_v8).
    public_hooks_naming_npc: publicHooks.slice(0, NPC_PUBLIC_HOOK_LIMIT),
    // Куда вести героя, если сам не знаешь или не скажешь (social_v8): имена,
    // роли и места, без текста тайн.
    leads: leads.slice(0, NPC_LEAD_LIMIT),
    // Свои последние реплики, которые этот герой мог слышать: не повторять.
    already_said: alreadySaid,
    // Что при собеседнике сказали другие здесь же: не противоречить им без
    // причины. Мара «не помнит Илу», а Терен тут же — «это лодка Илы», и судья
    // записывал разнобой на счёт ведущего (замеры 14–17, 2026-10-11).
    others_said: othersSaidNearby(state, social, profile),
    // Что герой сделал у собеседника на глазах прямо перед словами — тем же
    // ходом: «творит «Безмолвный образ» с чертами Илы… «Узнаёте её?»». Без
    // этого Иара просила «покажи или назови её», хотя образ стоял перед ней
    // (замер 19, 2026-10-11).
    ...(clean(justSeen, 600) ? { just_seen: clean(justSeen, 600) } : {}),
    ...(repeatRetry ? { repeat_retry: true } : {}),
    ...(repeatRetry && repeatedLines.length ? { repeated_lines: repeatedLines.map((line) => clean(line, 300)).filter(Boolean).slice(0, 6) } : {}),
    ...selectionFields(boundedSelectionMetadata({ scope: 'server_safe_leads_for_conversation_topic', candidateCount: leads.length, limit: NPC_LEAD_LIMIT }), 'leads'),
    ...selectionFields(boundedSelectionMetadata({ scope: 'npc_replies_visible_to_active_hero', candidateCount: alreadySaidCandidates, limit: NPC_ALREADY_SAID_LIMIT }), 'already_said'),
    ...selectionFields(conversationSelection, 'recent_conversation'),
    ...selectionFields(partyConversationSelection, 'recent_party_conversation'),
    ...selectionFields(memorySelection, 'relevant_memory'),
    ...selectionFields(factSelection, 'speakable_facts'),
    ...selectionFields(claimSelection, 'speakable_claims'),
    ...selectionFields(publicHookSelection, 'public_hooks_naming_npc'),
    ...selectionFields(promiseSelection, 'open_promises'),
    player_message: clean(message, 1_000),
    resolved_check: checkOutcome ? { skill: checkOutcome.skill, ability: checkOutcome.ability, success: checkOutcome.success, degree: checkOutcome.degree } : null,
  }
}

/**
 * Детерминированный ответ, когда модели нет или она не ответила.
 *
 * Слух здесь не украшение, а единственная дорога дошедшей молвы к столу: она
 * пишется `gm_only` и из проекции состояния игроку не видна — он узнаёт её
 * только из уст NPC (`server/world-deeds.mjs`). Пока фолбэк молчал о слухах,
 * вторая половина петли обрывалась ровно на последнем шаге: слух доходил до
 * держателя и там умирал.
 *
 * Порядок источников — от твёрдого к зыбкому: сначала факт, который NPC знает,
 * потом молва, за которую он не отвечает. Возвращается и список раскрытых
 * утверждений: реплика и провенанс расходиться не должны.
 *
 * Факт отвечает только на тот вопрос, с которым совпал словами, и звучит одним
 * предложением, а не целым абзацем. Плейтест 2026-10-04 (QP-02, SE-04): без
 * модели Мара, Элин и Мира на любой вопрос дословно зачитывали абзац пролога о
 * колоколах — пролог лежит в памяти фактом отряда и всегда шёл первым, совпал
 * он с вопросом или нет. Теперь несовпавший вопрос получает честное «ничего
 * нового», а сказанное этому герою раньше не повторяется.
 *
 * Тупика нет (плейтест 2026-10-10, social_v8): где ответить нечего или
 * собеседника не убедили, реплика ведёт дальше — к тому, кто знает, или к
 * месту, где искать (`leads`). Если тайну по вопросу знает сам собеседник, он
 * это даёт понять и называет цену, а удачная проверка убеждения её открывает.
 * «Уже сказанное» сверяется с репликами этого NPC всем героям.
 *
 * @returns {{ reply: string, claimIds: string[], factIds: string[] }}
 */
function fallbackDisclosure(profile, facts, claims, checkOutcome = null, memory = [], message = '', hooks = [], { earlierReplies = [], leads = [] } = {}) {
  const repeatIndex = earlierReplyIndex(earlierReplies)
  const alreadySaid = (text) => earlierReplies.some((reply) => reply.includes(text)) || sentenceRepeats(text, repeatIndex)
  const usableLead = leads.find((lead) => lead.kind !== 'self' && !alreadySaid(leadLine(lead)))
  const ownSecretAsked = leads.some((lead) => lead.kind === 'self' && lead.match === 'question')
  const withLead = (line) => usableLead ? `${line} ${leadLine(usableLead)}` : line
  // Исход проверки — механика, а не разговор: раскрывать по нему нечего, кроме
  // собственной тайны собеседника, которую удачная проверка и добывает.
  // Фразы русские: до 2026-10-04 этот путь отвечал игроку по-английски
  // («is not convinced»), стоило проверке пройти без модели (PR #136).
  if (checkOutcome?.skill === 'insight') return { reply: checkOutcome.success ? `${profile.name} отвечает уклончиво, и за словами угадывается что-то недосказанное.` : `${profile.name} отвечает ровно — по лицу ничего не прочесть.`, claimIds: [], factIds: [] }
  if (checkOutcome?.success) {
    const secret = ownSecretAsked ? fallbackSecretAnswer(profile, message, facts, alreadySaid) : null
    if (secret) return { reply: `${profile.name} сдаётся: «${secret.sentence}»`, claimIds: [], factIds: [secret.id] }
    return { reply: `${profile.name} отвечает: «${withLead('Ладно. Говори, я слушаю.')}»`, claimIds: [], factIds: [] }
  }
  if (checkOutcome) return { reply: `${profile.name} отвечает: «${withLead('Нет. Меня это не убеждает.')}»`, claimIds: [], factIds: [] }
  const request = clean(message, 1_000).toLocaleLowerCase('ru')
  if (/(?:пообещ|обещани|помоги|проведи|передай|открой)/iu.test(request)) {
    return { reply: `${profile.name} разводит руками: «Обещать пока нечего — скажи, чем именно помочь.»`, claimIds: [], factIds: [] }
  }
  if (/(?:напомни|вспомни|сигнал|договор|обещал|что мы)/iu.test(request)) {
    const remembered = memory.find((entry) => entry.kind === 'conversation' && entry.npc_reply)
    // Просьбу напомнить исполняет повтором своих же слов — без ярлыка
    // «напоминает:», который судья читал служебным (замер 26, 2026-10-11).
    if (remembered) return { reply: `${profile.name} повторяет: «${clean(remembered.npc_reply, 500)}»`, claimIds: [], factIds: [] }
  }
  const answer = fallbackAnswer(profile, message, hooks, facts, alreadySaid)
  if (answer?.kind === 'hook') return { reply: `${profile.name} подтверждает: «${answer.sentence}»`, claimIds: [], factIds: [] }
  if (answer) return { reply: `${profile.name} отвечает: «${answer.sentence}»`, claimIds: [], factIds: [] }
  const rumor = claims.find((claim) => claim.kind === 'rumor' && !alreadySaid(claim.summary))
  if (rumor) return { reply: `${profile.name} понижает голос: «${rumor.summary}»`, claimIds: [rumor.id], factIds: [] }
  const belief = claims.find((claim) => !alreadySaid(claim.summary))
  if (belief) return { reply: `${profile.name} отвечает: «${belief.summary}»`, claimIds: [belief.id], factIds: [] }
  if (ownSecretAsked) return { reply: `${profile.name} отвечает уклончиво: «Может, что-то и знаю. Но просто так такое не рассказывают.»`, claimIds: [], factIds: [] }
  // Голосом собеседника, а не протоколом: «X не сообщает ничего нового»
  // (замеры 20–26).
  if (usableLead) return { reply: `${profile.name} качает головой: «Больше мне сказать нечего. ${leadLine(usableLead)}»`, claimIds: [], factIds: [] }
  return { reply: `${profile.name} качает головой: «Больше мне сказать нечего.»`, claimIds: [], factIds: [] }
}

/**
 * Собственная тайна собеседника по вопросу героя — одним предложением.
 * Звучит только после удачной проверки убеждения, обмана или запугивания.
 *
 * @returns {{ id: string, sentence: string } | null}
 */
function fallbackSecretAnswer(profile, message, facts, alreadySaid) {
  const stems = fallbackQuestionStems(profile, message)
  if (!stems.length) return null
  let best = null
  for (const fact of facts.filter((entry) => entry.guarded)) {
    for (const sentence of clean(fact.summary, 1_000).split(/(?<=[.!?…])\s+/u).map((part) => clean(part, 320)).filter(Boolean)) {
      const words = plainWords(sentence)
      if (sentenceDescribesNpc(words, profile) || alreadySaid(sentence)) continue
      const score = stems.filter((stem) => words.some((word) => word.startsWith(stem))).length
      if (score >= 1 && (!best || score > best.score)) best = { id: fact.id, sentence, score }
    }
  }
  return best ? { id: best.id, sentence: best.sentence } : null
}

/**
 * Служебные слова вопроса, глаголы обращения и каркас «как пройти к…». По ним
 * ответ не подбирается: «прямо сейчас» не делает ответом фразу о «прямой
 * улице», «как пройти» — фразу «не пройти мимо», а «спрашиваю» ни о чём не
 * спрашивает. Слова короче четырёх букв отсекаются раньше.
 */
const FALLBACK_QUESTION_STOP_WORDS = new Set([
  'какой', 'какая', 'какое', 'какие', 'какую', 'каком', 'какого', 'почему', 'зачем', 'когда', 'куда', 'откуда',
  'сколько', 'кому', 'кого', 'чего', 'этот', 'этого', 'этом', 'этой', 'тебя', 'тебе', 'меня', 'есть', 'было',
  'была', 'были', 'быть', 'будет', 'может', 'можно', 'нужно', 'надо', 'сейчас', 'прямо', 'теперь', 'тогда',
  'здесь', 'очень', 'только', 'ничего', 'никто', 'скажи', 'скажите', 'расскажи', 'расскажите', 'знаешь',
  'знаете', 'слышал', 'слышала', 'слышали', 'слышно', 'нового', 'новое', 'новости', 'говорю', 'говорим',
  'спрашиваю', 'спросим', 'расспрашиваю', 'расспросим', 'обращаюсь', 'обращаемся', 'прошу', 'просим',
  'интересуюсь', 'узнаю', 'хочу', 'хотим', 'давай', 'давайте', 'пожалуйста', 'вопрос', 'ответь', 'подскажи',
  'думаешь', 'думаете', 'считаешь', 'считаете', 'видел', 'видела', 'видели', 'пройти', 'пройду', 'пройдем',
  'пойти', 'пойду', 'пойдем', 'идти', 'попасть', 'добраться', 'найти', 'найду', 'найдем', 'сделать', 'делать',
])

/** Обращение из досье NPC: «Обращаюсь к Маре (смотрительница): …» — адрес, а не вопрос. */
const ADDRESS_PREFIX_RE = /^\s*(?:обращаюсь|обращаемся)\s+к\s+[^:]{1,240}:\s*/iu

const QUESTION_ENDING_RE = /(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|иях|ях|ах|ов|ев|ий|ый|ой|ей|ых|их|ым|им|ую|юю|ая|яя|ое|ее|ие|ые|ам|ям|ом|ем|ью|ь|ю|ы|и|а|я|е|о|у|й)$/u

/**
 * Основы слов вопроса без обращения и без имени самого собеседника: имя
 * совпало бы с любым фактом о нём, и он снова отвечал бы на всё одним.
 */
function fallbackQuestionStems(profile, message) {
  const nameParts = plainWords(profile?.name, 200)
  return [...new Set(plainWords(clean(message, 1_000).replace(ADDRESS_PREFIX_RE, ''))
    .filter((word) => word.length >= 4 && !FALLBACK_QUESTION_STOP_WORDS.has(word))
    .filter((word) => !nameParts.some((part) => wordNamesPart(word, part)))
    .map((word) => {
      const stem = word.replace(QUESTION_ENDING_RE, '')
      return stem.length >= 4 ? stem : word
    }))]
}

/**
 * Лучшее совпавшее с вопросом предложение из публичных зацепок о собеседнике и
 * открытых фактов. Тайна (`guarded`) сюда не попадает: её без модели не выдают.
 *
 * @returns {{ kind: 'hook' | 'fact', sentence: string, score: number } | null}
 */
function fallbackAnswer(profile, message, hooks, facts, alreadySaid) {
  const stems = fallbackQuestionStems(profile, message)
  if (!stems.length) return null
  const candidates = [
    ...hooks.map((hook) => ({ kind: 'hook', text: hook.text })),
    ...facts.filter((fact) => !fact.guarded).map((fact) => ({ kind: 'fact', text: fact.summary })),
  ]
  let best = null
  for (const candidate of candidates) {
    const sentences = clean(candidate.text, 1_000).split(/(?<=[.!?…])\s+/u).map((part) => clean(part, 320)).filter(Boolean)
    // Факт хранится с пределом длины, и абзац пролога обрывается на полуслове.
    // Хвост без знака конца — не предложение: король отвечал «…отводит взгляд,
    // когда архивист п» (прогон Асстохана 2026-10-05).
    if (sentences.length > 1 && !/[.!?…»"')]$/u.test(sentences.at(-1))) sentences.pop()
    for (const sentence of sentences) {
      const words = plainWords(sentence)
      // Факт, где собеседник описан со стороны, — проза рассказчика, а не его
      // реплика: король без модели произносил «Он просит остановить дракона,
      // но отводит взгляд…» о самом себе (браузерный плейтест 2026-10-07).
      if (candidate.kind === 'fact' && sentenceDescribesNpc(words, profile)) continue
      const score = stems.filter((stem) => words.some((word) => word.startsWith(stem))).length
      if (score < 1 || alreadySaid(sentence)) continue
      if (!best || score > best.score) best = { kind: candidate.kind, sentence, score }
    }
  }
  return best
}

function promiseWithinBoundary(promise, profile) {
  const text = clean(promise?.text, 500).toLocaleLowerCase('ru')
  const policy = npcBehaviorPolicy(profile).boundaries
  if (policy.protects_people && /убить|убью|напад|пытк|погуб|выдам\s+людей/iu.test(text)) return false
  if (policy.keeps_secrets && /раскро|выдам|расскажу|сообщу\s+тайн|открою\s+секрет/iu.test(text)) return false
  return true
}

function normalizedResult(raw, profile, state, playerId, message, turnId, checkOutcome = null, { leads = [] } = {}) {
  const social = ensureNpcSocialState(state.social, state)
  const facts = npcFacts(state, profile, message)
  const memory = relevantNpcMemory(social, profile, playerId, message)
  const claims = npcClaims(state, profile, message)
  const allowedFactIds = new Set(npcSpeakableFactRecords(state, profile).map((fact) => String(fact.id)))
  const allowedClaimIds = new Set(npcSpeakableClaimRecords(state, profile).map((claim) => String(claim.id)))
  const modelReply = typeof raw?.reply === 'string' ? clean(raw.reply, 1_000) : ''
  // Запасной ответ подбирает факты по самому вопросу, без обращения и имени
  // собеседника: иначе «Обращаюсь к смотрительнице дамбы» находило пролог про
  // смотрителя дамбы на любой вопрос (плейтест 2026-10-04, QP-02).
  const answerFacts = modelReply ? [] : npcFacts(state, profile, fallbackQuestionStems(profile, message).join(' '), { summaryLimit: 4_000, spokenAloud: true })
  const answerHooks = modelReply ? [] : publicHooksNamingNpc(state, profile)
  const fallback = modelReply
    ? { reply: '', claimIds: [], factIds: [] }
    : fallbackDisclosure(profile, answerFacts, claims, checkOutcome, memory, message, answerHooks, {
      earlierReplies: npcEarlierReplies(social, profile, playerId), leads,
    })
  // Раскрытие фолбэка добавляется только тогда, когда прозвучала его реплика:
  // иначе провенанс обещал бы то, чего NPC не говорил.
  const disclosedFactIds = [...new Set([
    ...(Array.isArray(raw?.disclosed_fact_ids) ? raw.disclosed_fact_ids : []).map(String),
    ...fallback.factIds,
  ].filter((factId) => allowedFactIds.has(factId)))].slice(0, 20)
  const disclosedClaimIds = [...new Set([
    ...(Array.isArray(raw?.disclosed_claim_ids) ? raw.disclosed_claim_ids : []).map(String),
    ...fallback.claimIds,
  ].filter((claimId) => allowedClaimIds.has(claimId)))].slice(0, 20)
  const reply = modelReply || fallback.reply
  // Личной реплика становится по тому, что в ней прозвучало: раскрытая тайна
  // или слух собеседника, либо явный отзвук личной беседы с этим героем.
  const responseVisibility = privateKnowledgeDisclosed(state, profile, disclosedFactIds, disclosedClaimIds)
    || replyEchoesPrivateMaterial(
      reply,
      privateMaterialTexts(state, social, profile, playerId, [...facts, ...answerFacts]),
      openConversationText(state, social, profile, playerId, message, facts, publicHooksNamingNpc(state, profile)),
    )
    ? 'specific_player'
    : 'party'
  const stance = STANCES.has(raw?.stance) ? raw.stance : 'neutral'
  let relationshipDelta = Math.max(-2, Math.min(2, Number.isSafeInteger(Number(raw?.relationship_delta)) ? Number(raw.relationship_delta) : 0))
  let promise = null
  if (raw?.promise && typeof raw.promise === 'object' && !Array.isArray(raw.promise) && DIRECTIONS.has(raw.promise.direction)) {
    const promiseText = clean(raw.promise.text, 500)
    const dueHint = clean(raw.promise.due_hint, 240)
    if (promiseText && dueHint && promiseWithinBoundary({ ...raw.promise, text: promiseText }, profile)) promise = {
      id: stableId('promise', turnId, profile.id, playerId, promiseText),
      direction: raw.promise.direction,
      text: promiseText,
      due_hint: dueHint,
      visibility: responseVisibility,
    }
  }
  if (checkOutcome?.skill === 'insight') {
    relationshipDelta = 0
    promise = null
  } else if (checkOutcome && !checkOutcome.success) {
    relationshipDelta = Math.min(0, relationshipDelta)
    promise = null
  }
  return {
    npc_id: profile.id,
    reply,
    stance,
    disclosed_fact_ids: disclosedFactIds,
    disclosed_claim_ids: disclosedClaimIds,
    relationship_delta: relationshipDelta,
    promise,
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    visibility: responseVisibility,
    conversation: {
      id: stableId('conversation', turnId, profile.id, playerId),
      npc_id: profile.id,
      hero_id: playerId,
      player_message: clean(message, 1_000),
      npc_reply: reply,
      stance,
      disclosed_fact_ids: disclosedFactIds,
      disclosed_claim_ids: disclosedClaimIds,
      relationship_delta: relationshipDelta,
      visibility: responseVisibility,
      ...(promise ? { promise } : {}),
      ...(checkOutcome ? { check: checkOutcome } : {}),
    },
  }
}

export class NpcSocialController {
  constructor({ llmClient = null } = {}) {
    this.llmClient = llmClient
  }

  async respond({ state = {}, playerId = '', npcId = '', message = '', turnId = '', checkOutcome = null, justSeen = '' } = {}) {
    const social = ensureNpcSocialState(state.social, state)
    const persistedProfile = social.npcs.find((npc) => npc.id === String(npcId))
    const profile = persistedProfile ? npcProfileAtWorldTime(persistedProfile, state) : null
    if (!profile || profile.available === false) return null
    const contextMetadata = agentContextMetadata(state, { role: 'npc_social', actorId: playerId, targetId: profile.id, contractVersion: NPC_SOCIAL_PROMPT_VERSION })
    const facts = npcFacts(state, profile, message)
    const heroId = String(playerId)
    const leads = conversationLeads(state, profile, message, social)
    if (!this.llmClient) return {
      ...normalizedResult({}, profile, state, heroId, message, turnId, checkOutcome, { leads }),
      context_metadata: contextMetadata,
      provider: 'deterministic-social-fallback',
      prompt_version: NPC_SOCIAL_PROMPT_VERSION,
    }
    const complete = (options = {}) => this.llmClient.completeJson({
      messages: [
        { role: 'system', content: promptForModelRole(prompt, this.llmClient, 'npc') },
        { role: 'user', content: buildDataOnlyContext({ npc_social_brief: briefFor(state, profile, heroId, message, checkOutcome, { leads, justSeen, ...options }) }) },
      ],
      temperature: 0.7,
      maxTokens: 700,
      // Творческая роль: профиль рассуждений лидера кампании её касается.
      role: 'npc',
      // Форма ответа на стороне провайдера; structurallyValidSocialResponse всё равно проверяет.
      jsonSchema: NPC_SOCIAL_RESPONSE_JSON_SCHEMA,
    }, { timeoutMs: 20_000 })
    try {
      let result = await complete()
      if (!structurallyValidSocialResponse(result)) throw new Error('NPC_SOCIAL_RESPONSE_INVALID_SHAPE')
      // Антиповтор: предложения, которые NPC уже говорил любому герою,
      // вырезаются. Ничего нового не осталось — одна повторная попытка с явным
      // списком сказанного, а если и она повторяет — короткое признание и
      // зацепка, а не та же фраза в третий раз.
      // Стол уже слышал не только самого NPC: соседи пересказывали ту же
      // историю, а находки отряда NPC подавал как новость (замеры 20–29).
      const tableHeard = [
        ...othersSaidNearby(state, social, profile).map((entry) => entry.npc_reply),
        ...partyKnownFacts(state),
      ]
      const remind = REMIND_REQUEST.test(String(message ?? ''))
      const earlierFor = (candidate) => remind ? [] : [
        ...npcEarlierReplies(social, profile, heroId, {
          includeOtherPrivate: !privateKnowledgeDisclosed(state, profile, candidate?.disclosed_fact_ids ?? [], candidate?.disclosed_claim_ids ?? []),
        }),
        ...tableHeard,
      ]
      let repetition = null
      const fresh = freshReplyText(result.reply, earlierFor(result))
      if (!fresh.text) {
        let retried = null
        try {
          retried = await complete({ repeatRetry: true, repeatedLines: replySentences(result.reply).slice(0, 6) })
        } catch {
          retried = null
        }
        const retriedFresh = retried && structurallyValidSocialResponse(retried) ? freshReplyText(retried.reply, earlierFor(retried)) : { text: '', dropped: 0 }
        if (retriedFresh.text) {
          result = { ...retried, reply: retriedFresh.text }
          repetition = 'regenerated'
        } else {
          result = { ...result, reply: repeatAcknowledgement(leads), disclosed_fact_ids: [], disclosed_claim_ids: [], promise: null }
          repetition = 'acknowledged'
        }
      } else if (fresh.dropped) {
        result = { ...result, reply: fresh.text }
        repetition = 'trimmed'
      }
      const unlooped = withoutCircularReferral(result.reply, social, profile)
      if (unlooped !== result.reply) {
        result = { ...result, reply: unlooped }
        repetition = repetition ?? 'referral-trimmed'
      }
      return {
        ...normalizedResult(result, profile, state, heroId, message, turnId, checkOutcome, { leads }),
        context_metadata: contextMetadata,
        provider: this.llmClient.constructor?.name ?? 'llm',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
        ...(repetition ? { repetition } : {}),
      }
    } catch (error) {
      return {
        ...normalizedResult({}, profile, state, heroId, message, turnId, checkOutcome, { leads }),
        context_metadata: contextMetadata,
        provider: 'deterministic-social-fallback',
        prompt_version: NPC_SOCIAL_PROMPT_VERSION,
        provider_error: clean(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR', 80),
        facts_available: facts.length,
      }
    }
  }
}
