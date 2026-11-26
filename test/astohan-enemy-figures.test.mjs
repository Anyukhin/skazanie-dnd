import assert from 'node:assert/strict'
import test from 'node:test'
import { compileClientModules } from './kit/client-ts.mjs'
const { modules: [figures] } = await compileClientModules(['src/astohan-enemy-figures.ts'])
test('вид узнаётся по точному имени противника или призыва, без чтения скрытого id', () => {
  const name = (label, archetype, kind='enemy') => figures.campaignEnemySlug({id:'secret-ettin', label, archetype, kind})
  assert.equal(name('Эттин 3','giant'),'ettin')
  assert.equal(name('Гигантский кабан 2','beast'),'giant-boar')
  assert.equal(name('Скелет минотавра 1','undead'),'minotaur-skeleton')
  assert.equal(name('Путник','humanoid'),null)
  assert.equal(name('Сказание об эттине','giant'),null)
  assert.equal(name('Страж','giant'),null)
  assert.equal(name('Эттин 1','humanoid'),null)
  assert.equal(name('Огр','giant','hero'),null)
})
