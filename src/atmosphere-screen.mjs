/**
 * Насколько громко звучит фон на текущем экране — по живому отзыву владельца:
 * «при запуске не будет звуков или они должны быть тихими».
 *
 * До этого громкость зависела только от настройки игрока, а настроение — от
 * темы сцены. Поэтому список кампаний и оба мастера звучали ровно как игровая
 * комната: игрок ещё выбирает кампанию, а из колонок уже идёт таверна.
 *
 * Здесь **только громкость**. Своих музыкальных тем у этих экранов нет и не
 * заводится: чем именно им звучать — отдельное решение владельца, и придумывать
 * его за него нельзя. Пока фон либо молчит, либо звучит заметно тише.
 *
 * Функции чистые, без DOM и Web Audio, поэтому покрыты `node:test`; сам синтез
 * остаётся в `atmosphere-audio.ts`.
 */

/**
 * Экраны в порядке приоритета: мастер важнее списка, список важнее комнаты.
 * Порядок и есть правило — если мастер героя открыт поверх списка кампаний,
 * решает мастер.
 */
export const ATMOSPHERE_SCREENS = Object.freeze(['hero-forge', 'world-forge', 'lobby', 'play'])

/**
 * Приглушение фона по экрану. Множитель поверх пользовательской громкости, а
 * не её замена: настройка звука остаётся единственным местом, где игрок задаёт
 * уровень.
 *
 * Вход и список кампаний — полная тишина: владелец просил «не будет звуков или
 * очень тихо», и тишина здесь однозначнее любого подобранного числа. Мастера
 * приглушены, но не выключены: работа за столом уже началась, и мёртвая тишина
 * читалась бы как поломка.
 */
const SCREEN_ATTENUATION = Object.freeze({
  lobby: 0,
  'world-forge': 0.25,
  'hero-forge': 0.25,
  play: 1,
})

/**
 * Музыка мастеров. Владелец выбрал по дорожке на экран; процедурного фона у
 * этих экранов по-прежнему нет — вместо него играет файл.
 *
 * Пути, а не импорты: файлы весят почти шесть мегабайт вместе и грузятся
 * лениво, при заходе на экран, а не вместе с бандлом.
 */
export const SCREEN_MUSIC_TRACKS = Object.freeze({
  'hero-forge': '/assets/audio/character-creation-old-tower-inn.mp3',
  'world-forge': '/assets/audio/world-creation-noonday-feast.mp3',
})

/**
 * Громкость дорожки как доля пользовательской настройки. Умеренно и заведомо
 * не громче игрового фона: переход из мастера в комнату не должен звучать
 * провалом громкости.
 */
const SCREEN_MUSIC_VOLUME = 0.7

/**
 * Дорожка для экрана либо `null`. Прихожая молчит намеренно: владелец просил
 * «при запуске не будет звуков», и музыку туда не ставили.
 *
 * @param {string} screen
 * @returns {string | null}
 */
export function screenMusicTrack(screen) {
  return SCREEN_MUSIC_TRACKS[screen] ?? null
}

/**
 * Доля пользовательской громкости для дорожки этого экрана.
 *
 * @param {string} screen
 * @returns {number}
 */
export function screenMusicVolume(screen) {
  return screenMusicTrack(screen) ? SCREEN_MUSIC_VOLUME : 0
}

/**
 * Экран по флагам приложения. Флаги приходят как есть из состояния React, и
 * решение принимается здесь, а не тремя `?:` в компоненте.
 *
 * @param {{ authenticated?: boolean, campaignListOpen?: boolean, worldWizardOpen?: boolean, heroWizardOpen?: boolean }} flags
 * @returns {'hero-forge' | 'world-forge' | 'lobby' | 'play'}
 */
export function atmosphereScreenFor(flags = {}) {
  if (flags.authenticated === false) return 'lobby'
  if (flags.heroWizardOpen === true) return 'hero-forge'
  if (flags.worldWizardOpen === true) return 'world-forge'
  if (flags.campaignListOpen === true) return 'lobby'
  return 'play'
}

/**
 * Во сколько раз тише фон на этом экране. Незнакомый экран считается игровым:
 * ошибиться в сторону обычной громкости безопаснее, чем молча выключить звук.
 *
 * @param {string} screen
 * @returns {number}
 */
export function atmosphereScreenAttenuation(screen) {
  const value = SCREEN_ATTENUATION[screen]
  return typeof value === 'number' ? value : 1
}
