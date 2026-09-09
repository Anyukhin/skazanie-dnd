import { useMemo, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { TacticalBoard, type BoardCellNode } from './TacticalBoard'
import { decodeTacticalMap, passableAt, tacticalMapFromCells } from './tactical-map-client'
import type { GameEvent, MapCell, SerializedTacticalMap } from './types'

export type LabBoardActor = { id: string; name: string; side: 'party' | 'enemy'; hp: number; maxHp: number; x: number; y: number; image?: string; conditions?: string[] }
export function CombatLabBoard({ map: serialized, cells, actors, activeActorId, onPlace, events = [], frameId = '', preview = false, selectedActorId, onSelectActor }: {
  map?: SerializedTacticalMap; cells: { x: number; y: number; type: string; difficult?: boolean }[]; actors: LabBoardActor[]
  activeActorId?: string | null; onPlace?: (x: number, y: number) => void; events?: GameEvent[]; frameId?: string; preview?: boolean
  selectedActorId?: string | null; onSelectActor?: (id: string) => void
}) {
  const [viewReset, setViewReset] = useState(0)
  const map = useMemo(() => serialized ? decodeTacticalMap(serialized) : tacticalMapFromCells(cells.map((cell) => ({ ...cell, type: cell.type === 'wall' ? 'wall' : 'floor', revealed: true }) as MapCell)), [serialized, cells])
  const nodes: BoardCellNode[] = cells.flatMap((cell) => {
    const occupants = actors.filter((actor) => actor.x === cell.x && actor.y === cell.y)
    const placeable = map ? passableAt(map, cell.x, cell.y) : !['wall', 'water', 'void'].includes(cell.type)
    if (!onPlace && !occupants.length) return []
    return [{ x: cell.x, y: cell.y, className: 'combat-lab-board-cell', interactive: Boolean(onPlace && placeable || onSelectActor && occupants.length),
      ariaLabel: occupants.length ? occupants.map((actor) => preview ? actor.name : `${actor.name}, ${actor.hp} из ${actor.maxHp} ОЗ`).join('; ') : `Клетка ${cell.x}, ${cell.y}`,
      onActivate: onPlace && placeable ? () => onPlace(cell.x, cell.y) : onSelectActor && occupants[0] ? () => onSelectActor(occupants[0].id) : undefined,
      children: occupants.map((actor) => <span key={actor.id} className={`combat-lab-piece ${actor.side} ${actor.id === activeActorId ? 'selected' : ''} ${actor.id === selectedActorId ? 'inspected' : ''} ${actor.hp <= 0 ? 'fallen' : ''}`} title={preview ? actor.name : `${actor.name}: ${actor.hp}/${actor.maxHp} ОЗ`}>
        {actor.image?.startsWith('/assets/') ? <img src={actor.image} alt="" /> : <b>{actors.indexOf(actor) + 1}</b>}
        {!preview && <span className="combat-lab-piece-health"><span style={{ width: `${100 * Math.max(0, Math.min(1, actor.hp / Math.max(1, actor.maxHp)))}%` }} /></span>}
      </span>),
    }]
  })
  return <div className="combat-lab-board"><div className="combat-lab-board-controls"><span>Клетка — 5 футов. Масштаб: Alt + колесо.</span><button onClick={() => setViewReset((value) => value + 1)}><Maximize2 size={14} />Вся карта</button></div><div className="combat-lab-board-viewport"><TacticalBoard map={map} columns={map?.width ?? 10} rows={map?.height ?? 5} irregular={false}
    ariaLabel={onPlace ? 'Расстановка участников на карте' : 'Карта боя'} themeKey="combat-lab" artUrl={null} cells={nodes} overlayCells={[]}
    lighting={false} campaignId={preview ? 'combat-lab-setup' : 'combat-lab-playback'} viewResetKey={`${map?.locationId}:${viewReset}`} wheelZoomRequiresAltKey animationsEnabled={!preview} visualBatch={frameId ? { id: frameId, events, npcTurns: [] } : null}
    animationActors={actors.map((actor) => ({ id: actor.id, x: actor.x, y: actor.y, label: actor.name, kind: actor.side === 'party' ? 'hero' : 'enemy', defeated: actor.hp <= 0 }))}
  /></div></div>
}
