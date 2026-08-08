import { createHash } from 'node:crypto'

import { revealedPropPredicate } from './action-adjudicator.mjs'
import { normalizeDirectorIntent, serverReputationDelta } from './autonomous-campaign.mjs'
import {
  ENCOUNTER_COINS_POLICY_ID,
  ENCOUNTER_LOOT_POLICY_ID,
  ENCOUNTER_REWARD_POLICY_ID,
  ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
  SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION,
  assertEncounterDistributionPreconditions,
  assertEncounterRewardRecipients,
  distributeEncounterRewards,
  encounterCompletionStageKey,
  encounterRewardResponse,
  freezeEncounterOutcomePlan,
  frozenEncounterOutcomePlanFromEvent,
  lootForEncounterOutcome,
  rollEncounterCoins,
} from './encounter-rewards.mjs'
import {
  assembleSocialNpc,
  campaignArcPosition,
  completedDowntime,
  directorProgressFingerprint,
  pacingForDirectorIntent,
  planServerTravel,
} from './campaign-loop-policy.mjs'
import { partyDecisionOpenedEvent } from './party-decision.mjs'
import { planNpcTurn } from './npc-turn-scheduler.mjs'
import { planHeroTurn } from './party-tactics.mjs'
import {
  RulesValidationError,
  actorPosition,
  findActor,
  isEnemyActor,
  isLivingActor,
  normalizeCampaignState,
  previewD20Check,
} from './rules-engine.mjs'
import { classifyFreeActionKind } from './intent-parser.mjs'
import {
  buildDeterministicEpilogue,
  buildEpilogueNarrationBrief,
  campaignCanAdvanceArc,
  campaignCanAutoComplete,
} from './campaign-lifecycle.mjs'
import { questTitleFromObjective } from './scene-memory.mjs'
import {
  attemptFingerprint,
  bindFreeActionReadingToState,
  contextualResolutionFor,
  d20CheckLabel,
  failForwardFor,
  interpretFreeAction,
  previousFailedAttempt,
  resolveCorpseSearch,
  resolveInventoryTransfer,
  situationFingerprint,
  stakesFor,
  verifyMeans,
} from './free-action-adjudication.mjs'
import { planImprovisedEffect, resolveActionCost, scenePropIntentFor } from './improvised-effects.mjs'
import { npcProfileAtWorldTime } from './npc-social.mjs'
import { sceneHazardNarration } from './scene-hazard-narration.mjs'
import { nearestSceneObjectCommand, sceneInteractionNarration } from './scene-interactions.mjs'

const clone = (value) => structuredClone(value)
const encounterCompletionLocks = new Map()

/** Порядок отряда: сначала явный список, иначе порядок героев в состоянии. */
export function partyOrderIds(state) {
  return (state?.partyMemberIds?.length ? state.partyMemberIds : (state?.players ?? []).map((hero) => hero?.id))
    .map((id) => String(id ?? ''))
    .filter(Boolean)
}

export function isUnresolvedDeadHero(state, id) {
  return state?.mechanics?.death?.heroes?.[String(id)]?.status === 'dead'
}

/**
 * Кому достаётся добыча после победы.  Погибший герой не может быть автором ни
 * одной команды, пока его не воскресят или не заменят, поэтому выдача добычи в
 * его карман роняет весь ход кампании — а он вполне может оказаться первым в
 * списке отряда.
 */
export function lootOwnerId(state) {
  const order = partyOrderIds(state)
  return order.find((id) => !isUnresolvedDeadHero(state, id)) ?? order[0] ?? String(state?.players?.[0]?.id ?? '')
}
// A stabilised hero comes round on its own after 1d4 hours, so four hours is the
// longest the party can have to wait before a long rest is worth anything.
const STABLE_RECOVERY_MINUTES = 240
const clean = (value, maximum = 300) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)

function event(commandId, type, payload = {}, targets = [], visibility = 'party') {
  return {
    command_id: commandId,
    event_type: type,
    actor_id: null,
    target_ids: targets.map(String),
    payload: clone(payload),
    source_rule_ids: [],
    house_rule_id: null,
    ruling_id: null,
    visibility,
  }
}
function openQuest(state, requestedId = '') {
  return (state.worldMemory?.quests ?? []).find((quest) => quest.id === requestedId && quest.status === 'active')
    ?? (state.worldMemory?.quests ?? []).find((quest) => quest.status === 'active' && !quest.clock?.triggered)
    ?? null
}

function currentSubject(state) {
  return (state.worldMemory?.entities ?? []).find((entity) => entity.kind === 'location' && entity.name === state.scene?.location)
    ?? state.worldMemory?.entities?.[0]
    ?? null
}

/**
 * Материальное последствие свободного действия — задача 2.1 плана.
 * «Сожжённая таверна остаётся сожжённой»: успех, изменивший мир, оставляет
 * факт, который дальше видят Режиссёр, Рассказчик и сводка сцены.
 *
 * Граница намеренно узкая и берётся из полей, которые уже есть в прочтении:
 * успех И (эффект наносит урон обстановкой ИЛИ ставка была serious/deadly ИЛИ
 * названа опасность сцены). Обычная удачная проверка мир не меняет, и факт о
 * ней был бы шумом — а шум вытеснит из окна выборки настоящее последствие.
 */
export function materialConsequenceCommands(state, { succeeded = false, reading = {}, checkEvent = null } = {}) {
  if (!succeeded) return []
  const material = reading.effect === 'hazard_damage'
    || ['serious', 'deadly'].includes(String(reading.risk))
    || Boolean(reading.hazard)
  if (!material) return []
  const eventId = String(checkEvent?.event_id ?? '')
  if (!eventId) return []
  const factId = `fact-scene-change-${digest(eventId)}`
  const memory = state.worldMemory ?? {}
  if ((memory.facts ?? []).some((fact) => fact?.id === factId)) return []
  const goal = String(reading.goal_summary ?? '').trim()
  const approach = String(reading.approach_summary ?? '').trim()
  if (!goal && !approach) return []
  const commands = []
  let subject = currentSubject(state)
  if (!subject) {
    subject = {
      id: `location-${digest(state.scene?.location || 'scene')}`,
      kind: 'location',
      name: state.scene?.location || 'Текущая сцена',
      summary: '', aliases: [], visibility: 'party', tags: [],
    }
    commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
  }
  const place = String(state.scene?.location ?? '').trim()
  commands.push({ command_type: 'RecordWorldFact', fact: {
    id: factId,
    subject_id: subject.id,
    predicate: 'scene_change',
    object: goal || approach,
    summary: `${[goal, approach].filter(Boolean).join(': ')}${place ? ` (${place})` : ''}`,
    visibility: 'party',
    source_event_ids: [eventId],
  } })
  return commands
}

function explorationCells(state) {
  return (state.scene?.cells ?? []).filter((cell) => cell.revealed !== true && ['floor', 'door'].includes(String(cell.type)))
    .sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x))
    .map((cell) => ({ x: Number(cell.x), y: Number(cell.y) }))
}

/**
 * Кого можно позвать в социальную сцену прямо сейчас.
 *
 * Смотреть надо на профиль, выведенный из расписания, а не на записанный:
 * расписание уводит NPC из локации, не переписывая базовые поля, — так и
 * задумано в `npc-social.mjs`. Разговор это уже учитывает и отвечает
 * `NPC_SOCIAL_WRONG_LOCATION`, поэтому выбирать надо тем же правилом: иначе
 * Директор ставит цель «поговорить», а разговор потом невозможен.
 *
 * Возвращается **записанный** профиль, а не выведенный: дальше он может уехать
 * в `UpsertNpcSocialProfile`, и подменять там базовую локацию расписанием
 * нельзя.
 */
function availableNpc(state, requestedId = '') {
  const at = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  return (state.social?.npcs ?? []).find((npc) => {
    if (requestedId && npc.id !== requestedId) return false
    const now = npcProfileAtWorldTime(npc, state)
    return now.available !== false
      && (!now.location || !at || clean(now.location, 180).toLocaleLowerCase('ru') === at)
  }) ?? null
}

// Заголовок разворачивается перед подстановкой: в кампаниях, созданных до этой правки,
// он уже мог накопить обёртки «Продолжить квест «…».
const questGoal = (quest) => clean(questTitleFromObjective(quest?.title), 180)

function nextHook(state, reason = '') {
  const quest = openQuest(state)
  return clean(reason, 300) || (quest ? `Продолжить квест «${questGoal(quest)}»` : `Исследовать ${state.scene?.location || 'окрестности'} и найти новую зацепку`)
}

/**
 * Зацепка следующей арки. Она не выдумывается: берётся первая незакрытая нить,
 * затем неисполненное обещание, и только если не осталось ни того, ни другого —
 * нейтральное продолжение. Именно это и делает вторую сессию продолжением, а не
 * новой кампанией теми же фишками.
 */
function nextArcHook(state) {
  const thread = (state.worldMemory?.threads ?? []).find((entry) => entry.status === 'active')
  if (thread) return clean(`Вернуться к незакрытому: ${clean(thread.title, 180)}`, 300)
  for (const npc of state.social?.npcs ?? []) {
    const promise = (npc.promises ?? []).find((entry) => !['fulfilled', 'broken'].includes(String(entry?.status ?? '')))
    if (promise) return clean(`Сдержать слово, данное ${clean(npc.name, 120)}: ${clean(promise.text, 160)}`, 300)
  }
  const quest = (state.worldMemory?.quests ?? []).find((entry) => entry.status === 'active')
  if (quest) return clean(`Довести до конца: ${questGoal(quest)}`, 300)
  return clean(`Новая дорога уводит отряд из ${clean(state.scene?.location, 120) || 'знакомых мест'}`, 300)
}

