import { useRef } from 'react'
import { tacticalOverviewFocus, type LocationOverviewEntry } from './scene-art'
import type { TacticalMap } from './types'

/** Обзор места не содержит фишек и не отправляет игровые команды. */
export function LocationOverview({ overview, map }: { overview: LocationOverviewEntry | null; map: TacticalMap | null }) {
  const dialog = useRef<HTMLDialogElement>(null)
  if (!overview) return null
  const focus = tacticalOverviewFocus(overview, map)
  return <>
    <button className="location-overview-button" onClick={() => dialog.current?.showModal()}>Общий план</button>
    <dialog className="location-overview-dialog" ref={dialog} aria-label={`Общий план: ${overview.name}`}>
      <header><h2>{overview.name}</h2><button onClick={() => dialog.current?.close()} aria-label="Закрыть общий план">Закрыть</button></header>
      <div className="location-overview-plan">
        <img src={overview.url} alt={`Общий план локации ${overview.name}`} />
        {focus && <span className="location-overview-focus" role="note" aria-label={`Вы здесь: ${overview.firstPlayableZone}`}
          data-align={focus.x < .35 ? 'left' : focus.x > .65 ? 'right' : 'center'} data-below={focus.y < .35 || undefined}
          style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }}>
          <span className="location-overview-focus-dot" aria-hidden="true" />
          <span className="location-overview-focus-label"><strong>Вы здесь</strong><span className="location-overview-focus-name">{overview.firstPlayableZone}</span></span>
        </span>}
      </div>
      <p>Участок для перемещения и боя: {overview.firstPlayableZone}.</p>
    </dialog>
  </>
}
