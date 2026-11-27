import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Group } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [models, figures] } = await compileClientModules(['src/actor-models.ts', 'src/astohan-hero-figures.ts'])
const manifest = JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'))

const expected = {
  fighter: 'hero-male', paladin: 'hero-male', barbarian: 'hero-male', monk: 'hero-male',
  wizard: 'mage-male', sorcerer: 'mage-male', warlock: 'mage-male', cleric: 'mage-male',
  druid: 'mage-male', bard: 'mage-male', rogue: 'ranger-male', ranger: 'ranger-male',
}

test('все двенадцать классов получают class-specific фигуру Асстохана', () => {
  for (const [classKey, modelKey] of Object.entries(expected)) {
    const entry = models.resolveModelProfile({ id: `hero-${classKey}`, label: classKey, kind: 'hero', archetype: classKey }, manifest)
    assert.equal(entry.key, modelKey, classKey)
    assert.ok(entry.url, `${classKey}: модель должна быть GLB`)
  }
})

test('серверная внешность, ручной выбор и старые входы не ломаются', () => {
  assert.equal(models.resolveModelProfile({ id: 'manual', label: 'Воин', kind: 'hero', archetype: 'fighter', modelKey: 'mage-male' }, manifest).key, 'mage-male')
  assert.equal(models.resolveModelProfile({ id: 'cleric-warrior', label: 'Жрец', kind: 'hero', archetype: 'cleric', appearance: { version: 2, profile: 'warrior', equipment: 'sword', loadout: {} } }, manifest).key, 'hero-male')
  assert.equal(models.resolveModelProfile({ id: 'legacy', label: 'Ильва', kind: 'hero', archetype: 'cleric' }, manifest).key, 'mage-male')
  assert.equal(models.resolveModelProfile({ id: 'enemy', label: 'Гоблин', kind: 'enemy', archetype: 'goblin' }, manifest).profile, 'goblin')
})

test('class-specific детали героя не попадают в выбор целей', () => {
  for (const [classKey, detailName] of [['cleric', 'cleric-medallion'], ['druid', 'druid-leaf-focus'], ['bard', 'bard-lute-body'], ['monk', 'monk-sash'], ['warlock', 'warlock-arcane-orb'], ['fighter', 'fighter-shoulder'], ['wizard', 'wizard-spellbook'], ['rogue', 'rogue-scarf'], ['ranger', 'ranger-feather']]) {
    const root = new Group()
    figures.decorateAstohanHeroFigure(root, { kind: 'hero', archetype: classKey })
    const details = []
    root.traverse((object) => { if (object.name === detailName || object.name.startsWith(detailName + '-')) details.push(object) })
    assert.ok(details.length, classKey)
    assert.ok(details.every((object) => object.userData.board3dPickable === false), classKey)
  }
  const npc = new Group()
  assert.equal(figures.decorateAstohanHeroFigure(npc, { kind: 'enemy', archetype: 'cleric' }), null)
  assert.equal(npc.children.length, 0)
})

test('публичный loadout переживает обновление фигурки и не убирает class-specific деталь', () => {
  const hero = models.createProceduralActorModel({
    id: 'bard-1', label: 'Бард', kind: 'hero', archetype: 'bard',
    appearance: { version: 2, profile: 'mage', equipment: 'staff', loadout: {} },
  }, manifest)
  try {
    assert.equal(hero.modelKey, 'mage-male')
    assert.ok(hero.getObjectByName('astohan-hero-detail:bard'))
    hero.setAppearance({
      version: 2, profile: 'mage', equipment: 'dagger',
      loadout: { main_hand: { model_key: 'dagger' } },
    })
    assert.equal(hero.appearance?.equipment, 'dagger')
    assert.equal(hero.appearance?.version, 2)
    assert.deepEqual(hero.appearance?.loadout, { main_hand: { model_key: 'dagger' } })
    assert.ok(hero.getObjectByName('astohan-hero-detail:bard'))
  } finally {
    hero.dispose()
  }
})

test('деталь барда действительно прикреплена к кости реального Quaternius GLB', async () => {
  const entry = manifest.models.find((item) => item.key === 'mage-male')
  const bytes = readFileSync(new URL('../public' + entry.url, import.meta.url))
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  const actor = await models.createActorModel({
    id: 'bard-glb', label: 'Бард', kind: 'hero', archetype: 'bard',
    appearance: { version: 2, profile: 'mage', equipment: 'unknown', loadout: {} },
  }, {
    manifest,
    loader: new GLTFLoader(),
    fetcher: async () => new Response(bytes, { status: 200 }),
    height: 1.3,
  })
  try {
    const detail = actor.getObjectByName('astohan-hero-detail:bard')
    assert.ok(detail)
    assert.match(detail.parent?.name ?? '', /spine_0[23]/u)
    assert.ok(detail.getObjectByName('bard-lute-body'))
    assert.ok(detail.getObjectByName('bard-lute-body').position.z < 0, 'лютня крепится за спиной')
    assert.ok(detail.getObjectByName('bard-lute-rosette'))
    assert.ok(detail.getObjectByName('bard-lute-pegs'))
    actor.setAppearance({ version: 2, profile: 'mage', equipment: 'dagger', loadout: { main_hand: { model_key: 'dagger' } } })
    assert.equal(actor.appearance?.equipment, 'dagger')
    assert.ok(actor.getObjectByName('bard-lute-body'))
  } finally {
    actor.dispose()
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})
