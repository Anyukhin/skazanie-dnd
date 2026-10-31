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
import { DIALOGUES, dialogueOptionsFor, normalizeDialogues, sceneDialoguesForViewer } from '../server/campaign-dialogues.mjs'
import { campaignScenario, scenarioClueFactId, scenarioFoundClueIds, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { scenarioKnightState } from '../server/scenario-knight.mjs'
import { minutesUntilClock } from '../server/weather.mjs'
import { fixedDice, maxDice, minDice } from './kit/dice.mjs'

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
      // Команды рыцаря — только в разговоре с самим рыцарем; навык и СЛ в окне
      // — те, что бросит команда упокоения.
      if (['ReturnKnightHead', 'ReleaseCursedKnight'].includes(option.action?.command_type)) assert.equal(dialogue.npc_id, scenario.knight?.npc_id, `${dialogue.id}.${option.id}: рыцарь`)
      if (option.action?.command_type === 'ReleaseCursedKnight') {
        assert.ok(scenario.knight.release.skills.includes(option.check.skill), `${dialogue.id}.${option.id}: навык ${option.check.skill}`)
        assert.equal(option.check.dc, scenario.knight.release.dc, `${dialogue.id}.${option.id}: СЛ упокоения`)
      }
      // Судьба осведомителя — в разговоре с ним самим; перевербовка в окне —
      // те же навык и СЛ, что бросит команда.
      if (option.action?.command_type === 'ResolveScenarioInformant') {
        const informant = scenario.attention.informants.find((entry) => entry.id === option.action.informant_id)
        assert.ok(informant, `${dialogue.id}.${option.id}: осведомитель ${option.action.informant_id}`)
        assert.equal(informant.npc_id, dialogue.npc_id, `${dialogue.id}.${option.id}: собеседник осведомителя`)
        if (option.action.choice === 'turn') assert.deepEqual(option.check, { skill: informant.turn.skill, dc: informant.turn.dc })
      }
      if (option.action?.command_type === 'NegotiateScenarioTreaty') {
        const finale = scenario.beats.find((beat) => beat.kind === 'finale')
        assert.equal(dialogue.npc_id, finale.boss.npc_id, `${dialogue.id}.${option.id}: договор — с главным противником`)
        assert.deepEqual(option.check, { skill: finale.treaty.skill, dc: finale.treaty.dc })
      }
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
  assert.throws(broken({ options: [{ id: 'x', label: 'Покойся.', reply: 'Да.', action: { command_type: 'ReleaseCursedKnight' } }] }), /бросает проверку/u)
  assert.throws(broken({ options: [{ id: 'x', label: 'К страже.', reply: 'Да.', action: { command_type: 'ResolveScenarioInformant', informant_id: 'toban', choice: 'burn' } }] }), /решение/u)
  assert.throws(broken({ options: [{ id: 'x', label: 'Кошель.', check: { skill: 'insight', dc: 15 }, success: { reply: 'Да.' }, failure: { reply: 'Нет.' }, action: { command_type: 'ReceiveScenarioPurse' } }] }), /не поддержаны/u)
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
  assert.ok(!run.options().some((id) => id.startsWith('armory-')), 'вещь — одна на героя: других вещей оружейной ему не предлагают')
  assert.ok(run.options(heroes[1].id).includes('armory-cloak'), 'второй герой ещё выбирает')
  // Вторую вещь окно не предлагает, а поданный в обход вариант отвергается.
  assert.throws(() => run.choose('armory-mail'), { code: 'DIALOGUE_OPTION_UNAVAILABLE' }, 'вторая вещь тому же герою — отказ')
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

// --- Линия Б: Каэлан ---------------------------------------------------------

const KAELAN = 'astohan-kaelan'

/** Ждать до минуты суток — тем же путём, что «ждём до полуночи». */
const waitUntil = (run, minuteOfDay) => run.apply({
  command_type: 'AdvanceTime', unit: 'minute', amount: minutesUntilClock(run.state.mechanics.world_time.elapsed_minutes, minuteOfDay),
})

/** Герой ставится у поста рыцаря: подготовка сцены, а не проверяемое правило. */
function standByKnight(run, heroId, offset) {
  const placements = run.state.npc_world.placements ?? {}
  const post = placements[KAELAN] ?? Object.values(placements).flat().find((entry) => entry?.npc_id === KAELAN)
  assert.ok(post, 'у рыцаря есть пост')
  const state = structuredClone(run.state)
  const x = Number(post.x) + offset
  const y = Number(post.y)
  state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [heroId]: { x, y } }
  Object.assign(state.players.find((entry) => entry.id === heroId), { x, y })
  run.state = normalizeCampaignState(state)
}

