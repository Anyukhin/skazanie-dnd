import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { agentContextMetadata, campaignConceptForAgent, heroCardForAgent } from './agent-context.mjs'
import { HERO_HOOKS_JSON_SCHEMA } from './llm-json-schemas.mjs'
import { ensureNpcSocialState, npcSecretMeta, validateNpcSocialCommand } from './npc-social.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { gmSecretFact, normalizeGmSecrets } from './world-memory.mjs'

/**
 * Зацепки из предысторий героев.
 *
 * Плейтест 2026-10-10 («Серый Причал»): сестра волшебника Ила пропала в море
 * три месяца назад, бывшего стражника капитан учил не замечать ночных лодок у
 * маяка — и за весь вечер мир ни разу на это не откликнулся. Предыстории
 * лежали в листе героя и не доходили ни до NPC, ни до Режиссёра, а механизма,
 * который превращал бы предысторию в зацепку мира, не было вовсе.
 *
 * Модуль — роль модели с внедрённым клиентом (`server/llm-client.mjs` сюда не
 * импортируется, AGENTS.md §4). Модель по предыстории героя, завязке мира,
 * стартовой сцене, её жителям и местам предлагает одну–две скрытые зацепки на
 * героя: тема, одно предложение правды, навыки поиска, необязательный
 * хранитель (только существующий NPC). Сервер их проверяет и записывает тем же
 * путём, каким живут заготовки ведущего (`gm_secret`, `gmSecretFact`,
 * `RecordWorldFact` → `WorldFactRecorded`), поэтому replay не требует новой
 * схемы событий, удачный поиск открывает зацепку как любую тайну места
 * (`freeActionDiscoveryCommands`), а хранитель выдаёт её в разговоре
 * (`npcKnownFactIds`). Герой зацепки — поле `hero_id` в JSON `object` факта.
 * Каждому герою — одна личная нить (`UpsertNarrativeThread`, видна отряду):
 * её заголовок — цель героя его же словами, без текста зацепки.
 *
 * Плетение одно на героя: ключ коммита `hero-hooks:<hero_id>`, id фактов
 * детерминированы от героя и текста. Модель промолчала или ответила негодным —
 * зацепок нет, ход игры не страдает, попытка повторится позже (не больше
 * `HERO_HOOK_MAX_ATTEMPTS` за процесс).
 */

export const HERO_HOOKS_PROMPT_VERSION = 'hero_hooks/v1'
const prompt = readFileSync(fileURLToPath(new URL('../prompts/hero_hooks/v1.txt', import.meta.url)), 'utf8')

/** Зацепок на героя не больше этого числа. */
export const HERO_HOOK_LIMIT = 2
/** Попыток плетения на героя за жизнь процесса. */
export const HERO_HOOK_MAX_ATTEMPTS = 2
/** Пауза перед повторной попыткой после неудачи. */
export const HERO_HOOK_RETRY_MS = 60_000
/** Короче этого предыстория и привязанности вместе — плести не из чего. */
const HERO_STORY_MIN = 20
const CLUE_MIN = 20
const CLUE_MAX = 300
const TOPIC_MAX = 120
const MOTIVE_MIN = 4
const MOTIVE_MAX = 90

/** Поля факта, которые принимает команда `RecordWorldFact`. */
const FACT_COMMAND_FIELDS = Object.freeze(['id', 'subject_id', 'predicate', 'object', 'summary', 'visibility', 'source_event_ids', 'supersedes_fact_id'])
/** Поля профиля, которые принимает `UpsertNpcSocialProfile` (как у `scenario-knight`). */
const PROFILE_FIELDS = Object.freeze([
  'id', 'name', 'role', 'location', 'location_id', 'public_summary', 'voice', 'speech_profile', 'goals', 'beliefs',
  'known_fact_ids', 'social_dcs', 'visibility', 'reveal_on_presence', 'available', 'tags', 'schedule', 'inventory',
])
const PLACEHOLDERS = new Set(['не выбран', 'не выбрано', 'не определено'])

/**
 * Механика в тексте зацепки: цифры, сложности, броски, хиты, урон. Зацепка —
 * правда мира словами, числа решает Rules Engine.
 */
const MECHANICS_RE = /(?:\d|(?<!\p{L})(?:СЛ|КД)(?!\p{L})|урон|(?<!\p{L})хит(?:ы|ов|ам)?(?!\p{L})|бросок|броск|бросить|проверк|спасброс|преимуществ|(?<!\p{L})помех)/iu

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const lower = (value) => clean(value, 400).toLocaleLowerCase('ru').replaceAll('ё', 'е')
const digest = (value) => createHash('sha256').update(String(value)).digest('hex')

