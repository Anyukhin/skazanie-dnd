import { useMemo, useState } from 'react'
import { ArrowLeft, Building2, Landmark, MapPin, ScrollText } from 'lucide-react'

import type { WorldMapCityPlace, WorldMapLocation } from './types'
import './city-overview.css'

const CITY_OVERVIEW_IMAGE_RE = /^\/assets\/maps\/city\/skazanie\/[a-z0-9-]+-v[1-9][0-9]*\.webp$/u

const PLACE_KIND_LABELS: Record<WorldMapCityPlace['kind'], string> = {
  civic: 'Власть',
  harbor: 'Гавань',
  market: 'Рынок',
  temple: 'Святыня',
  archive: 'Архив',
  gate: 'Ворота',
  tower: 'Башня',
  garden: 'Сады',
  workshop: 'Мастерские',
  infrastructure: 'Городское устройство',
  inn: 'Постоялый двор',
  other: 'Важное место',
}

function safeImage(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return CITY_OVERVIEW_IMAGE_RE.test(candidate) ? candidate : ''
}

export function CityOverviewView({ campaignName, location, onBack }: {
  campaignName: string
  location: WorldMapLocation
  onBack: () => void
}) {
  const overview = location.cityOverview!
  const [selectionId, setSelectionId] = useState(overview.places[0]?.id ?? overview.districts[0]?.id ?? '')
  const districtById = useMemo(() => new Map(overview.districts.map((district) => [district.id, district])), [overview.districts])
  const selectedPlace = overview.places.find((place) => place.id === selectionId) ?? null
  const selectedDistrict = selectedPlace
    ? districtById.get(selectedPlace.districtId) ?? null
    : overview.districts.find((district) => district.id === selectionId) ?? overview.districts[0] ?? null
  const selected = selectedPlace ?? selectedDistrict
  const image = safeImage(overview.image)

  return <section className="world-map-page city-overview-page">
    <header className="world-map-header city-overview-header">
      <div><span>ГЛОБАЛЬНАЯ КАРТА · ПЛАН ГОРОДА</span><h1>{overview.name}</h1><p>{overview.summary}</p></div>
      <div className="city-overview-header-actions">
        <div className="world-map-stats"><span><Building2 size={14}/>{overview.districts.length} районов</span><span><Landmark size={14}/>{overview.places.length} мест</span></div>
        <button type="button" className="city-overview-back" onClick={onBack}><ArrowLeft size={15}/>К глобальной карте</button>
      </div>
    </header>

    <div className="world-map-layout">
      <div className="world-map-frame city-overview-frame" style={{ aspectRatio: `${overview.width} / ${overview.height}`, minHeight: 0, alignSelf: 'start' }}>
        <svg className="world-map-canvas" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox={`0 0 ${overview.width} ${overview.height}`} role="img" aria-label={`План города ${location.name} в кампании ${campaignName}`}>
          {image
            ? <image className="city-overview-background" href={image} x="0" y="0" width={overview.width} height={overview.height} preserveAspectRatio="xMidYMid slice" aria-label={overview.imageAlt || undefined}/>
            : <rect className="world-paper" width={overview.width} height={overview.height}/>
          }
          <rect className="city-overview-veil" width={overview.width} height={overview.height}/>
          <g className="city-districts">
            {overview.districts.map((district, index) => <g
              key={district.id}
              className={`city-district district-tone-${index % 6}${selectedDistrict?.id === district.id && !selectedPlace ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Район ${district.name}`}
              aria-pressed={selectionId === district.id}
              onClick={() => setSelectionId(district.id)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectionId(district.id) } }}
            >
              <rect className="city-district-shape" x={district.bounds.x} y={district.bounds.y} width={district.bounds.width} height={district.bounds.height} rx="22"/>
              <text className="city-district-label" x={district.x} y={district.y}>{district.name}</text>
            </g>)}
          </g>
          <g className="city-places">
            {overview.places.map((place) => <g
              key={place.id}
              className={`city-place${selectedPlace?.id === place.id ? ' selected' : ''}`}
              transform={`translate(${place.x} ${place.y})`}
              role="button"
              tabIndex={0}
              aria-label={place.name}
              aria-pressed={selectedPlace?.id === place.id}
              onClick={() => setSelectionId(place.id)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectionId(place.id) } }}
            >
              <circle className="city-place-hit" r="24"/>
              <circle className="city-place-ring" r="8"/>
              <circle className="city-place-core" r="3"/>
              <text className="city-place-label" y="22">{place.name}</text>
            </g>)}
          </g>
        </svg>
        <div className="city-overview-legend"><span><i className="district-sample"/>Район</span><span><i className="place-sample"/>Важное место</span></div>
      </div>

      <aside className="world-map-inspector city-overview-inspector">
        {selected && <>
          <div className="location-kind"><span>{selectedPlace ? <MapPin size={18}/> : <Building2 size={18}/>}</span><small>{selectedPlace ? PLACE_KIND_LABELS[selectedPlace.kind] : 'Район'}</small></div>
          <h2>{selected.name}</h2>
          <p className="region-name">{selectedPlace ? selectedDistrict?.name : location.name}</p>
          <p className="location-summary">{selected.summary}</p>
          {selected.history && <section className="location-history" aria-label="История места"><h3>История места</h3><p>{selected.history}</p></section>}
          {!!selected.storyHooks?.length && <section className="location-hooks" aria-label="Сюжетные зацепки"><h3>Сюжетные зацепки</h3><ul>{selected.storyHooks.map((hook, index) => <li key={`${selected.id}-hook-${index}`}>{hook}</li>)}</ul></section>}
        </>}
        <div className="city-overview-note"><ScrollText size={15}/><p><b>Это обзор города.</b> Выбор района или места не перемещает отряд и не расходует ход. Тактическая сцена меняется только подтверждённым игровым действием.</p></div>
      </aside>
    </div>
  </section>
}
