import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { atomicWrite } from './store.mjs'

/**
 * Счётчик живых генераций локаций Архитектора сцены — задача 1.4 плана
 * `docs/experience-upgrade-plan.md`.
 *
 * Решение владельца: в хаос-режиме локации создаются **без лимита**, но после
 * порога стол получает предупреждение о расходе. Поэтому здесь нет ни одной
 * ветки отказа: счётчик только считает и один раз за день сообщает, что расход
 * выше обычного.
 *
 * Почему отдельное хранилище, а не `usage-ledger.mjs`: тот леджер считает
 * токены и держит квоту, его запись — резервирование под конкретный запрос с
 * TTL и retention на месяц. Здесь нужна другая величина — сколько локаций
 * фактически создано в кампании за сегодня, — и она живёт ровно один день.
 * Складывать это в чужую структуру значило бы смешать квоту с игровой метрикой.
 *
 * Считаются только генерации, которые **дошли до модели**: `plan()` возвращает
 * `trace.mode === 'model'`, а детерминированный fallback токенов не тратит и в
 * счётчик не идёт.
 */

const SCHEMA_VERSION = 1
export const DEFAULT_ARCHITECT_ALERT_THRESHOLD = 3

const dayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10)
const campaignKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9-]/gu, '').slice(0, 24)

function emptyState(day) {
  return { schema_version: SCHEMA_VERSION, day, campaigns: {} }
}

function emptyCampaign() {
  return { generations: 0, lab_generations: 0, alerted: false }
}

export class ArchitectUsageStore {
  constructor({ storageFile, alertThreshold = DEFAULT_ARCHITECT_ALERT_THRESHOLD, now = () => Date.now() } = {}) {
    if (!storageFile) throw new TypeError('ArchitectUsageStore requires storageFile')
    this.storageFile = resolve(storageFile)
    const threshold = Number(alertThreshold)
    this.alertThreshold = Number.isSafeInteger(threshold) && threshold > 0
      ? threshold
      : DEFAULT_ARCHITECT_ALERT_THRESHOLD
    this.now = now
  }

  /**
   * Читает состояние, приведённое к текущему дню. Смена календарного дня
   * обнуляет счётчики: предупреждение относится к вечеру игры, а не к истории.
   * Повреждённый файл не роняет ход — счёт начинается заново, потому что цена
   * ошибки здесь это одна лишняя или пропущенная строка в летописи.
   */
  _read() {
    const today = dayKey(Number(this.now()))
    if (!existsSync(this.storageFile)) return emptyState(today)
    try {
      const value = JSON.parse(readFileSync(this.storageFile, 'utf8'))
      if (value?.schema_version !== SCHEMA_VERSION || !value.campaigns || typeof value.campaigns !== 'object' || Array.isArray(value.campaigns)) {
        return emptyState(today)
      }
      if (value.day !== today) return emptyState(today)
      return value
    } catch {
      return emptyState(today)
    }
  }

  _campaign(state, campaignId) {
    const key = campaignKey(campaignId)
    if (!key) return null
    const entry = state.campaigns[key]
    if (!entry || typeof entry !== 'object') {
      state.campaigns[key] = emptyCampaign()
      return state.campaigns[key]
    }
    return {
      ...emptyCampaign(),
      ...entry,
      generations: Number.isSafeInteger(Number(entry.generations)) && Number(entry.generations) >= 0 ? Number(entry.generations) : 0,
      lab_generations: Number.isSafeInteger(Number(entry.lab_generations)) && Number(entry.lab_generations) >= 0 ? Number(entry.lab_generations) : 0,
      alerted: entry.alerted === true,
    }
  }

  /** Сколько локаций кампания создала сегодня. */
  generationsToday(campaignId) {
    const state = this._read()
    const key = campaignKey(campaignId)
    if (!key) return 0
    return this._campaign(state, key)?.generations ?? 0
  }

  /**
   * Отмечает одну живую генерацию.
   *
   * @returns {{ day: string, generations: number, threshold: number, alert: boolean }}
   *   `alert` истинен ровно один раз за день на кампанию — на пересечении порога.
   */
  recordGeneration(campaignId) {
    const state = this._read()
    const key = campaignKey(campaignId)
    if (!key) return { day: state.day, generations: 0, threshold: this.alertThreshold, alert: false }
    const entry = this._campaign(state, key)
    entry.generations += 1
    // Порог считается достигнутым, когда за день создано столько локаций,
    // сколько названо порогом. Предупреждение уходит один раз: дальше расход
    // растёт, но повторять строку каждый ход — это шум, а не сигнал.
    const alert = !entry.alerted && entry.generations >= this.alertThreshold
    if (alert) entry.alerted = true
    state.campaigns[key] = entry
    atomicWrite(this.storageFile, state)
    return { day: state.day, generations: entry.generations, threshold: this.alertThreshold, alert }
  }

  /** Разбивка по кампаниям за сегодня — для `/api/admin/usage`. */
  report() {
    const state = this._read()
    const campaigns = Object.fromEntries(Object.entries(state.campaigns).map(([key, entry]) => [key, {
      generations: Number(entry?.generations) || 0,
      lab_generations: Number(entry?.lab_generations) || 0,
      alerted: entry?.alerted === true,
    }]))
    return {
      day: state.day,
      alert_threshold: this.alertThreshold,
      campaigns,
      total_generations: Object.values(campaigns).reduce((total, entry) => total + entry.generations, 0),
      total_lab_generations: Object.values(campaigns).reduce((total, entry) => total + entry.lab_generations, 0),
    }
  }
}

/** Текст предупреждения. Лимита нет — формулировка не должна пугать запретом. */
export function architectAlertText(generations) {
  return `За сегодня создано ${generations} новых локаций — расход токенов выше обычного. Ограничения нет, это только предупреждение.`
}
