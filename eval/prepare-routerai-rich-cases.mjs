import { readFileSync, writeFileSync } from 'node:fs'

const source = JSON.parse(readFileSync('eval/routerai-cases-2026-09-07.json', 'utf8'))
const openPromise = source.find(entry => entry.id === 'open-promise')
if (!openPromise) throw new Error('open-promise case is missing')
openPromise.brief.visible_events = []
openPromise.brief.known_environment.player_intent = {
  action: 'Я спрашиваю Миру, оставила ли она обещанную карту старых троп под медной кружкой.',
  goal: 'Понять, выполнено ли обещание Миры',
  roleplay_speech: true,
}
openPromise.brief.known_environment.scene.objective = 'Проверить обещание Миры о карте старых троп'
openPromise.expected = 'Напомнить об обещании Миры и не выдавать карту за полученную без события передачи.'
writeFileSync('tmp/routerai-narrator-rich-cases-2026-11-27.json', `${JSON.stringify(source, null, 2)}\n`)
