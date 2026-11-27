/** Это лишь выбор клиентского маршрута. Сервер проверяет происхождение решения. */
export function isDirectorPartyDecision(interaction) {
  return interaction?.type === 'vote' && String(interaction?.id ?? '').startsWith('autonomy-')
}

/** После последнего голоса за путь до известной точки сервер сам исполняет решение. */
export function isAutomaticWorldTravel(interaction) {
  return interaction?.type === 'vote' && !isDirectorPartyDecision(interaction)
    && Boolean(interaction.destinationLocationId)
}
