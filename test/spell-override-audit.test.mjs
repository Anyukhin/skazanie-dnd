import assert from 'node:assert/strict'
import test from 'node:test'

import { auditSpellOverrides } from '../server/spell-override-audit.mjs'

test('каждый серверный override заклинания согласован с каталогом и исполним движком', () => {
  const report = auditSpellOverrides()
  assert.deepEqual(report.problems, [], 'аудит нашёл несогласованные карточки')
  assert.equal(report.ok, true)
  assert.ok(report.checked >= 100, `проверено всего ${report.checked} карточек`)
})

test('аудит измеряет, насколько автогенерация расходится с ручными правилами', () => {
  const report = auditSpellOverrides()
  // Сам факт большого числа исправлений — довод против массовой разблокировки
  // каталога: карточки, которые никто не проверял руками, содержат те же
  // ошибки вида и цели, что и уже исправленные.
  assert.ok(report.corrections > 100, `исправлений всего ${report.corrections}`)
  assert.ok(report.correctionsByField.kind > 0, 'ожидались исправления вида карточки')
  assert.ok(report.correctionsByField.target > 0, 'ожидались исправления цели')
})

test('аудит покрывает только исполнимые виды карточек', () => {
  const report = auditSpellOverrides()
  // Ни один override не имеет права объявлять вид, которого нет в диспетчере
  // CastSpell: такая карточка загрузилась бы и молча ничего не сделала.
  assert.equal(report.problems.filter((problem) => problem.code === 'UNSUPPORTED_KIND').length, 0)
  assert.equal(report.problems.filter((problem) => problem.code === 'AREA_WITHOUT_RADIUS').length, 0)
  assert.ok(report.catalog > report.checked, 'в каталоге обязаны оставаться неразобранные карточки')
})
