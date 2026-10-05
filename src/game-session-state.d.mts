import type { NarrationPreview } from './ai-client'
import type { AiTurnResult, CombatMechanics, GameState, TwoPhaseCheckCommand } from './types'

/** Поля ответа команды, которые читает слияние: только реплика повествования. */
export type TacticalNarrationFields = {
  narration?: string
  turn_id?: string | null
  narration_message_id?: string | null
  narration_speaker?: 'narrator' | 'system'
  narration_author?: string
}

export function twoPhaseCheckCommandFor(command: { command_type: string; intent?: unknown }): TwoPhaseCheckCommand | null

export const NARRATION_PREVIEW_TEXT_MAX_BYTES: number
export const NARRATION_PREVIEW_EVENT_MAX_BYTES: number
export function parseNarrationPreview(value: string): NarrationPreview | null

export function pendingActionForSnapshot(current: GameState, incoming: GameState): GameState['pendingAction'] | null
export function latestRoomVersion(current: number, candidate: unknown): number

export function combatTurnActive(state: Pick<GameState, 'mechanics'>): boolean
export function activeInitiativeIndex(combat: Pick<CombatMechanics, 'active_index'> | null | undefined): number
export function currentTurnActorId(state: Pick<GameState, 'mechanics' | 'activePlayerId'>): string

export function mergeTacticalCommandState(current: GameState, authoritative: GameState, result: TacticalNarrationFields & Record<string, unknown>, requestId: string): GameState
export function mergeAuthoritativeState(current: GameState, result: AiTurnResult | null): GameState
