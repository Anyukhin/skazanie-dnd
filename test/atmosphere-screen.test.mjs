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
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ATMOSPHERE_SCREENS,
  SCREEN_MUSIC_TRACKS,
  atmosphereScreenAttenuation,
  atmosphereScreenFor,
  screenMusicTrack,
  screenMusicVolume,
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

test('музыка есть только у мастеров, прихожая молчит', () => {
  assert.deepEqual(Object.keys(SCREEN_MUSIC_TRACKS).sort(), ['hero-forge', 'world-forge'])
  assert.equal(screenMusicTrack('hero-forge'), '/assets/audio/character-creation-old-tower-inn.mp3')
  assert.equal(screenMusicTrack('world-forge'), '/assets/audio/world-creation-noonday-feast.mp3')
  // Владелец просил «при запуске не будет звуков»: музыку туда не ставили.
  assert.equal(screenMusicTrack('lobby'), null)
  assert.equal(screenMusicTrack('play'), null)
  assert.equal(screenMusicTrack('что-то ещё'), null)

  // Громкость — доля пользовательской настройки, и заведомо не громче игры.
  for (const screen of ['hero-forge', 'world-forge']) {
    const volume = screenMusicVolume(screen)
    assert.ok(volume > 0 && volume <= 1, `${screen}: ${volume}`)
    assert.ok(volume < 1, `${screen}: музыка мастера не должна быть громче игрового фона`)
  }
  assert.equal(screenMusicVolume('lobby'), 0)
  assert.equal(screenMusicVolume('play'), 0)
})

test('файлы музыки лежат в репозитории и объявлены в реестре прав', () => {
  const registry = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
  const declared = new Map(registry.assets.map((entry) => [entry[0], entry]))
  for (const track of Object.values(SCREEN_MUSIC_TRACKS)) {
    const relative = track.replace(/^\/assets\//u, '')
    const file = new URL(`../public/assets/${relative}`, import.meta.url)
    const bytes = readFileSync(file)
    assert.ok(bytes.length > 100_000, `${relative}: файл подозрительно мал`)
    const entry = declared.get(relative)
    assert.ok(entry, `${relative}: файл не объявлен в data/asset-rights.json`)
    assert.equal(entry[1], createHash('sha256').update(bytes).digest('hex'), `${relative}: хеш разошёлся с реестром`)
    assert.equal(entry[2], bytes.length, `${relative}: размер разошёлся с реестром`)
  }

  // CC BY 4.0 обязывает указать автора: без этой записи файл распространять
  // нельзя, и сторож не даст её потерять.
  const attribution = readFileSync(new URL('../ATTRIBUTION.md', import.meta.url), 'utf8')
  assert.match(attribution, /Noonday Feast of\s*\nthe Jolly Friar|Noonday Feast of the Jolly Friar/u)
  assert.match(attribution, /Elyvilon/u)
  assert.match(attribution, /CC BY 4\.0/u)
  assert.match(attribution, /opengameart\.org\/content\/medieval-fantasy-ambient-music-nimuehs-gift/u)
  assert.match(attribution, /RandomMind/u)
  assert.match(attribution, /opengameart\.org\/content\/medieval-the-old-tower-inn/u)
})

test('новых процедурных тем не заведено, приглушение идёт поверх настройки игрока', () => {
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
