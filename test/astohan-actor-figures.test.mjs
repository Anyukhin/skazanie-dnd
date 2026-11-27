import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [figures, models] } = await compileClientModules(['src/astohan-actor-figures.ts', 'src/actor-models.ts'])
const manifest = JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'))

test('формы дикого облика выбирают публичную подходящую фигурку', () => {
  assert.equal(figures.publicShapeModelKey({ id: 'giant-spider', name: 'Гигантский паук', wild_shape: true }), 'spider')
  assert.equal(figures.publicShapeModelKey({ id: 'brown-bear', name: 'Бурый медведь', wild_shape: true }), 'astohan-figure-brown-bear')
  assert.equal(figures.publicShapeModelKey({ id: 'lion', name: 'Лев', wild_shape: true }), 'astohan-figure-lion')
  assert.equal(figures.publicShapeModelKey({ id: 'giant-boar', name: 'Кабан', wild_shape: true }), 'astohan-figure-giant-boar')
  assert.equal(figures.publicShapeModelKey({ id: 'wolf', name: 'Волк', wild_shape: true }), 'wolf')
})

test('призыв выбирает модель по открытому имени, без скрытого actor id', () => {
  assert.equal(figures.summonModelKey({ name: 'Гигантский паук', creature_type: 'beast' }), 'spider')
  assert.equal(figures.summonModelKey({ name: 'Дух зверя', sourceSpellId: 'summon-beast' }), 'astohan-summon-beast')
  assert.equal(figures.summonModelKey({ name: 'Дух стихии', sourceSpellId: 'summon-elemental' }), 'astohan-summon-elemental')
  assert.equal(figures.summonModelKey({ name: 'Союзник', creature_type: 'celestial' }), undefined)
})

test('временная форма имеет приоритет над сохранённой фигуркой и снимается при возврате', () => {
  const form = figures.publicShapeModelKey({ id: 'giant-spider', name: 'Гигантский паук', wild_shape: true })
  assert.equal(form, 'spider')
  assert.equal(figures.publicShapeModelKey(undefined), undefined)
})

test('ключ формы проходит реальный createActorModel и грузит локальный GLB', async () => {
  const key = figures.publicShapeModelKey({ id: 'giant-spider', name: 'Гигантский паук', wild_shape: true })
  const entry = manifest.models.find((item) => item.key === key)
  assert.ok(entry?.url)
  const bytes = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'public', entry.url))
  const model = await models.createActorModel(
    { id: 'shape-giant-spider', label: 'Гигантский паук', kind: 'hero', modelKey: key },
    { manifest, fetcher: async () => new Response(bytes, { status: 200 }) },
  )
  try {
    assert.equal(model.source, 'glb')
    assert.equal(model.modelKey, key)
  } finally {
    model.dispose()
  }
})

test('новые формы зверей проходят createActorModel через authored figure API', async () => {
  for (const [id, name, key] of [
    ['brown-bear', 'Бурый медведь', 'astohan-figure-brown-bear'],
    ['lion', 'Лев', 'astohan-figure-lion'],
    ['giant-boar', 'Кабан', 'astohan-figure-giant-boar'],
    ['dire-wolf', 'Лютый волк', 'astohan-figure-dire-wolf'],
  ]) {
    const model = await models.createActorModel(
      { id: 'shape-' + id, label: name, kind: 'hero', modelKey: key },
      { manifest },
    )
    try {
      assert.equal(model.modelKey, key, id)
      assert.equal(model.source, 'procedural', id)
      assert.ok(model.getObjectByName('astohan-beast:' + id), id)
    } finally {
      model.dispose()
    }
  }
})