test('Каэлан: вопросы из набросков дословно, голова и упокоение — командами рыцаря', async () => {
  const run = await astohan()
  await travel(run, 'astohan-forgotten-cliffs')
  const ids = (hero = heroes[0].id) => offeredBy(run, KAELAN, hero)

  // Днём рыцаря в замке нет — и разговора с ним тоже.
  waitUntil(run, 12 * 60)
  assert.throws(() => sayTo(run, KAELAN, 'who'), { code: 'DIALOGUE_NPC_ABSENT' })
  assert.equal(sceneDialoguesForViewer(run.state, { playerId: heroes[0].id })[KAELAN], undefined)

  waitUntil(run, 0)
  const view = sceneDialoguesForViewer(run.state, { playerId: heroes[0].id })[KAELAN]
  assert.ok(view, 'закрытый рыцарь виден отряду, пока стоит в сцене')
  assert.match(view.greeting, /Вы пришли за смертью… или за правдой\?/u)
  assert.deepEqual(ids(), ['who', 'why-cursed', 'how-free', 'tear', 'throne', 'farewell'])
  const who = chosenOf(sayTo(run, KAELAN, 'who'))
  assert.equal(who.npc_name, 'Каэлан Вердант')
  assert.match(who.reply, /Я был Каэланом Вердантом, рыцарем Короны Пламени/u)
  assert.match(chosenOf(sayTo(run, KAELAN, 'how-free')).reply, /туда, где пали небеса/u)

  // Голова — когда отряд разгадал загадку часовни; ставит её тот, кто рядом.
  run.discover('cliffs-chapel')
  assert.ok(ids().includes('head'))
  assert.ok(!ids().includes('release-words'), 'упокоение — после головы')
  standByKnight(run, heroes[0].id, 6)
  assert.throws(() => sayTo(run, KAELAN, 'head'), { code: 'TARGET_OUT_OF_RANGE' })
  standByKnight(run, heroes[0].id, 1)
  const head = sayTo(run, KAELAN, 'head')
  assert.ok(types(head).includes('ScenarioKnightHeadReturned'), types(head).join(','))
  // Строки боя у сцены головы вне боя нет: её авторский текст — в ответе.
  assert.match(chosenOf(head).reply, /Вы нашли меня\. Голова ложится на камень перед всадником/u)
  assert.equal(scenarioKnightState(run.state).head_returned, true)
  assert.ok(!ids(heroes[1].id).includes('head'), 'голова уже перед ним — у всех')
  assert.ok(ids().includes('release-words') && ids().includes('release-prayer'))

  // Провал сжигает попытку героя этой ночью — оба пути упокоения для него
  // закрыты, у второго героя открыты.
  const failed = sayTo(run, KAELAN, 'release-prayer', { diceService: minDice() })
  assert.deepEqual({ skill: chosenOf(failed).check.skill, dc: chosenOf(failed).check.dc, success: chosenOf(failed).check.success }, { skill: 'religion', dc: 18, success: false })
  assert.match(chosenOf(failed).reply, /Молитва тонет в тумане/u)
  assert.ok(types(failed).includes('ScenarioKnightReleaseFailed'))
  assert.ok(!ids().some((id) => id.startsWith('release-')))
  assert.ok(ids(heroes[1].id).includes('release-words'))

  const released = sayTo(run, KAELAN, 'release-words', { hero: heroes[1].id, diceService: maxDice() })
  assert.equal(chosenOf(released).check.success, true)
  assert.match(chosenOf(released).reply, /становится тише\. Каэлан опускает Лунного Судью.+Я свободен… а он — следующий/u, 'ответ и авторский текст упокоения — одной репликой')
  assert.ok(types(released).includes('ScenarioKnightReleased'))
  assert.ok(run.state.players.find((player) => player.id === heroes[1].id).inventory.some((item) => item.name === 'Слеза Проклятого Рыцаря'))
  assert.equal(run.state.social.npcs.find((npc) => npc.id === KAELAN).available, false)
  assert.equal(sceneDialoguesForViewer(run.state, { playerId: heroes[0].id })[KAELAN], undefined, 'обретший покой ушёл')
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.dialogues, run.state.dialogues)
  assert.deepEqual(replayed.scenario_knight, run.state.scenario_knight)
})

// --- Линия В: осведомители, Гедрик и договор с Саргатом -----------------------

const npcAvailable = (run, npcId) => run.state.social.npcs.find((npc) => npc.id === npcId)?.available !== false
const informantFate = (run, informantId) => run.state.scenario_attention?.informants?.[informantId]

