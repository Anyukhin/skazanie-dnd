import assert from 'node:assert/strict'
import test from 'node:test'
import { traceLoreAnswer } from '../eval/lore-trace.mjs'
import { renderLorePlan } from '../server/lore-voice.mjs'

const testimony = 'Саргат три месяца требует с поселений золото и сведения, десять дней назад сжёг Пепельную заставу.'
const material = {
  found: [],
  heard: [{ who: 'Король Арес', line: testimony }],
  known: [],
}

test('eval проверяет ответ по источнику и ловит подмену субъекта и срока', () => {
  const canonical = 'Вам говорили — Король Арес: «' + testimony + '»'
  const lore = { narration: canonical, lore_material: material }
  const checked = traceLoreAnswer(canonical, lore)
  assert.equal(checked.status, 'checked')
  assert.equal(checked.claims, 1)
  assert.deepEqual(checked.reasons, [])
  const rendered = renderLorePlan([{ kind: 'heard', index: 0 }], material)
  assert.deepEqual(traceLoreAnswer(rendered, lore).reasons, [])
  assert.ok(traceLoreAnswer(rendered + ' Значит, это король совершил налёт.', lore).reasons.length > 0)

  const substituted = traceLoreAnswer('Король Арес потребовал от поселений золото, а заставу сожгли три месяца назад.', lore)
  assert.equal(substituted.status, 'checked')
  assert.ok(substituted.reasons.length > 0)
})

test('deterministic fallback с пустым материалом считается проверенным', () => {
  const lore = { narration: 'Пока ничего подтверждённого об этом не известно.', lore_material: { found: [], heard: [], known: [], unknown: true } }
  const fallback = traceLoreAnswer(lore.narration, lore)
  assert.deepEqual(fallback, { status: 'checked', claims: 0, reasons: [] })
  assert.ok(traceLoreAnswer('Это сделал король.', lore).reasons.length > 0)
  assert.equal(traceLoreAnswer('Новый ответ без trace-материала', null).status, 'unverified')
})
