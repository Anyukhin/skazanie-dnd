import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/atmosphere-audio.ts', import.meta.url), 'utf8')
const rootSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const viewsSource = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')

function extractedArray(name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`, 'u'))
  assert.ok(match, `${name} должен быть статическим readonly-каталогом`)
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}

test('атмосфера — только записанные петли: по одной на место, без синтеза и без эффектов', () => {
  // Владелец сравнил синтезированный гул с записями и оставил только
  // загруженное. Каталог настроений — ровно файлы в public/assets/audio/ambience.
  assert.deepEqual(extractedArray('ATMOSPHERE_MOODS'), [
    'building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement',
  ])
  assert.match(source, /\/assets\/audio\/ambience\/\$\{mood\}\.ogg/u, 'записанная атмосфера грузится по настроению')
  // Ни осцилляторов, ни шума, ни профилей синтеза, ни сигналов событий.
  assert.doesNotMatch(source, /createOscillator\(/u)
  assert.doesNotMatch(source, /createBiquadFilter\(/u)
  assert.doesNotMatch(source, /MOOD_PROFILES/u)
  assert.doesNotMatch(source, /ATMOSPHERE_EFFECTS/u)
  assert.doesNotMatch(source, /playEffect/u)
  assert.doesNotMatch(source, /effectsBus/u)
  // Бой и финал — не отдельные настроения: место от начала боя не меняется.
  assert.doesNotMatch(source, /'combat'|'finale'/u)
  assert.match(source, /export function normalizeAtmosphereMood\(value: unknown\): AtmosphereMood/u)
})

test('место без готового буфера не глушит сцену: играет прежняя петля, пока файл летит', () => {
  // Пока запись не раскодирована, слой не перезапускается: старая петля
  // продолжает звучать, а новая встаёт кроссфейдом, когда буфер готов.
  assert.match(source, /if \(!recorded\) \{\s*void loadAmbience\(mood\)\s*return\s*\}/u)
  assert.match(source, /if \(desiredMood === mood\) startAmbientLayer\(mood, 1\.2\)/u)
  assert.match(source, /if \(currentLayer\?\.mood === mood\) return/u, 'одно и то же место не перезапускается')
  // Неудача загрузки запоминается, чтобы не долбить сервер на каждой смене сцены.
  assert.match(source, /ambienceFailed\.add\(mood\)/u)
  assert.match(source, /player\.loop = true/u)
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

test('настройки — громкость фона и тишина; старый effectsVolume отбрасывается без ошибки', () => {
  for (const api of [
    'loadAtmosphereSettings', 'saveAtmosphereSettings', 'createAtmosphereAudio',
    'normalizeAtmosphereMood', 'setWaiting', 'setAmbientVolume', 'setMuted', 'getSettings', 'dispose',
  ]) assert.match(source, new RegExp(`\\b${api}\\b`, 'u'), `нет API ${api}`)
  assert.doesNotMatch(source, /setEffectsVolume/u)
  assert.match(source, /ambientVolume/u)
  assert.match(source, /localStorage/u)
  assert.match(source, /catch\s*\{/u)
  assert.match(source, /await context\.close\(\)/u)
  // Настройки — без ползунка эффектов; приложение не вызывает ушедших API.
  assert.doesNotMatch(viewsSource, /Эффекты событий/u)
  assert.doesNotMatch(viewsSource, /onEffectsVolumeChange/u)
  assert.doesNotMatch(rootSource, /playEffect\(|playEvents\(|setEffectsVolume\(/u)
  assert.match(rootSource, /setMood\(normalizeAtmosphereMood\(sceneTheme\), 1\.8\)/u, 'настроение — только по теме сцены')
})

test('ожидание генерации приглушает фон и возвращает его без отдельного сигнала', () => {
  assert.match(source, /ambientVolume \* \(waiting \? 0\.62 : 1\)/u)
  assert.match(source, /setWaiting\(value\)/u)
  assert.match(source, /updateBus\(context\?\.currentTime \?\? 0, 0\.45\)/u)
})
