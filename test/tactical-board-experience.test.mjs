import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const boardStyles = readFileSync(new URL('../src/tactical-board.css', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/TacticalBoard.tsx', import.meta.url), 'utf8')

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

test('легенда доски сворачивается, помнит состояние и объясняет динамические слои', () => {
  assert.match(app, /<details\s+className="map-legend"/u)
  for (const label of ['трудная местность', 'длящееся заклинание', 'Концентрация владельца', 'Высота в футах', 'Укрытие от линии огня']) {
    assert.match(app, new RegExp(label, 'u'))
  }
  assert.match(styles, /\.map-legend:not\(\[open\]\)/u)

  // Этап L8: поверхности, лестницы и память о свёрнутом состоянии.
  for (const label of ['Вода · движение вдвое дороже', 'Лёд · проверка на падение', 'Грязь · трудная местность',
    'Щебень · трудная местность', 'Лестница или люк · переход между этажами']) {
    assert.match(app, new RegExp(label, 'u'))
  }
  for (const swatch of ['surface-water', 'surface-ice', 'surface-mud', 'surface-rubble']) {
    assert.match(styles, new RegExp(`\\.legend-swatch\\.${swatch}`, 'u'))
  }
  assert.match(styles, /\.legend-mark\.stairs/u)
  // Свёрнута по умолчанию, состояние переживает перезагрузку.
  assert.match(app, /MAP_LEGEND_KEY\) === 'open'/u)
  assert.match(app, /window\.localStorage\.setItem\(MAP_LEGEND_KEY, open \? 'open' : 'closed'\)/u)
})

test('лестница объясняет назначение раньше кнопки перехода', () => {
  // Тултип и подпись панели считает та же чистая функция, что и надпись кнопки.
  assert.match(app, /levelTransitionHint\(sceneObject\?\.transition, knownSceneLevels\)/u)
  assert.match(app, /levelTransitionHint\(selectedSceneObject\.transition, knownSceneLevels\)/u)
  assert.match(app, /title=\{sceneObjectHint\}/u)
  assert.match(app, /aria-label=\{sceneObjectHint\}/u)
  assert.match(styles, /\.hotbar-turn-controls \.scene-object-lead/u)
})

test('лестница даёт кнопку перехода, а индикатор этажей стоит поверх карты и не ловит клики', () => {
  // Кнопка живёт в том же блоке, что и действия объекта сцены: подпись,
  // доступность и подсказку считает `levelTransitionPresentation`.
  assert.match(app, /levelTransitionPresentation\(\{/u)
  assert.match(app, /onUseLevelTransition\(selected, selectedSceneObject\.id\)/u)
  assert.match(app, /className="map-level-stack"/u)
  assert.match(app, /levelIndicatorRows\(knownSceneLevels, sceneLevelIndex\)/u)
  assert.match(app, /levelStackRows\.length > 0 &&/u)
  assert.match(boardStyles, /\.map-level-stack \{[^}]*pointer-events: none;/su)
  assert.match(boardStyles, /\.map-level-stack span\.active/u)
})

test('доска помнит камеру по этажу и растворяет смену этажа за 400 мс без rAF-цикла', () => {
  assert.match(board, /boardCameraKey\(map\?\.locationId, levelIndex\)/u)
  assert.match(board, /const LEVEL_CROSSFADE_MS = 400/u)
  assert.match(board, /level-change-\$\{levelShift\}/u)
  // Анимация живёт только эти 400 мс: таймер снимает класс, постоянного цикла нет.
  assert.match(board, /setTimeout\(\(\) => setLevelShift\(null\), LEVEL_CROSSFADE_MS\)/u)
  assert.match(boardStyles, /\.board-frame\.level-change-up \{[^}]*animation: tactical-level-change-up \.4s/su)
  assert.match(boardStyles, /@keyframes tactical-level-change-down \{[^}]*translateY\(-18px\)/su)
  // Reduced motion оставляет проявление, но убирает сдвиг.
  assert.match(boardStyles, /animation-name: tactical-level-change-fade;/u)
})