function storyText(value, maximum) {
  const text = clean(value, maximum)
  return PLACEHOLDERS.has(text.toLocaleLowerCase('ru')) ? '' : text
}

function stems(value) {
  return new Set((lower(value).match(/\p{L}{5,}/gu) ?? []).map((word) => word.slice(0, 5)))
}

/** Личная нить героя: одна на героя, id стабилен. */
export function heroHookThreadId(heroId) {
  const id = clean(heroId, 120)
  return /^[A-Za-z0-9._:-]{1,90}$/u.test(id) ? `thread:hero-hook:${id}` : `thread:hero-hook:${digest(id).slice(0, 20)}`
}

/** Ключ коммита плетения: одно плетение на героя. */
export function heroHookIdempotencyKey(heroId) {
  return `hero-hooks:${clean(heroId, 120)}`
}

/**
 * Зацепки героя (или всех героев) — заготовки ведущего с `hero_id` в JSON
 * `object`, в любом статусе: найденная зацепка остаётся зацепкой героя.
 */
export function heroHookFacts(state = {}, heroId = '') {
  const expected = clean(heroId, 120)
  return (state.worldMemory?.facts ?? []).filter((fact) => {
    if (fact?.predicate !== 'gm_secret') return false
    const owner = npcSecretMeta(fact).hero_id
    return expected ? owner === expected : Boolean(owner)
  })
}

function partyHeroes(state = {}) {
  const party = new Set((state.partyMemberIds ?? []).map(String))
  return (state.players ?? []).filter((hero) => hero?.id && (!party.size || party.has(String(hero.id))))
}

function heroStory(hero = {}) {
  return [storyText(hero.backstory, 2_000), storyText(hero.bonds, 1_000)].filter(Boolean).join(' ')
}

function locationEntities(state = {}) {
  return (state.worldMemory?.entities ?? []).filter((entity) => entity?.kind === 'location' && entity.id && entity.name)
}

function sceneLocationEntity(state = {}) {
  const scene = lower(state.scene?.location)
  return scene ? locationEntities(state).find((entity) => lower(entity.name) === scene) ?? null : null
}

/**
 * Нужно ли герою плетение: лист собран, предыстория есть, зацепок и личной
 * нити ещё нет, и мир уже знает место, к которому их привязать.
 */
export function heroNeedsHooks(state = {}, heroId = '') {
  const hero = partyHeroes(state).find((candidate) => String(candidate.id) === String(heroId))
  if (!hero || hero.characterSetupRequired === true) return false
  if (state.mechanics?.death?.heroes?.[String(hero.id)]?.status === 'dead') return false
  if (heroStory(hero).length < HERO_STORY_MIN) return false
  if (!sceneLocationEntity(state)) return false
  if (heroHookFacts(state, String(hero.id)).length) return false
  return !(state.worldMemory?.threads ?? []).some((thread) => thread?.id === heroHookThreadId(hero.id))
}

/** Герои, которым ещё нужны зацепки, — по возрастанию id. */
export function heroesNeedingHooks(state = {}) {
  return partyHeroes(state).map((hero) => String(hero.id)).filter((heroId) => heroNeedsHooks(state, heroId)).sort()
}

/**
 * Бриф модели. Всё, что пишет игрок (предыстория), уходит внутри
 * UNTRUSTED_DATA через `buildDataOnlyContext`.
 */
export function heroHooksBrief(state = {}, heroIds = []) {
  const social = ensureNpcSocialState(state.social, state)
  const scene = sceneLocationEntity(state)
  const places = [...new Set([
    clean(state.scene?.location, 160),
    ...locationEntities(state).filter((entity) => entity.visibility !== 'gm_only').map((entity) => clean(entity.name, 160)),
  ].filter(Boolean))].slice(0, 16)
  const npcs = social.npcs
    .filter((npc) => npc.visibility !== 'gm_only' && npc.available !== false && clean(npc.name, 120))
    .slice(0, 16)
    .map((npc) => ({
      name: clean(npc.name, 120), role: clean(npc.role, 120), location: clean(npc.location, 160),
      summary: clean(npc.public_summary, 240),
    }))
  const topics = [...new Set((state.worldMemory?.facts ?? [])
    .filter((fact) => fact?.predicate === 'gm_secret' && fact.status !== 'superseded')
    .map((fact) => clean(npcSecretMeta(fact).topic, 120))
    .filter(Boolean))].slice(0, 12)
  return {
    context_metadata: agentContextMetadata(state, { role: 'hero_hooks', actorId: null, contractVersion: HERO_HOOKS_PROMPT_VERSION }),
    campaign_premise: campaignConceptForAgent(state),
    scene: {
      title: clean(state.scene?.title, 160), location: clean(scene?.name ?? state.scene?.location, 160),
      objective: clean(state.scene?.objective, 240), mood: clean(state.scene?.mood, 160),
    },
    places,
    npcs,
    mystery_topics: topics,
    heroes: heroIds.map((heroId) => {
      const hero = partyHeroes(state).find((candidate) => String(candidate.id) === String(heroId)) ?? {}
      const card = heroCardForAgent(state, heroId) ?? {}
      return {
        hero_id: String(heroId),
        name: card.name ?? '',
        ...(card.class ? { class: card.class } : {}),
        ...(card.species ? { species: card.species } : {}),
        ...(card.background ? { background: card.background } : {}),
        backstory: storyText(hero.backstory, 900),
        bonds: storyText(hero.bonds, 300),
        ideals: storyText(hero.ideals, 200),
      }
    }),
  }
}

