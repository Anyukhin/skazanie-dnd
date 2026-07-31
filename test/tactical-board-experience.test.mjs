import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('тактические модификаторы видны на самой цели и объясняют блокировку', () => {
  assert.match(app, /enemyForecast\.cover_bonus/u)
  assert.match(app, /позиция выше цели/u)
  assert.match(app, /позиция ниже цели/u)
  assert.match(app, /Траектория выходит за край карты/u)
  assert.match(app, /Линию огня перекрывает стена/u)
  assert.match(app, /token-tactical-badges/u)
  assert.match(styles, /\.token-tactical-badges \.advantage/u)
  assert.match(styles, /\.token-tactical-badges \.blocked/u)
})

test('постоянные состояния фишки имеют различимые знаки с приоритетом', () => {
  for (const condition of ['paralyzed', 'restrained', 'prone', 'frightened']) {
    assert.match(app, new RegExp(`${condition}:`))
    assert.match(styles, new RegExp(`data-condition="${condition}"`))
  }
  assert.match(app, /TOKEN_CONDITION_PRIORITY/u)
  assert.match(app, /<TokenConditionIcons conditions=\{enemyConditions\}/u)
})

test('качественное здоровье врага остаётся тонким кольцом без чисел', () => {
  assert.match(app, /!enemyHealth\.exact/u)
  assert.match(app, /className="enemy-health-ring"/u)
  assert.match(styles, /\.enemy-health-ring\[data-status="critical"\]/u)
})

test('легенда доски сворачивается и объясняет динамические слои', () => {
  assert.match(app, /<details className="map-legend">/u)
  for (const label of ['трудная местность', 'длящееся заклинание', 'Концентрация владельца', 'Высота в футах', 'Укрытие от линии огня']) {
    assert.match(app, new RegExp(label, 'u'))
  }
  assert.match(styles, /\.map-legend:not\(\[open\]\)/u)
})
