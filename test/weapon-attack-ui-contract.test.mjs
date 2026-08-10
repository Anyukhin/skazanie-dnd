import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('HTTP API принимает только безопасные mode/ability для MakeAttack и передаёт их Rules Engine', async () => {
  const index = await source('server/index.mjs')

  assert.match(index, /input\?\.attack_mode\s*==\s*null\s*&&\s*input\?\.attackMode\s*==\s*null/u)
  assert.match(index, /\['melee', 'ranged', 'thrown', 'two-handed'\]\.includes\(attackMode\)/u)
  assert.match(index, /\['str', 'dex'\]\.includes\(attackAbility\)/u)
  assert.match(index, /\(attackMode \|\| attackAbility \|\| sneakAttack\) && !itemId/u)
  assert.match(index, /attack_mode:\s*attackMode/u)
  assert.match(index, /attack_ability:\s*attackAbility/u)
})

test('игровой клиент отправляет выбранные weapon mode/ability и показывает только серверные варианты', async () => {
  const [session, map, types] = await Promise.all([
    source('src/useGameSession.ts'),
    source('src/DungeonMap.tsx'),
    source('src/types.ts'),
  ])

  assert.match(session, /attack_mode\?: 'melee' \| 'ranged' \| 'thrown' \| 'two-handed'/u)
  assert.match(session, /attack_ability\?: 'str' \| 'dex'/u)
  assert.match(session, /itemId && attackMode \? \{ attack_mode: attackMode \}/u)
  assert.match(session, /itemId && attackAbility \? \{ attack_ability: attackAbility \}/u)
  assert.match(map, /const weaponModeOptions = selectedWeaponCatalogCombat\?\.modes \?\? \[\]/u)
  assert.match(map, /WEAPON_ATTACK_MODE_LABELS/u)
  assert.match(map, /WEAPON_ATTACK_ABILITY_LABELS/u)
  assert.match(map, /attackMode: selectedWeaponMode\.id/u)
  assert.match(map, /attackAbility: selectedWeaponAbility/u)
  assert.match(types, /modes\?: Array<\{/u)
})
