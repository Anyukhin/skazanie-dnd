import { createHash } from 'node:crypto'

import { normalizeDirectorIntent, serverReputationDelta, serverRewardForEncounter } from './autonomous-campaign.mjs'
import {
  assembleSocialNpc,
  completedDowntime,
  pacingForDirectorIntent,
  planServerTravel,
} from './campaign-loop-policy.mjs'
import { partyDecisionOpenedEvent } from './party-decision.mjs'
import { planNpcTurn } from './npc-turn-scheduler.mjs'
import {
  actorPosition,
  attackProfileFor,
  findActor,
  isEnemyActor,
  isLivingActor,
  normalizeCampaignState,
  shortestTacticalPath,
} from './rules-engine.mjs'
import { classifyFreeActionKind } from './intent-parser.mjs'

const clone = (value) => structuredClone(value)
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

function explorationCells(state) {
  return (state.scene?.cells ?? []).filter((cell) => cell.revealed !== true && ['floor', 'door'].includes(String(cell.type)))
    .sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x))
    .map((cell) => ({ x: Number(cell.x), y: Number(cell.y) }))
}

function availableNpc(state, requestedId = '') {
  const at = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  return (state.social?.npcs ?? []).find((npc) => (!requestedId || npc.id === requestedId) && npc.available !== false
    && (!npc.location || !at || clean(npc.location, 180).toLocaleLowerCase('ru') === at)) ?? null
}

