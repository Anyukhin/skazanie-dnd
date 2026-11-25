/**
 * Отличает уже импортированный стартовый лист от пустого слота, который по
 * умолчанию тоже выглядит как воин первого уровня.
 */
export function pilotImportAlreadyStarted(player, build) {
  return Boolean(
    player?.characterSetupRequired === true
    && String(player?.characterClass ?? '') === String(build?.class ?? '')
    && String(player?.species ?? '') !== 'Не выбран'
    && String(player?.background ?? '') !== 'Не выбрано'
    && String(player?.character ?? '').trim(),
  )
}
