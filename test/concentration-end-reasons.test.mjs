import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { combatNarration } from '../server/combat-narration.mjs'
import { CONCENTRATION_END_REASON_LABELS, concentrationEndReasonLabel } from '../server/concentration-end-reasons.mjs'

// До 2026-10-04 подпись была у одной причины из тридцати, и игрок читал
// «Концентрация Миры прекращена · failed-saving-throw».

test('у каждой причины, которую пишет сервер, есть русская подпись', () => {
  const literal = new Set()
  for (const file of readdirSync(new URL('../server/', import.meta.url)).filter((name) => name.endsWith('.mjs'))) {
    const source = readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/'ConcentrationEnded',\s*\{[^}]*?reason:\s*'([a-z_-]+)'/gu)) literal.add(match[1])
  }
  assert.ok(literal.size >= 20, `найдено причин: ${literal.size}`)
  const missing = [...literal].filter((reason) => !Object.hasOwn(CONCENTRATION_END_REASON_LABELS, reason))
  assert.deepEqual(missing, [])
})

test('подписи русские, а незнакомый ключ не просачивается сырым', () => {
  for (const label of Object.values(CONCENTRATION_END_REASON_LABELS)) assert.match(label, /^[а-яё ,]+$/u)
  assert.equal(concentrationEndReasonLabel('failed-saving-throw'), 'спасбросок концентрации провален')
  assert.equal(concentrationEndReasonLabel('some-future-reason'), 'эффект завершён')
  assert.equal(concentrationEndReasonLabel(undefined), 'эффект завершён')
})

test('хроника боя называет причину словами', () => {
  const state = { players: [{ id: 'hero', character: 'Мира' }] }
  const text = combatNarration([{ event_type: 'ConcentrationEnded', target_ids: ['hero'], payload: { reason: 'failed-saving-throw' } }], state)
  assert.match(text, /спасбросок концентрации провален/u)
  assert.doesNotMatch(text, /failed-saving-throw/u)
  const lost = combatNarration([{ event_type: 'ReadiedActionExpired', target_ids: ['hero'], payload: { reason: 'concentration-lost', spell_id: 'magic-missile' } }], state)
  assert.match(lost, /заготовленное заклинание рассеивается/u)
})
