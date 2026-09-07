import { useMemo } from 'react'
import { TacticalBoard, type BoardCellNode } from './TacticalBoard'
import { decodeTacticalMap, tacticalMapFromCells } from './tactical-map-client'
import type { GameEvent, MapCell, SerializedTacticalMap } from './types'

export type LabBoardActor = { id: string; name: string; side: 'party' | 'enemy'; hp: number; maxHp: number; x: number; y: number; image?: string; conditions?: string[] }
export function CombatLabBoard({ map: serialized, cells, actors, activeActorId, onPlace, events = [], frameId = '' }: {
  map?: SerializedTacticalMap; cells: { x: number; y: number; type: string; difficult?: boolean }[]; actors: LabBoardActor[]
  activeActorId?: string | null; onPlace?: (x: number, y: number) => void; events?: GameEvent[]; frameId?: string
}) {
  const map = useMemo(() => serialized ? decodeTacticalMap(serialized) : tacticalMapFromCells(cells.map((cell) => ({ ...cell, type: cell.type === 'wall' ? 'wall' : 'floor', revealed: true }) as MapCell)), [serialized, cells])
  const nodes: BoardCellNode[] = cells.flatMap((cell) => {
    const occupants = actors.filter((actor) => actor.x === cell.x && actor.y === cell.y)
    if (!onPlace && !occupants.length) return []
    return [{ x: cell.x, y: cell.y, className: 'combat-lab-board-cell', interactive: Boolean(onPlace && cell.type !== 'wall'),
      ariaLabel: occupants.length ? occupants.map((actor) => `${actor.name}, ${actor.hp} из ${actor.maxHp} ОЗ`).join('; ') : `Клетка ${cell.x}, ${cell.y}`,
      onActivate: onPlace && cell.type !== 'wall' ? () => onPlace(cell.x, cell.y) : undefined,
      children: occupants.map((actor) => <span key={actor.id} className={`combat-lab-piece ${actor.side} ${actor.id === activeActorId ? 'selected' : ''} ${actor.hp <= 0 ? 'fallen' : ''}`} title={`${actor.name}: ${actor.hp}/${actor.maxHp} ОЗ`}>
        {actor.image?.startsWith('/assets/') ? <img src={actor.image} alt="" /> : <b>{actors.indexOf(actor) + 1}</b>}
        <span className="combat-lab-piece-health"><span style={{ width: `${100 * Math.max(0, Math.min(1, actor.hp / actor.maxHp))}%` }} /></span>
      </span>),
    }]
  })
  return <div className="combat-lab-board"><TacticalBoard map={map} columns={map?.width ?? 10} rows={map?.height ?? 5} irregular={false}
    ariaLabel={onPlace ? 'Расстановка участников на карте' : 'Карта боя'} themeKey="combat-lab" artUrl={null} cells={nodes} overlayCells={[]}
    lighting={false} campaignId="combat-lab" animationsEnabled={!onPlace} visualBatch={frameId ? { id: frameId, events, npcTurns: [] } : null}
    animationActors={actors.map((actor) => ({ id: actor.id, x: actor.x, y: actor.y, label: actor.name, kind: actor.side === 'party' ? 'hero' : 'enemy' }))}
  /></div>
}
