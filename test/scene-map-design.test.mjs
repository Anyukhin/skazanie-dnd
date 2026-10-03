import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSceneMapDesign, sceneMapDesignFor, worldLocationDesignContext } from '../server/scene-map-design.mjs'

test('замысел принимает только ограниченные признаки, без координат и механики', () => {
  assert.deepEqual(normalizeSceneMapDesign({ topology: 'harbor', density: 'dense', architecture: 'stone',
    climate: 'lava', building_use: 'teleport', seed: 'forged', houses: [{ x: 1, y: 1 }], hp: 900 }),
  { topology: 'harbor', architecture: 'stone', density: 'dense' })
  assert.deepEqual(normalizeSceneMapDesign(null), {})
})

test('канон порта и реки сильнее одинаковой заявки модели на перекрёсток', () => {
  const request = { design: { topology: 'crossroads', climate: 'cold' } }
  assert.equal(sceneMapDesignFor({ worldKind: 'port', location: 'Мормар', request }).topology, 'harbor')
  const river = sceneMapDesignFor({ worldKind: 'city', location: 'Два Берега', description: 'Город на слиянии двух рек.', request })
  assert.equal(river.topology, 'river')
  assert.equal(river.density, 'dense')
})

test('местный климат сильнее ответа модели, разнородный мир не превращается весь в пустыню', () => {
  const worldDescription = 'На юге пустыня, на севере снежная тундра.'
  const plain = sceneMapDesignFor({ biome: 'plains', worldDescription, seed: 'plain' })
  assert.equal(plain.climate, 'temperate')
  const desert = sceneMapDesignFor({ biome: 'desert', worldKind: 'village', worldDescription,
    request: { design: { climate: 'cold' } } })
  assert.equal(desert.climate, 'arid')
  assert.equal(desert.architecture, 'sand')
  assert.equal(desert.density, 'sparse')
  assert.equal(sceneMapDesignFor({ biome: 'marsh' }).climate, 'wetland')
})

test('портал не становится портом, а слово «весело» не превращает город в село', () => {
  const design = sceneMapDesignFor({ location: 'Город порталов', description: 'Здесь весело, реконструкция рынка уже закончилась.', worldKind: 'city' })
  assert.notEqual(design.topology, 'harbor')
  assert.notEqual(design.topology, 'river')
  assert.equal(design.density, 'dense')
  assert.equal(sceneMapDesignFor({ location: 'Высохшее русло', description: 'Река пересохла, район без реки.', worldKind: 'city' }).topology === 'river', false)
})

test('публичные сведения относятся к выбранному месту, скрытые записи не раскрываются', () => {
  const map = { regions: [{ id: 'south', biome: 'desert' }], locations: [
    { id: 'port', name: 'Мормар', known: true, summary: 'Гавань', history: 'Старые верфи', regionId: 'south' },
    { id: 'hidden', name: 'Тайник', known: false, summary: 'SECRET' },
  ] }
  assert.deepEqual(worldLocationDesignContext(map, 'port'), { description: 'Гавань Старые верфи', biome: 'desert' })
  assert.deepEqual(worldLocationDesignContext(map, 'hidden'), { description: '', biome: '' })
  assert.deepEqual(sceneMapDesignFor({ location: 'Трактир у дороги', seed: 'repeat' }), sceneMapDesignFor({ location: 'Трактир у дороги', seed: 'repeat' }))
})

test('дамба и шлюзы — край воды, а не сухая деревня', () => {
  // Плейтест 2026-10-02: «Смотровая дамба» строилась улицами без воды.
  assert.equal(sceneMapDesignFor({ location: 'Смотровая дамба', description: 'Кирпичная дамба над соляными полями, у шлюзов толпа.' }).topology, 'harbor')
  assert.equal(sceneMapDesignFor({ location: 'Старая плотина' }).topology, 'harbor')
  assert.notEqual(sceneMapDesignFor({ location: 'Амбары у мельницы' }).topology, 'harbor', '«амбар» не «дамба»')
})
