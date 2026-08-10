import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('HTTP принимает только явный boolean-флаг Коварной атаки и привязывает его к оружию', () => {
  const index = source('../server/index.mjs')
  assert.match(index, /input\?\.sneak_attack === true \|\| input\?\.sneakAttack === true/u)
  assert.match(index, /\(attackMode \|\| attackAbility \|\| sneakAttack\) && !itemId/u)
  assert.match(index, /sneak_attack: true/u)
  assert.match(index, /sneak_attack: command\?\.sneak_attack === true/u)
  assert.match(index, /request_fingerprint: makeAttackCommandFingerprint\(command\)/u)
  assert.match(index, /assertMakeAttackIdempotency\(commandMatch\[1\], idempotencyKey, makeAttackCommands\)/u)
  assert.match(index, /assertMakeAttackResultFingerprint\(result, makeAttackCommands\)/u)
})

test('основной клиентский путь сохраняет выбор Коварной атаки до подтверждения цели', () => {
  const session = source('../src/useGameSession.ts')
  const map = source('../src/DungeonMap.tsx')
  const actions = source('../src/combat-actions.ts')
  assert.match(session, /sneakAttack\?: boolean/u)
  assert.match(session, /itemId && sneakAttack \? \{ sneak_attack: true \}/u)
  assert.match(map, /activeHero\?\.characterClass === 'rogue'/u)
  assert.match(map, /selectedItem\?\.type === 'weapon'/u)
  assert.match(map, /sneakAttack\?: boolean/u)
  assert.match(map, /pendingCommand\.sneakAttack \? \{ sneakAttack: true \}/u)
  assert.match(map, /type="checkbox" checked=\{sneakAttack\}/u)
  assert.match(actions, /id: 'sneak-attack',[\s\S]*name: 'Коварная атака',[\s\S]*mechanicsSupport: 'ruling-only'/u)
  assert.doesNotMatch(actions, /id: 'sneak-attack', name: 'Скрытая атака'/u)
})