test('Тобан: страх за семью открывает правду, перевербовка — один раз, отпущенный остаётся на мельнице', async () => {
  const run = await astohan()
  await travel(run, 'astohan-redstone')
  const ids = (hero = heroes[0].id) => offeredBy(run, 'astohan-toban', hero)
  assert.ok(!ids().includes('help'), 'просьба о правде — когда видно, чего он боится')
  assert.ok(!ids().some((id) => ['expose', 'release', 'turn'].includes(id)), 'судьба — после правды')
  sayTo(run, 'astohan-toban', 'read', { diceService: fixedDice(20) })
  const truth = sayTo(run, 'astohan-toban', 'help')
  assert.match(chosenOf(truth).reply, /клетка с почтовыми стрижами/u)
  assert.ok(scenarioFoundClueIds(run.state).has('redstone-mill'))
  assert.ok(!ids().includes('press'), 'вторая дорога к той же правде закрыта')
  assert.ok(['expose', 'release', 'turn'].every((id) => ids().includes(id)))

  const failed = sayTo(run, 'astohan-toban', 'turn', { diceService: minDice() })
  assert.deepEqual({ skill: chosenOf(failed).check.skill, success: chosenOf(failed).check.success }, { skill: 'persuasion', success: false })
  assert.match(chosenOf(failed).reply, /Тобан пятится к жерновам\. Тобан мотает головой/u, 'ответ и авторский текст сценария — одной репликой')
  assert.ok(!ids(heroes[1].id).includes('turn'), 'перевербовать не вышло — у всех')
  const released = sayTo(run, 'astohan-toban', 'release', { hero: heroes[1].id })
  assert.ok(types(released).includes('ScenarioInformantResolved'), types(released).join(','))
  assert.equal(informantFate(run, 'toban'), 'release')
  assert.ok(npcAvailable(run, 'astohan-toban'), 'отпущенный мельник остаётся у себя')
  assert.ok(!ids().some((id) => ['expose', 'release', 'turn'].includes(id)), 'судьба решена один раз')
  assert.deepEqual(replayEvents(run.initial, run.events).scenario_attention, run.state.scenario_attention)
})

test('Ларс: кошель с драконьей медью Запугиванием; выданного уводит стража', async () => {
  const run = await astohan()
  await travel(run, 'astohan-mittlayd')
  const told = sayTo(run, 'astohan-lars', 'purse', { diceService: fixedDice(20) })
  assert.equal(chosenOf(told).check.success, true)
  assert.ok(scenarioFoundClueIds(run.state).has('mittlayd-informant'))
  const exposed = sayTo(run, 'astohan-lars', 'expose')
  assert.match(chosenOf(exposed).reply, /от реки не убежишь\. Ларса берут прямо у причала/u)
  assert.equal(informantFate(run, 'ferryman'), 'expose')
  assert.equal(npcAvailable(run, 'astohan-lars'), false, 'выданного уводит стража')
  assert.equal(sceneDialoguesForViewer(run.state, { playerId: heroes[0].id })['astohan-lars'], undefined)
  assert.throws(() => sayTo(run, 'astohan-lars', 'who-crossed'), { code: 'DIALOGUE_NPC_ABSENT' })
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.scenario_attention, run.state.scenario_attention)
  assert.equal(replayed.social.npcs.find((npc) => npc.id === 'astohan-lars').available, false)
})

test('Гедрик признаётся только разговором; с правдой о походе Саргат соглашается на договор в логове', async () => {
  const run = await astohan()
  await travel(run, 'astohan-quiet-watch-camp')
  const ids = () => offeredBy(run, 'astohan-gedrik')
  assert.ok(!ids().includes('confess-guilt') && !ids().includes('confess-journal') && !ids().includes('why-ares'))
  sayTo(run, 'astohan-gedrik', 'read', { diceService: fixedDice(20) })
  const confession = sayTo(run, 'astohan-gedrik', 'confess-guilt')
  assert.match(chosenOf(confession).reply, /разбил яйца/u)
  assert.ok(scenarioFoundClueIds(run.state).has('camp-gedrik'))
  assert.ok(ids().includes('why-ares') && !ids().includes('confess-press'))

  // Вторая улика правды — страница журнала; затем — в логово.
  run.discover('stormberg-journal-page')
  // Логово открывается с Обсидианового перевала (`map_reveals` сценария).
  await travel(run, 'astohan-obsidian-pass')
  await travel(run, 'astohan-vulkanis-brazier')
  assert.ok(npcAvailable(run, 'astohan-sargat'), 'дракон в логове')
  assert.ok(offeredBy(run, 'astohan-sargat').includes('treaty'))
  const pact = sayTo(run, 'astohan-sargat', 'treaty', { diceService: maxDice() })
  assert.equal(chosenOf(pact).check.success, true)
  assert.ok(types(pact).includes('ScenarioTreatyConcluded'), types(pact).join(','))
  assert.match(chosenOf(pact).reply, /Правда стоит больше мести/u)
  assert.equal(npcAvailable(run, 'astohan-sargat'), false, 'дракон ушёл с равнин')
  assert.deepEqual(replayEvents(run.initial, run.events).scenario_attention, run.state.scenario_attention)
})

test('договор не предлагают, пока правда о походе не раскрыта', async () => {
  const run = await astohan()
  await travel(run, 'astohan-vulkanis-brazier')
  assert.ok(offeredBy(run, 'astohan-sargat').includes('why'))
  assert.ok(!offeredBy(run, 'astohan-sargat').includes('treaty'))
})
