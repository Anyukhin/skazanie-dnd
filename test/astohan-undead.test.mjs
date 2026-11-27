import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [undead] } = await compileClientModules(['src/astohan-undead.ts'])
const profiles = {
  'crawling-claw': ['claw-palm', 'claw-tip-0'],
  flameskull: ['flameskull-cranium', 'flame-tongue-0'],
  specter: ['ghost-tail', 'specter-cowl'],
  banshee: ['banshee-hair--1', 'banshee-sleeve-1'],
  ghost: ['ghost-shroud', 'ghost-face'],
  mummy: ['mummy-bandage-0', 'mummy-veil'],
  ghoul: ['ghoul-torso', 'ghoul-claw-1'],
  ghast: ['ghast-shoulder-spine-1', 'ghast-tongue'],
  wight: ['wight-cloak', 'wight-blade'],
  'vampire-spawn': ['vampire-coat-tail-1', 'vampire-raised-collar-1'],
  zombie: ['zombie-reaching-arm-1', 'zombie-reaching-hand--1'],
  'minotaur-skeleton': ['minotaur-skull', 'minotaur-horn-1'],
}

test('особая нежить получает различимый силуэт в пределах миниатюры', () => {
  for (const [slug, names] of Object.entries(profiles)) {
    const group = undead.buildAstohanUndead(slug)
    assert.ok(group, slug)
    for (const name of names) assert.ok(group.getObjectByName(name), slug + ': ' + name)
    group.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
    assert.ok(size.x > .1 && size.z > .1 && size.y > .03, slug + ': empty bounds')
    assert.ok(Number.isFinite(size.x + size.y + size.z), slug + ': finite bounds')
  }
})

test('обычный skeleton остаётся штатным GLB профилем', () => {
  assert.equal(undead.buildAstohanUndead('skeleton'), null)
})
