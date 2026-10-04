#!/usr/bin/env node
// Какие действия игрок видит без собственного рисунка и все ли они есть в плане.
//
// Тест test/action-icon-manifest.test.mjs перебирает классы без подкласса, поэтому
// действия подклассов в нём не видны: интерфейс показывает им клетку атласа, и
// пробел не ловит никто. Здесь перебираются все подклассы на 12-м уровне тем же
// combatActionsFor, что кормит интерфейс, плюс клиентские действия из
// src/combat-actions.ts. Без selectedFeatureIds необязательные умения доступны
// все, поэтому список максимальный.
//
// Таблица промптов — docs/icon-plan-2026-10-actions.md: строка на файл `<id>.png`.
//
// Запуск: node tools/action-icon-gaps.mjs           — сводка
//         node tools/action-icon-gaps.mjs --json    — список без рисунка
//         node tools/action-icon-gaps.mjs --check   — код 1, если план разошёлся с кодом
import { readdirSync, readFileSync } from 'node:fs'

import { combatActionsFor } from '../server/combat-actions.mjs'

const ICON_DIR = new URL('../public/assets/ui/action-icons/', import.meta.url)
const CATALOG = new URL('../data/dndsu-class-actions-1-12.json', import.meta.url)
const CLIENT_ACTIONS = new URL('../src/combat-actions.ts', import.meta.url)
const PLAN = new URL('../docs/icon-plan-2026-10-actions.md', import.meta.url)

export function iconIds() {
  return new Set(readdirSync(ICON_DIR).filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -'.png'.length)))
}

/** Действия без рисунка: идентификатор, название, тип, класс и подкласс. */
export function actionsWithoutIcon() {
  const icons = iconIds()
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
  const found = new Map()
  for (const entry of catalog.classes) {
    for (const subclass of [null, ...entry.subclasses]) {
      const actor = { characterClass: entry.classKey, level: 12, abilities: {}, ...(subclass ? { subclass: subclass.id } : {}) }
      for (const action of combatActionsFor(actor)) {
        if (icons.has(String(action.id)) || found.has(action.id)) continue
        found.set(action.id, { id: action.id, name: action.name, actionType: action.actionType ?? null, classKey: entry.classKey, subclass: subclass?.name ?? null })
      }
    }
  }
  // Оружие дыхания приходит от расы, а не от класса: combatActionsFor отдаёт его,
  // только когда у героя есть speciesBenefits с драконьим наследием.
  if (!icons.has('breath-weapon')) found.set('breath-weapon', { id: 'breath-weapon', name: 'Оружие дыхания', actionType: 'action', classKey: 'species', subclass: null })
  // Клиентский каталог держит пару умений, которых нет в серверном списке действий.
  const source = readFileSync(CLIENT_ACTIONS, 'utf8')
  for (const match of source.matchAll(/^\s+id: '([a-z0-9-]+)', classKey: '([a-z]+)', name: '([^']+)'.*actionType: '([a-z_]+)'/gmu)) {
    const [, id, classKey, name, actionType] = match
    if (!icons.has(id) && !found.has(id)) found.set(id, { id, name, actionType, classKey, subclass: null, client: true })
  }
  return [...found.values()]
}

/** Идентификаторы из таблицы плана: первая колонка с `<id>.png`. */
export function plannedIds() {
  let text = ''
  try { text = readFileSync(PLAN, 'utf8') } catch { return new Set() }
  return new Set([...text.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9-]+)\.png`/gmu)].map((match) => match[1]))
}

export function planReport() {
  const icons = iconIds()
  const missing = actionsWithoutIcon()
  const planned = plannedIds()
  const missingIds = new Set(missing.map((row) => row.id))
  return {
    withoutIcon: missing.length,
    planned: planned.size,
    notPlanned: missing.filter((row) => !planned.has(row.id)).map((row) => row.id),
    alreadyDrawn: [...planned].filter((id) => icons.has(id)),
    unknownInPlan: [...planned].filter((id) => !icons.has(id) && !missingIds.has(id)),
  }
}

if (process.argv[1]?.replace(/\\/gu, '/').endsWith('tools/action-icon-gaps.mjs')) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(actionsWithoutIcon(), null, 2))
  } else {
    const report = planReport()
    console.log(JSON.stringify(report, null, 2))
    if (process.argv.includes('--check') && (report.notPlanned.length || report.unknownInPlan.length)) process.exitCode = 1
  }
}
