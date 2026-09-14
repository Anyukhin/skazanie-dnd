import assert from 'node:assert/strict'
import test from 'node:test'
import { Narrator, deterministicNarration } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

const event = (event_type, payload = {}, target_ids = []) => ({ event_type, actor_id: 'ada', payload, target_ids, visibility: 'public' })
function brief(events = []) {
  return buildNarrationBrief({
    visible_events: events,
    known_environment: {
      scene: { title: 'Двор суда', location: 'Двор суда', mood: 'Под аркой лежит узкая полоса тени.' },
      story_context: {
        heroes: [{ id: 'ada', name: 'Ада' }],
        present_npcs: [{ id: 'osvald', name: 'Освальд' }, { id: 'lada', name: 'Лада' }, { id: 'bandit', name: 'Разбойник' }],
      },
    },
    permitted_npc_reactions: [],
  })
}
async function render(text, input) {
  const shown = []
  let calls = 0
  const result = await new Narrator({ asyncFeedback: false, llmClient: {
    complete: async ({ onDelta }) => {
      calls += 1
      for (const fragment of text.match(/[^.!?]+[.!?]?/gu) ?? []) onDelta(fragment)
      return { content: text }
    },
  } }).render(input, { onProgress: value => shown.push(value) })
  assert.equal(calls, 1, 'Исправление проверки не требует второй генерации')
  return { result, shown }
}
const check = (ability = 'cha', success = true) => brief([event('AbilityCheckResolved', { ability, success })])

for (const [ability, success, text] of [
  ['cha', true, 'Ада убедила собеседника.'],
  ['cha', true, 'Ада сумела расположить к себе собеседников у Северных ворот.'],
  ['cha', true, 'Ада ведёт разговор уверенно, и её попытка взять верх удаётся.'],
  ['cha', true, 'Слова Ады попали куда нужно — удача улыбнулась ей.'],
  ['cha', true, 'Ада убедила собеседников, но новых сведений это пока не принесло.'],
  ['cha', true, 'Слова Ады легли в цель — её наконец услышали.'],
  ['cha', true, 'Проверка не означает, что Ада убедила собеседника, но Ада убедила стражу.'],
  ['dex', false, 'Ада попыталась разглядеть след у каменного льва, но ловкость её не выручила.'],
  ['dex', false, 'Ада не смогла удержать равновесие на обугленных досках, и ловкость подвела её.'],
  ['dex', false, 'Колеи в золе остались лишь колеями — ловушка не удалась.'],
  ['wis', true, 'Внимательный взгляд нашёл то, что искал.'],
]) test(`проверка не создаёт самостоятельный результат: ${text}`, async () => {
  const { result, shown } = await render(text, check(ability, success))
  assert.equal(result.provider, 'deterministic-fallback', JSON.stringify(result.verification))
  assert.ok(result.verification.valid, 'Сам запасной текст должен оставаться допустимым')
  assert.deepEqual(shown, [result.narration], 'Выдумка не попадает даже в потоковый префикс')
})

