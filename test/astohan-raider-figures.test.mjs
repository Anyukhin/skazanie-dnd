import assert from 'node:assert/strict'
import test from 'node:test'
import { compileClientModules } from './kit/client-ts.mjs'
import * as THREE from 'three'

const { modules: [figures] } = await compileClientModules(['src/astohan-raider-figures.ts'])

test('бандитские гуманоиды получают костюм на костях', () => {
  for (const slug of ['bandit', 'bandit-captain', 'veteran', 'berserker', 'orc', 'hobgoblin']) {
    const root = new THREE.Group()
    const torso = new THREE.Group(); torso.name = 'spine_03'
    const head = new THREE.Group(); head.name = 'Head'
    root.add(torso, head)
    figures.decorateRaider(root, slug)
    assert.ok(root.getObjectByName('astohan-raider-belt'), slug)
    if (slug === 'bandit-captain') assert.ok(head.getObjectByName('astohan-raider-captain-hat'))
    if (slug === 'veteran') assert.ok(torso.getObjectByName('astohan-raider-veteran-backplate'))
    assert.ok(root.children.every(child => child.userData.board3dPickable !== true), slug)
  }
})

test('гнолл и багбир имеют самостоятельные читаемые формы', () => {
  for (const slug of ['gnoll', 'bugbear']) {
    const root = figures.buildAstohanRaider(slug)
    assert.ok(root)
    root.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
    assert.ok(size.y > 1 && size.x > .4 && size.z > .3, slug)
    assert.ok(root.children.length >= 4, slug)
    for (const side of [-1, 1]) assert.ok(root.getObjectByName(`astohan-raider-${slug}-leg-${side}`))
  }
})
