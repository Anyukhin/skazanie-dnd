import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [beasts] } = await compileClientModules(['src/astohan-beasts.ts'])

const slugs = ['brown-bear', 'giant-boar', 'lion', 'hyena', 'jackal', 'dire-wolf', 'hell-hound']

test('кампания получает отдельные звериные силуэты для семи нужных статблоков', () => {
  for (const slug of slugs) {
    const model = beasts.buildAstohanBeast(slug)
    assert.ok(model, slug)
    assert.equal(model.userData.astohanBeastSlug, slug)
    const bounds = new THREE.Box3().setFromObject(model, true)
    const size = bounds.getSize(new THREE.Vector3())
    assert.ok(size.x > .35 && size.z > .55 && size.y > .5, slug)
    assert.ok(bounds.min.y >= -.001, slug + ': лапы не должны проваливаться')
    assert.ok(model.children.some(child => child.name.startsWith('head')), slug + ': голова')
    assert.ok(model.children.some(child => child.name.startsWith('leg-')), slug + ': лапы')
    const neck = new THREE.Box3().setFromObject(model.getObjectByName('neck'), true)
    const head = new THREE.Box3().setFromObject(model.getObjectByName('head'), true)
    const body = new THREE.Box3().setFromObject(model.getObjectByName('body'), true)
    assert.ok(neck.intersectsBox(head) && neck.intersectsBox(body), slug + ': шея соединяет голову с корпусом')
  }
})

test('особыe признаки животных присутствуют', () => {
  const bear = beasts.buildAstohanBeast('brown-bear')
  const boar = beasts.buildAstohanBeast('giant-boar')
  const lion = beasts.buildAstohanBeast('lion')
  const hell = beasts.buildAstohanBeast('hell-hound')
  assert.ok(bear.getObjectByName('tail'))
  assert.equal(boar.children.filter(child => child.name.startsWith('tusk-')).length, 2)
  assert.ok(lion.getObjectByName('mane'))
  assert.ok(hell.children.some(child => child.name === 'ember-ridge'))
  assert.equal(beasts.buildAstohanBeast('wolf'), null)
})
