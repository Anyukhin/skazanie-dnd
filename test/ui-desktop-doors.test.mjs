import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  doorDirectionFromActor,
  doorOverlayCells,
} from '../src/desktop-ui.mjs'

test('door labels name the side of the exact edge relative to the acting hero', () => {
  const eastDoor = { x: 4, y: 3, dir: 'e' }
  const southDoor = { x: 8, y: 6, dir: 's' }
  assert.equal(doorDirectionFromActor(eastDoor, { x: 4, y: 3 }), 'восток')
  assert.equal(doorDirectionFromActor(eastDoor, { x: 5, y: 3 }), 'запад')
  assert.equal(doorDirectionFromActor(southDoor, { x: 8, y: 6 }), 'юг')
  assert.equal(doorDirectionFromActor(southDoor, { x: 8, y: 7 }), 'север')
})

test('hovering a door highlights precisely the two cells joined by its edge', () => {
  assert.deepEqual(doorOverlayCells({ x: 4, y: 3, dir: 'e' }), [{ x: 4, y: 3 }, { x: 5, y: 3 }])
  assert.deepEqual(doorOverlayCells({ x: 8, y: 6, dir: 's' }), [{ x: 8, y: 6 }, { x: 8, y: 7 }])
})

test('door controls connect hover and focus to the board overlay and expose lock DC in the label', async () => {
  const appSource = (await Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n')
  assert.match(appSource, /onPointerEnter: \(\) => setHoveredDoorId\(door\.id\)/)
  assert.match(appSource, /onFocus: \(\) => setHoveredDoorId\(door\.id\)/)
  assert.match(appSource, /doorOverlayCells\(highlightedDoor\)/)
  assert.match(appSource, /СЛ \$\{lockDc\}/)
})