/**
 * Цель героя для личной нити. Её видят игроки, поэтому она не должна нести
 * того, чего герой ещё не знает: слово из зацепки, которого нет в предыстории,
 * — и цель заменяется первой фразой привязанностей или предыстории.
 */
function safeMotive(value, hooks, hero) {
  const motive = clean(value, MOTIVE_MAX + 40).replace(/[.!…]+$/u, '')
  const own = stems(`${heroStory(hero)} ${hero.character ?? ''} ${hero.name ?? ''}`)
  const hidden = new Set(hooks.flatMap((hook) => [...stems(hook.clue)]).filter((stem) => !own.has(stem)))
  const leaks = [...stems(motive)].some((stem) => hidden.has(stem))
  if (motive.length >= MOTIVE_MIN && motive.length <= MOTIVE_MAX && !MECHANICS_RE.test(motive) && !leaks) return motive
  const sentence = (text) => clean(String(text ?? '').split(/(?<=[.!?…])\s+/u)[0], 400).replace(/[.!…]+$/u, '')
  const fromStory = [sentence(storyText(hero.bonds, 1_000)), sentence(storyText(hero.backstory, 2_000))]
    .find((candidate) => candidate.length >= MOTIVE_MIN && candidate.length <= MOTIVE_MAX && !MECHANICS_RE.test(candidate))
  return fromStory || `Личная история: ${clean(hero.character || hero.name, 60) || 'герой'}`
}

/**
 * Проверка ответа модели. Зацепка принимается, если в ней одно предложение
 * правды разумной длины, тема и ни одной цифры или механики; хранитель —
 * только существующий видимый NPC (иначе зацепка остаётся без хранителя и
 * открывается поиском). Повтор уже существующей тайны отбрасывается.
 *
 * @returns {Map<string, { motive: string, hooks: Array<{ clue: string, topic: string, skills: string[], holder: string, holder_id: string }> }>}
 */
export function normalizeHeroHookProposals(raw, state = {}, heroIds = []) {
  const wanted = new Set(heroIds.map(String))
  const social = ensureNpcSocialState(state.social, state)
  const npcByName = new Map(social.npcs
    .filter((npc) => npc.visibility !== 'gm_only' && clean(npc.name, 120))
    .map((npc) => [lower(npc.name), npc]))
  const existing = new Set((state.worldMemory?.facts ?? []).filter((fact) => fact?.predicate === 'gm_secret').map((fact) => lower(fact.summary)))
  const proposals = new Map()
  for (const entry of Array.isArray(raw?.heroes) ? raw.heroes : []) {
    const heroId = clean(entry?.hero_id, 120)
    if (!wanted.has(heroId) || proposals.has(heroId)) continue
    const hero = partyHeroes(state).find((candidate) => String(candidate.id) === heroId) ?? {}
    const hooks = []
    for (const candidate of (Array.isArray(entry?.hooks) ? entry.hooks : []).slice(0, 4)) {
      const rawClue = clean(candidate?.clue, 1_000)
      if (rawClue.length < CLUE_MIN || rawClue.length > CLUE_MAX) continue
      const [secret] = normalizeGmSecrets([candidate], { limit: 1 })
      if (!secret || !secret.topic || secret.topic.length > TOPIC_MAX) continue
      if (MECHANICS_RE.test(secret.clue) || MECHANICS_RE.test(secret.topic)) continue
      if (existing.has(lower(secret.clue)) || hooks.some((hook) => lower(hook.clue) === lower(secret.clue))) continue
      const holder = secret.holder ? npcByName.get(lower(secret.holder)) ?? null : null
      hooks.push({ ...secret, holder: holder ? clean(holder.name, 120) : '', holder_id: holder ? String(holder.id) : '' })
      if (hooks.length >= HERO_HOOK_LIMIT) break
    }
    if (!hooks.length) continue
    proposals.set(heroId, { motive: safeMotive(entry?.motive, hooks, hero), hooks })
  }
  return proposals
}

