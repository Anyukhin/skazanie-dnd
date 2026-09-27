export interface UiCombatGuardState {
  active?: boolean
  reaction_window?: {
    actor_id?: string
    action_ids?: string[]
  } | null
}

export interface UiTacticalGuardCommand {
  command_type?: string
  actor_id?: string
  action_id?: string
}

export function canIssueUiTacticalCommand(combat: UiCombatGuardState | null | undefined, command: UiTacticalGuardCommand, currentActorId: string | undefined): boolean

export const ENERVATION_TARGET_REASON: string

export interface UiCombatActionTarget {
  id?: string
  effect?: Record<string, unknown> | null
}

export interface UiCombatActionTargetGuard {
  allowed: boolean
  reason: string | null
}

export function combatActionTargetGuard(action: UiCombatActionTarget | null | undefined, targetId: string | null | undefined): UiCombatActionTargetGuard
