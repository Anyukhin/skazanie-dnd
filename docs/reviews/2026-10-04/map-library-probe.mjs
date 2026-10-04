import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditTacticalMap } from '../../../server/map-quality.mjs'
import { MapLibrary, libraryRequestFor } from '../../../server/map-library.mjs'
import { deserializeTacticalMap } from '../../../server/tactical-map.mjs'
import { importTaleSpireSlab } from '../../../server/talespire-import.mjs'
import { HOUSE_SLAB } from '../../../test/talespire-fixtures.mjs'

// Воспроизведение AI-06 использует временный каталог и тестовую фикстуру;
// рабочие .env и storage не читаются.
const temporaryRoot = mkdtempSync(join(tmpdir(), 'skazanie-map-library-probe-'))
try {
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'probe-location' })
  if (imported.levels.length < 2) throw new Error('Fixture must contain ground and upper levels')
  const levels = imported.levels.map((level) => level.index === 0
    ? level
    : {
        ...level,
        map: {
          ...level.map,
          props: [
            ...(level.map.props ?? []),
            { ...level.map.props?.[0], id: 'probe-out-of-bounds', x: -0.5, y: -0.5, footprint: [{ x: -1, y: -1 }] },
          ],
        },
      })
  const entry = {
    id: 'probe-location',
    title: 'Probe location',
    source: { site: 'fixture', url: 'https://example.invalid/probe', author: 'fixture', license: 'test' },
    place_kinds: ['tavern'], types: ['inn'], terrains: [], climate: '', passport: imported.passport,
    levels: [], slab_sha256: 'probe', added_at: '2026-10-04',
  }
  const library = new MapLibrary(temporaryRoot)
  library.put(entry, levels)
  const upper = levels.find((level) => level.index !== 0)
  const upperAudit = auditTacticalMap(deserializeTacticalMap(upper.map))
  const picked = library.pick(libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' }), { seed: 'probe' })
  const result = {
    upper_problems: upperAudit.problems.slice(0, 3),
    picked: Boolean(picked),
    picked_upper_level: Boolean(picked?.levels.some((level) => level.index !== 0)),
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.upper_problems.some((problem) => problem.code === 'PROP_OUT_OF_BOUNDS') || !result.picked) {
    throw new Error('Probe behavior changed: expected malformed upper floor to be selected before the fix')
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