/**
 * Команды плетения одного героя: скрытые факты зацепок, хранителю — id его
 * факта в `known_fact_ids`, отряду — личная нить. Всё в одном коммите.
 */
export function heroHookCommands(state = {}, heroId = '', proposal = { motive: '', hooks: [] }) {
  const social = ensureNpcSocialState(state.social, state)
  const scene = sceneLocationEntity(state)
  const locations = locationEntities(state)
  const hero = partyHeroes(state).find((candidate) => String(candidate.id) === String(heroId)) ?? {}
  const facts = []
  /** @type {Map<string, string[]>} */
  const holderFacts = new Map()
  for (const [index, hook] of (proposal.hooks ?? []).slice(0, HERO_HOOK_LIMIT).entries()) {
    const holder = hook.holder_id ? social.npcs.find((npc) => npc.id === hook.holder_id) ?? null : null
    // Зацепка живёт там, где её хранитель; без хранителя — в стартовой сцене.
    const holderPlace = holder
      ? locations.find((entity) => (holder.location_id && String(entity.id) === holder.location_id) || lower(entity.name) === lower(holder.location)) ?? null
      : null
    const subject = holderPlace ?? scene
    if (!subject) continue
    const base = gmSecretFact({ clue: hook.clue, topic: hook.topic, skills: hook.skills, holder: hook.holder }, {
      subjectId: String(subject.id), salt: `hero-hook:${clean(heroId, 120)}`, index,
    })
    const fact = Object.fromEntries(FACT_COMMAND_FIELDS.map((field) => [field, base[field]]))
    fact.object = JSON.stringify({ ...JSON.parse(base.object), hero_id: clean(heroId, 120) })
    facts.push(fact)
    if (holder) holderFacts.set(holder.id, [...(holderFacts.get(holder.id) ?? []), fact.id])
  }
  if (!facts.length) return []
  const commands = facts.map((fact) => ({ command_type: 'RecordWorldFact', fact }))
  for (const [npcId, factIds] of holderFacts) {
    // Хранитель — NPC из профилей кампании (не выведенный из торговца или
    // сущности памяти): только такой профиль можно переписать целиком.
    if (!(state.social?.npcs ?? []).some((npc) => String(npc?.id) === npcId)) continue
    const stored = social.npcs.find((npc) => npc.id === npcId)
    if (!stored) continue
    const known = [...new Set([...(stored.known_fact_ids ?? []), ...factIds])]
    const profile = Object.fromEntries(PROFILE_FIELDS.filter((field) => stored[field] !== undefined).map((field) => [field, structuredClone(stored[field])]))
    const command = { command_type: 'UpsertNpcSocialProfile', npc: { ...profile, known_fact_ids: known } }
    try {
      validateNpcSocialCommand(command, state, { isDirector: true })
    } catch {
      // Профиль не проходит строгую проверку (переполнен список знаний и т. п.):
      // хранитель всё равно знает зацепку — он назван в самой заготовке.
      continue
    }
    commands.push(command)
  }
  const name = clean(hero.character || hero.name, 120) || 'героя'
  commands.push({
    command_type: 'UpsertNarrativeThread',
    thread: {
      id: heroHookThreadId(heroId),
      title: clean(proposal.motive, 180) || `Личная история: ${name}`,
      summary: `Личная нить из предыстории: ${name}.`,
      status: 'active',
      visibility: 'party',
      entity_ids: [String(scene?.id ?? facts[0].subject_id)],
      clock: { current: 0, max: 4, label: 'Личная история героя' },
    },
  })
  return commands
}

/**
 * Мотивы отряда для Режиссёра: на героя — короткая цель (заголовок личной
 * нити, иначе первая фраза привязанностей) и сколько его зацепок ещё не
 * раскрыто. Текстов зацепок здесь нет.
 *
 * @returns {Array<{ hero_id: string, hero: string, motive: string, unrevealed_hook_leads: number }>}
 */
