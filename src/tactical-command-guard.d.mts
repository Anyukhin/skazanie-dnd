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
