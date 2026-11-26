import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [creatures] } = await compileClientModules(['src/astohan-chimera-family.ts'])
const slugs = ['owlbear', 'harpy', 'manticore', 'displacer-beast', 'basilisk', 'gorgon', 'chimera', 'couatl', 'wyvern']

test('создаёт узнаваемые профили крупных чудовищ', () => {
  for (const slug of slugs) {
    const group = creatures.buildAstohanChimeraFamily(slug)
    assert.ok(group, slug)
    group.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(group)
    assert.ok(bounds.min.y >= -.02 && bounds.max.y > .7, slug)
    assert.ok(bounds.getSize(new THREE.Vector3()).z > .3, slug)
    group.traverse(node => { if (node.isMesh) assert.equal(node.userData.board3dPickable, false) })
  }
})

test('крылатые и составные формы имеют специальные части', () => {
  const chimera = creatures.buildAstohanChimeraFamily('chimera')
  const wyvern = creatures.buildAstohanChimeraFamily('wyvern')
  assert.equal(chimera.children.filter(child => child.name.startsWith('wing-membrane')).length, 2)
  assert.equal(wyvern.children.filter(child => child.name.startsWith('wing-membrane')).length, 2)
  assert.ok(chimera.getObjectByName('dragon-head'))
})
