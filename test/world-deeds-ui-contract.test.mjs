import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DEED_KINDS } from '../server/world-deeds.mjs'
import { campaignClockLabel } from '../src/desktop-ui.mjs'

const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('мировые минуты читаются ведущим как день и время', () => {
  assert.equal(campaignClockLabel(0), 'день 1, 00:00')
  assert.equal(campaignClockLabel(725), 'день 1, 12:05')
  assert.equal(campaignClockLabel(1_440), 'день 2, 00:00')
  assert.equal(campaignClockLabel(-10), 'день 1, 00:00')
})

test('лента поступков и слухов живёт в админке и подписана по-русски', () => {
  assert.match(views, /<WorldDeedsCard state=\{state\} \/>/u)
  assert.match(views, /admin-card admin-deeds/u)
  assert.match(views, /Поступки и слухи/u)
  // Секрет и молва — разные состояния карточки, и оба обязаны быть видны.
  assert.match(views, /БЕЗ СВИДЕТЕЛЕЙ/u)
  assert.match(views, /СВИДЕТЕЛЕЙ: \$\{deed\.witness_ids\?\.length \?\? 0\}/u)
  assert.match(views, /ВИДЕЛ САМ/u)
  assert.match(views, /ПЕРЕСКАЗ/u)
})

test('у каждого вида поступка есть русская подпись в интерфейсе', () => {
  const labels = views.match(/const DEED_LABELS: Record<string, string> = \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  for (const kind of Object.keys(DEED_KINDS)) {
    assert.match(labels, new RegExp(`\\b${kind}:`, 'u'),
      `вид поступка ${kind} остался без подписи в DEED_LABELS`)
  }
})

test('карточки поступков и слухов оформлены и не ломают узкий экран', () => {
  assert.match(styles, /\.deed-feed article \{/u)
  assert.match(styles, /\.deed-feed article\.bright \{/u)
  assert.match(styles, /\.rumor-list li \{/u)
  assert.match(styles, /\.deed-feed article \{ grid-template-columns: 1fr; \}/u)
})
