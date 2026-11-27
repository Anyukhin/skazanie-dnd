import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ArchitectUsageStore,
  DEFAULT_ARCHITECT_ALERT_THRESHOLD,
  architectAlertText,
} from '../server/architect-usage.mjs'

/**
 * Задача 1.4 плана: лимита на генерацию локаций нет, есть предупреждение о
 * расходе. Поэтому сторож проверяет счёт и однократность сигнала, а не отказ —
 * отказа тут не должно появиться никогда.
 */

function temporaryStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-architect-'))
  const storageFile = join(directory, 'architect-usage.json')
  return {
    directory,
    storageFile,
    create: (overrides = {}) => new ArchitectUsageStore({ storageFile, ...options, ...overrides }),
  }
}

test('генерация увеличивает счётчик кампании и не задевает соседнюю', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const store = fixture.create({ alertThreshold: 3 })

  assert.equal(store.generationsToday('ALFA'), 0)
  assert.equal(store.recordGeneration('ALFA').generations, 1)
  assert.equal(store.recordGeneration('ALFA').generations, 2)
  assert.equal(store.generationsToday('ALFA'), 2)
  assert.equal(store.generationsToday('BETA'), 0)
  assert.equal(store.recordGeneration('BETA').generations, 1)
  assert.equal(store.generationsToday('ALFA'), 2, 'счётчик соседней кампании не сдвинулся')
})

test('порог срабатывает ровно один раз за день, дальше счёт продолжается молча', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const store = fixture.create({ alertThreshold: 3 })

  assert.equal(store.recordGeneration('ALFA').alert, false, 'до порога предупреждения нет')
  assert.equal(store.recordGeneration('ALFA').alert, false)
  const crossing = store.recordGeneration('ALFA')
  assert.equal(crossing.alert, true, 'на пересечении порога предупреждение уходит')
  assert.equal(crossing.generations, 3)
  assert.equal(crossing.threshold, 3)
  // Лимита нет: после порога генерации продолжаются, но строка не повторяется.
  assert.equal(store.recordGeneration('ALFA').alert, false)
  assert.equal(store.recordGeneration('ALFA').alert, false)
  assert.equal(store.generationsToday('ALFA'), 5)
})

test('смена календарного дня обнуляет счётчик и возвращает право на предупреждение', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  let now = Date.parse('2026-08-02T21:00:00.000Z')
  const store = fixture.create({ alertThreshold: 2, now: () => now })

  store.recordGeneration('ALFA')
  assert.equal(store.recordGeneration('ALFA').alert, true)
  assert.equal(store.generationsToday('ALFA'), 2)

  now = Date.parse('2026-08-03T09:00:00.000Z')
  assert.equal(store.generationsToday('ALFA'), 0, 'новый день — новый счёт')
  assert.equal(store.recordGeneration('ALFA').alert, false)
  assert.equal(store.recordGeneration('ALFA').alert, true, 'предупреждение снова доступно на новом дне')
})

test('счётчик переживает перезапуск процесса', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const first = fixture.create({ alertThreshold: 3 })
  first.recordGeneration('ALFA')
  first.recordGeneration('ALFA')

  // Другой экземпляр поверх того же файла — это и есть перезапуск сервера.
  const second = fixture.create({ alertThreshold: 3 })
  assert.equal(second.generationsToday('ALFA'), 2)
  assert.equal(second.recordGeneration('ALFA').alert, true, 'порог считается по сохранённому счёту')
  const third = fixture.create({ alertThreshold: 3 })
  assert.equal(third.recordGeneration('ALFA').alert, false, 'однократность тоже durable')
})

test('старые записи AgentLab остаются читаемыми после удаления прогона', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const store = fixture.create({ alertThreshold: 2 })

  writeFileSync(fixture.storageFile, JSON.stringify({
    schema_version: 1,
    day: new Date().toISOString().slice(0, 10),
    campaigns: { ALFA: { generations: 0, lab_generations: 2, alerted: false } },
  }), 'utf8')
  assert.equal(store.generationsToday('ALFA'), 0, 'dry-run лаборатории локаций не создаёт')
  assert.equal(store.report().campaigns.ALFA.lab_generations, 2, 'но расход админ видит')
  assert.equal(store.recordGeneration('ALFA').alert, false)
  assert.equal(store.recordGeneration('ALFA').alert, true, 'порог достигается только настоящими локациями')
})

test('отчёт даёт разбивку по кампаниям за сегодня', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const store = fixture.create({ alertThreshold: 2 })
  store.recordGeneration('ALFA')
  store.recordGeneration('ALFA')
  store.recordGeneration('BETA')
  writeFileSync(fixture.storageFile, JSON.stringify({
    schema_version: 1,
    day: new Date().toISOString().slice(0, 10),
    campaigns: {
      ALFA: { generations: 2, lab_generations: 0, alerted: true },
      BETA: { generations: 1, lab_generations: 1, alerted: false },
    },
  }), 'utf8')

  const report = store.report()
  assert.equal(report.alert_threshold, 2)
  assert.match(report.day, /^\d{4}-\d{2}-\d{2}$/u)
  assert.equal(report.campaigns.ALFA.generations, 2)
  assert.equal(report.campaigns.ALFA.alerted, true)
  assert.equal(report.campaigns.BETA.generations, 1)
  assert.equal(report.campaigns.BETA.alerted, false)
  assert.equal(report.total_generations, 3)
  assert.equal(report.total_lab_generations, 1)
})

test('порог берётся из настройки, а мусорное значение откатывается к умолчанию', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  assert.equal(fixture.create({ alertThreshold: 7 }).alertThreshold, 7)
  assert.equal(fixture.create({ alertThreshold: 0 }).alertThreshold, DEFAULT_ARCHITECT_ALERT_THRESHOLD)
  assert.equal(fixture.create({ alertThreshold: -3 }).alertThreshold, DEFAULT_ARCHITECT_ALERT_THRESHOLD)
  assert.equal(fixture.create({ alertThreshold: Number.NaN }).alertThreshold, DEFAULT_ARCHITECT_ALERT_THRESHOLD)
  assert.equal(fixture.create({ alertThreshold: 'много' }).alertThreshold, DEFAULT_ARCHITECT_ALERT_THRESHOLD)
})

test('повреждённый файл не роняет ход: счёт начинается заново', (t) => {
  const fixture = temporaryStore()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  writeFileSync(fixture.storageFile, '{ это не json', 'utf8')
  const store = fixture.create({ alertThreshold: 2 })
  assert.equal(store.generationsToday('ALFA'), 0)
  assert.equal(store.recordGeneration('ALFA').generations, 1)
})

test('текст предупреждения называет число и прямо говорит, что запрета нет', () => {
  const text = architectAlertText(4)
  assert.match(text, /создано 4 новых локаций/u)
  assert.match(text, /Ограничения нет/u)
})
