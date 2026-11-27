import assert from 'node:assert/strict'
import test from 'node:test'
import { Group, Box3, Vector3 } from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [giants] } = await compileClientModules(['src/astohan-giants.ts'])

test('сюжетные великаны и элементали получают самостоятельные силуэты', () => {
  for (const slug of ['ogre', 'troll', 'hill-giant', 'ettin', 'cyclops', 'air-elemental', 'water-elemental', 'awakened-shrub']) {
    const root = giants.buildAstohanGiant(slug)
    assert.ok(root, slug)
    root.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(root)
    const size = bounds.getSize(new Vector3())
    assert.ok(size.y > .65 && bounds.min.y >= -.01, `${slug}: нижняя точка стоит на y=0`)
    assert.ok(root.children.length >= 3, `${slug}: нужен читаемый силуэт, а не одна коробка`)
    root.traverse(object => { if (object.isMesh) assert.equal(object.userData.board3dPickable, false, `${slug}: деталь не должна перехватывать выбор`) })
    if (!['air-elemental', 'water-elemental', 'awakened-shrub'].includes(slug)) assert.ok(root.getObjectByName(slug === 'ettin' ? 'ettin-left-eye' : slug === 'cyclops' ? 'cyclops-eye' : `${slug}-eye`), `${slug}: лицо должно иметь глаз`)
    if (['ogre', 'troll', 'hill-giant', 'ettin', 'cyclops'].includes(slug)) {
      const club = slug === 'hill-giant' ? 'hill-giant-trunk-knot' : 'giant-club-head'
      assert.ok(root.getObjectByName(club), `${slug}: в руках должна быть дубина`)
    }
  }
})

test('тяжёлые формы сохраняют порядок размеров', () => {
  const bounds = slug => {
    const root = giants.buildAstohanGiant(slug)
    root.updateMatrixWorld(true)
    return new Box3().setFromObject(root).getSize(new Vector3())
  }
  assert.ok(bounds('hill-giant').y > bounds('ogre').y)
  assert.ok(bounds('ettin').y > bounds('ogre').y)
  assert.ok(bounds('water-elemental').x > .6)
})