function questResolutionFor(quest = {}) {
  const label = clean(quest.clock?.label, 160)
  const failureClock = /(угроз|опасност|провал|разыск|подозрен|deadline|danger|failure)/iu.test(label)
  const outcome = failureClock ? 'failure' : 'success'
  const goal = questGoal(quest)
  const summary = outcome === 'success'
    ? `Цель «${goal}» достигнута: заполненные часы подтвердили успех отряда.`
    : `Угроза в квесте «${goal}» осуществилась: заполненные часы подтвердили неудачу, но история продолжается с последствиями.`
  return {
    outcome,
    summary,
    nextObjective: outcome === 'success'
      ? `Развить последствия победы в квесте «${goal}» и приблизить развязку`
      : `Ответить на последствия провала квеста «${goal}» и найти новый путь`,
  }
}

function boundedObjective(state, text) {
  const lower = text.toLocaleLowerCase('ru')
  if (/двер\w*|подпира\w*|баррикад\w*/iu.test(lower)) return 'Проверить, удерживает ли баррикада дверь, и выбрать следующий способ пройти.'
  if (/страж\w*|вор\w*|крич\w*|зову\w*/iu.test(lower)) return 'Дождаться ответа стражи на сообщение о воре.'
  if (/поджиг\w*|зажиг\w*|огон\w*|дым\w*/iu.test(lower)) return 'Проверить последствия использования огня и выбрать безопасный путь.'
  return nextHook(state, 'Проверить последствия нестандартного действия героя')
}

function declaredActionCommand(playerId, text) {
  return playerId ? { command_type: 'DeclareAction', actor_id: playerId, action: text } : null
}

function isNoise(text) {
  return /^[a-z]{8,}$/iu.test(text) && !/\s/u.test(text)
}

function factionIdsForWitnesses(state, witnessIds) {
  const wanted = new Set(witnessIds.map(String))
  const values = []
  for (const npc of state.social?.npcs ?? []) {
    if (!wanted.has(String(npc.id))) continue
    for (const tag of npc.tags ?? []) if (String(tag).startsWith('faction:')) values.push(String(tag).slice('faction:'.length))
  }
  return [...new Set(values.filter(Boolean))].sort()
}

function parseJsonFact(fact) {
  try { return JSON.parse(String(fact?.object ?? '')) } catch { return null }
}

export class AutonomousCampaignOrchestrator {
  constructor({
    loreAuthor = null, eventStore, rulesEngine, narrator = null, actionAdjudicator = null, rollRegistry = null, now = () => Date.now() } = {}) {
    if (!eventStore || !rulesEngine) throw new TypeError('AutonomousCampaignOrchestrator requires eventStore and rulesEngine')
    this.eventStore = eventStore
    this.rulesEngine = rulesEngine
    this.narrator = narrator
    // Без арбитра свободное действие читает детерминированная таблица: игра
    // обязана оставаться играбельной без ключа модели.
    this.actionAdjudicator = actionAdjudicator
    this.loreAuthor = loreAuthor
    // Реестр бросков нужен только ручному подтверждению кубика игроком.
    // Без него свободное действие разрешается как раньше — серверным броском.
    this.rollRegistry = rollRegistry
    this.now = now
  }

  async load(campaignId) {
    const loaded = await this.eventStore.load(campaignId)
    return { ...loaded, state: normalizeCampaignState(loaded.state) }
  }

