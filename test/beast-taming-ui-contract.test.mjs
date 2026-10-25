import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BEAST_PLAYER_COMMAND_TYPES, beastChronicleEntry } from '../server/beast-taming.mjs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('клиент называет только зверя: СЛ, навык и паёк остаются серверными', () => {
  for (const type of BEAST_PLAYER_COMMAND_TYPES) {
    assert.ok(session.includes(`command_type: '${type}'`), `клиент не умеет отправлять ${type}`)
  }
  assert.match(session, /beastAction = useCallback/u)
  assert.match(app, /onBeastAction=\{\(beastId, action\) => beastAction\(activePlayer\.id, beastId, action\)\}/u)
  // Ни навыка, ни СЛ, ни выбранного предмета в клиентской команде быть не должно.
  assert.doesNotMatch(session, /beast_id[^\n]*(difficulty|skill|item_id)/u)
})

test('ступень приручения приезжает в летопись карточкой, а не голой строкой', () => {
  const card = beastChronicleEntry({
    event_type: 'BeastTamed',
    payload: { beast_id: 'beast:abc', beast_name: 'Волк 1', diet: 'predator' },
  })
  assert.equal(card.id, 'chronicle:beast:abc:tamed')
  assert.equal(card.beast.kind, 'tamed')
  assert.match(card.beast.text, /в строй не встаёт/u)
  assert.equal(card.beast.diet_label, 'хищник')
  // Провал и укус карточки не получают: рамка вокруг «волк не подпустил»
  // превратила бы летопись в ленту уведомлений.
  assert.equal(beastChronicleEntry({ event_type: 'BeastBit', payload: { beast_id: 'beast:abc' } }), null)
  assert.equal(beastChronicleEntry({
    event_type: 'BeastSoothingResolved',
    payload: { beast_id: 'beast:abc', success: false, stage_after: 'calmed' },
  }), null)
  assert.match(views, /export function BeastChronicleEntry/u)
  assert.match(views, /message\.beast \?/u)
})

// JS-only: проверка читает текст server/index.mjs. После переключения на Rust она
// проверяла бы мёртвый код — удалить вместе с server/index.mjs (С19). В Rust тот же путь в летопись —
// candidates_for в rust/crates/sk-server/src/journal.rs (beast_chronicle_entry);
// HTTP-сценария приручения пока нет ни в одном режиме.
test('JS-only (server/index.mjs): карточка зверя идёт в летопись тем же путём, что конверт почты', () => {
  // Тот же путь в летопись, что у конверта почты, — иначе карточка не дойдёт.
  assert.match(server, /eventsForChronicle\.map\(beastChronicleEntry\)/u)
})
