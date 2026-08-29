import { useMemo, useState } from 'react'
import { Castle, Check, Clock3, Compass, MapPin, Minus, Mountain, Navigation, Plus, Route, ScrollText, Trees } from 'lucide-react'
import type { GameState, WorldMapLocation, WorldMapRoute } from './types'
import { KIND_LABELS, ROUTE_LABELS, currentWorldLocation, routeDanger, shortestRoute, travelProposalText } from './world-travel'
import './world-map.css'

function seedNumber(value: string) {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return result >>> 0
}

function randomFor(value: string) {
  let state = seedNumber(value) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function routePath(route: WorldMapRoute, byId: Map<string, WorldMapLocation>) {
  const from = byId.get(route.from)
  const to = byId.get(route.to)
  if (!from || !to) return ''
  const random = randomFor(route.id)
  const mx = (from.x + to.x) / 2 + (random() - .5) * 54
  const my = (from.y + to.y) / 2 + (random() - .5) * 42
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`
}

function Terrain({ state }: { state: GameState }) {
  const map = state.worldMap!
  const ornaments = useMemo(() => map.regions.flatMap((region) => {
    const random = randomFor(`${map.seed}:${region.id}:terrain`)
    const count = region.biome === 'forest' ? 34 : region.biome === 'mountains' ? 22 : region.biome === 'marsh' ? 18 : 10
    return Array.from({ length: count }, (_, index) => {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random()) * region.radius * .72
      return { id: `${region.id}-${index}`, biome: region.biome, x: region.x + Math.cos(angle) * radius, y: region.y + Math.sin(angle) * radius, scale: .65 + random() * .65 }
    })
  }), [map.seed, map.regions])
  return <g className="world-terrain" aria-hidden="true">
    {map.regions.map((region) => <ellipse key={region.id} className={`world-region-fill biome-${region.biome}`} cx={region.x} cy={region.y} rx={region.radius} ry={region.radius * .72} />)}
    {ornaments.map((item) => item.biome === 'mountains' || item.biome === 'tundra'
      ? <g key={item.id} className="terrain-mountain" transform={`translate(${item.x} ${item.y}) scale(${item.scale})`}><path d="M-15 10 0-14 15 10Z"/><path d="m-6-3 6-11 5 9-5-3z"/></g>
      : item.biome === 'forest'
        ? <g key={item.id} className="terrain-tree" transform={`translate(${item.x} ${item.y}) scale(${item.scale})`}><path d="M0-10-7 2h4l-5 7H8L3 2h4Z"/><path d="M0 7v5"/></g>
        : item.biome === 'marsh' || item.biome === 'coast'
          ? <path key={item.id} className="terrain-water" d={`M ${item.x - 10} ${item.y} q 5 -4 10 0 t 10 0`} />
          : <circle key={item.id} className="terrain-dot" cx={item.x} cy={item.y} r={1.2 * item.scale} />)}
    {map.regions.map((region) => <text key={`${region.id}-label`} className="world-region-label" x={region.x} y={region.y - region.radius * .47}>{region.name}</text>)}
  </g>
}

function LocationMarker({ location, selected, current, onSelect }: { location: WorldMapLocation; selected: boolean; current: boolean; onSelect: () => void }) {
  const major = ['capital', 'city', 'fortress'].includes(location.kind)
  return <g
    className={`world-location ${major ? 'major' : ''} ${selected ? 'selected' : ''} ${current ? 'current' : ''} ${location.visited ? 'visited' : ''}`}
    transform={`translate(${location.x} ${location.y})`}
    role="button"
    tabIndex={0}
    aria-label={`${location.name}${current ? ', здесь находится отряд' : ''}`}
    aria-current={current ? 'location' : undefined}
    aria-pressed={selected}
    onClick={onSelect}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}
  >
    <circle className="location-hit" r="26" />
    {location.kind === 'capital' || location.kind === 'city' ? <><circle className="location-ring" r={major ? 8 : 6}/><circle className="location-core" r={major ? 3.2 : 2.6}/></>
      : location.kind === 'fortress' ? <path className="location-symbol" d="M-8 7V-6h4v4h3v-4h4v4h3v-4h4V7Z" />
        : location.kind === 'ruin' || location.kind === 'dungeon' ? <path className="location-symbol" d="M-7 7 0-8 7 7Zm4-2h6" />
          : location.kind === 'port' ? <path className="location-symbol" d="M0-8v14m-6-9h12M-8 3q8 9 16 0" />
            : <><circle className="location-ring" r="5"/><circle className="location-core" r="2"/></>}
    {current && <g className="party-pin" transform="translate(0 -18)"><path d="M0 10C-9-1-7-9 0-9S9-1 0 10Z"/><circle cy="-3" r="2.5"/></g>}
    <text className="location-label" y={current ? 28 : 20}>{location.name}</text>
  </g>
}

export function WorldMapView({ state, busy, onTravel }: { state: GameState; busy: boolean; onTravel: (action: string) => void }) {
  const map = state.worldMap
  const [selectedId, setSelectedId] = useState(() => map?.currentLocationId ?? '')
  const [zoom, setZoom] = useState(1)
  if (!map) return <section className="world-map-empty"><Compass size={40}/><h1>Карта мира составляется</h1><p>Хранитель мира ещё связывает места этой кампании с географией.</p></section>

  const current = currentWorldLocation(state)
  const knownLocations = map.locations.filter((location) => location.known || location.visited || location.id === current?.id)
  const byId = new Map(knownLocations.map((location) => [location.id, location]))
  const selected = byId.get(selectedId) ?? current
  const route = shortestRoute(current?.id ?? '', selected?.id ?? '', map.routes)
  const routeIds = new Set(route.routes.map((item) => item.id))
  const routeNames = route.locationIds.map((id) => byId.get(id)?.name).filter(Boolean) as string[]
  const nextStop = route.locationIds.length > 2 ? byId.get(route.locationIds[1]) : selected
  const totalDays = route.routes.reduce((sum, item) => sum + item.distance, 0)
  const highestDanger = routeDanger(route.routes)
  const selectedRegion = map.regions.find((region) => region.id === selected?.regionId)
  const viewWidth = map.width / zoom
  const viewHeight = map.height / zoom
  const focusX = selected?.x ?? map.width / 2
  const focusY = selected?.y ?? map.height / 2
  const viewX = Math.max(0, Math.min(map.width - viewWidth, focusX - viewWidth / 2))
  const viewY = Math.max(0, Math.min(map.height - viewHeight, focusY - viewHeight / 2))
  const combatActive = state.mechanics?.combat?.active === true
  const travelBlocked = busy || combatActive || !current

  // Формат строки — договор с сервером, а не проза (`travelProposalText`,
  // `src/world-travel.ts`): `detectPartyExitRequest` читает маркер и берёт из
  // кавычек первое место как исходное, а второе как пункт назначения. Пока
  // договора не было, кнопка отправляла текст, который не подходил ни под один
  // шаблон ухода: голосование не открывалось, решения группы не появлялось, а
  // без него сервер отказывается менять сцену — кнопка не работала вовсе.
  // Сторож на обе стороны — `test/party-exit-intent.test.mjs`.
  const proposeTravel = () => {
    if (!selected || !current || selected.id === current.id || !route.locationIds.length || travelBlocked) return
    onTravel(travelProposalText(current, selected, routeNames))
  }

  return <section className="world-map-page">
    <header className="world-map-header">
      <div><span>ГЕОГРАФИЯ КАМПАНИИ</span><h1>{map.name}</h1><p>{state.campaignConcept?.worldSummary ?? 'Известные земли, дороги и места этой истории.'}</p></div>
      <div className="world-map-stats"><span><MapPin size={14}/>{knownLocations.length} мест</span><span><Route size={14}/>{map.routes.filter((item) => item.discovered).length} путей</span></div>
    </header>

    <div className="world-map-layout">
      <div className="world-map-frame">
        <svg className="world-map-canvas" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="img" aria-label={`Глобальная карта кампании ${state.campaign}`}>
          <defs>
            <filter id="paper-grain"><feTurbulence baseFrequency=".72" numOctaves="3" seed={seedNumber(map.seed) % 97}/><feColorMatrix values="0 0 0 0 .25 0 0 0 0 .2 0 0 0 0 .12 0 0 0 .15 0"/><feBlend in="SourceGraphic" mode="multiply"/></filter>
            <pattern id="map-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".7"/><circle cx="14" cy="12" r=".5"/></pattern>
          </defs>
          <rect className="world-paper" width={map.width} height={map.height}/>
          <rect className="world-paper-dots" width={map.width} height={map.height} fill="url(#map-dots)"/>
          <Terrain state={state}/>
          <g className="world-routes">
            {map.routes.filter((item) => item.discovered && byId.has(item.from) && byId.has(item.to)).map((item) => <path key={item.id} className={`world-route route-${item.kind} danger-${item.danger} ${routeIds.has(item.id) ? 'selected' : ''}`} d={routePath(item, byId)}/>)}
          </g>
          <g className="world-locations">
            {knownLocations.map((location) => <LocationMarker key={location.id} location={location} selected={selected?.id === location.id} current={current?.id === location.id} onSelect={() => setSelectedId(location.id)}/>)}
          </g>
          <g className="compass-rose" transform={`translate(${viewX + viewWidth - 55 / zoom} ${viewY + 58 / zoom}) scale(${1 / zoom})`} aria-hidden="true"><circle r="28"/><path d="M0-25 5-5 0 0-5-5ZM25 0 5 5 0 0 5-5ZM0 25-5 5 0 0 5 5ZM-25 0-5-5 0 0-5 5Z"/><text y="-34">С</text></g>
        </svg>
        <div className="world-map-tools">
          <button onClick={() => setZoom((value) => Math.min(1.8, value + .2))} disabled={zoom >= 1.8} aria-label="Приблизить карту"><Plus size={17}/></button>
          <button onClick={() => setZoom((value) => Math.max(1, value - .2))} disabled={zoom <= 1} aria-label="Отдалить карту"><Minus size={17}/></button>
        </div>
        <div className="world-map-legend"><span><i className="legend-current"/>Отряд</span><span><i className="legend-visited"/>Посещено</span><span><i className="legend-road"/>Дорога</span></div>
      </div>

      <aside className="world-map-inspector">
        {!current && <p className="route-missing" role="status">Текущая точка отряда не совпадает с картой мира. Переход временно недоступен — обновите кампанию или обратитесь к мастеру.</p>}
        {selected && <>
          <div className="location-kind"><span>{selected.kind === 'fortress' ? <Castle size={18}/> : selected.kind === 'wilds' ? <Trees size={18}/> : selected.kind === 'ruin' || selected.kind === 'dungeon' ? <Mountain size={18}/> : <MapPin size={18}/>}</span><small>{KIND_LABELS[selected.kind]}</small></div>
          <h2>{selected.name}</h2>
          <p className="region-name">{selectedRegion?.name ?? 'Неизведанный регион'}</p>
          <p className="location-summary">{selected.summary || 'Об этом месте пока известно немного.'}</p>
          <div className="location-status">{selected.visited ? <span className="visited"><Check size={13}/>Посещено</span> : <span>Известно по карте</span>}{selected.id === current?.id && <b><Navigation size={13}/>Здесь отряд</b>}</div>
          {selected.id !== current?.id && <div className="route-card">
            <header><Route size={16}/><strong>Выбранный путь</strong></header>
            {route.locationIds.length ? <>
              <div className="route-chain">{routeNames.map((name, index) => <span key={`${name}-${index}`}>{name}{index < routeNames.length - 1 && <i>→</i>}</span>)}</div>
              <dl><div><dt><Clock3 size={13}/>В пути</dt><dd>≈ {totalDays} дн.</dd></div><div><dt>Опасность</dt><dd className={`danger-${highestDanger}`}>{highestDanger}</dd></div></dl>
              <button className="travel-button" disabled={travelBlocked} onClick={proposeTravel}><Navigation size={16}/>{combatActive
                ? 'Сначала завершите бой'
                : busy
                  ? 'Сначала завершите текущее действие'
                  : route.routes.length > 1 && nextStop
                    ? `Начать путь через «${nextStop.name}»`
                    : 'Предложить отряду этот путь'}</button>
              <small className="travel-note">{combatActive
                ? 'Во время боя глобальное перемещение недоступно.'
                : route.routes.length > 1 && nextStop
                  ? `Дальний путь проходит поэтапно: следующая локальная сцена откроется в точке «${nextStop.name}».`
                  : 'Переход начнётся после решения группы. Агент создаст следующую локальную карту в точке назначения.'}</small>
            </> : <p className="route-missing">Из текущего места ещё не открыт путь к этой точке.</p>}
          </div>}
        </>}
        <details className="world-lore" open={!selected || selected.id === current?.id}>
          <summary><ScrollText size={15}/>Летопись мира</summary>
          <p>{state.campaignConcept?.worldHistory ?? state.campaignConcept?.worldSummary ?? 'Летопись будет дополняться по мере развития кампании.'}</p>
        </details>
        <div className="route-legend">
          <strong>Условные обозначения</strong>
          {Object.entries(ROUTE_LABELS).map(([kind, label]) => <span key={kind}><i className={`route-sample ${kind}`}/>{label}</span>)}
        </div>
      </aside>
    </div>
  </section>
}