  async commitEvents(campaignId, idempotencyKey, events) {
    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, idempotencyKey)
    if (duplicate) return duplicate
    const loaded = await this.load(campaignId)
    return this.eventStore.commit({
      campaign_id: campaignId,
      expected_state_version: loaded.state_version,
      idempotency_key: idempotencyKey,
      command_id: idempotencyKey,
      events: events.map((entry) => ({ ...entry, campaign_id: campaignId })),
    })
  }

  async commitEventsWithRetry(campaignId, idempotencyKey, events, {
    maximumAttempts = 3,
    validateState = null,
  } = {}) {
    const prepared = events.map((entry) => ({ ...entry, campaign_id: campaignId }))
    const acceptsStoredStage = (stored) => {
      if (!stored || stored.events?.length !== prepared.length) return false
      return prepared.every((expected, index) => {
        const actual = stored.events[index]
        const expectedEncounterId = String(expected.payload?.encounter_id ?? '')
        const actualEncounterId = String(actual?.payload?.encounter_id ?? '')
        const expectedPolicy = expected.payload?.provenance?.policy ?? expected.payload?.policy ?? null
        const actualPolicy = actual?.payload?.provenance?.policy ?? actual?.payload?.policy ?? null
        return actual?.event_type === expected.event_type
          && (!expectedEncounterId || actualEncounterId === expectedEncounterId)
          && (!expectedPolicy || actualPolicy === expectedPolicy)
          && (expected.event_schema_version == null
            || Number(actual.event_schema_version) === Number(expected.event_schema_version))
      })
    }
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, idempotencyKey)
      if (duplicate) {
        if (!acceptsStoredStage(duplicate)) throw new Error(`Stored encounter reward stage ${idempotencyKey} has an incompatible contract`)
        return { ...duplicate, duplicate: true }
      }
      const loaded = await this.load(campaignId)
      if (validateState) await validateState(loaded.state)
      try {
        return await this.eventStore.commit({
          campaign_id: campaignId,
          expected_state_version: loaded.state_version,
          idempotency_key: idempotencyKey,
          command_id: idempotencyKey,
          events: prepared,
        })
      } catch (error) {
        if (error?.code === 'IDEMPOTENCY_CONFLICT') {
          const stored = await this.eventStore.getByIdempotencyKey?.(campaignId, idempotencyKey)
          if (acceptsStoredStage(stored)) return { ...stored, duplicate: true }
        }
        if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === maximumAttempts - 1) throw error
      }
    }
    throw new Error('Encounter reward stage exhausted its retry budget')
  }

  async runCommands(campaignId, idempotencyKey, commands, context = {}) {
    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, idempotencyKey)
    if (duplicate) return { ...duplicate, duplicate: true, commands: [] }
    const loaded = await this.load(campaignId)
    const proposed = commands.map((command, index) => ({
      ...command,
      campaign_id: campaignId,
      command_id: `${idempotencyKey}:${index + 1}`,
    }))
    const resolved = this.rulesEngine.resolvePlan({ proposed_commands: proposed }, loaded.state, {
      isDirector: true,
      serverAuthoritativeCombat: true,
      allowedActorIds: [...loaded.state.players, ...loaded.state.enemies, ...(loaded.state.actors ?? [])].map((actor) => String(actor.id ?? actor.actor_id)),
      ...context,
    })
    if (!resolved.events.length) throw new Error('Autonomous command batch produced no events')
    const committed = await this.eventStore.commit({
      campaign_id: campaignId,
      expected_state_version: loaded.state_version,
      idempotency_key: idempotencyKey,
      command_id: idempotencyKey,
      events: resolved.events,
    })
    await this.resolvePromiseConditions(campaignId, committed.events, `${idempotencyKey}:promises`)
    return { ...committed, commands: resolved.commands, rolls: resolved.rolls }
  }

  async resolveTriggeredQuests(campaignId, idempotencyKey, sourceEvents = []) {
    const loaded = await this.load(campaignId)
    const triggered = (loaded.state.worldMemory?.quests ?? [])
      .filter((quest) => quest.status === 'active' && quest.clock?.triggered === true)
    if (!triggered.length) return null
    const sourceEventIds = sourceEvents
      .filter((entry) => entry.event_type === 'QuestClockAdvanced')
      .map((entry) => entry.event_id)
      .filter(Boolean)
    const commands = []
    for (const quest of triggered) {
      const resolution = questResolutionFor(quest)
      let subject = (loaded.state.worldMemory?.entities ?? []).find((entity) => quest.entity_ids?.includes(entity.id))
        ?? currentSubject(loaded.state)
      if (!subject) {
        subject = {
          id: `quest-resolution-${digest(quest.id)}`,
          kind: 'event',
          name: `Развязка: ${clean(quest.title, 160)}`,
          summary: resolution.summary,
          aliases: [],
          visibility: quest.visibility === 'gm_only' ? 'gm_only' : 'party',
          tags: ['quest-resolution'],
        }
        commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
      }
      commands.push({
        command_type: 'ResolveQuest',
        quest_id: quest.id,
        outcome: resolution.outcome,
        summary: resolution.summary,
        next_objective: resolution.nextObjective,
        source_event_ids: sourceEventIds,
      })
      commands.push({ command_type: 'RecordWorldFact', fact: {
        id: `fact-quest-resolution-${digest({ quest: quest.id, clock: quest.clock })}`,
        subject_id: subject.id,
        predicate: 'quest_outcome',
        object: resolution.outcome,
        summary: resolution.summary,
        visibility: quest.visibility === 'gm_only' ? 'gm_only' : 'party',
        source_event_ids: sourceEventIds,
      } })
      commands.push({ command_type: 'UpdateObjective', objective: resolution.nextObjective })
    }
    return this.runCommands(campaignId, `${idempotencyKey}:quest-resolution`, commands)
  }

  async completeCampaignIfReady(campaignId, idempotencyKey) {
    const loaded = await this.load(campaignId)
    if (!campaignCanAutoComplete(loaded.state)) return null
    const fallback = buildDeterministicEpilogue(loaded.state)
    let epilogue = fallback
    let provider = 'deterministic'
    if (this.narrator) {
      const rendered = await this.narrator.render(buildEpilogueNarrationBrief(loaded.state), {
        style: 'Связный русский эпилог в 3–5 предложениях: эмоциональная развязка без новых фактов и решений за героев.',
      })
      if (rendered.provider && !String(rendered.provider).startsWith('deterministic') && rendered.narration) {
        epilogue = rendered.narration
        provider = rendered.provider
      } else provider = rendered.provider ?? provider
    }
    // Стол заранее объявил, что играет цепочку арок: тот же подтверждённый
    // момент закрывает арку, а не кампанию. Эпилог уже написан — он становится
    // эпилогом арки, и его же читает следующая как «в прошлый раз».
    if (loaded.state.campaignConcept?.arc_chain === true && campaignCanAdvanceArc(loaded.state)) {
      // Хроника арки — развёрнутый рассказ летописца поверх сухого эпилога.
      // Пишется до коммита, потому что едет в payload события: replay не должен
      // зависеть от доступности провайдера. Пустая хроника легальна.
      const chronicle = this.loreAuthor
        ? await this.loreAuthor.composeArcChronicle({
          arcNumber: Number(loaded.state.campaignConcept?.arc?.arc_number) || 1,
          epilogue,
          facts: (loaded.state.worldMemory?.facts ?? []).slice(-24),
          promises: (loaded.state.social?.promises ?? []).filter((entry) => entry?.status === 'open').slice(0, 12),
        })
        : ''
      const committedArc = await this.runCommands(campaignId, `${idempotencyKey}:campaign-arc`, [{
        command_type: 'AdvanceCampaignArc',
        reason: 'arc_resolved_at_climax',
        occurred_at: new Date(this.now()).toISOString(),
        epilogue,
        ...(chronicle ? { chronicle } : {}),
        hook: nextArcHook(loaded.state),
      }])
      return { ...committedArc, epilogue_provider: provider, arc_advanced: true }
    }
    const committed = await this.runCommands(campaignId, `${idempotencyKey}:campaign-completion`, [{
      command_type: 'CompleteCampaign',
      reason: 'main_thread_resolved_at_climax',
      occurred_at: new Date(this.now()).toISOString(),
      epilogue,
    }])
    return { ...committed, epilogue_provider: provider }
  }

  async recordIntent(campaignId, intent, idempotencyKey, authorization = null) {
    const loaded = await this.load(campaignId)
    const provenance = {
      source: 'director',
      contract: 'skazanie:director-intent-v1',
      intent_type: intent.type,
      request_fingerprint: digest({ campaignId, intent }),
      recorded_at_ms: this.now(),
    }
    return this.commitEvents(campaignId, `${idempotencyKey}:intent`, [
      event(`${idempotencyKey}:intent`, 'DirectorIntentRecorded', {
        intent,
        provenance,
        policy: authorization ? {
          policy: authorization.policy,
          phase: authorization.phase,
          replaced: authorization.replaced,
          reason: authorization.reason,
          proposed_type: authorization.proposed_intent?.type,
        } : null,
      }, [], 'party'),
      event(`${idempotencyKey}:pacing`, 'CampaignPacingAdvanced', {
        ...pacingForDirectorIntent(loaded.state, intent),
        provenance: { source: 'server-pacing-policy' },
      }, [], 'party'),
    ])
  }

  async runIntent({ campaignId, intent: rawIntent, idempotencyKey }) {
    const proposed = normalizeDirectorIntent(rawIntent)
    const key = clean(idempotencyKey, 120) || `director-${digest({ campaignId, intent: proposed })}`
    const existingCompletion = await this.eventStore.getByIdempotencyKey?.(campaignId, `${key}:campaign-completion`)
    if (existingCompletion) {
      const current = await this.load(campaignId)
      const intentCommit = await this.eventStore.getByIdempotencyKey?.(campaignId, `${key}:intent`)
      const recorded = intentCommit?.events?.find((entry) => entry.event_type === 'DirectorIntentRecorded')?.payload?.intent
      return {
        intent: recorded ? normalizeDirectorIntent(recorded) : proposed,
        authorization: { policy: 'director-intent-policy-v1', reason: 'idempotent_replay', replaced: false },
        results: [existingCompletion],
        state: current.state,
        state_version: current.state_version,
        admin_commands: 0,
        duplicate: true,
      }
    }
    const existingIntentCommit = await this.eventStore.getByIdempotencyKey?.(campaignId, `${key}:intent`)
    let loaded = await this.load(campaignId)
    const existingIntent = existingIntentCommit?.events?.find((entry) => entry.event_type === 'DirectorIntentRecorded')?.payload?.intent
    const authorization = existingIntent
      ? { intent: normalizeDirectorIntent(existingIntent), proposed_intent: proposed, replaced: false, phase: loaded.state.autonomy?.pacing?.phase, policy: 'director-intent-policy-v1', reason: 'idempotent_replay' }
      : this.rulesEngine.authorizeDirectorIntent(proposed, loaded.state)
    const intent = authorization.intent
    const progressBefore = directorProgressFingerprint(loaded.state)
    await this.recordIntent(campaignId, intent, key, authorization)
    loaded = await this.load(campaignId)
    const commands = []
    const custom = []
    const setupCommands = []
    let travel = null
    let travelStartedAt = null

    if (intent.type === 'continue_exploration') {
      const cells = explorationCells(loaded.state)
      if (cells.length) commands.push({ command_type: 'RevealArea', cells })
      else commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state) })
    }
    if (intent.type === 'open_social_scene') {
      let npc = availableNpc(loaded.state, intent.npc_id)
      if (!npc) {
        npc = assembleSocialNpc(loaded.state, {
          campaignId,
          requestedId: intent.npc_id,
          idempotencyKey: key,
        })
        setupCommands.push({ command_type: 'UpsertNpcSocialProfile', npc })
      }
      if (npc) {
        custom.push(event(`${key}:social`, 'SocialSceneOpened', {
          npc_id: npc.id,
          server_check_required: true,
          provenance: { source: 'director', intent_type: intent.type },
        }, [npc.id]))
        commands.push({ command_type: 'UpdateObjective', objective: `Поговорить с ${npc.name}` })
      } else commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state, 'Найти доступного очевидца') })
    }
    if (intent.type === 'advance_quest_clock') {
      const quest = openQuest(loaded.state, intent.quest_id)
      if (quest) commands.push({ command_type: 'AdvanceQuestClock', quest_id: quest.id, amount: 1 })
      else commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state, 'Найти подтверждённую квестовую зацепку') })
    }
    if (intent.type === 'request_encounter') {
      commands.push({ command_type: 'CreateEncounter', theme: intent.theme, difficulty: intent.difficulty, seed: `${campaignId}:${key}` })
      commands.push({ command_type: 'StartCombat', server_authoritative: true })
    }
    if (intent.type === 'end_scene') {
      const arc = campaignArcPosition(loaded.state)
      const destination = intent.destination || `${loaded.state.scene?.location || 'Путь'} — следующая сцена`
      travel = planServerTravel(loaded.state, { campaignId, destination, idempotencyKey: key })
      travelStartedAt = Number(loaded.state.mechanics?.world_time?.elapsed_minutes) || 0
      const decisionId = `autonomy-${digest(key)}`
      const partyIds = (loaded.state.partyMemberIds?.length
        ? loaded.state.partyMemberIds
        : loaded.state.players?.map((player) => player.id) ?? []).map(String)
      // Голосовать за переход должен живой герой: погибший остаётся в списке
      // отряда, пока его не воскресят или не заменят.
      const preferred = String(loaded.state.activePlayerId ?? '')
      const actorId = preferred && !isUnresolvedDeadHero(loaded.state, preferred) ? preferred : lootOwnerId(loaded.state)
      custom.push(partyDecisionOpenedEvent({
        id: decisionId,
        type: 'choice',
        title: 'Продолжить путь',
        description: `Отряд подтверждает переход в ${destination}.`,
        options: [{ id: 'continue', label: `Перейти в ${destination}` }],
        resolutionPrompt: 'Продолжить подтверждённый переход.',
      }, actorId || null, { eligibleHeroIds: partyIds }))
      custom.push({
        ...event(`${key}:decision-resolved`, 'PartyDecisionResolved', {
          interaction_id: decisionId,
          resolved_option_id: 'continue',
          votes: actorId ? { [actorId]: 'continue' } : {},
          eligible_hero_ids: partyIds,
          required_votes: 1,
        }, partyIds),
        actor_id: actorId || null,
      })
      const mainQuest = arc
        ? (loaded.state.worldMemory?.quests ?? []).find((quest) => (
            !String(quest.id || '').startsWith('quest:chapter:')
            && quest.status === 'active'
            && quest.clock?.triggered !== true
          ))
        : null
      if (mainQuest) commands.push({ command_type: 'AdvanceQuestClock', quest_id: mainQuest.id, amount: 1 })
      commands.push({ command_type: 'AdvanceScene', scene_args: {
        title: destination,
        location: destination,
        objective: nextHook(loaded.state),
        transition: `Завершив текущую сцену, отряд направляется в ${destination}.`,
        hook: nextHook(loaded.state),
        seed: `${campaignId}:${key}:scene`,
      }, party_decision: { interaction_id: decisionId, resolved_option_id: 'continue' } })
      commands.unshift({ command_type: 'AdvanceTime', amount: travel.duration_minutes, unit: 'minute' })
      if (travel.random_encounter) {
        commands.push({
          command_type: 'CreateEncounter',
          theme: travel.encounter.theme,
          difficulty: travel.encounter.difficulty,
          seed: `${campaignId}:${travel.travel_id}:random-encounter`,
        })
        commands.push({ command_type: 'StartCombat', server_authoritative: true })
      }
    }
    if (intent.type === 'offer_next_hook') commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state, intent.hook) })

    const results = []
    if (setupCommands.length) results.push(await this.runCommands(campaignId, `${key}:setup`, setupCommands))
    if (custom.length) results.push(await this.commitEvents(campaignId, `${key}:custom`, custom))
    if (commands.length) results.push(await this.runCommands(campaignId, `${key}:commands`, commands))
    const questResolution = await this.resolveTriggeredQuests(
      campaignId,
      key,
      results.flatMap((result) => result.events ?? []),
    )
    if (questResolution) results.push(questResolution)
    if (travel) {
      const afterTravel = await this.load(campaignId)
      const scheduled = await this.executeNpcSchedules(campaignId, {
        start: travelStartedAt,
        end: Number(afterTravel.state.mechanics?.world_time?.elapsed_minutes) || travelStartedAt,
        idempotencyKey: `${key}:travel-schedules`,
        sourceEventIds: results.flatMap((result) => result.events ?? []).map((entry) => entry.event_id).filter(Boolean),
      })
      if (scheduled.result) results.push(scheduled.result)
      const travelEvents = [event(`${key}:travel`, 'TravelResolved', {
        ...travel,
        provenance: { source: 'server-travel-policy' },
      }, loaded.state.partyMemberIds ?? [])]
      if (travel.random_encounter) travelEvents.push(event(`${key}:random-encounter`, 'RandomEncounterTriggered', {
        travel_id: travel.travel_id,
        theme: travel.encounter.theme,
        difficulty: travel.encounter.difficulty,
        risk_score: travel.risk_score,
        provenance: { source: 'server-travel-policy' },
      }, loaded.state.partyMemberIds ?? []))
      results.push(await this.commitEvents(campaignId, `${key}:travel`, travelEvents))
    }
    loaded = await this.load(campaignId)
    if (!clean(loaded.state.scene?.objective, 300)) {
      results.push(await this.runCommands(campaignId, `${key}:failsafe-hook`, [{ command_type: 'UpdateObjective', objective: nextHook(loaded.state) }]))
      loaded = await this.load(campaignId)
    }
    const progressAfter = directorProgressFingerprint(loaded.state)
    const outcome = await this.commitEvents(campaignId, `${key}:director-outcome`, [
      event(`${key}:director-outcome`, 'DirectorIntentOutcomeRecorded', {
        intent_type: intent.type,
        state_changed: progressBefore !== progressAfter,
        progress_before: progressBefore,
        progress_after: progressAfter,
        policy: 'director-anti-stall-v1',
      }, [], 'party'),
    ])
    results.push(outcome)
    const completion = await this.completeCampaignIfReady(campaignId, key)
    if (completion) results.push(completion)
    loaded = await this.load(campaignId)
    return { intent, authorization, results, state: loaded.state, state_version: loaded.state_version, admin_commands: 0 }
  }

  async handleUnknownAction({ campaignId, action, idempotencyKey, playerId = '', intent = null, manualRoll = false, verifiedRoll = null }) {
    const text = clean(action, 1_000)
    const loaded = await this.load(campaignId)
    const actorId = clean(playerId, 120)
    const declaration = declaredActionCommand(actorId, text)
    const run = async (commands) => {
      const actualCommands = commands.filter(Boolean)
      if (!actualCommands.length) return { state: loaded.state, state_version: loaded.state_version, events: [], commands: [], rolls: [], duplicate: false }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await this.runCommands(campaignId, idempotencyKey, actualCommands, { allowedActorIds: [actorId] })
        } catch (error) {
          if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
        }
      }
      throw new Error('Свободное действие не удалось сохранить')
    }
    const verifyDuplicate = (commit, { requiresRuling = false } = {}) => {
      if (!commit?.duplicate) return
      const declared = (commit.events ?? []).find((event) => event.event_type === 'ActionDeclared')
      if (declared && String(declared.payload?.action ?? '') !== text) {
        const error = new Error('Этот ключ идемпотентности уже использован для другого свободного действия')
        error.code = 'IDEMPOTENCY_CONFLICT'
        throw error
      }
      const rulingEvent = (commit.events ?? []).find((event) => event.event_type === 'RulingRecorded')
      if (requiresRuling && (!rulingEvent || String(rulingEvent.payload?.ruling?.provenance?.action_fingerprint ?? '') !== digest(text))) {
        const error = new Error('Этот ключ идемпотентности уже использован для другого свободного действия')
        error.code = 'IDEMPOTENCY_CONFLICT'
        throw error
      }
    }
    const currentActorId = String(loaded.state.mechanics?.combat?.initiative?.[loaded.state.mechanics?.combat?.active_index]?.actor_id ?? '')
    if (loaded.state.mechanics?.combat?.active && currentActorId && currentActorId !== actorId) {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'rejected',
        narration: 'Сейчас действует другой участник. Действие не выполнено, и ваш ход не потрачен.',
        turn_consumed: false,
        rejected: true,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }
    const freeActionKind = intent?.free_action_kind ?? classifyFreeActionKind(text)
    if (text.length < 8 || isNoise(text) || /^(?:это|туда|сделать|что-то|как-нибудь)[?.!]*$/iu.test(text)) {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'clarification',
        narration: 'Опишите действие подробнее: что делает герой, с чем или с кем и какого результата хочет добиться.',
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }
    if (freeActionKind === 'physically_impossible') {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'clarification',
        narration: 'Для такого действия нужен подтверждённый способ — конкретное заклинание, предмет или способность героя. Укажите его, и я проверю допустимый вариант.',
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }
    // Частая фраза про уже существующий реквизит не должна превращаться во
    // второй, приблизительный путь импровизации. Текст выбирает только объект,
    // глагол и способ; дальность, состояние, СЛ, бросок, награда и последствия
    // снова проверяет та же OperateSceneObject, которой пользуются кнопки.
    const sceneProps = Array.isArray(loaded.state.scene?.map?.props) ? loaded.state.scene.map.props : []
    // Позиция берётся тем же `actorPosition`, которым движок проверяет
    // досягаемость: `mechanics.positions` с фолбэком на лист. Лист остаётся той
    // клеткой, с которой герой начал бой, и «ближайший» по нему выбирал не тот
    // сундук из двух — а иногда объявлял недосягаемым тот, что под рукой.
    const sceneActorPosition = actorPosition(loaded.state, actorId)
    // Раскрытие спрашивается по авторитетной карте — тем же предикатом, что
    // вырезает нераскрытые пропсы из брифа арбитра. Иначе фраза «осмотреть
    // сундук» работала бы оракулом по неразведанной части подземелья: игрок
    // называл бы предметы, которых на его карте ещё нет, и узнавал, есть ли они.
    const revealedProp = revealedPropPredicate(loaded.state)
    const namedSceneObject = nearestSceneObjectCommand({ props: sceneProps, actorPosition: sceneActorPosition, text })
    const sceneObjectCommand = namedSceneObject
      ? nearestSceneObjectCommand({
          props: sceneProps.filter((prop) => revealedProp(prop)),
          actorPosition: sceneActorPosition,
          text,
        })
      : null
    // Предмет на карте есть, но отряд его ещё не видел. Это не выдумка игрока и
    // не путь в импровизацию: честный ответ — «отсюда такого не видно», ход при
    // герое, событий нет.
    if (namedSceneObject && !sceneObjectCommand) {
      return {
        kind: 'clarification',
        narration: 'Отсюда такого не видно. Подойдите ближе или осмотритесь: на вашей карте этого места ещё нет.',
        turn_consumed: false,
        admin_commands: 0,
        state: loaded.state,
        state_version: loaded.state_version,
        events: [],
        commands: [],
        rolls: [],
        duplicate: false,
      }
    }
    if (sceneObjectCommand) {
      try {
        const commit = await run([
          declaration,
          {
            ...sceneObjectCommand,
            actor_id: actorId,
            server_authoritative: true,
          },
        ])
        verifyDuplicate(commit)
        const interactionEvents = commit.events ?? []
        return {
          kind: 'scene_interaction',
          narration: sceneInteractionNarration(interactionEvents)
            || 'Герой взаимодействует с объектом сцены; результат подтверждён правилами.',
          turn_consumed: interactionEvents.some((event) => (
            event.event_type === 'SceneObjectOperated' && event.payload?.action_spent === true
          )),
          admin_commands: 0,
          state: commit.state ?? loaded.state,
          state_version: commit.state_version ?? loaded.state_version,
          events: interactionEvents,
          commands: commit.commands ?? [],
          rolls: commit.rolls ?? [],
          duplicate: Boolean(commit.duplicate),
        }
      } catch (error) {
        if (!(error instanceof RulesValidationError)) throw error
        // Предмет выбирает текст игрока, а досягаемость и состояние проверяет
        // движок. «Осмотреть кровать в дальнем углу» называет настоящий пропс,
        // до которого не дотянуться, — это ответ правил игроку, а не ошибка
        // запроса. Без этой ветки SCENE_OBJECT_OUT_OF_REACH уезжал наружу
        // как HTTP 400 и обрывал ход.
        return {
          kind: 'clarification',
          narration: `${error.message}.`,
          turn_consumed: false,
          admin_commands: 0,
          state: loaded.state,
          state_version: loaded.state_version,
          events: [],
          commands: [],
          rolls: [],
          duplicate: false,
        }
      }
    }
    // Судейство как у живого ведущего: понять намерение, сверить средства, выбрать режим
    // разрешения, объявить ставки и дать непустое последствие даже при провале.
    // Смысл задумки понимает агент, если он есть; всё остальное — СЛ, бросок,
    // сверка средств, цена хода и последствие — остаётся за сервером.
    const deterministicReading = interpretFreeAction(text)
    // Вторая фаза ручного броска: прочтение действия зафиксировано вместе с
    // проверкой в реестре бросков. Повторный вызов модели дал бы другой навык
    // или СЛ — не те, что игроку показали перед броском.
    const storedReading = verifiedRoll?.context?.kind === 'free_action'
      && String(verifiedRoll.context.action_fingerprint ?? '') === digest(text)
      ? verifiedRoll.context.reading ?? null
      : null
    const proposedReading = storedReading
      ?? (this.actionAdjudicator
        ? await this.actionAdjudicator.read(loaded.state, actorId, text, deterministicReading)
        : deterministicReading)
    const reading = bindFreeActionReadingToState(loaded.state, actorId, text, proposedReading)
    if (reading.reference_ambiguities.length) {
      return {
        kind: 'clarification',
        narration: reading.reference_ambiguities.includes('item_id')
          ? 'В действии подходят несколько предметов. Назовите конкретную вещь.'
          : 'В действии подходят несколько целей. Назовите конкретного участника.',
        turn_consumed: false,
        admin_commands: 0,
        state: loaded.state,
        state_version: loaded.state_version,
        events: [],
        commands: [],
        rolls: [],
        duplicate: false,
      }
    }
    // Мост между свободной фразой и обстановкой как оружием (задача 3.2c).
    // Арбитр называет предмет из переданного ему списка и глагол; всё
    // остальное — досягаемость, проверка, источник огня, урон, зона огня и цена
    // действия — считает та же `OperateSceneObject`, которой пользуются кнопки
    // пропса. Второго пути импровизации здесь не заводится: это маршрут, а не
    // ещё один движок.
    const scenePropIntent = scenePropIntentFor(reading.effect)
    if (scenePropIntent && reading.prop_id) {
      try {
        const commit = await run([
          declaration,
          {
            command_type: 'OperateSceneObject',
            actor_id: actorId,
            prop_id: reading.prop_id,
            intent: scenePropIntent,
            approach: 'hand',
            server_authoritative: true,
          },
        ])
        verifyDuplicate(commit)
        const hazardEvents = commit.events ?? []
        const hazardState = commit.state ?? loaded.state
        return {
          kind: 'scene_interaction',
          narration: sceneHazardNarration(hazardEvents, hazardState)
            || sceneInteractionNarration(hazardEvents)
            || 'Герой обращает обстановку против противника; результат подтверждён правилами.',
          turn_consumed: hazardEvents.some((event) => (
            event.event_type === 'SceneObjectOperated' && event.payload?.action_spent === true
          )),
          admin_commands: 0,
          state: hazardState,
          state_version: commit.state_version ?? loaded.state_version,
          events: hazardEvents,
          commands: commit.commands ?? [],
          rolls: commit.rolls ?? [],
          duplicate: Boolean(commit.duplicate),
        }
      } catch (error) {
        if (!(error instanceof RulesValidationError)) throw error
        // «Нечем поджечь», «встаньте вплотную», «уже горит» — это честный ответ
        // игроку от правил, а не ошибка запроса. Ход не тратится, событий не
        // остаётся: коммит атомарен и целиком откатился.
        return {
          kind: 'clarification',
          narration: `${error.message}.`,
          turn_consumed: false,
          admin_commands: 0,
          state: loaded.state,
          state_version: loaded.state_version,
          events: [],
          commands: [],
          rolls: [],
          duplicate: false,
        }
      }
    }
    const corpseSearch = resolveCorpseSearch(loaded.state, text, reading)
    if (corpseSearch) {
      return {
        kind: 'clarification',
        narration: corpseSearch.narration,
        turn_consumed: false,
        admin_commands: 0,
        state: loaded.state,
        state_version: loaded.state_version,
        events: [],
        commands: [],
        rolls: [],
        duplicate: false,
      }
    }
    const inventoryTransfer = resolveInventoryTransfer(loaded.state, actorId, text, reading)
    if (inventoryTransfer?.status === 'clarification') {
      return {
        kind: 'clarification',
        narration: inventoryTransfer.narration,
        turn_consumed: false,
        admin_commands: 0,
        state: loaded.state,
        state_version: loaded.state_version,
        events: [],
        commands: [],
        rolls: [],
        duplicate: false,
      }
    }
    if (inventoryTransfer?.status === 'command') {
      const commit = await run([declaration, inventoryTransfer.command])
      verifyDuplicate(commit)
      return {
        kind: 'item_transfer',
        narration: inventoryTransfer.narration,
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }
    const means = verifyMeans(loaded.state, actorId, reading.required_means)
    const resolution = means.satisfied
      ? contextualResolutionFor(loaded.state, actorId, reading, text)
      : contextualResolutionFor(loaded.state, actorId, { ...reading, plausibility: 'impossible_without_means' }, text)
    const attempt = attemptFingerprint({ actorId, approach: reading.approach_summary, obstacle: reading.obstacle })
    const repeated = previousFailedAttempt(loaded.state, attempt)
    const objective = boundedObjective(loaded.state, text)

    // Тот же подход к тому же препятствию в неизменившейся обстановке нового броска не даёт.
    if (repeated) {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'clarification',
        narration: `Этот способ уже не сработал, и обстановка с тех пор не изменилась. Нужен другой подход к препятствию «${reading.obstacle}».`,
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }

    // Встречное предложение вместо отказа: «нет, но» — принцип «никаких невидимых стен».
    if (resolution.mode === 'counter_offer') {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'counter_offer',
        narration: `Без подтверждённого средства так не выйдет: не хватает ${means.missing.join(', ')}. Но препятствие «${reading.obstacle}» можно взять проверкой — опишите, как герой к нему подступится.`,
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }

    const stakes = stakesFor({
      ability: reading.ability,
      skill: reading.skill,
      resolution,
      risk: reading.risk,
      proficiency: reading.proficiency,
      consequence_type: reading.consequence_type,
    })
    const ruling = {
      id: `ruling-${digest({ campaignId, text })}`,
      status: 'applied',
      scope: 'single-action',
      question: text,
      bounded_options: ['auto-success', 'ability-check', 'counter-offer'],
      selected_option: resolution.mode === 'auto_success' ? 'auto-success' : 'ability-check',
      consequence: objective,
      world_change: true,
      stakes,
      interpretation: {
        target_id: reading.target_id || null,
        item_id: reading.item_id || null,
        skill: reading.skill,
        proficiency: reading.proficiency,
        consequence_type: reading.consequence_type,
      },
      provenance: {
        source: 'free-action-adjudication',
        action_fingerprint: digest(text),
        attempt_fingerprint: attempt,
        situation_fingerprint: situationFingerprint(loaded.state),
        policy: 'free-action-adjudication-v1',
      },
    }

    // Автоуспех — тоже событие: replay обязан его воспроизводить.
    if (resolution.mode === 'auto_success') {
      const commit = await run([
        declaration,
        { command_type: 'RecordRuling', ruling: { ...ruling, outcome: 'success' }, ruling_id: ruling.id },
        { command_type: 'UpdateObjective', objective },
      ])
      verifyDuplicate(commit, { requiresRuling: true })
      return {
        kind: 'auto_success',
        ruling,
        narration: `Это удаётся без броска — на кону ничего нет. Следующая цель отряда: «${objective}»`,
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }

    // В бою импровизация платит слотом хода. Проверка стоит до броска: занятый
    // слот — это отказ, а не потраченный впустую кубик.
    const inCombat = Boolean(loaded.state.mechanics?.combat?.active)
    const actionCost = inCombat ? resolveActionCost(loaded.state, actorId, reading.action_cost) : { cost: 'free', available: true }
    if (inCombat && !actionCost.available) {
      const commit = await run([declaration])
      verifyDuplicate(commit)
      return {
        kind: 'clarification',
        narration: `На этом ходу ${actionCost.slot} уже потрачено. Импровизация обойдётся в него же — попробуйте на следующем ходу или опишите что-то, что укладывается в оставшееся.`,
        turn_consumed: false,
        admin_commands: 0,
        state: commit.state ?? loaded.state,
        state_version: commit.state_version ?? loaded.state_version,
        events: commit.events ?? [],
        commands: commit.commands ?? [],
        rolls: commit.rolls ?? [],
        duplicate: Boolean(commit.duplicate),
      }
    }

    // Ручной бросок: проверка объявляется, но кубик остаётся за игроком.
    // Сервер регистрирует её в реестре бросков и ничего не коммитит; ход
    // завершится вторым запросом с roll_id, выданным `/api/roll`. Прочтение
    // действия едет в контексте проверки, чтобы вторая фаза не спрашивала
    // модель заново и игрок бросал ровно то, что ему объявили.
    if (manualRoll && !verifiedRoll && this.rollRegistry) {
      const preview = previewD20Check(loaded.state, {
        actorId, kind: 'check', ability: reading.ability, skill: reading.skill, difficulty: resolution.difficulty,
      })
      const check = this.rollRegistry.registerCheck({
        campaignId,
        actorId,
        label: d20CheckLabel({ kind: 'check', ability: preview.ability, skill: preview.skill }),
        modifier: preview.modifier,
        difficulty: preview.difficulty,
        ability: preview.ability,
        advantage: preview.advantage,
        disadvantage: preview.disadvantage,
        context: { kind: 'free_action', action_fingerprint: digest(text), reading },
      })
      return {
        kind: 'check_required',
        check: { ...check, sides: 20, skill: preview.skill },
        stakes,
        narration: `Требуется проверка: ${check.label}, СЛ ${check.difficulty}. Бросьте d20, чтобы узнать исход.`,
        turn_consumed: false,
        admin_commands: 0,
        state: loaded.state,
        state_version: loaded.state_version,
        events: [],
        commands: [],
        rolls: [],
        duplicate: false,
      }
    }
    // Бросок, который игрок уже сделал через реестр, передаётся движку как
    // выпавшие кости; математику и итог движок пересчитывает сам.
    const { context: _checkContext, ...verifiedRollPayload } = verifiedRoll ?? {}
    // Проверка: бросок делает движок своим Dice Service, число СЛ выбрал сервер.
    const checkCommit = await run([
      declaration,
      // Провенанс обязателен для любого механического решения: импровизация
      // опирается на то же самое судейское решение, что записывается ниже.
      ...(inCombat ? [{
        command_type: 'ResolveImprovisedAction',
        actor_id: actorId,
        action_cost: actionCost.cost,
        summary: reading.goal_summary,
        ruling_id: ruling.id,
      }] : []),
      {
        command_type: 'MakeAbilityCheck',
        actor_id: actorId,
        ability: reading.ability,
        skill: reading.skill,
        difficulty: resolution.difficulty,
        difficulty_category: resolution.difficulty_category,
        ...(verifiedRoll ? { verified_roll: verifiedRollPayload } : {}),
      },
    ])
    verifyDuplicate(checkCommit)
    const checkEvent = (checkCommit.events ?? []).find((entry) => entry.event_type === 'AbilityCheckResolved')
    const succeeded = checkEvent?.payload?.success === true
    const consequence = failForwardFor(reading.risk, reading.consequence_type)
    const outcomeRuling = { ...ruling, outcome: succeeded ? 'success' : 'failure' }
    // Внутри раунда время не идёт и цель отряда не переписывается: ход занимает
    // секунды, а «следующая цель» посреди боя ломала бы сцену.
    const effectPlan = succeeded && inCombat
      ? planImprovisedEffect(checkCommit.state ?? loaded.state, {
        actorId, effectId: reading.effect, targetId: reading.effect_target, hazardId: reading.hazard, risk: reading.risk,
      })
      : null
    const followUp = [
      { command_type: 'RecordRuling', ruling: outcomeRuling, ruling_id: ruling.id },
      ...(effectPlan?.commands ?? []),
      ...materialConsequenceCommands(loaded.state, { succeeded, reading, checkEvent }),
      ...(inCombat ? [] : [
        { command_type: 'AdvanceTime', amount: succeeded ? 5 : consequence.minutes, unit: 'minute' },
        { command_type: 'UpdateObjective', objective },
      ]),
    ]
    if (!succeeded && !inCombat && consequence.advances_quest_clock) {
      const quest = openQuest(loaded.state)
      if (quest) followUp.push({ command_type: 'AdvanceQuestClock', quest_id: quest.id, amount: 1 })
    }
    let consequenceCommit = null
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      try {
        consequenceCommit = await this.runCommands(campaignId, `${idempotencyKey}:consequence`, followUp)
        break
      } catch (error) {
        if (error?.code !== 'STATE_VERSION_CONFLICT' || attemptIndex === 2) throw error
      }
    }
    const events = [...(checkCommit.events ?? []), ...(consequenceCommit?.events ?? [])]
    return {
      kind: succeeded ? 'check_success' : 'check_failure',
      ruling: outcomeRuling,
      stakes,
      narration: inCombat
        ? succeeded
          ? `Проверка пройдена. ${effectPlan?.summary ?? ''}`.trim()
          : `Не вышло: задумка сорвалась, и ${actionCost.slot} потрачено впустую.`
        : succeeded
          ? `Проверка пройдена. Следующая цель отряда: «${objective}»`
          : `Не вышло. ${consequence.summary} Следующая цель отряда: «${objective}»`,
      turn_consumed: false,
      admin_commands: 0,
      state: consequenceCommit?.state ?? checkCommit.state ?? loaded.state,
      state_version: consequenceCommit?.state_version ?? checkCommit.state_version ?? loaded.state_version,
      events,
      commands: [...(checkCommit.commands ?? []), ...(consequenceCommit?.commands ?? [])],
      rolls: [...(checkCommit.rolls ?? []), ...(consequenceCommit?.rolls ?? [])],
      duplicate: Boolean(checkCommit.duplicate),
    }
  }

  async runCombat(campaignId, { idempotencyPrefix = 'autocombat', maxTurns = 200 } = {}) {
    const turns = []
    for (let iteration = 0; iteration < maxTurns; iteration += 1) {
      const loaded = await this.load(campaignId)
      const state = loaded.state
      const combat = state.mechanics.combat
      if (!combat.active) return { turns, state, state_version: loaded.state_version }
      const actorId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
      const actor = findActor(state, actorId)
      const livingEnemies = state.enemies.filter(isLivingActor)
      const livingHeroes = state.players.filter(isLivingActor)
      let commands
      let heroRule = null
      if (combat.reaction_window) {
        commands = [{
          command_type: 'UseCombatAction',
          actor_id: String(combat.reaction_window.actor_id),
          action_id: 'decline-reaction',
          server_authoritative: true,
        }]
      } else if (!livingEnemies.length || !livingHeroes.length) {
        commands = [{ command_type: 'EndCombat', actor_id: actorId || livingHeroes[0]?.id || livingEnemies[0]?.id, reason: livingEnemies.length ? 'party_defeated' : 'enemies_defeated' }]
      } else if (!isLivingActor(actor)) {
        commands = [{ command_type: 'EndTurn', actor_id: actorId }]
      } else if (isEnemyActor(state, actorId)) {
        commands = planNpcTurn(state, actorId)
      } else {
        // Тактика героя — отдельная серверная политика (`party-tactics.mjs`),
        // а не лестница условий внутри цикла боя: её нужно проверять тестом
        // отдельно от оркестрации.
        const plan = planHeroTurn(state, actorId)
        commands = plan.commands
        heroRule = plan.rule
      }
      const key = `${idempotencyPrefix}:${iteration + 1}:v${loaded.state_version}`
      const committed = await this.runCommands(campaignId, key, commands, { isNpcScheduler: isEnemyActor(state, actorId) })
      turns.push({
        actor_id: actorId,
        commands: commands.map((command) => command.command_type),
        events: committed.events.map((entry) => entry.event_type),
        ...(heroRule ? { tactic: heroRule } : {}),
      })
    }
    throw new Error(`Autonomous combat exceeded ${maxTurns} turns`)
  }

  async completeEncounter({ campaignId, outcome = 'enemies_defeated', idempotencyKey = 'encounter-completion' }) {
    const loaded = await this.load(campaignId)
    const encounterId = String(loaded.state.mechanics?.encounter?.id ?? loaded.state.mechanics?.encounter?.encounter_id ?? '')
    if (!encounterId) throw new Error('Encounter completion requires an active encounter record')
    const lockKey = `${campaignId}\u0000${encounterId}`
    const previous = encounterCompletionLocks.get(lockKey)
    if (previous) {
      await previous
      return this.completeEncounterUnlocked({ campaignId, outcome, idempotencyKey })
    }
    const operation = this.completeEncounterUnlocked({ campaignId, outcome, idempotencyKey })
    encounterCompletionLocks.set(lockKey, operation)
    try {
      return await operation
    } finally {
      if (encounterCompletionLocks.get(lockKey) === operation) encounterCompletionLocks.delete(lockKey)
    }
  }

  async completeEncounterUnlocked({ campaignId, outcome = 'enemies_defeated' }) {
    let loaded = await this.load(campaignId)
    const encounterId = String(loaded.state.mechanics?.encounter?.id ?? loaded.state.mechanics?.encounter?.encounter_id ?? '')
    const baseKey = `encounter-completion:${encounterId}`
    if (loaded.state.mechanics.combat.active) {
      const activeId = String(loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index]?.actor_id ?? loaded.state.players[0]?.id ?? '')
      await this.runCommands(campaignId, `${baseKey}:end-combat`, [{ command_type: 'EndCombat', actor_id: activeId, reason: outcome }])
      loaded = await this.load(campaignId)
    }

    const outcomeKey = encounterCompletionStageKey(encounterId, 'outcome')
    const transitionKey = encounterCompletionStageKey(encounterId, 'transition')
    let outcomeCommit = await this.eventStore.getByIdempotencyKey?.(campaignId, outcomeKey)
    let plan
    let prepared
    if (outcomeCommit) {
      const outcomeEvent = outcomeCommit.events.find((entry) => entry.event_type === 'EncounterOutcomeRecorded')
      plan = frozenEncounterOutcomePlanFromEvent(outcomeEvent)
      prepared = clone(outcomeEvent.payload?.prepared_reward)
      if (!prepared?.coins || !Array.isArray(prepared?.loot) || !prepared?.distribution) {
        throw new Error('Frozen encounter reward preparation is missing')
      }
      const finalized = await this.eventStore.getByIdempotencyKey?.(campaignId, transitionKey)
      if (finalized) {
        const final = await this.load(campaignId)
        return {
          events: [],
          reward: encounterRewardResponse({ plan, ...prepared }),
          state: final.state,
          state_version: final.state_version,
          admin_commands: 0,
          duplicate: true,
        }
      }
    } else {
      plan = freezeEncounterOutcomePlan(loaded.state, outcome)
      const coins = rollEncounterCoins(plan, this.rulesEngine.diceService)
      const loot = lootForEncounterOutcome(plan)
      const distribution = distributeEncounterRewards(loaded.state, { plan, coins, loot })
      prepared = { coins, loot, distribution }
      const outcomeEvent = event(outcomeKey, 'EncounterOutcomeRecorded', {
        encounter_id: plan.encounter_id,
        outcome: plan.outcome,
        plan,
        prepared_reward: prepared,
        provenance: { source: 'server-reward-policy', policy: ENCOUNTER_REWARD_POLICY_ID },
      })
      outcomeCommit = await this.commitEventsWithRetry(campaignId, outcomeKey, [outcomeEvent])
    }
    const committedOutcomeEvent = outcomeCommit.events.find((entry) => entry.event_type === 'EncounterOutcomeRecorded')
    plan = frozenEncounterOutcomePlanFromEvent(committedOutcomeEvent)
    prepared = clone(committedOutcomeEvent.payload?.prepared_reward)
    if (!prepared?.coins || !Array.isArray(prepared?.loot) || !prepared?.distribution) {
      throw new Error('Committed frozen encounter reward preparation is missing')
    }

    const emitted = []
    const collect = (commit) => {
      if (commit && !commit.duplicate) emitted.push(...(commit.events ?? []))
      return commit
    }
    collect(outcomeCommit)

    const xpKey = encounterCompletionStageKey(encounterId, 'xp')
    const xpEvent = plan.rewards_eligible
      ? event(xpKey, 'ExperienceAwarded', {
          encounter_id: plan.encounter_id,
          total_xp: plan.total_xp,
          recipients: plan.recipients,
          unassigned_xp: plan.recipients.length ? 0 : plan.total_xp,
          plan_version: plan.version,
          provenance: { source: 'server-reward-policy', policy: ENCOUNTER_REWARD_POLICY_ID },
        }, plan.recipients)
      : event(xpKey, 'EncounterRewardStageSkipped', {
          encounter_id: plan.encounter_id,
          stage: 'xp',
          reason: 'outcome-not-rewardable',
        })
    collect(await this.commitEventsWithRetry(campaignId, xpKey, [xpEvent], {
      validateState: plan.rewards_eligible
        ? (state) => assertEncounterRewardRecipients(state, plan.recipients)
        : null,
    }))

    const coinsKey = encounterCompletionStageKey(encounterId, 'coins')
    const coinsEvent = plan.rewards_eligible
      ? {
          ...event(coinsKey, 'EncounterCoinsRolled', {
            schema_version: 1,
            ...prepared.coins,
            provenance: { source: 'server-coin-policy', policy: ENCOUNTER_COINS_POLICY_ID },
          }),
          event_schema_version: 1,
        }
      : event(coinsKey, 'EncounterRewardStageSkipped', {
          encounter_id: plan.encounter_id,
          stage: 'coins',
          reason: 'outcome-not-rewardable',
        })
    collect(await this.commitEventsWithRetry(campaignId, coinsKey, [coinsEvent]))

    const lootKey = encounterCompletionStageKey(encounterId, 'loot')
    const lootEvent = plan.rewards_eligible
      ? {
          ...event(lootKey, 'ServerLootGenerated', {
            schema_version: SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION,
            encounter_id: plan.encounter_id,
            loot: prepared.loot,
            provenance: { source: 'server-loot-table', policy: ENCOUNTER_LOOT_POLICY_ID },
          }),
          event_schema_version: SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION,
        }
      : event(lootKey, 'EncounterRewardStageSkipped', {
          encounter_id: plan.encounter_id,
          stage: 'loot',
          reason: 'outcome-not-rewardable',
        })
    collect(await this.commitEventsWithRetry(campaignId, lootKey, [lootEvent]))

    const distributionKey = encounterCompletionStageKey(encounterId, 'distribution')
    const distributionEvent = plan.rewards_eligible
      ? {
          ...event(distributionKey, 'EncounterRewardsDistributed', prepared.distribution, plan.recipients),
          event_schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
        }
      : event(distributionKey, 'EncounterRewardStageSkipped', {
          encounter_id: plan.encounter_id,
          stage: 'distribution',
          reason: 'outcome-not-rewardable',
        })
    collect(await this.commitEventsWithRetry(campaignId, distributionKey, [distributionEvent], {
      validateState: plan.rewards_eligible
        ? (state) => assertEncounterDistributionPreconditions(state, prepared.distribution)
        : null,
    }))

    loaded = await this.load(campaignId)
    const commands = []
    const quest = openQuest(loaded.state)
    if (quest) commands.push({ command_type: 'AdvanceQuestClock', quest_id: quest.id, amount: 1 })
    let subject = currentSubject(loaded.state)
    if (!subject) {
      subject = { id: `location-${digest(loaded.state.scene?.location || campaignId)}`, kind: 'location', name: loaded.state.scene?.location || 'Текущая сцена', summary: '', aliases: [], visibility: 'party', tags: [] }
      commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
    }
    commands.push({ command_type: 'RecordWorldFact', fact: {
      id: `fact-${plan.encounter_id || digest(baseKey)}-outcome`,
      subject_id: subject.id,
      predicate: 'encounter_outcome',
      object: plan.outcome,
      summary: `Встреча завершилась исходом: ${plan.outcome}.`,
      visibility: 'party',
      source_event_ids: outcomeCommit.events.map((entry) => entry.event_id).filter(Boolean),
    } })
    commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state) })
    const consequences = await this.runCommands(campaignId, `${baseKey}:consequences`, commands)
    if (!consequences.duplicate) emitted.push(...(consequences.events ?? []))
    const questResolution = await this.resolveTriggeredQuests(
      campaignId,
      baseKey,
      consequences.events ?? [],
    )
    if (questResolution && !questResolution.duplicate) emitted.push(...(questResolution.events ?? []))

    if (plan.outcome === 'enemies_defeated') {
      let afterConsequences = await this.load(campaignId)
      const survivors = (state) => {
        const partyIds = new Set((state.partyMemberIds ?? []).map(String))
        return (state.players ?? []).filter((hero) => (
          partyIds.has(String(hero.id)) && state.mechanics?.death?.heroes?.[hero.id]?.status !== 'dead'
        ))
      }
      const stableRecoveryKey = `${baseKey}:stable-recovery`
      const existingStableRecovery = await this.eventStore.getByIdempotencyKey?.(campaignId, stableRecoveryKey)
      let stableRecoveryMinutes = existingStableRecovery ? STABLE_RECOVERY_MINUTES : 0
      if (!existingStableRecovery && survivors(afterConsequences.state).some((hero) => Number(hero.hp) === 0)) {
        stableRecoveryMinutes = STABLE_RECOVERY_MINUTES
        const stableRecovery = await this.runCommands(campaignId, stableRecoveryKey, [
          { command_type: 'AdvanceTime', amount: stableRecoveryMinutes, unit: 'minute' },
        ])
        if (!stableRecovery.duplicate) emitted.push(...(stableRecovery.events ?? []))
        afterConsequences = await this.load(campaignId)
      }
      const restingHeroes = survivors(afterConsequences.state).filter((hero) => Number(hero.hp) > 0)
      if (restingHeroes.length) {
        const downtime = completedDowntime(afterConsequences.state, {
          kind: 'long_rest',
          durationMinutes: 480 + stableRecoveryMinutes,
          reason: stableRecoveryMinutes ? 'post_encounter_recovery_after_stabilisation' : 'post_encounter_recovery',
        })
        const recoveryCommands = [
          ...restingHeroes.map((hero) => ({ command_type: 'StartRest', actor_id: String(hero.id), kind: 'long' })),
          { command_type: 'AdvanceTime', amount: 480, unit: 'minute' },
          ...restingHeroes.map((hero) => ({ command_type: 'CompleteRest', actor_id: String(hero.id), kind: 'long' })),
        ]
        const recovery = await this.runCommands(campaignId, `${baseKey}:recovery`, recoveryCommands)
        if (!recovery.duplicate) emitted.push(...(recovery.events ?? []))
        const downtimeKey = `${baseKey}:downtime`
        const downtimeCommit = await this.commitEventsWithRetry(campaignId, downtimeKey, [
          event(downtimeKey, 'DowntimeResolved', {
            ...downtime,
            provenance: { source: 'server-downtime-policy' },
          }, downtime.participant_ids),
        ])
        collect(downtimeCommit)
      }
    }

    await this.propagateWitnesses(campaignId, {
      sourceEventId: outcomeCommit.events.find((entry) => entry.event_type === 'EncounterOutcomeRecorded')?.event_id,
      outcome: plan.outcome === 'enemies_defeated' ? 'helpful' : 'harmful',
      severity: 'major',
      idempotencyKey: `${baseKey}:witnesses`,
    })
    const campaignCompletion = await this.completeCampaignIfReady(campaignId, baseKey)
    if (campaignCompletion && !campaignCompletion.duplicate) emitted.push(...(campaignCompletion.events ?? []))

    const beforeTransition = await this.load(campaignId)
    const transition = {
      transition_id: `transition-${plan.encounter_id || digest(baseKey)}`,
      status: 'available',
      hook: nextHook(beforeTransition.state),
    }
    collect(await this.commitEventsWithRetry(campaignId, transitionKey, [
      event(transitionKey, 'TransitionUnlocked', {
        encounter_id: plan.encounter_id,
        transition,
        provenance: { source: 'server-reward-policy', policy: ENCOUNTER_REWARD_POLICY_ID },
      }),
    ]))

    const final = await this.load(campaignId)
    return {
      events: emitted,
      reward: encounterRewardResponse({ plan, ...prepared }),
      state: final.state,
      state_version: final.state_version,
      admin_commands: 0,
      duplicate: emitted.length === 0,
    }
  }

  async propagateWitnesses(campaignId, { sourceEventId = '', outcome = 'neutral', severity = 'minor', idempotencyKey = 'witnesses' } = {}) {
    const loaded = await this.load(campaignId)
    const location = clean(loaded.state.scene?.location, 180).toLocaleLowerCase('ru')
    const witnesses = (loaded.state.social?.npcs ?? []).filter((npc) => npc.available !== false && (!npc.location || clean(npc.location, 180).toLocaleLowerCase('ru') === location)).map((npc) => String(npc.id)).sort()
    const factions = factionIdsForWitnesses(loaded.state, witnesses)
    const delta = serverReputationDelta({ outcome, severity })
    const events = [event(`${idempotencyKey}:graph`, 'WitnessConsequencePropagated', {
      source_event_id: sourceEventId,
      witness_ids: witnesses,
      faction_ids: factions,
      propagation_scope: 'direct-factions-only',
      outcome, severity,
      provenance: { source: 'server-witness-policy' },
    }, witnesses)]
    for (const factionId of factions) events.push(event(`${idempotencyKey}:${factionId}`, 'FactionReputationAdjusted', {
      faction_id: factionId,
      delta,
      source_event_id: sourceEventId,
      witness_ids: witnesses,
      provenance: { source: 'server-reputation-table', policy: 'faction-reputation-v1' },
    }))
    return this.commitEvents(campaignId, idempotencyKey, events)
  }

  async registerNpcSchedule(campaignId, { npcId, entries, idempotencyKey = `schedule-${npcId}` } = {}) {
    const loaded = await this.load(campaignId)
    const npc = (loaded.state.social?.npcs ?? []).find((candidate) => candidate.id === npcId)
    if (!npc) throw new Error('NPC schedule references an unknown NPC')
    const normalized = (Array.isArray(entries) ? entries : []).slice(0, 64).map((entry) => ({
      at_minutes: Math.max(1, Math.min(10_000_000, Number.isSafeInteger(Number(entry.at_minutes)) ? Number(entry.at_minutes) : 1)),
      action: ['move', 'appear', 'depart'].includes(entry.action) ? entry.action : 'move',
      location: clean(entry.location, 180),
      summary: clean(entry.summary, 300),
    })).sort((a, b) => a.at_minutes - b.at_minutes)
    let subject = currentSubject(loaded.state)
    const commands = []
    if (!subject) {
      subject = { id: `world-${digest(campaignId)}`, kind: 'concept', name: 'Расписание мира', summary: '', aliases: [], visibility: 'party', tags: [] }
      commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
    }
    commands.push({ command_type: 'RecordWorldFact', fact: {
      id: `schedule-${npcId}-${digest(normalized)}`, subject_id: subject.id, predicate: 'npc_schedule',
      object: JSON.stringify({ npc_id: npcId, entries: normalized }), summary: `Расписание NPC ${npc.name}`, visibility: 'gm_only', source_event_ids: [],
    } })
    const result = await this.runCommands(campaignId, `${idempotencyKey}:fact`, commands)
    await this.commitEvents(campaignId, `${idempotencyKey}:event`, [event(`${idempotencyKey}:event`, 'NpcScheduleRegistered', { npc_id: npcId, entries: normalized, provenance: { source: 'server-schedule-policy' } }, [npcId], 'gm_only')])
    return result
  }

  async executeNpcSchedules(campaignId, {
    start = 0,
    end = 0,
    idempotencyKey = 'scheduled-actions',
    sourceEventIds = [],
  } = {}) {
    const loaded = await this.load(campaignId)
    const scheduleFacts = (loaded.state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active' && fact.predicate === 'npc_schedule')
    const executed = new Set((loaded.state.worldMemory?.facts ?? []).filter((fact) => fact.predicate === 'npc_scheduled_action_executed').map((fact) => fact.object))
    const actions = []
    for (const fact of scheduleFacts) {
      const schedule = parseJsonFact(fact)
      const npc = (loaded.state.social?.npcs ?? []).find((candidate) => candidate.id === schedule?.npc_id)
      if (!npc) continue
      for (const entry of schedule.entries ?? []) {
        const actionKey = `${schedule.npc_id}:${entry.at_minutes}:${entry.action}`
        if (entry.at_minutes <= start || entry.at_minutes > end || executed.has(actionKey)) continue
        const profile = { ...npc, location: entry.location || npc.location, available: entry.action !== 'depart' }
        actions.push({ command_type: 'UpsertNpcSocialProfile', npc: profile })
        actions.push({ command_type: 'RecordWorldFact', fact: {
          id: `schedule-action-${digest(actionKey)}`, subject_id: fact.subject_id, predicate: 'npc_scheduled_action_executed',
          object: actionKey, summary: entry.summary || `${npc.name}: ${entry.action}`, visibility: 'party', source_event_ids: sourceEventIds,
        } })
      }
    }
    if (!actions.length) return { scheduled_actions: 0, result: null }
    const result = await this.runCommands(campaignId, idempotencyKey, actions)
    return { scheduled_actions: actions.length / 2, result }
  }

  async advanceTime(campaignId, { amount, unit = 'minute', idempotencyKey = 'advance-time' } = {}) {
    const before = await this.load(campaignId)
    const start = Number(before.state.mechanics.world_time?.elapsed_minutes) || 0
    const advanced = await this.runCommands(campaignId, `${idempotencyKey}:clock`, [{ command_type: 'AdvanceTime', amount, unit }])
    const after = await this.load(campaignId)
    const end = Number(after.state.mechanics.world_time?.elapsed_minutes) || start
    const scheduled = await this.executeNpcSchedules(campaignId, {
      start,
      end,
      idempotencyKey: `${idempotencyKey}:scheduled-actions`,
      sourceEventIds: advanced.events.map((entry) => entry.event_id).filter(Boolean),
    })
    return { before: start, after: end, scheduled_actions: scheduled.scheduled_actions, state: (await this.load(campaignId)).state, admin_commands: 0 }
  }

  async bindPromise(campaignId, { promiseId, condition, idempotencyKey = `promise-binding-${promiseId}` } = {}) {
    const loaded = await this.load(campaignId)
    const promise = (loaded.state.social?.promises ?? []).find((candidate) => candidate.id === promiseId && candidate.status === 'open')
    if (!promise) throw new Error('Open promise not found')
    const allowed = ['QuestClockAdvanced', 'EncounterOutcomeRecorded', 'WorldFactRecorded']
    if (!allowed.includes(condition?.event_type)) throw new Error('Promise condition event is not allowed')
    let subject = currentSubject(loaded.state)
    const commands = []
    if (!subject) {
      subject = { id: `world-${digest(campaignId)}`, kind: 'concept', name: 'События мира', summary: '', aliases: [], visibility: 'party', tags: [] }
      commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
    }
    commands.push({ command_type: 'RecordWorldFact', fact: {
      id: `promise-condition-${promiseId}-${digest(condition)}`, subject_id: subject.id, predicate: 'promise_condition',
      object: JSON.stringify({ promise_id: promiseId, condition }), summary: `Условие обещания ${promiseId}`, visibility: 'gm_only', source_event_ids: [],
    } })
    return this.runCommands(campaignId, idempotencyKey, commands)
  }

  async resolvePromiseConditions(campaignId, triggeringEvents, idempotencyKey) {
    if (!triggeringEvents?.length) return null
    const loaded = await this.load(campaignId)
    const bindings = (loaded.state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active' && fact.predicate === 'promise_condition').map(parseJsonFact).filter(Boolean)
    const commands = []
    for (const binding of bindings) {
      const promise = (loaded.state.social?.promises ?? []).find((candidate) => candidate.id === binding.promise_id && candidate.status === 'open')
      if (!promise) continue
      const matched = triggeringEvents.some((entry) => entry.event_type === binding.condition?.event_type
        && (!binding.condition.quest_id || binding.condition.quest_id === entry.payload?.quest_id)
        && (!binding.condition.outcome || binding.condition.outcome === entry.payload?.outcome))
      if (matched) commands.push({ command_type: 'ResolveNpcPromise', promise_id: promise.id, status: 'fulfilled' })
    }
    if (!commands.length) return null
    return this.runCommands(campaignId, idempotencyKey, commands, { isSocialController: true })
  }
}