export function partyMotivesForDirector(state = {}) {
  const revealed = new Set([...(state.worldMemory?.knowledge_ledger ?? []), ...(state.worldMemory?.knowledge_revealed ?? [])]
    .map((entry) => String(entry?.fact_id ?? '')))
  const threads = new Map((state.worldMemory?.threads ?? []).map((thread) => [String(thread?.id ?? ''), thread]))
  return partyHeroes(state).map((hero) => {
    const heroId = String(hero.id)
    const thread = threads.get(heroHookThreadId(heroId))
    const firstSentence = (text) => clean(String(text ?? '').split(/(?<=[.!?…])\s+/u)[0], 160)
    const motive = thread?.status === 'active' ? clean(thread.title, 160)
      : firstSentence(storyText(hero.bonds, 1_000)) || firstSentence(storyText(hero.backstory, 2_000))
    const hooks = heroHookFacts(state, heroId)
    return {
      hero_id: heroId,
      hero: clean(hero.character || hero.name, 120),
      motive,
      unrevealed_hook_leads: hooks.filter((fact) => fact.status !== 'superseded' && !revealed.has(String(fact.id))).length,
    }
  }).filter((entry) => entry.motive || entry.unrevealed_hook_leads)
}

export class HeroHookWeaver {
  constructor({ llmClient = null, maxAttemptsPerHero = HERO_HOOK_MAX_ATTEMPTS, retryMs = HERO_HOOK_RETRY_MS, now = () => Date.now() } = {}) {
    this.llmClient = llmClient
    this.maxAttempts = Math.max(1, Number(maxAttemptsPerHero) || HERO_HOOK_MAX_ATTEMPTS)
    this.retryMs = Math.max(0, Number(retryMs) || 0)
    this.now = now
    /** @type {Map<string, { count: number, at: number }>} */
    this.attempts = new Map()
  }

  /**
   * Герои, для которых плетение имеет смысл сейчас: модель есть, зацепок нет,
   * попытки не исчерпаны и пауза после неудачи прошла.
   */
  pendingHeroIds(state = {}, campaignId = '') {
    if (!this.llmClient) return []
    const now = this.now()
    return heroesNeedingHooks(state).filter((heroId) => {
      const attempt = this.attempts.get(`${campaignId}\u0000${heroId}`)
      return !attempt || (attempt.count < this.maxAttempts && now - attempt.at >= this.retryMs)
    })
  }

  /** Остались ли у героя попытки плетения в этом процессе. */
  attemptsLeft(campaignId = '', heroId = '') {
    return (this.attempts.get(`${campaignId}\u0000${heroId}`)?.count ?? 0) < this.maxAttempts
  }

  /**
   * Одна модель на всех ждущих героев; на выходе — план коммита на героя.
   * Коммитит вызывающий (`authoritativeExecutor.executeCommands` с
   * `context.isDirector` и ключом `idempotency_key`).
   *
   * @returns {Promise<{ hero_ids: string[], plans: Array<{ hero_id: string, idempotency_key: string, commands: any[] }>, provider: string, prompt_version: string, error?: string }>}
   */
  async weave({ state = {}, campaignId = '', heroIds = null } = {}) {
    const targets = (Array.isArray(heroIds) ? heroIds.map(String) : this.pendingHeroIds(state, campaignId))
      .filter((heroId) => heroNeedsHooks(state, heroId))
    if (!this.llmClient || !targets.length) return { hero_ids: [], plans: [], provider: 'none', prompt_version: HERO_HOOKS_PROMPT_VERSION }
    const now = this.now()
    for (const heroId of targets) {
      const key = `${campaignId}\u0000${heroId}`
      this.attempts.set(key, { count: (this.attempts.get(key)?.count ?? 0) + 1, at: now })
    }
    let raw
    try {
      raw = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ hero_hooks_brief: heroHooksBrief(state, targets) }) },
        ],
        temperature: 0.8,
        maxTokens: 900,
        // Творческая роль ведущего: тот же профиль рассуждений, что у Режиссёра.
        role: 'director',
        jsonSchema: HERO_HOOKS_JSON_SCHEMA,
      }, { timeoutMs: 30_000 })
    } catch (error) {
      return {
        hero_ids: targets, plans: [], provider: 'error', prompt_version: HERO_HOOKS_PROMPT_VERSION,
        error: clean(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR', 80),
      }
    }
    const proposals = normalizeHeroHookProposals(raw, state, targets)
    const plans = targets.map((heroId) => {
      const proposal = proposals.get(heroId)
      const commands = proposal ? heroHookCommands(state, heroId, proposal) : []
      return commands.length ? { hero_id: heroId, idempotency_key: heroHookIdempotencyKey(heroId), commands } : null
    }).filter((plan) => plan !== null)
    return {
      hero_ids: targets, plans, provider: this.llmClient.constructor?.name ?? 'llm', prompt_version: HERO_HOOKS_PROMPT_VERSION,
      ...(plans.length ? {} : { error: 'HERO_HOOKS_INVALID_RESPONSE' }),
    }
  }
}
