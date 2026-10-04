export function canIssueUiTacticalCommand(combat, command, currentActorId) {
  if (!combat?.active) return true
  if (command?.command_type === 'AttackNpc') return false
  if (['StartCombat', 'ResolveHeroDeath'].includes(command?.command_type)) return true
  // Режим реакции — заранее данный ответ, а не действие: его меняют в чужой ход,
  // ровно тогда, когда реакции и случаются. Сервер очередь здесь не проверяет.
  if (command?.command_type === 'SetReactionPreference') return true
  // Уговор на переговорах заключает отряд, а не тот, на ком стоит указатель
  // инициативы: перемирие эту очередь уже заморозило. Сервер проверяет то же
  // самое — здесь только не мешаем нажать кнопку карточки условий.
  if (command?.command_type === 'SettleParley') return Boolean(combat.truce)
  if (command?.actor_id === currentActorId) return true
  if (command?.command_type !== 'UseCombatAction') return false

  const reactionWindow = combat.reaction_window
  if (!reactionWindow || reactionWindow.actor_id !== command.actor_id) return false
  if (command.action_id === 'decline-reaction') return true
  return Array.isArray(reactionWindow.action_ids) && reactionWindow.action_ids.includes(command.action_id)
}

export const ENERVATION_TARGET_REASON = 'Продолжение доступно только для исходной цели'

/**
 * Продолжение «Обессиливания» получает target_id только из server-owned
 * action.effect. Остальные действия не получают клиентского ограничения.
 */
export function combatActionTargetGuard(action, targetId) {
  if (String(action?.id ?? '') !== 'enervation-repeat') return { allowed: true, reason: null }
  const effect = action?.effect
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return { allowed: true, reason: null }
  const sourceTargetId = effect.target_id
  if (typeof sourceTargetId !== 'string' || !sourceTargetId) return { allowed: true, reason: null }
  return String(targetId ?? '') === sourceTargetId
    ? { allowed: true, reason: null }
    : { allowed: false, reason: ENERVATION_TARGET_REASON }
}
