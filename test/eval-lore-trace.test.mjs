import assert from 'node:assert/strict'
import test from 'node:test'
import { traceLoreAnswer } from '../eval/lore-trace.mjs'

test('eval сверяет дословный ответ и передаёт новые формулировки на проверку с тем же материалом', async () => {
  const material = { heard: [{ who: 'Король Арес', line: 'Саргат сжёг заставу десять дней назад.' }] }
  const lore = { narration: 'Канонический ответ.', lore_material: material }
  const canonical = await traceLoreAnswer(lore.narration, lore, () => assert.fail('дословный ответ уже проверен'))
  assert.deepEqual(canonical, { status: 'checked', claims: 1, reasons: [] })

  const rendered = 'Король Арес: «Саргат сжёг заставу десять дней назад.»'
  const verify = async (answer, source) => {
    assert.equal(source, material)
    return answer === rendered
  }
  assert.deepEqual((await traceLoreAnswer(rendered, lore, verify)).reasons, [])
  assert.deepEqual((await traceLoreAnswer('Король Арес сжёг заставу три месяца назад.', lore, verify)).reasons, ['unsupported_answer'])
})

test('ответ без сведений проверяется, а ответ без материала остаётся непроверенным', async () => {
  const lore = { narration: 'Пока ничего подтверждённого об этом не известно.', lore_material: { unknown: true } }
  assert.deepEqual(await traceLoreAnswer(lore.narration, lore), { status: 'checked', claims: 0, reasons: [] })
  assert.equal((await traceLoreAnswer('Новый ответ без материала', null)).status, 'unverified')
})
