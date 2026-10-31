// Опрос погоды по одному состоянию: все экспортируемые функции
// `server/weather.mjs`, которые читают состояние, по набору героев, навыков и
// шагов времени. Rust-тест (`tests/weather.rs`) строит тот же объект в том же
// порядке ключей и сверяет sha256 его `JSON.stringify`.

export const PROBE_SKILLS = ['perception', 'Survival', ' stealth ', 'sleight_of_hand', 'persuasion', 'PERCEPTION', '']
export const PROBE_ADVANCES = [0, 1, 59, 60, 180, 420, 480, 1_439, 1_440, 2_880, 4_000, '30', -5, 10_000_000, 1.5]
export const PROBE_MINUTES = [0, 300, 720, 1_260, 99_999]

/** Герои, от лица которых опрашивается погода. `null` — по умолчанию. */
export function probeActorIds(state) {
  const ids = [null, 'missing']
  const add = (value) => {
    const id = String(value ?? '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  add(state?.activePlayerId)
  for (const list of [state?.players, state?.enemies, state?.actors]) {
    if (!Array.isArray(list)) continue
    for (const actor of list.slice(0, 3)) add(actor?.id ?? actor?.actor_id)
  }
  return ids
}

/** Другие места карты мира — для черновика смены края. */
export function probeLocationIds(state) {
  const locations = Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
  return locations.slice(0, 6).map((location) => location?.id).filter((id) => typeof id === 'string')
}

export function probe(w, state) {
  const actors = probeActorIds(state)
  const perActor = actors.map((id) => ({
    id,
    clock: w.worldClockFor(state, id),
    viewer: w.weatherForViewer(state, id),
    agents: w.worldClockForAgents(state, id),
    labels: w.weatherEffectLabels(state, id),
    swings: PROBE_SKILLS.map((skill) => w.weatherCheckSwing(state, skill, id)),
    ranged: w.weatherRangedPenalty(state, id),
    indoors: w.isIndoors(state, id),
  }))
  const regions = probeLocationIds(state).map((locationId) => {
    const after = { ...state, worldMap: { ...state.worldMap, currentLocationId: locationId } }
    return w.regionWeatherEventDraft(state, after)
  })
  return {
    elapsed: w.elapsedMinutesOf(state),
    seed: w.campaignSeedOf(state),
    // Край целиком не сравнивается: урезание оставляет у него id, имя и климат.
    region: regionKey(w.currentRegionOf(state)),
    biome: w.currentBiomeOf(state),
    weather: w.weatherOf(state),
    scene_indoor: w.isIndoorScene(state?.scene ?? {}),
    clock: w.worldClockFor(state),
    at_minutes: PROBE_MINUTES.map((minute) => w.worldClockFor(state, minute)),
    actors: perActor,
    drafts: PROBE_ADVANCES.map((advance) => w.worldClockEventDrafts(state, advance)),
    regions,
  }
}

/** Край так, как его видно после урезания: `[id, name, biome]` либо `null`. */
export function regionKey(region) {
  if (region == null) return null
  return [region?.id ?? null, region?.name ?? null, region?.biome ?? null]
}
