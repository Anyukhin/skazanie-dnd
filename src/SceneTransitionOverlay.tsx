import { useEffect, useState } from 'react'
import { Compass, DoorOpen, Map, MapPin, Navigation, Sparkles, X } from 'lucide-react'
import type { GameState, WorldMapLocation } from './types'
import { KIND_LABELS, currentWorldLocation, reachableDestinations, travelProposalText, type TravelDestination } from './world-travel'

/**
 * Две карточки перехода между локациями поверх доски.
 *
 * `LeaveLocationPicker` — ответ на кнопку «Покинуть локацию». Раньше кнопка
 * сразу уводила отряд «куда-нибудь»: Архитектор придумывал промежуточную
 * дорогу, и игрок видел ту же пустую карту. Теперь сначала спрашивается, куда
 * именно: соседи по карте мира с дорогой до них, «пусть решит Рассказчик» —
 * прежний путь, и переход к глобальной карте.
 *
 * `SceneTransitionBanner` — знак смены сцены. Сервер менял карту молча: новое
 * название мелким шрифтом в шапке, герой на клетке входа — и всё. Теперь смена
 * главы объявляется плашкой, которую нельзя не заметить, с тем, откуда и куда
 * пришёл отряд.
 */

export function travelDestinationsFor(state: Pick<GameState, 'scene' | 'worldMap'>): TravelDestination[] {
  return reachableDestinations(state)
}

export function LeaveLocationPicker({ state, busy, onTravel, onNarratorDecides, onOpenWorldMap, onClose }: {
  state: GameState
  busy: boolean
  /** Отряд назвал место: текст в формате глобальной карты. */
  onTravel: (action: string) => void
  /** Прежний путь — уйти, не называя места. */
  onNarratorDecides: () => void
  onOpenWorldMap: () => void
  onClose: () => void
}) {
  const current = currentWorldLocation(state)
  const destinations = travelDestinationsFor(state)
  const from = state.scene.location || state.scene.title
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const choose = (destination: TravelDestination) => {
    if (!current || busy) return
    onTravel(travelProposalText(current, destination.location, destination.routeNames))
  }
  return <section className="leave-location-picker" role="dialog" aria-label="Куда отправиться">
    <header>
      <DoorOpen size={16} />
      <span><small>Решение группы</small><strong>Куда отправиться из «{from}»?</strong></span>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть выбор пути"><X size={15} /></button>
    </header>
    {destinations.length > 0
      ? <ul className="leave-location-destinations">
        {destinations.map((destination) => <li key={destination.location.id}>
          <button type="button" disabled={busy} onClick={() => choose(destination)} title={`Путь: ${destination.routeNames.join(' → ')}`}>
            <DestinationIcon kind={destination.location.kind} />
            <span>
              <strong>{destination.location.name}</strong>
              <small>{KIND_LABELS[destination.location.kind]} · ≈ {destination.days} дн. · опасность {destination.danger}{destination.location.visited ? ' · посещено' : ''}</small>
            </span>
          </button>
        </li>)}
      </ul>
      : <p className="leave-location-empty">Из этого места ещё не известно ни одной дороги. Рассказчик найдёт путь сам.</p>}
    <footer>
      <button type="button" className="leave-location-narrator" disabled={busy} onClick={onNarratorDecides}>
        <Sparkles size={15} /><span><strong>Куда глаза глядят</strong><small>Пусть Рассказчик решит, что за поворотом</small></span>
      </button>
      {state.worldMap && <button type="button" className="leave-location-world-map" onClick={onOpenWorldMap}>
        <Map size={15} /><span><strong>Глобальная карта</strong><small>Выбрать путь на карте мира</small></span>
      </button>}
    </footer>
    <small className="leave-location-note">Переход начнётся после решения группы: за одного героя оно принимается сразу.</small>
  </section>
}

function DestinationIcon({ kind }: { kind: WorldMapLocation['kind'] }) {
  if (kind === 'wilds' || kind === 'landmark') return <Compass size={16} />
  if (kind === 'ruin' || kind === 'dungeon' || kind === 'fortress') return <Navigation size={16} />
  return <MapPin size={16} />
}

export type SceneTransitionNotice = {
  /** Ключ смены сцены — чтобы плашка не повторялась на каждом опросе комнаты. */
  key: string
  chapter: number
  title: string
  location: string
  from: string
  kind?: WorldMapLocation['kind']
}

/**
 * Что изменилось между двумя снимками сцены. `null` — сцена та же или это
 * первая загрузка кампании, о которой объявлять нечего.
 */
export function sceneTransitionNotice(previous: GameState | null, next: GameState): SceneTransitionNotice | null {
  if (!previous || previous.sessionCode !== next.sessionCode) return null
  const previousKey = previous.scene.location_id ?? previous.scene.location
  const nextKey = next.scene.location_id ?? next.scene.location
  if (!previousKey || !nextKey || previousKey === nextKey) return null
  const location = next.worldMap?.locations.find((candidate) => candidate.id === next.scene.location_id)
    ?? next.worldMap?.locations.find((candidate) => candidate.name === next.scene.location)
  return {
    key: `${next.sessionCode}:${nextKey}:${next.adventure?.chapter ?? 0}`,
    chapter: next.adventure?.chapter ?? 0,
    title: next.scene.title,
    location: next.scene.location,
    from: previous.scene.location || previous.scene.title,
    kind: location?.kind,
  }
}

export function SceneTransitionBanner({ notice, onClose }: { notice: SceneTransitionNotice; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    setLeaving(false)
    const fade = window.setTimeout(() => setLeaving(true), 7_600)
    const close = window.setTimeout(onClose, 8_400)
    return () => { window.clearTimeout(fade); window.clearTimeout(close) }
  }, [notice.key, onClose])
  // Детерминированный Архитектор называет сцену «Глава N · Место» — это уже
  // сказано строкой выше, и повторять нечего. Авторский заголовок («Развилка
  // под зелёными знаками») — другое дело, его показываем.
  const subtitle = notice.title.replace(/^глава\s+\d+\s*[·:—-]\s*/iu, '').trim()
  return <section className={`scene-transition-banner${leaving ? ' leaving' : ''}`} role="status" aria-live="polite" onClick={onClose}>
    <small>{notice.chapter > 0 ? `Глава ${notice.chapter} · ` : ''}Новая локация{notice.kind ? ` · ${KIND_LABELS[notice.kind]}` : ''}</small>
    <strong>{notice.location}</strong>
    {subtitle && subtitle !== notice.location && <em>{subtitle}</em>}
    <span><MapPin size={13} />из «{notice.from}»</span>
  </section>
}