function nextHook(state, reason = '') {
  const quest = openQuest(state)
  return clean(reason, 300) || (quest ? `Продолжить квест «${quest.title}»` : `Исследовать ${state.scene?.location || 'окрестности'} и найти новую зацепку`)
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
  constructor({ eventStore, rulesEngine, now = () => Date.now() } = {}) {
    if (!eventStore || !rulesEngine) throw new TypeError('AutonomousCampaignOrchestrator requires eventStore and rulesEngine')
    this.eventStore = eventStore
    this.rulesEngine = rulesEngine
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

  async recordIntent(campaignId, intent, idempotencyKey) {
    const loaded = await this.load(campaignId)
    const provenance = {
      source: 'director',
      contract: 'skazanie:director-intent-v1',
      intent_type: intent.type,
      request_fingerprint: digest({ campaignId, intent }),
      recorded_at_ms: this.now(),
    }
    return this.commitEvents(campaignId, `${idempotencyKey}:intent`, [
      event(`${idempotencyKey}:intent`, 'DirectorIntentRecorded', { intent, provenance }, [], 'party'),
      event(`${idempotencyKey}:pacing`, 'CampaignPacingAdvanced', {
        ...pacingForDirectorIntent(loaded.state, intent),
        provenance: { source: 'server-pacing-policy' },
      }, [], 'party'),
    ])
  }

  async runIntent({ campaignId, intent: rawIntent, idempotencyKey }) {
    const intent = normalizeDirectorIntent(rawIntent)
    const key = clean(idempotencyKey, 120) || `director-${digest({ campaignId, intent })}`
    await this.recordIntent(campaignId, intent, key)
    let loaded = await this.load(campaignId)
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
      const destination = intent.destination || `${loaded.state.scene?.location || 'Путь'} — следующая сцена`
      travel = planServerTravel(loaded.state, { campaignId, destination, idempotencyKey: key })
      travelStartedAt = Number(loaded.state.mechanics?.world_time?.elapsed_minutes) || 0
      const decisionId = `autonomy-${digest(key)}`
      const partyIds = (loaded.state.partyMemberIds?.length
        ? loaded.state.partyMemberIds
        : loaded.state.players?.map((player) => player.id) ?? []).map(String)
      const actorId = String(loaded.state.activePlayerId ?? partyIds[0] ?? '')
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
    return { intent, results, state: loaded.state, state_version: loaded.state_version, admin_commands: 0 }
  }

  async handleUnknownAction({ campaignId, action, idempotencyKey, playerId = '', intent = null }) {
    const text = clean(action, 1_000)
    const loaded = await this.load(campaignId)
    const actorId = clean(playerId, 120)
    const declaration = declaredActionCommand(actorId, text)
    const run = async (commands) => {
      const actualCommands = commands.filter(Boolean)
      if (!actualCommands.length) return { state: loaded.state, state_version: loaded.state_version, events: [], commands: [], rolls: [], duplicate: false }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await this.runCommands(campaignId, idempotencyKey, actualCommands)
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
        suggestions: [],
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
        suggestions: [nextHook(loaded.state)],
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
        suggestions: [nextHook(loaded.state)],
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
    const objective = boundedObjective(loaded.state, text)
    const ruling = {
      id: `ruling-${digest({ campaignId, text })}`,
      status: 'applied',
      scope: 'single-action',
      question: text,
      bounded_options: ['ability-check', 'existing-action', 'fiction-only'],
      selected_option: 'objective-update',
      consequence: objective,
      world_change: true,
      provenance: { source: 'free-action-fallback', action_fingerprint: digest(text) },
    }
    const commit = await run([
      declaration,
      { command_type: 'RecordRuling', ruling, ruling_id: ruling.id },
      { command_type: 'UpdateObjective', objective },
    ])
    verifyDuplicate(commit, { requiresRuling: true })
    return {
      kind: 'bounded_ruling',
      ruling,
      narration: `Действие принято. Следующая цель отряда: «${objective}»`,
      suggestions: [objective],
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
      if (!livingEnemies.length || !livingHeroes.length) {
        commands = [{ command_type: 'EndCombat', actor_id: actorId || livingHeroes[0]?.id || livingEnemies[0]?.id, reason: livingEnemies.length ? 'party_defeated' : 'enemies_defeated' }]
      } else if (isEnemyActor(state, actorId)) {
        commands = planNpcTurn(state, actorId)
      } else {
        const target = livingEnemies.sort((a, b) => Number(a.hp) - Number(b.hp) || String(a.id).localeCompare(String(b.id)))[0]
        const profile = attackProfileFor(state, actorId)
        const from = actorPosition(state, actorId)
        const to = actorPosition(state, target.id)
        let attackFrom = from
        let distance = from && to ? Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5 : Number.MAX_SAFE_INTEGER
        commands = []
        if (profile && distance > profile.range_feet) {
          const path = shortestTacticalPath(state, actorId, to, { allowOccupiedDestination: true })
          const rangeCells = Math.max(1, Math.floor(Number(profile.range_feet) / 5))
          const neededSteps = Math.max(0, (path?.length ?? 0) - rangeCells)
          const steps = Math.min(neededSteps, Math.max(1, Math.floor((Number(actor?.speed) || 30) / 5)))
          if (steps > 0 && path?.[steps - 1]) {
            attackFrom = path[steps - 1]
            commands.push({ command_type: 'MoveActor', actor_id: actorId, to: attackFrom })
          }
          distance = attackFrom && to ? Math.max(Math.abs(attackFrom.x - to.x), Math.abs(attackFrom.y - to.y)) * 5 : Number.MAX_SAFE_INTEGER
        }
        if (profile && distance <= profile.range_feet) commands.push({ command_type: 'MakeAttack', actor_id: actorId, target_id: String(target.id), server_authoritative: true })
        commands.push({ command_type: 'EndTurn', actor_id: actorId })
      }
      const key = `${idempotencyPrefix}:${iteration + 1}:v${loaded.state_version}`
      const committed = await this.runCommands(campaignId, key, commands, { isNpcScheduler: isEnemyActor(state, actorId) })
      turns.push({ actor_id: actorId, commands: commands.map((command) => command.command_type), events: committed.events.map((entry) => entry.event_type) })
    }
    throw new Error(`Autonomous combat exceeded ${maxTurns} turns`)
  }

  async completeEncounter({ campaignId, outcome = 'enemies_defeated', idempotencyKey = 'encounter-completion' }) {
    let loaded = await this.load(campaignId)
    if (loaded.state.mechanics.combat.active) {
      const activeId = String(loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index]?.actor_id ?? loaded.state.players[0]?.id ?? '')
      await this.runCommands(campaignId, `${idempotencyKey}:end-combat`, [{ command_type: 'EndCombat', actor_id: activeId, reason: outcome }])
      loaded = await this.load(campaignId)
    }
    const reward = serverRewardForEncounter(loaded.state, outcome)
    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, `${idempotencyKey}:outcome`)
    if (duplicate) return { ...duplicate, state: (await this.load(campaignId)).state }
    const completionEvents = [event(`${idempotencyKey}:outcome`, 'EncounterOutcomeRecorded', {
      ...reward,
      provenance: { source: 'server-reward-policy', policy: 'encounter-reward-v1' },
    })]
    if (reward.xp > 0) completionEvents.push(event(`${idempotencyKey}:xp`, 'ExperienceAwarded', {
      encounter_id: reward.encounter_id,
      total_xp: reward.xp,
      recipients: loaded.state.partyMemberIds,
      provenance: { source: 'server-reward-policy' },
    }, loaded.state.partyMemberIds))
    else completionEvents.push(event(`${idempotencyKey}:milestone`, 'MilestoneAwarded', { milestone: reward.milestone, encounter_id: reward.encounter_id }))
    completionEvents.push(event(`${idempotencyKey}:loot`, 'ServerLootGenerated', {
      encounter_id: reward.encounter_id,
      loot: reward.loot,
      provenance: { source: 'server-loot-table', policy: 'encounter-loot-v1' },
    }))
    completionEvents.push(event(`${idempotencyKey}:transition`, 'TransitionUnlocked', {
      transition_id: `transition-${reward.encounter_id || digest(idempotencyKey)}`,
      status: 'available',
      hook: nextHook(loaded.state),
    }))
    const outcomeCommit = await this.commitEvents(campaignId, `${idempotencyKey}:outcome`, completionEvents)

    loaded = await this.load(campaignId)
    const ownerId = String(loaded.state.partyMemberIds[0] ?? loaded.state.players[0]?.id ?? '')
    const commands = reward.loot.map((item, index) => ({ command_type: 'GrantItem', actor_id: ownerId, item: {
      id: `loot-${reward.encounter_id}-${index + 1}`,
      catalog_id: item.catalog_id,
      name: item.name,
      quantity: item.quantity,
      type: 'consumable', rarity: 'обычный', weight: 0, equipped: false,
    } }))
    const quest = openQuest(loaded.state)
    if (quest) commands.push({ command_type: 'AdvanceQuestClock', quest_id: quest.id, amount: 1 })
    let subject = currentSubject(loaded.state)
    if (!subject) {
      subject = { id: `location-${digest(loaded.state.scene?.location || campaignId)}`, kind: 'location', name: loaded.state.scene?.location || 'Текущая сцена', summary: '', aliases: [], visibility: 'party', tags: [] }
      commands.push({ command_type: 'UpsertWorldEntity', entity: subject })
    }
    commands.push({ command_type: 'RecordWorldFact', fact: {
      id: `fact-${reward.encounter_id || digest(idempotencyKey)}-outcome`,
      subject_id: subject.id,
      predicate: 'encounter_outcome',
      object: outcome,
      summary: `Встреча завершилась исходом: ${outcome}.`,
      visibility: 'party',
      source_event_ids: outcomeCommit.events.map((entry) => entry.event_id).filter(Boolean),
    } })
    commands.push({ command_type: 'UpdateObjective', objective: nextHook(loaded.state) })
    const consequences = await this.runCommands(campaignId, `${idempotencyKey}:consequences`, commands)
    let recovery = { events: [] }
    if (outcome === 'enemies_defeated') {
      const afterConsequences = await this.load(campaignId)
      const partyIds = new Set((afterConsequences.state.partyMemberIds ?? []).map(String))
      const restingHeroes = (afterConsequences.state.players ?? []).filter((hero) => (
        partyIds.has(String(hero.id)) && afterConsequences.state.mechanics?.death?.heroes?.[hero.id]?.status !== 'dead'
      ))
      if (restingHeroes.length) {
        const downtime = completedDowntime(afterConsequences.state, {
          kind: 'long_rest',
          durationMinutes: 480,
          reason: 'post_encounter_recovery',
        })
        const recoveryCommands = [
          ...restingHeroes.map((hero) => ({ command_type: 'StartRest', actor_id: String(hero.id), kind: 'long' })),
          { command_type: 'AdvanceTime', amount: 480, unit: 'minute' },
          ...restingHeroes.map((hero) => ({ command_type: 'CompleteRest', actor_id: String(hero.id), kind: 'long' })),
        ]
        recovery = await this.runCommands(campaignId, `${idempotencyKey}:recovery`, recoveryCommands)
        const downtimeCommit = await this.commitEvents(campaignId, `${idempotencyKey}:downtime`, [
          event(`${idempotencyKey}:downtime`, 'DowntimeResolved', {
            ...downtime,
            provenance: { source: 'server-downtime-policy' },
          }, downtime.participant_ids),
        ])
        recovery = { ...recovery, events: [...recovery.events, ...downtimeCommit.events] }
      }
    }
    await this.propagateWitnesses(campaignId, {
      sourceEventId: outcomeCommit.events.find((entry) => entry.event_type === 'EncounterOutcomeRecorded')?.event_id,
      outcome: outcome === 'enemies_defeated' ? 'helpful' : 'harmful', severity: 'major',
      idempotencyKey: `${idempotencyKey}:witnesses`,
    })
    const final = await this.load(campaignId)
    return { events: [...outcomeCommit.events, ...consequences.events, ...recovery.events], reward, state: final.state, state_version: final.state_version, admin_commands: 0 }
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
