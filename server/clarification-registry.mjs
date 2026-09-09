import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1
const DEFAULT_TTL_MS = 60 * 60 * 1_000

function text(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function error(message, code) {
  const result = new Error(message)
  result.code = code
  return result
}

function safeIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null
  return {
    actor_id: text(intent.actor_id, 120),
    intent: text(intent.intent, 80),
    approach: text(intent.approach, 80),
    targets: (Array.isArray(intent.targets) ? intent.targets : []).map((value) => text(value, 120)).filter(Boolean).slice(0, 8),
    mentioned_entities: (Array.isArray(intent.mentioned_entities) ? intent.mentioned_entities : []).map((value) => text(value, 120)).filter(Boolean).slice(0, 8),
    missing_information: (Array.isArray(intent.missing_information) ? intent.missing_information : []).map((value) => text(value, 80)).filter(Boolean).slice(0, 8),
    free_action_kind: text(intent.free_action_kind, 80),
    confidence: Number.isFinite(Number(intent.confidence)) ? Number(intent.confidence) : 0,
    ...(Array.isArray(intent.target_candidates) ? {
      target_candidates: intent.target_candidates.slice(0, 8).map((candidate) => ({
        id: text(candidate?.id, 120),
        name: text(candidate?.name, 120),
        role: text(candidate?.role, 80),
      })),
    } : {}),
    ...(Array.isArray(intent.action_steps) ? { action_steps: intent.action_steps.map((value) => text(value, 500)).filter(Boolean).slice(0, 6) } : {}),
    ...(Array.isArray(intent.constraints) ? { constraints: intent.constraints.map((value) => text(value, 200)).filter(Boolean).slice(0, 6) } : {}),
    ...(intent.pending_step == null ? {} : { pending_step: text(intent.pending_step, 500) }),
  }
}

/**
 * Долговечный реестр непрозрачных продолжений диалога. Клиент получает только
 * случайный идентификатор и безопасные поля карточки; исходное намерение
 * читается из реестра сервера и никогда не декодируется из запроса клиента.
 */
