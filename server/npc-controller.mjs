import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { actorPosition, findActor, isEnemyActor, isLivingActor, shortestTacticalPath } from './rules-engine.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/npc_controller/v1.txt', import.meta.url)), 'utf8')
const DISPOSITIONS = new Set(['fight', 'flee', 'surrender'])
const FINAL_MORALE_CONDITIONS = new Set(['fled', 'surrendered'])

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function actorName(actor) {
  return String(actor?.character ?? actor?.name ?? actorId(actor) ?? 'NPC').slice(0, 100)
}

function conditionsFor(state, id) {
  return Array.isArray(state?.mechanics?.conditions?.[String(id)]) ? state.mechanics.conditions[String(id)] : []
}

function hasCondition(state, id, condition) {
  return conditionsFor(state, id).some((entry) => String(entry?.id ?? entry) === condition)
}

export function isMoraleMoment(state, enemyId) {
  const enemy = findActor(state, enemyId)
  if (!enemy || !isEnemyActor(state, enemyId) || !isLivingActor(enemy)) return false
  if (hasCondition(state, enemyId, 'morale-tested') || [...FINAL_MORALE_CONDITIONS].some((condition) => hasCondition(state, enemyId, condition))) return false
  const hp = Math.max(0, Number(enemy.hp) || 0)
  const maxHp = Math.max(1, Number(enemy.maxHp ?? enemy.max_hp) || hp || 1)
  return hp / maxHp <= 0.3
}

function localDisposition(state, enemy) {
  const identity = `${actorName(enemy)} ${enemy.kind ?? ''} ${enemy.type ?? ''}`.toLocaleLowerCase('ru')
  if (/нежит|скелет|зомби|конструкт|голем|автомат/u.test(identity)) return 'fight'
  if (/звер|волк|паук|крыса|животн/u.test(identity)) return 'flee'
  const value = createHash('sha256').update(`${state.campaign_id ?? state.sessionCode ?? ''}:${actorId(enemy)}:${state.mechanics?.combat?.round ?? 0}`).digest()[0]
  return value % 3 === 0 ? 'fight' : value % 3 === 1 ? 'flee' : 'surrender'
}

function normalizeDecision(value, fallback, expectedId) {
  const disposition = DISPOSITIONS.has(value?.disposition) ? value.disposition : fallback
  return {
    npc_id: expectedId,
    disposition,
    reaction: String(value?.reaction ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240),
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0)),
  }
}

function publicBrief(state, enemy) {
  return {
    npc: {
      id: actorId(enemy),
      name: actorName(enemy),
      kind: String(enemy.kind ?? enemy.type ?? ''),
      hp: Math.max(0, Number(enemy.hp) || 0),
      max_hp: Math.max(1, Number(enemy.maxHp ?? enemy.max_hp) || 1),
      visible_conditions: conditionsFor(state, actorId(enemy)).map((entry) => String(entry?.id ?? entry)).slice(0, 12),
    },
    scene: {
      title: String(state.scene?.title ?? ''),
      location: String(state.scene?.location ?? ''),
      mood: String(state.scene?.mood ?? ''),
      objective: String(state.scene?.objective ?? ''),
    },
    campaign_premise: {
      genre: String(state.campaignConcept?.genre ?? state.campaign_concept?.genre ?? ''),
      tone: String(state.campaignConcept?.tone ?? state.campaign_concept?.tone ?? ''),
      theme: String(state.campaignConcept?.theme ?? state.campaign_concept?.theme ?? ''),
    },
    visible_heroes: (state.players ?? []).filter(isLivingActor).map((hero) => ({ id: actorId(hero), name: actorName(hero) })).slice(0, 8),
    allowed_dispositions: [...DISPOSITIONS],
  }
}

export class NpcControllerAgent {
  constructor({ llmClient = null } = {}) {
    this.llmClient = llmClient
  }

  async decide({ state, enemyId } = {}) {
    const enemy = findActor(state, enemyId)
    if (!enemy || !isMoraleMoment(state, enemyId)) return null
    const fallback = localDisposition(state, enemy)
    if (!this.llmClient) return { ...normalizeDecision({}, fallback, actorId(enemy)), provider: 'deterministic-morale-fallback' }
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `UNTRUSTED_DATA\n${JSON.stringify(publicBrief(state, enemy))}` },
        ],
        temperature: 0.65,
        maxTokens: 300,
      })
      return { ...normalizeDecision(result, fallback, actorId(enemy)), provider: this.llmClient.constructor?.name ?? 'llm' }
    } catch (error) {
      return { ...normalizeDecision({}, fallback, actorId(enemy)), provider: 'deterministic-morale-fallback', provider_error: String(error?.code ?? error?.name ?? 'LLM_PROVIDER_ERROR').slice(0, 80) }
    }
  }
}

function farthestReachableDestination(state, enemyId) {
  const enemy = findActor(state, enemyId)
  const from = actorPosition(state, enemyId)
  if (!enemy || !from) return null
  const speed = Number(enemy.speed)
  const maximumSteps = Math.max(1, Math.floor((Number.isFinite(speed) ? speed : 30) / 5))
  const heroes = (state.players ?? []).filter(isLivingActor).map((hero) => actorPosition(state, actorId(hero))).filter(Boolean)
  const candidates = (state.scene?.cells ?? []).filter((cell) => cell.revealed === true && (cell.type === 'floor' || cell.type === 'door'))
  let best = null
  for (const cell of candidates) {
    const path = shortestTacticalPath(state, enemyId, { x: Number(cell.x), y: Number(cell.y) })
    if (!path?.length || path.length > maximumSteps) continue
    const destination = path[path.length - 1]
    const heroDistance = heroes.length
      ? Math.min(...heroes.map((hero) => Math.max(Math.abs(destination.x - hero.x), Math.abs(destination.y - hero.y))))
      : path.length
    const edgeDistance = Math.min(destination.x, destination.y, Math.max(0, Number(state.scene?.grid?.width ?? 0) - 1 - destination.x), Math.max(0, Number(state.scene?.grid?.height ?? 0) - 1 - destination.y))
    const score = heroDistance * 100 + path.length * 4 - edgeDistance
    if (!best || score > best.score) best = { score, destination }
  }
  return best?.destination ?? null
}

export function commandsForMoraleDecision(state, enemyId, decision, ordinaryCommands = []) {
  const actor = String(enemyId)
  if (!decision || !DISPOSITIONS.has(decision.disposition)) return ordinaryCommands
  if (decision.disposition === 'fight') {
    return [{ command_type: 'AddCondition', actor_id: actor, target_id: actor, condition: 'morale-tested' }, ...ordinaryCommands]
  }
  if (decision.disposition === 'flee') {
    const destination = farthestReachableDestination(state, actor)
    if (destination) return [
      { command_type: 'MoveActor', actor_id: actor, to: destination },
      { command_type: 'AddCondition', actor_id: actor, target_id: actor, condition: 'fled' },
    ]
  }
  return [{ command_type: 'AddCondition', actor_id: actor, target_id: actor, condition: 'surrendered' }]
}
