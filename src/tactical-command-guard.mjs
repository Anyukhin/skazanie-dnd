export function canIssueUiTacticalCommand(combat, command, currentActorId) {
  if (!combat?.active) return true
  if (['StartCombat', 'ResolveHeroDeath'].includes(command?.command_type)) return true
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
