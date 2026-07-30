import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/atmosphere-audio.ts', import.meta.url), 'utf8')

function extractedArray(name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`, 'u'))
  assert.ok(match, `${name} должен быть статическим readonly-каталогом`)
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}

test('аудиоконтур покрывает все темы и процедурные эффекты W', () => {
  assert.deepEqual(extractedArray('ATMOSPHERE_MOODS'), [
    'building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement', 'combat', 'finale',
  ])
  assert.deepEqual(extractedArray('ATMOSPHERE_EFFECTS'), [
    'dice', 'hit', 'miss', 'heal', 'coins', 'door', 'level', 'victory', 'defeat', 'narration',
  ])
  assert.match(source, /createOscillator\(/u)
  assert.match(source, /createBufferSource\(/u)
  assert.match(source, /createBiquadFilter\(/u)
  assert.doesNotMatch(source, /\.(?:mp3|wav|ogg|m4a)\b/ui)
})

test('AudioContext создаётся только внутри явного unlock и mood меняется crossfade-ом', () => {
  const factoryUse = source.indexOf('context = factory()')
  const unlock = source.indexOf('async unlock()')
  assert.ok(unlock >= 0 && factoryUse > unlock, 'factory AudioContext должна вызываться после unlock')
  assert.doesNotMatch(source.slice(0, source.indexOf('export function createAtmosphereAudio')), /new AudioContext\(/u)
  assert.match(source, /linearRampToValueAtTime\(1,/u)
  assert.match(source, /linearRampToValueAtTime\(0,/u)
  assert.match(source, /previous\.sources/u)
})

test('настройки разделяют ambient/effects, сохраняются безопасно и dispose закрывает контекст', () => {
  for (const api of [
    'loadAtmosphereSettings', 'saveAtmosphereSettings', 'createAtmosphereAudio',
    'normalizeAtmosphereMood', 'atmosphereEffectForEvent', 'atmosphereEffectsForEvents',
    'setAmbientVolume', 'setEffectsVolume', 'setMuted', 'getSettings', 'dispose',
  ]) assert.match(source, new RegExp(`\\b${api}\\b`, 'u'), `нет API ${api}`)
  assert.match(source, /ambientVolume/u)
  assert.match(source, /effectsVolume/u)
  assert.match(source, /localStorage/u)
  assert.match(source, /catch\s*\{/u)
  assert.match(source, /await context\.close\(\)/u)
})

test('event mapping отличает hit/miss и не раскрывает скрытую ловушку', () => {
  assert.match(source, /AttackResolved/u)
  assert.match(source, /payload\?\.hit === false \? 'miss' : 'hit'/u)
  assert.match(source, /CampaignCompleted: 'victory'/u)
  assert.match(source, /CampaignFailed: 'defeat'/u)
  assert.match(source, /NarrativeSummaryRecorded: 'narration'/u)
  assert.match(source, /HIDDEN_TRAP_EVENTS/u)
  assert.match(source, /TrapHidden/u)
  assert.doesNotMatch(source, /TrapHidden:\s*'(?:hit|dice|door|narration)'/u)
})
