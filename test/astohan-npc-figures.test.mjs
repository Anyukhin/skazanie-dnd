import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [figures] } = await compileClientModules(['src/astohan-npc-figures.ts'])

function actor() {
  const root = new THREE.Group()
  const head = new THREE.Bone(); head.name = 'Head'
  const spine = new THREE.Bone(); spine.name = 'spine_02'
  root.add(head, spine)
  return root
}

test('именованные NPC Асстохана получают различимые публичные варианты', () => {
  const cases = [
    ['Король Арес', 'король', 'ares', 'astohan-npc-crown'],
    ['Орен Фаль', 'хранитель Архива', 'oren', 'astohan-npc-spectacles-left'],
    ['Ломар', 'чародей', 'lomar', 'astohan-npc-cape'],
    ['Гедрик Сол', 'комендант лагеря', 'gedrik', 'astohan-npc-npc-sash'],
  ]
  for (const [label, archetype, style, part] of cases) {
    const root = actor()
    assert.equal(figures.applyAstohanNpcFigure(root, { id: 'opaque', label, archetype, kind: 'neutral' }), style)
    assert.ok(root.getObjectByName(part), `${label}: ${part}`)
    root.traverse(object => { if (object.isMesh) assert.equal(object.userData.board3dPickable, false) })
  }
})

test('имя замаскированной фигуры не раскрывает сюжетный стиль', () => {
  const root = actor()
  assert.equal(figures.applyAstohanNpcFigure(root, { id: 'astohan-oren', label: 'Неизвестный', archetype: 'humanoid', kind: 'neutral' }), null)
  assert.equal(root.userData.astohanNpcStyle, undefined)
})

test('роль Трента остаётся профилем древнего дерева', () => {
  assert.equal(figures.astohanNpcStyle({ label: 'Трент', archetype: 'страж Дикого леса' }), 'trent')
  const root = actor()
  figures.applyAstohanNpcFigure(root, { id: 'opaque', label: 'Трент', archetype: 'страж Дикого леса', kind: 'neutral' })
  assert.ok(root.getObjectByName('astohan-npc-oak-bark-shield-left'))
  assert.ok(root.getObjectByName('astohan-npc-resin-eye-left'))
})

test('Каэлан получает всадника, коня и призрачную голову', () => {
  const root = actor()
  assert.equal(figures.applyAstohanNpcFigure(root, { id: 'opaque', label: 'Каэлан Вердант', archetype: 'Дуннахан Замка Забытых Скал', kind: 'neutral' }), 'kaelan')
  assert.ok(root.getObjectByName('kaelan-horse-body'))
  assert.ok(root.getObjectByName('kaelan-floating-head'))
  assert.ok(root.getObjectByName('kaelan-moon-judge'))
  const bounds = new THREE.Box3().setFromObject(root)
  assert.ok(bounds.max.y > 1.5 && bounds.max.x - bounds.min.x < 1.2)
})

test('ростер именованных NPC кампании покрывает все публичные варианты', () => {
  const expected = new Map([
    ['Король Арес', 'ares'], ['Маршал Ивара Тейн', 'ivara'], ['Орен Фаль', 'oren'], ['Мира Венн', 'mira'],
    ['Ломар', 'lomar'], ['Каэлан Вердант', 'kaelan'], ['Саргат', 'sargat'], ['Ларс', 'lars'], ['Тобан', 'toban'], ['Гедрик Сол', 'gedrik'],
  ])
  for (const [label, style] of expected) assert.equal(figures.astohanNpcStyle({ label, archetype: '' }), style)
})

test('частичные совпадения имён и общая роль не раскрывают чужой NPC', () => {
  assert.equal(figures.astohanNpcStyle({ label: 'Земира', archetype: 'жительница' }), null)
  assert.equal(figures.astohanNpcStyle({ label: 'Случайный мельник', archetype: 'мельник' }), null)
  assert.equal(figures.applyAstohanNpcFigure(actor(), { id: 'masked', label: 'Неизвестный', archetype: 'король', kind: 'neutral' }), null)
  assert.equal(figures.applyAstohanNpcFigure(actor(), { id: 'hero', label: 'Король Арес', archetype: 'король', kind: 'hero' }), null)
})

test('аксессуары NPC прикреплены к костям, а габарит остаётся миниатюрным', () => {
  const root = actor()
  figures.applyAstohanNpcFigure(root, { id: 'npc', label: 'Король Арес', archetype: 'король', kind: 'neutral' })
  assert.equal(root.getObjectByName('astohan-npc-crown')?.parent?.name, 'Head')
  assert.equal(root.getObjectByName('astohan-npc-cape')?.parent?.name, 'spine_02')
  const bounds = new THREE.Box3().setFromObject(root)
  assert.ok(bounds.max.y < 2 && bounds.max.x - bounds.min.x < 1)
})

test('Ивара и Мира выбирают женскую базу, ручной ключ остаётся приоритетом', () => {
  assert.equal(figures.astohanNpcModelKey({ kind: 'neutral', label: 'Маршал Ивара Тейн', archetype: 'командующая гарнизоном' }), 'hero-female')
  assert.equal(figures.astohanNpcModelKey({ kind: 'neutral', label: 'Мира Венн', archetype: 'посланница' }), 'hero-female')
  assert.equal(figures.astohanNpcModelKey({ kind: 'neutral', label: 'Мира Венн', archetype: 'посланница' }), 'hero-female')
})
