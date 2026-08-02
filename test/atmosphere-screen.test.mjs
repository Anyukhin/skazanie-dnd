// Громкость фона на экранах до игры.
//
// Живой отзыв владельца: «при запуске не будет звуков или они должны быть
// тихими». До этого громкость зависела только от настройки игрока, и список
// кампаний звучал ровно как игровая комната.
//
// Своих музыкальных тем у этих экранов нет намеренно: чем им звучать — решение
// владельца, и придумывать его за него нельзя. Здесь проверяется только выбор
// экрана и приглушение.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ATMOSPHERE_SCREENS,
  atmosphereScreenAttenuation,
  atmosphereScreenFor,
} from '../src/atmosphere-screen.mjs'

const audioSource = readFileSync(new URL('../src/atmosphere-audio.ts', import.meta.url), 'utf8')

test('экран выбирается по приоритету: мастер важнее списка, список важнее комнаты', () => {
  assert.deepEqual([...ATMOSPHERE_SCREENS], ['hero-forge', 'world-forge', 'lobby', 'play'])

  assert.equal(atmosphereScreenFor({ authenticated: false }), 'lobby', 'до входа звучит прихожая')
  assert.equal(atmosphereScreenFor({ authenticated: true }), 'play')
  assert.equal(atmosphereScreenFor({ campaignListOpen: true }), 'lobby')
  assert.equal(atmosphereScreenFor({ worldWizardOpen: true }), 'world-forge')
  assert.equal(atmosphereScreenFor({ heroWizardOpen: true }), 'hero-forge')

  // Мастер поверх списка — решает мастер, а не список.
  assert.equal(atmosphereScreenFor({ campaignListOpen: true, worldWizardOpen: true }), 'world-forge')
  assert.equal(atmosphereScreenFor({ campaignListOpen: true, heroWizardOpen: true }), 'hero-forge')
  assert.equal(atmosphereScreenFor({ worldWizardOpen: true, heroWizardOpen: true }), 'hero-forge')

  // Экран входа перебивает всё: там ещё нет ни кампании, ни героя.
  assert.equal(atmosphereScreenFor({ authenticated: false, heroWizardOpen: true }), 'lobby')
  assert.equal(atmosphereScreenFor(), 'play')
})

test('вход молчит, мастера приглушены, игра звучит как прежде', () => {
  assert.equal(atmosphereScreenAttenuation('lobby'), 0, 'на входе и в списке кампаний фона нет')
  assert.equal(atmosphereScreenAttenuation('play'), 1, 'в игре громкость не тронута')
  for (const screen of ['world-forge', 'hero-forge']) {
    const value = atmosphereScreenAttenuation(screen)
    assert.ok(value > 0 && value < 1, `${screen}: тише игры, но не мёртвая тишина — ${value}`)
  }
  // Незнакомый экран считается игровым: ошибиться в сторону обычной громкости
  // безопаснее, чем молча выключить звук.
  assert.equal(atmosphereScreenAttenuation('что-то ещё'), 1)
  assert.equal(atmosphereScreenAttenuation(undefined), 1)
})

test('новых музыкальных тем не заведено, приглушение идёт поверх настройки игрока', () => {
  // Сторож против «изобрели тему»: каталог настроений обязан остаться прежним.
  const moods = audioSource.match(/export const ATMOSPHERE_MOODS = \[([\s\S]*?)\] as const/u)
  assert.ok(moods)
  assert.deepEqual([...moods[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]), [
    'building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement', 'combat', 'finale',
  ])

  // Приглушение — множитель поверх пользовательской громкости, а не её замена.
  assert.match(audioSource, /settings\.ambientVolume \* \(waiting \? 0\.62 : 1\) \* screenAttenuation/u)
  assert.match(audioSource, /setScreenAttenuation\(scale: number\): void/u)
  // Эффекты не трогаются: кубик и удар обязаны звучать одинаково везде.
  assert.match(audioSource, /const effects = settings\.muted \? 0 : settings\.effectsVolume/u)
})
