// Авторские диалоги кампании (docs/offline-playable-plan.md, этап 1).
//
// Прогон «Асстоханских равнин» без модели 2026-10-12: король Арес на первый
// же вопрос о поручении отвечал «Больше мне сказать нечего», и все реплики
// собеседников были отписками. Диалог с вариантами ответа — данные; здесь
// стерегутся их целостность и правила показа вариантов.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { DIALOGUES, dialogueOptionsFor, normalizeDialogues } from '../server/campaign-dialogues.mjs'
import { campaignScenario, scenarioClueFactId, scenarioFoundClueIds, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { fixedDice } from './kit/dice.mjs'

const scenarios = JSON.parse(readFileSync(new URL('../data/campaign-scenarios-v1.json', import.meta.url), 'utf8')).scenarios
const worlds = JSON.parse(readFileSync(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8'))
const worldList = Array.isArray(worlds) ? worlds : (worlds.worlds ?? worlds.templates ?? Object.values(worlds).find(Array.isArray))

test('каждый диалог ссылается на настоящих собеседника, тайны и предметы сценария', () => {
  assert.ok(DIALOGUES.length >= 1)
  for (const dialogue of DIALOGUES) {
    const scenario = scenarios.find((entry) => entry.id === dialogue.scenario_id)
    assert.ok(scenario, `${dialogue.id}: сценарий ${dialogue.scenario_id}`)
    const world = worldList.find((entry) => entry.id === scenario.world_template_id)
    const npcIds = new Set([
      ...(world?.opening?.npcs ?? []).map((npc) => npc.id),
      ...scenario.locations.flatMap((location) => (location.npcs ?? []).map((npc) => npc.id)),
    ])
    assert.ok(npcIds.has(dialogue.npc_id), `${dialogue.id}: собеседник ${dialogue.npc_id}`)
    const secretIds = new Set(scenario.locations.flatMap((location) => (location.secrets ?? []).map((secret) => secret.id)))
    const openingTopics = new Set((world?.opening?.secrets ?? []).map((secret) => secret.topic))
    const armory = new Set(scenario.progression?.armory?.catalog_ids ?? [])
    for (const option of dialogue.options) {
      for (const clue of [...option.requires.clues_any, ...option.requires.clues_all]) assert.ok(secretIds.has(clue), `${dialogue.id}.${option.id}: улика ${clue}`)
      for (const reveal of [option.success.reveal, option.failure?.reveal].filter(Boolean)) assert.ok(secretIds.has(reveal), `${dialogue.id}.${option.id}: тайна ${reveal}`)
      for (const topic of [option.success.reveal_topic, option.failure?.reveal_topic].filter(Boolean)) assert.ok(openingTopics.has(topic), `${dialogue.id}.${option.id}: тема ${topic}`)
      if (option.action?.command_type === 'ChooseScenarioArmoryItem') assert.ok(armory.has(option.action.catalog_id), `${dialogue.id}.${option.id}: предмет ${option.action.catalog_id}`)
    }
    assert.ok(dialogue.options.some((option) => option.ends), `${dialogue.id}: разговор можно закончить`)
  }
})

test('сломанные данные диалога отвергаются при загрузке, а не посреди вечера', () => {
  const base = { schema_version: 1, dialogues: [{ id: 'd', scenario_id: 's', npc_id: 'n', greeting: 'Здравствуй.', options: [{ id: 'bye', label: 'Пока.', reply: 'Пока.', ends: true }] }] }
  assert.equal(normalizeDialogues(base).length, 1)
  const broken = (patch) => () => normalizeDialogues({ ...base, dialogues: [{ ...base.dialogues[0], ...patch }] })
  assert.throws(broken({ options: [{ id: 'x', label: 'Кто ты?', check: { skill: 'insight', dc: 15 }, success: { reply: 'Да.' } }] }), /success и failure/u)
  assert.throws(broken({ options: [{ id: 'x', label: 'Кто ты?', reply: 'Да.', requires: { flags: ['nobody-sets'] } }] }), /никто не ставит/u)
  assert.throws(broken({ options: [{ id: 'x', label: 'Кто ты?', reply: 'Да.', action: { command_type: 'KillEveryone' } }] }), /команда/u)
  assert.throws(broken({ options: [{ id: 'x', label: 'Кто ты?', check: { skill: 'insight', dc: 99 }, success: { reply: 'Да.' }, failure: { reply: 'Нет.' } }] }), /СЛ/u)
  assert.throws(() => normalizeDialogues({ ...base, schema_version: 2 }), /schema_version/u)
})

// --- Команда ChooseDialogueOption на настоящей кампании Асстохана -----------

const heroes = [
  { id: 'talk-hero', character: 'Мирт', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Солдат', level: 7, hp: 70, maxHp: 70, armor: 18, speed: 30 },
  { id: 'talk-ally', character: 'Лиса', name: 'Игрок 2', role: 'Плут · ур. 7', species: 'Полурослик', background: 'Преступник', level: 7, hp: 50, maxHp: 50, armor: 15, speed: 25 },
]
const ARES = 'astohan-ares'

async function astohan() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'TALK', worldTemplateId: 'astohan-plains', players: heroes }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, { context = { isAdmin: true }, diceService = fixedDice(10) } = {}) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `talk-${run.step}-${index}`, ...command }))
    const result = resolveCommands(list, run.state, { diceService, context })
    run.state = normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  run.choose = (optionId, { hero = heroes[0].id, ...options } = {}) => run.apply({ command_type: 'ChooseDialogueOption', actor_id: hero, npc_id: ARES, option_id: optionId }, options)
  run.options = (hero = heroes[0].id) => (dialogueOptionsFor(run.state, ARES, hero)?.options ?? []).map((option) => option.id)
  run.discover = (clueId) => {
    const secretId = scenarioClueFactId(campaignScenario(run.state), clueId)
    const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
    assert.ok(secret, `тайна ${clueId} записана`)
    return run.apply({ command_type: 'RecordWorldFact', fact: {
      id: `fact-found-${clueId}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
      summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
    } })
  }
  return run
}

const types = (result) => result.events.map((event) => event.event_type)
const chosenOf = (result) => result.events.find((event) => event.event_type === 'DialogueOptionChosen')?.payload

test('Арес отвечает по-авторски: поручение без «больше мне сказать нечего», запись разговора и replay', async () => {
  const run = await astohan()
  assert.equal(scenarioLocationId(run.state), 'astohan-stormberg')
  const first = dialogueOptionsFor(run.state, ARES, heroes[0].id)
  assert.match(first.greeting, /Времени мало/u)
  assert.ok(run.options().includes('task'))
  assert.ok(!run.options().includes('armory-cloak'), 'вещи оружейной — после «покажите оружейную»')
  assert.ok(!run.options().includes('confession'), 'признание — только с уликой на руках')

  const told = run.choose('task')
  assert.deepEqual(types(told), ['DialogueOptionChosen', 'NpcConversationRecorded'])
  const chosen = chosenOf(told)
  assert.equal(chosen.npc_name, 'Король Арес')
  assert.match(chosen.reply, /Найдите Саргата/u)
  assert.equal(chosen.label, 'Какое поручение вы даёте нам?')
  assert.ok(run.state.social.conversations.some((entry) => entry.npc_id === ARES && /Найдите Саргата/u.test(entry.npc_reply)), 'NPC помнит разговор')
  assert.equal(dialogueOptionsFor(run.state, ARES, heroes[0].id).options.find((option) => option.id === 'task').asked, true, 'заданный вопрос помечен, как в BG3')
  assert.deepEqual(replayEvents(run.initial, run.events).dialogues, run.state.dialogues)
})

test('оружейная и кошель — вариантами разговора, той же командой, что и фраза', async () => {
  const run = await astohan()
  run.choose('armory')
  assert.ok(run.options().includes('armory-cloak'))
  const cloak = run.choose('armory-cloak')
  assert.ok(types(cloak).includes('ItemGranted') && types(cloak).includes('ScenarioArmoryItemChosen'), types(cloak).join(','))
  assert.ok(!run.options().includes('armory-cloak'), 'свою вещь герой уже взял')
  assert.ok(run.options(heroes[1].id).includes('armory-cloak'), 'второй герой ещё выбирает')
  assert.throws(() => run.choose('armory-mail'), { code: 'SCENARIO_ARMORY_ALREADY_TAKEN' }, 'вторая вещь тому же герою — отказ самой оружейной')
  const purse = run.choose('purse', { hero: heroes[1].id })
  assert.ok(types(purse).includes('ScenarioPurseGranted'), types(purse).join(','))
})

test('проверка в разговоре: одна попытка на героя, успех открывает флаг, провал — свой ответ', async () => {
  const run = await astohan()
  const missed = run.choose('vulkanis-eyes', { hero: heroes[1].id, diceService: fixedDice(1) })
  assert.ok(types(missed).includes('AbilityCheckResolved'))
  assert.match(chosenOf(missed).reply, /Старая рана/u)
  assert.ok(!run.options(heroes[1].id).includes('vulkanis-eyes'), 'попытка героя потрачена')
  assert.throws(() => run.choose('vulkanis-eyes', { hero: heroes[1].id }), { code: 'DIALOGUE_OPTION_UNAVAILABLE' })
  assert.ok(run.options().includes('vulkanis-eyes'), 'у другого героя своя попытка')
  const read = run.choose('vulkanis-eyes', { diceService: fixedDice(20) })
  assert.equal(chosenOf(read).check.success, true)
  assert.match(chosenOf(read).reply, /недоговаривает/u)
  assert.ok(run.state.dialogues['astohan-ares'].flags.includes('ares-hides'))
  assert.ok(read.events.some((event) => event.event_type === 'KnowledgeRevealed'), 'тайна исходной ситуации о взгляде короля раскрыта по теме')
  assert.ok(!run.options().includes('vulkanis-eyes'), 'понятое второй раз не выясняют')
})

test('признание Ареса — только с уликой; удача раскрывает тайну всему отряду, и сюжет её засчитывает', async () => {
  const run = await astohan()
  assert.throws(() => run.choose('confession'), { code: 'DIALOGUE_OPTION_UNAVAILABLE' })
  // Страница журнала из архива Орена — тайна Штормберга, она есть с начала кампании.
  run.discover('stormberg-journal-page')
  assert.ok(run.options().includes('confession'))
  const confessed = run.choose('confession', { diceService: fixedDice(20) })
  const revealed = confessed.events.find((event) => event.event_type === 'KnowledgeRevealed')
  assert.ok(revealed, types(confessed).join(','))
  assert.deepEqual([...revealed.target_ids].sort(), heroes.map((hero) => hero.id).sort())
  assert.ok(scenarioFoundClueIds(run.state).has('ares-confession'))
  assert.match(chosenOf(confessed).reply, /Гедрик разбил яйца/u)
  assert.ok(!run.options().includes('confession'), 'рассказанное второй раз не спрашивают')
  assert.deepEqual(replayEvents(run.initial, run.events).worldMemory.knowledge_revealed, run.state.worldMemory.knowledge_revealed)
})

test('разговор — только у собеседника, вне боя, от своего героя', async () => {
  const run = await astohan()
  assert.throws(() => run.choose('task', { context: { allowedActorIds: [heroes[1].id] } }), (error) => /ACTOR|FORBIDDEN|PERMISSION/u.test(String(error.code)))
  assert.throws(() => run.apply({ command_type: 'ChooseDialogueOption', actor_id: heroes[0].id, npc_id: 'starter-provisioner', option_id: 'task' }), { code: 'DIALOGUE_ABSENT' })
  assert.throws(() => run.choose('no-such-option'), { code: 'DIALOGUE_OPTION_UNAVAILABLE' })
  const peaceful = run.state
  run.state = normalizeCampaignState({ ...peaceful, mechanics: { ...peaceful.mechanics, combat: { ...peaceful.mechanics.combat, active: true } } })
  assert.throws(() => run.choose('task'), { code: 'DIALOGUE_DURING_COMBAT' })
  run.state = peaceful
  for (let hop = 0; hop < 8 && scenarioLocationId(run.state) !== 'astohan-ash-watch'; hop += 1) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: 'В заставу', destinationLocationId: 'astohan-ash-watch' })
    run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
  }
  assert.throws(() => run.choose('task'), { code: 'DIALOGUE_NPC_ABSENT' })
})

test('Штормберг: Ивара, Орен и Мира — свои тайны по теме и цепочка до признания короля', async () => {
  const run = await astohan()
  const say = (npc, option, { hero = heroes[0].id, ...options } = {}) => run.apply({ command_type: 'ChooseDialogueOption', actor_id: hero, npc_id: npc, option_id: option }, options)
  const ids = (npc, hero = heroes[0].id) => (dialogueOptionsFor(run.state, npc, hero)?.options ?? []).map((option) => option.id)
  const known = (topicPart) => run.state.worldMemory.facts.some((fact) => fact.predicate === 'gm_secret' && fact.object.includes(topicPart)
    && (run.state.worldMemory.knowledge_revealed ?? []).some((entry) => entry.fact_id === fact.id))

  // Маршал отдаёт военное донесение без торга: она против того, чтобы двор прятал сведения.
  const report = say('astohan-ivara', 'ash-watch-report')
  assert.match(chosenOf(report).reply, /засов снят изнутри/u)
  assert.ok(known('донесение о сожжённой Пепельной заставе'))
  assert.ok(!ids('astohan-ivara').includes('ash-watch-report'), 'рассказанное второй раз не спрашивают')

  // Орен: журнал — либо Убеждением, либо без проверки, если у короля поняли, что он скрывает.
  assert.ok(ids('astohan-oren').includes('journal'))
  assert.ok(!ids('astohan-oren').includes('journal-for-the-truth'))
  assert.ok(!ids(ARES).includes('confession'))
  run.choose('vulkanis-eyes', { diceService: fixedDice(20) })
  assert.ok(ids('astohan-oren').includes('journal-for-the-truth'), 'понятое у короля открывает путь у архивиста')
  const journal = say('astohan-oren', 'journal-for-the-truth')
  assert.ok(journal.events.some((event) => event.event_type === 'KnowledgeRevealed'))
  assert.ok(scenarioFoundClueIds(run.state).has('stormberg-journal-page'))
  assert.ok(!ids('astohan-oren').includes('journal') && !ids('astohan-oren').includes('journal-for-the-truth'))
  assert.ok(ids(ARES).includes('confession'), 'с вырванной страницей на руках — к королю')

  // Мира: Проницательность показывает страх за деревню и открывает разговор без торга.
  assert.ok(!ids('astohan-mira').includes('protect-village'))
  say('astohan-mira', 'read-her', { diceService: fixedDice(20) })
  assert.ok(ids('astohan-mira').includes('protect-village'))
  const mill = say('astohan-mira', 'protect-village')
  assert.match(chosenOf(mill).reply, /двор у старой мельницы/u)
  assert.ok(known('исчезнувший сборщик налогов у Митглайда'))
  assert.ok(!ids('astohan-mira').includes('tax-collector'), 'второй путь к той же тайне закрыт')
  assert.deepEqual(replayEvents(run.initial, run.events).dialogues, run.state.dialogues)
})

// --- Линия А: Ломар, Трент, Великое Древо ------------------------------------

async function travel(run, locationId) {
  for (let hop = 0; hop < 10 && scenarioLocationId(run.state) !== locationId; hop += 1) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `В ${locationId}`, destinationLocationId: locationId })
    run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
  }
  assert.equal(scenarioLocationId(run.state), locationId)
}

const sayTo = (run, npc, option, { hero = heroes[0].id, ...options } = {}) => run.apply({ command_type: 'ChooseDialogueOption', actor_id: hero, npc_id: npc, option_id: option }, options)
const offeredBy = (run, npc, hero = heroes[0].id) => (dialogueOptionsFor(run.state, npc, hero)?.options ?? []).map((option) => option.id)
const wardHolders = (run) => run.state.players.filter((player) => (player.inventory ?? []).some((item) => item.catalog_id === 'scenario_astohan:lomar-ward')).map((player) => player.id)

test('Ломар: сделка отдаёт оберег задатком, и находка на столе второго не выдаёт', async () => {
  const run = await astohan()
  await travel(run, 'astohan-lomar-tower')
  assert.ok(offeredBy(run, 'astohan-lomar').includes('barrier'))
  assert.ok(!offeredBy(run, 'astohan-lomar').includes('pact'), 'сделка — после его предложения')
  const notes = sayTo(run, 'astohan-lomar', 'barrier')
  assert.ok(notes.events.some((event) => event.event_type === 'KnowledgeRevealed'))
  assert.ok(scenarioFoundClueIds(run.state).has('tower-barrier-notes'))
  sayTo(run, 'astohan-lomar', 'offer')
  const pact = sayTo(run, 'astohan-lomar', 'pact')
  assert.ok(pact.events.some((event) => event.event_type === 'ItemGranted'), pact.events.map((event) => event.event_type).join(','))
  assert.deepEqual(wardHolders(run), [heroes[0].id])
  assert.ok(run.state.dialogues['astohan-lomar'].granted.length === 1)
  const found = run.discover('tower-fire-ward')
  assert.ok(!found.events.some((event) => event.event_type === 'ItemGranted'), 'оберег уже выдан разговором')
  assert.deepEqual(wardHolders(run), [heroes[0].id])
  assert.deepEqual(replayEvents(run.initial, run.events).dialogues, run.state.dialogues)
})

test('Трент пропускает того, кто назвал свой страх; Древо — один вопрос на героя и уговор Ломара его историей', async () => {
  const run = await astohan()
  await travel(run, 'astohan-wild-forest')
  assert.ok(run.state.social.npcs.some((npc) => npc.id === 'astohan-trent'), 'трент стоит в своём лесу')
  assert.ok(!offeredBy(run, 'astohan-trent').includes('fear-alone'), 'страх называют, когда трент спросит')
  sayTo(run, 'astohan-trent', 'not-lomar')
  assert.ok(offeredBy(run, 'astohan-trent').includes('fear-alone'))
  const passed = sayTo(run, 'astohan-trent', 'fear-alone')
  assert.match(chosenOf(passed).reply, /Проходите/u)
  assert.ok(scenarioFoundClueIds(run.state).has('forest-trent'))
  assert.ok(!offeredBy(run, 'astohan-trent', heroes[1].id).some((id) => id.startsWith('fear-')), 'отряд пропущен — страх больше не спрашивают')

  await travel(run, 'astohan-eldrin-heart')
  const story = sayTo(run, 'astohan-eldrin', 'who')
  assert.match(chosenOf(story).reply, /Я был Элдрином/u)
  assert.ok(scenarioFoundClueIds(run.state).has('eldrin-story'), 'история Древа закрывает линию')
  const path = sayTo(run, 'astohan-eldrin', 'beat-sargat')
  assert.ok(path.events.some((event) => event.event_type === 'KnowledgeRevealed'))
  assert.ok(scenarioFoundClueIds(run.state).has('eldrin-lava-path'))
  assert.ok(!offeredBy(run, 'astohan-eldrin').some((id) => ['stop-lomar', 'free-you', 'dragons'].includes(id)), 'свой вопрос герой уже задал')
  assert.ok(offeredBy(run, 'astohan-eldrin', heroes[1].id).includes('stop-lomar'), 'у другого героя свой вопрос')
  sayTo(run, 'astohan-eldrin', 'stop-lomar', { hero: heroes[1].id })
  assert.ok(!offeredBy(run, 'astohan-eldrin', heroes[1].id).includes('dragons'))

  // С историей Древа — к Ломару: страх, увиденный Проницательностью, делает уговор лёгким.
  await travel(run, 'astohan-lomar-tower')
  assert.ok(offeredBy(run, 'astohan-lomar').includes('dissuade'))
  sayTo(run, 'astohan-lomar', 'fear', { diceService: fixedDice(20) })
  assert.ok(!offeredBy(run, 'astohan-lomar').includes('dissuade'))
  assert.ok(offeredBy(run, 'astohan-lomar').includes('dissuade-fear'))
  const dissuaded = sayTo(run, 'astohan-lomar', 'dissuade-fear', { diceService: fixedDice(10) })
  assert.equal(chosenOf(dissuaded).check.success, true)
  assert.ok(!offeredBy(run, 'astohan-lomar').includes('pact'), 'отговорённый маг сделку не предлагает')
  const gift = sayTo(run, 'astohan-lomar', 'ward-gift')
  assert.ok(gift.events.some((event) => event.event_type === 'ItemGranted'))
  assert.deepEqual(wardHolders(run), [heroes[0].id])
  assert.deepEqual(replayEvents(run.initial, run.events).dialogues, run.state.dialogues)
})
