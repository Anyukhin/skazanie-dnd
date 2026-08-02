import { SCREEN_MUSIC_TRACKS, screenMusicTrack, screenMusicVolume } from './atmosphere-screen.mjs'

/**
 * Музыка экранов создания мира и героя.
 *
 * Отдельный проигрыватель, а не слой процедурной атмосферы: это готовые файлы,
 * их незачем гонять через синтез и незачем держать в общем звуковом графе,
 * который живёт всю сессию. Здесь обычный `<audio>` — он умеет всё, что нужно:
 * зациклить, приглушить и остановиться.
 *
 * Файлы грузятся лениво, при первом заходе на экран: вместе они весят почти
 * шесть мегабайт, и тянуть их в бандл ради экрана, куда игрок заходит дважды за
 * кампанию, было бы платой за то, чем он почти не пользуется.
 *
 * Громкость берётся из той же настройки, что и вся атмосфера: своей ручки у
 * этой музыки нет и не заводится.
 */

export type ScreenMusicSettings = {
  ambientVolume: number
  muted: boolean
}

export type ScreenMusicPlayer = {
  setScreen(screen: string): void
  setSettings(settings: ScreenMusicSettings): void
  stop(): void
  dispose(): void
}

const canPlay = () => typeof window !== 'undefined' && typeof window.Audio === 'function'

export function createScreenMusic(initial: ScreenMusicSettings): ScreenMusicPlayer {
  let settings = initial
  let screen = ''
  let element: HTMLAudioElement | null = null
  let disposed = false

  const applyVolume = () => {
    if (!element) return
    // Множитель дорожки поверх пользовательской громкости: музыка мастеров не
    // должна быть громче игрового фона, иначе переход в комнату звучит провалом.
    element.volume = settings.muted ? 0 : Math.max(0, Math.min(1, settings.ambientVolume * screenMusicVolume(screen)))
  }

  const stopTrack = () => {
    if (!element) return
    element.pause()
    // Ссылку рвём явно: иначе браузер держит загруженный буфер до сборки мусора.
    element.removeAttribute('src')
    element.load()
    element = null
  }

  return {
    setScreen(next) {
      if (disposed || screen === next) return
      screen = next
      const track = screenMusicTrack(next)
      if (!track) {
        stopTrack()
        return
      }
      if (!canPlay()) return
      stopTrack()
      const audio = new Audio(track)
      audio.loop = true
      // Ленивая загрузка: файл начинает качаться только сейчас, при заходе.
      audio.preload = 'auto'
      element = audio
      applyVolume()
      // Автозапуск может быть запрещён до жеста пользователя. Это не ошибка:
      // на экран мастера игрок попадает нажатием, и следующий заход сработает.
      void audio.play().catch(() => {})
    },
    setSettings(next) {
      settings = next
      applyVolume()
    },
    stop() {
      screen = ''
      stopTrack()
    },
    dispose() {
      disposed = true
      screen = ''
      stopTrack()
    },
  }
}

export { SCREEN_MUSIC_TRACKS }