test('подтверждённое согласие разрешает социальный результат', async () => {
  const input = check()
  input.permitted_npc_reactions = [{ npc_id: 'osvald', name: 'Освальд', reaction: 'persuaded', description: 'принимает довод' }]
  const { result } = await render('Ада убедила собеседника.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})
test('посторонний кивок не разрешает находку после проверки', async () => {
  const input = check('wis')
  input.permitted_npc_reactions = [{ npc_id: 'osvald', name: 'Освальд', reaction: 'welcoming', description: 'приветливо кивает' }]
  const { result } = await render('Взгляд нашёл то, что искал.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})
for (const text of ['Освальд не соглашается.', 'Освальд не убеждён.']) {
  test(`разрешённое согласие не становится отказом: ${text}`, async () => {
    const input = check()
    input.permitted_npc_reactions = [{ npc_id: 'osvald', name: 'Освальд', reaction: 'persuaded', description: 'соглашается с доводом' }]
    const { result } = await render(text, input)
    assert.equal(result.provider, 'deterministic-fallback')
  })
}
for (const [reaction, text, accepted] of [
  ['persuaded', 'Освальд соглашается.', true],
  ['persuaded', 'Освальд убеждён.', true],
  ['unconvinced', 'Освальд не соглашается.', true],
  ['unconvinced', 'Освальд соглашается.', false],
]) test(`утверждение и отрицание согласия не смешиваются: ${reaction}, ${text}`, async () => {
  const input = check()
  input.permitted_npc_reactions = [{ npc_id: 'osvald', name: 'Освальд', reaction, description: reaction === 'persuaded' ? 'Освальд соглашается с доводом' : 'Освальд не соглашается с доводом' }]
  const { result } = await render(text, input)
  assert.equal(result.provider === 'Object', accepted, JSON.stringify(result.verification))
})
test('описание известного звука не считается убеждением NPC', async () => {
  const input = brief()
  input.known_environment.scene.sensory_anchors = { sound: 'Шум за стеной' }
  const { result } = await render('Наконец услышали шум за стеной.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

for (const text of [
  'Проверка Харизмы завершилась успехом.',
  'Успешная проверка ещё не означает, что Ада убедила собеседника.',
  'Ловкость подвела Аду.',
]) test(`честный предел проверки разрешён: ${text}`, async () => {
  const { result } = await render(text, check())
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

function declaration() {
  const input = brief([event('ActionDeclared'), event('RulingRecorded')])
  input.known_environment.player_intent = { action: 'Расспросить Миру', goal: 'Получить новые показания' }
  return input
}
for (const text of [
  'Ада лишь наметила расспросить Миру — это намерение пока не исполнено, и новых показаний у неё нет.',
  'Новых показаний пока нет.',
  'Пока нет новых показаний.',
  'Показаний ещё нет; действие не выполнено.',
]) test(`отсутствие новых сведений не становится их раскрытием: ${text}`, async () => {
  const { result, shown } = await render(text, declaration())
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
  assert.deepEqual(shown, [text])
})
for (const text of [
  'Показания получены, но улик пока нет.',
  'Новых показаний нет, зато Ада узнала правду.',
]) test(`отрицание соседнего факта не разрешает раскрытие: ${text}`, async () => {
  const { result } = await render(text, declaration())
  assert.equal(result.provider, 'deterministic-fallback')
})

function dialogue() {
  const replies = [
    ['osvald', 'Освальд', 'Без печати магистра доступ закрыт. Порядок один для всех.'],
    ['lada', 'Лада', 'До заката подожду у переправы. Дольше — уж не обессудьте.'],
  ]
  const input = brief(replies.map(([npc_id, , npc_reply]) => event('NpcConversationRecorded', { conversation: { npc_id, hero_id: 'ada', npc_reply } }, [npc_id])))
  input.permitted_npc_reactions = replies.map(([npc_id, name, text]) => ({ npc_id, name, text }))
  return input
}
test('пересказ записанного отказа не считается опусканием предмета', async () => {
  const text = 'Освальд не пропускает в архив без печати магистра, а Лада соглашается ждать у переправы до заката. Под аркой двора суда лежит узкая полоса тени.'
  const { result, shown } = await render(text, dialogue())
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
  assert.ok(shown.includes(text))
})
for (const text of ['Освальд пропустил отряд.', 'Освальд не пропустил отряд.']) {
  test(`прошедшее время допуска тоже требует основания: ${text}`, async () => {
    const { result } = await render(text, brief())
    assert.equal(result.provider, 'deterministic-fallback')
  })
}
test('подтверждённый отказ передаётся и в прошедшем времени', async () => {
  const { result } = await render('Освальд не пропустил в архив без печати магистра.', dialogue())
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})
test('отказ с повторённым условием доступа после двоеточия остаётся разрешённым', async () => {
  const { result } = await render('Освальд не пропустил отряд в архив: без печати магистра доступ закрыт, и порядок один для всех.', dialogue())
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})
for (const text of [
  'Освальд пропускает в архив без печати магистра.',
  'Лада не пропускает в архив без печати магистра.',
  'Освальд не пропускает в архив без печати магистра и открывает дверь.',
  'Освальд не пропускает в архив без печати магистра. Он опускает решётку.',
  'Освальд пропускает в архив и не пропускает в архив без печати магистра.',
]) test(`разрешённый отказ не разрешает другой исход или действие: ${text}`, async () => {
  const { result } = await render(text, dialogue())
  assert.equal(result.provider, 'deterministic-fallback', JSON.stringify(result.verification))
})

function ring() {
  const input = brief([event('LootContainerTaken', {
    recipient_id: 'ada', container_id: 'chest', container_name: 'кедровый ларец',
    items: [{ id: 'silver-ring', name: 'серебряное кольцо без камня', quantity: 1 }],
    summary: 'Ада забрала серебряное кольцо без камня из кедрового ларца.',
  }, ['ada'])])
  return input
}
test('получение кольца не сообщает, что его кто-то спрятал', async () => {
  const text = 'Ада забрала серебряное кольцо. Остаётся вопросом, чьей рукой оно было спрятано здесь.'
  const { result, shown } = await render(text, ring())
  assert.equal(result.provider, 'deterministic-fallback')
  assert.ok(!shown.some(value => value.includes('спрятано')))
})
test('известное происхождение вещи остаётся разрешённым', async () => {
  const input = ring()
  input.visible_events.push(event('WorldFactRecorded', { fact: { subject_id: 'silver-ring', summary: 'Серебряное кольцо было спрятано в ларце смотрителем.' } }))
  const { result } = await render('Серебряное кольцо было спрятано в ларце смотрителем.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})
test('история другой вещи не разрешает придуманное происхождение кольца', async () => {
  const input = ring()
  input.visible_events.push(event('WorldFactRecorded', { fact: { subject_id: 'other-ring', summary: 'Серебряное кольцо было спрятано смотрителем.' } }))
  const { result } = await render('Кольцо было спрятано смотрителем.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})
test('история одной вещи не распространяется на другую из того же набора добычи', async () => {
  const input = ring()
  input.visible_events[0].payload.items.push({ id: 'gold-ring', name: 'золотое кольцо', quantity: 1 })
  input.visible_events.push(event('WorldFactRecorded', { fact: { subject_id: 'silver-ring', summary: 'Серебряное кольцо было спрятано смотрителем.' } }))
  const { result } = await render('Золотое кольцо было спрятано смотрителем.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})
test('совпадение названия без идентификатора не доказывает историю вещи', async () => {
  const input = ring()
  input.visible_events.push(event('WorldFactRecorded', { fact: { summary: 'Другое серебряное кольцо было спрятано смотрителем.' } }))
  const { result } = await render('Серебряное кольцо было спрятано смотрителем.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})

for (const [actor, target, text, accepted] of [
  ['ada', 'bandit', 'Ада достаёт разбойника рубящим ударом.', true],
  ['ada', 'bandit', 'Ада достаёт разбойника рубящим ударом — тот получает урон, но остаётся жив.', true],
  ['other-hero', 'bandit', 'Ада достаёт разбойника рубящим ударом.', false],
  ['ada', 'osvald', 'Ада достаёт разбойника рубящим ударом.', false],
  ['ada', 'bandit', 'Ада достаёт меч.', false],
  ['ada', 'bandit', 'Ада достаёт разбойника рубящим ударом и открывает дверь.', false],
]) test(`удар сохраняет действующего героя и цель: ${actor}, ${target}, ${text}`, async () => {
  const input = brief([{ ...event('DamageApplied', { damage_type: 'slashing', hp_after: 7 }, [target]), actor_id: actor }])
  const { result } = await render(text, input)
  assert.equal(result.provider === 'Object', accepted, JSON.stringify(result.verification))
})
test('нулевой применённый урон не разрешает боевой оборот о достигшем цели ударе', async () => {
  const input = brief([event('DamageApplied', { damage_type: 'slashing', applied_amount: 0, hp_after: 7 }, ['bandit'])])
  const { result } = await render('Ада достаёт разбойника рубящим ударом.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})
test('боевой оборот не утверждает жизнь цели без положительных ОЗ', async () => {
  for (const hp_after of [0, undefined]) {
    const input = brief([event('DamageApplied', { damage_type: 'slashing', applied_amount: 3, hp_after }, ['bandit'])])
    const { result } = await render('Ада достаёт разбойника рубящим ударом — тот получает урон, но остаётся ЖИВ.', input)
    assert.equal(result.provider, 'deterministic-fallback')
  }
})

test('запасной диалог корректно соединяет реплики и полное предложение mood', async () => {
  const input = dialogue()
  const fallback = deterministicNarration(input).narration
  assert.doesNotMatch(fallback, /\.{2}|[.!?]»\.|Двор суда, Под/u)
  assert.match(fallback, /Освальд: «Без печати магистра доступ закрыт\. Порядок один для всех\.»/u)
  assert.match(fallback, /Лада: «До заката подожду у переправы\. Дольше — уж не обессудьте\.»/u)
  const result = await new Narrator({ asyncFeedback: false }).render(input)
  assert.equal(result.verification.valid, true, JSON.stringify(result.verification))
})
test('полное предложение обстановки не склеивается с местом через запятую', () => {
  const text = deterministicNarration(brief()).narration
  assert.doesNotMatch(text, /\.{2}|Двор суда, Под/u)
})