export class ClarificationRegistry {
  constructor({ storageFile = null, ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.storageFile = storageFile ? resolve(storageFile) : null
    this.ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS
    this.now = now
    this.idFactory = idFactory
    this.entries = new Map()
    this.revokedProposals = new Map()
    this.proposals = new Map()
    this.dialogues = new Map()
    this.load()
    this.cleanup()
  }

  load() {
    if (!this.storageFile || !existsSync(this.storageFile)) return
    let payload
    try {
      payload = JSON.parse(readFileSync(this.storageFile, 'utf8'))
    } catch (cause) {
      throw error(`Повреждено хранилище уточнений: ${cause instanceof Error ? cause.message : cause}`, 'CLARIFICATION_REGISTRY_CORRUPT')
    }
    if (payload?.schema_version !== SCHEMA_VERSION || !Array.isArray(payload.entries)) {
      throw error('Некорректная схема хранилища уточнений', 'CLARIFICATION_REGISTRY_CORRUPT')
    }
    this.entries = new Map(payload.entries.map(([id, entry]) => [String(id), entry]))
    this.revokedProposals = new Map((Array.isArray(payload.revoked_proposals) ? payload.revoked_proposals : [])
      .map(([key, entry]) => [String(key), entry]))
    this.proposals = new Map((Array.isArray(payload.proposals) ? payload.proposals : [])
      .map(([id, entry]) => [String(id), entry]))
    this.dialogues = new Map((Array.isArray(payload.dialogues) ? payload.dialogues : [])
      .map(([id, entry]) => [String(id), entry]))
  }

  persist() {
    if (!this.storageFile) return
    mkdirSync(dirname(this.storageFile), { recursive: true })
    const temporary = `${this.storageFile}.${process.pid}.${this.idFactory()}.tmp`
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify({
        schema_version: SCHEMA_VERSION,
        entries: [...this.entries.entries()],
        revoked_proposals: [...this.revokedProposals.entries()],
        proposals: [...this.proposals.entries()],
        dialogues: [...this.dialogues.entries()],
      }), 'utf8')
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.storageFile)
  }

  cleanup() {
    const cutoff = this.now()
    let changed = false
    for (const [id, entry] of this.entries) {
      if (Number(entry?.expires_at) <= cutoff) {
        this.entries.delete(id)
        changed = true
      }
    }
    for (const [key, entry] of this.revokedProposals) {
      if (Number(entry?.expires_at) <= cutoff) {
        this.revokedProposals.delete(key)
        changed = true
      }
    }
    for (const [id, entry] of this.proposals) {
      if (Number(entry?.expires_at) <= cutoff) {
        this.proposals.delete(id)
        changed = true
      }
    }
    for (const [id, entry] of this.dialogues) {
      if (Number(entry?.expires_at) <= cutoff) {
        this.dialogues.delete(id)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  create({ campaignId, actorId, stateVersion, action, question, intent = null } = {}) {
    this.cleanup()
    const campaign = text(campaignId, 120)
    const actor = text(actorId, 120)
    const normalizedAction = text(action)
    const normalizedQuestion = text(question, 600)
    for (const [id, existing] of this.entries) {
      if (!existing.completed && existing.campaign_id === campaign
        && existing.actor_id === actor
        && Number(existing.state_version) === Number(stateVersion)
        && existing.action === normalizedAction
        && existing.question === normalizedQuestion) return this.public(id, existing)
    }
    const id = `clarification:${this.idFactory()}`
    const entry = {
      campaign_id: campaign,
      actor_id: actor,
      state_version: Number.isSafeInteger(Number(stateVersion)) ? Number(stateVersion) : 0,
      action: normalizedAction,
      question: normalizedQuestion,
      original_intent: safeIntent(intent),
      expires_at: this.now() + this.ttlMs,
    }
    if (!entry.campaign_id || !entry.actor_id || !entry.question) {
      throw error('Недостаточно данных для сохранения уточнения', 'CLARIFICATION_INVALID')
    }
    for (const previous of this.entries.values()) {
      if (previous.campaign_id === campaign && previous.actor_id === actor) previous.completed = true
    }
    this.entries.set(id, entry)
    this.persist()
    return this.public(id, entry)
  }

  rememberDialogue({ campaignId, actorId, question, answer, action = '', stateVersion = null } = {}) {
    this.cleanup()
    const campaign = text(campaignId, 120)
    const actor = text(actorId, 120)
    const normalizedQuestion = text(question, 600)
    const normalizedAnswer = text(answer, 2_000)
    if (!campaign || !actor || !normalizedQuestion || !normalizedAnswer) {
      throw error('Недостаточно данных для сохранения диалога', 'CLARIFICATION_DIALOGUE_INVALID')
    }
    const id = `dialogue:${this.idFactory()}`
    this.dialogues.set(id, {
      campaign_id: campaign,
      actor_id: actor,
      question: normalizedQuestion,
      answer: normalizedAnswer,
      action: text(action, 2_000),
      state_version: stateVersion == null ? null : (Number.isSafeInteger(Number(stateVersion)) ? Number(stateVersion) : null),
      created_at: this.now(),
      expires_at: this.now() + this.ttlMs,
    })
    const own = [...this.dialogues.entries()].filter(([, entry]) => entry.campaign_id === campaign && entry.actor_id === actor)
    for (const [oldId] of own.slice(0, -6)) this.dialogues.delete(oldId)
    this.persist()
    return structuredClone({ id, ...this.dialogues.get(id) })
  }

  recentDialogue({ campaignId, actorId } = {}) {
    this.cleanup()
    const campaign = text(campaignId, 120)
    const actor = text(actorId, 120)
    return [...this.dialogues.entries()].reverse()
      .filter(([, entry]) => entry.campaign_id === campaign && entry.actor_id === actor)
      .slice(0, 6)
      .map(([id, entry]) => structuredClone({ id, ...entry }))
  }

  resetDialogue({ campaignId, actorId } = {}) {
    this.cleanup()
    const campaign = text(campaignId, 120)
    const actor = text(actorId, 120)
    let removed = 0
    for (const [id, entry] of this.dialogues) {
      if (entry.campaign_id === campaign && entry.actor_id === actor) {
        this.dialogues.delete(id)
        removed += 1
      }
    }
    if (removed) this.persist()
    return removed
  }

  resolve(id, { campaignId, actorId, stateVersion = null } = {}) {
    this.cleanup()
    const key = text(id, 300)
    const entry = this.entries.get(key)
    if (!entry) throw error('Уточнение не найдено или истекло. Отправьте действие заново.', 'CLARIFICATION_NOT_FOUND')
    if (entry.campaign_id !== text(campaignId, 120) || entry.actor_id !== text(actorId, 120)) {
      throw error('Уточнение не принадлежит этому герою или кампании.', 'CLARIFICATION_FORBIDDEN')
    }
    if (stateVersion != null && Number(entry.state_version) !== Number(stateVersion)) {
      throw error('Обстановка изменилась, поэтому старое уточнение больше не действует. Отправьте заявку заново.', 'CLARIFICATION_STALE')
    }
    return structuredClone({ id: key, ...entry })
  }

  current({ campaignId, actorId, stateVersion } = {}) {
    this.cleanup()
    const found = [...this.entries.entries()].reverse().find(([, entry]) => !entry.completed
      && entry.campaign_id === text(campaignId, 120) && entry.actor_id === text(actorId, 120)
      && Number(entry.state_version) === Number(stateVersion))
    return found ? this.public(...found) : null
  }

  complete(id, { campaignId, actorId } = {}) {
    this.resolve(id, { campaignId, actorId })
    this.entries.get(String(id)).completed = true
    this.persist()
  }

  revokeProposal(proposalId, { campaignId, actorId } = {}) {
    this.cleanup()
    const id = text(proposalId, 300)
    const key = `${text(campaignId, 120)}\u0000${text(actorId, 120)}\u0000${id}`
    this.revokedProposals.set(key, { expires_at: this.now() + this.ttlMs })
    const proposal = this.proposals.get(id)
    if (proposal
      && proposal.campaign_id === text(campaignId, 120)
      && proposal.actor_id === text(actorId, 120)) proposal.revoked = true
    this.persist()
  }

  isProposalRevoked(proposalId, { campaignId, actorId } = {}) {
    this.cleanup()
    const key = `${text(campaignId, 120)}\u0000${text(actorId, 120)}\u0000${text(proposalId, 300)}`
    return this.revokedProposals.has(key) || this.proposals.get(text(proposalId, 300))?.revoked === true
  }

  issueProposal({ campaignId, actorId, stateVersion, proposal, planFingerprint } = {}) {
    this.cleanup()
    const id = `proposal:${this.idFactory()}`
    const entry = {
      campaign_id: text(campaignId, 120),
      actor_id: text(actorId, 120),
      state_version: Number.isSafeInteger(Number(stateVersion)) ? Number(stateVersion) : 0,
      proposal: structuredClone(proposal ?? {}),
      plan_fingerprint: text(planFingerprint, 128),
      expires_at: this.now() + this.ttlMs,
      revoked: false,
    }
    if (!entry.campaign_id || !entry.actor_id || !entry.plan_fingerprint || !entry.proposal?.title) {
      throw error('Недостаточно данных для сохранения предложения', 'PROPOSAL_INVALID')
    }
    entry.proposal.id = id
    this.proposals.set(id, entry)
    this.persist()
    return structuredClone(entry.proposal)
  }

  resolveProposal(id, { campaignId, actorId, stateVersion = null } = {}) {
    this.cleanup()
    const key = text(id, 300)
    const entry = this.proposals.get(key)
    if (!entry) throw error('Предложение не найдено или истекло. Отправьте заявку заново.', 'PROPOSAL_NOT_FOUND')
    if (entry.campaign_id !== text(campaignId, 120) || entry.actor_id !== text(actorId, 120)) {
      throw error('Предложение не принадлежит этому герою или кампании.', 'PROPOSAL_FORBIDDEN')
    }
    if (entry.revoked || this.isProposalRevoked(key, { campaignId, actorId })) {
      throw error('Это предложение уже отменено изменением заявки. Получите новый маршрут.', 'PROPOSAL_REVOKED')
    }
    if (stateVersion != null && Number(entry.state_version) !== Number(stateVersion)) {
      throw error('Обстановка изменилась, поэтому старое предложение больше не действует.', 'PROPOSAL_STALE')
    }
    return structuredClone(entry)
  }

  getProposal(id, { campaignId, actorId, stateVersion = null } = {}) {
    return this.resolveProposal(id, { campaignId, actorId, stateVersion })
  }

  public(id, entry) {
    return {
      id,
      campaign_id: entry.campaign_id,
      actor_id: entry.actor_id,
      state_version: entry.state_version,
      action: entry.action,
      question: entry.question,
      ...(entry.original_intent?.action_steps?.length || entry.original_intent?.pending_step === 'proposal' ? { confirmation_required: true } : {}),
    }
  }
}
