import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [board, session] = await Promise.all([
  readFile(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8'),
])

test('панель «Разбудить» показывает выбор эффекта и отправляет wake_spell_id', () => {
  assert.match(board, /Эффект для пробуждения/u)
  assert.match(board, /Усыпление/u)
  assert.match(board, /Гипнотический узор/u)
  assert.match(board, /wakeSpellId/u)
  assert.match(session, /wake_spell_id: options\.wakeSpellId/u)
  assert.match(board, /action\.id !== 'awaken' \|\| awakenableAllyExists/u)
})

test('узор на союзнике распознаётся по видимому эффекту до проверки концентрации', () => {
  assert.match(board, /if \(spellId !== 'hypnotic-pattern' \|\| !condition\.effect_id\) return false[\s\S]+?if \(condition\.effect_id\.startsWith\('hypnotic-pattern:'\)\) return true[\s\S]+?concentration\[condition\.source_actor\]/u)
})
