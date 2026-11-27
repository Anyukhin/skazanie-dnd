/** Это лишь выбор клиентского маршрута. Сервер проверяет происхождение решения. */
export function isDirectorPartyDecision(interaction) {
  return interaction?.type === 'vote' && String(interaction?.id ?? '').startsWith('autonomy-')
}
