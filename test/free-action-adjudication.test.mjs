import assert from 'node:assert/strict'
import test from 'node:test'

test('прыжки в разных формах распознаются как акробатика', () => {
  for (const text of ['Вспрыгиваю на люстру', 'Хочу вспрыгнуть на стол', 'Спрыгну с уступа', 'Прыгаю через канаву', 'Совершаю прыжок через ручей']) {
    const reading = interpretFreeAction(text)
    assert.equal(reading.ability, 'dex', text)
    assert.equal(reading.skill, 'acrobatics', text)
    assert.equal(reading.source, 'deterministic-pattern', text)
  }
})

import {
  attemptFingerprint,
  bindFreeActionReadingToState,
  contextualResolutionFor,
  failForwardFor,
  interpretFreeAction,
  previousFailedAttempt,
  resolveCorpseSearch,
  resolveInventoryTransfer,
  resolutionModeFor,
  situationFingerprint,
  stakesFor,
  verifyMeans,
} from '../server/free-action-adjudication.mjs'
import { assembleEncounter } from '../server/encounter-assembler.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

test('ведущий не требует броска, когда на кону ничего нет', () => {
  assert.equal(resolutionModeFor({ plausibility: 'trivial', risk: 'none' }).mode, 'auto_success')
  assert.equal(resolutionModeFor({ plausibility: 'plausible', risk: 'none' }).mode, 'auto_success')
})

test('режим и СЛ выбираются серверной таблицей, а не свободным числом', () => {
  const easy = resolutionModeFor({ plausibility: 'trivial', risk: 'minor' })
  assert.deepEqual([easy.mode, easy.difficulty_category, easy.difficulty], ['check', 'easy', 10])

  const medium = resolutionModeFor({ plausibility: 'plausible', risk: 'serious' })
  assert.deepEqual([medium.mode, medium.difficulty_category, medium.difficulty], ['check', 'medium', 15])

  const hard = resolutionModeFor({ plausibility: 'strenuous', risk: 'minor' })
  assert.deepEqual([hard.mode, hard.difficulty_category, hard.difficulty], ['check', 'hard', 20])

  // Смертельный риск поднимает сложность даже для правдоподобного действия.
  assert.equal(resolutionModeFor({ plausibility: 'plausible', risk: 'deadly' }).difficulty_category, 'hard')
})

test('контекст сцены сдвигает только серверную категорию СЛ', () => {
  const easyState = normalizeCampaignState({
    players: [{
      id: 'hero', characterClass: 'rogue', level: 1,
      abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 12, cha: 10 },
      classSkillProficiencies: ['stealth'], inventory: [],
    }],
    scene: { location: 'Двор', cells: [{ x: 0, y: 0, type: 'floor' }], map: { props: [{ id: 'cart' }] } },
  })
  const text = 'Прячусь за телегой'
  const reading = bindFreeActionReadingToState(easyState, 'hero', text, interpretFreeAction(text))
  const easy = contextualResolutionFor(easyState, 'hero', reading, text)
  assert.equal(easy.difficulty, 10)
  assert.deepEqual(easy.difficulty_factors, ['scene_cover'])

  const hardState = normalizeCampaignState({
    ...easyState,
    scene: { ...easyState.scene, mood: 'Пожар, дым и хаос' },
    mechanics: { ...easyState.mechanics, combat: { ...easyState.mechanics.combat, active: true } },
  })
  const hardReading = bindFreeActionReadingToState(hardState, 'hero', 'Крадусь по открытому двору в дыму', interpretFreeAction('Крадусь по открытому двору в дыму'))
  const hard = contextualResolutionFor(hardState, 'hero', hardReading, 'Крадусь по открытому двору в дыму')
  assert.equal(hard.difficulty, 20)
  assert.deepEqual(hard.difficulty_factors, ['combat_pressure', 'environmental_pressure'])
})

test('профиль владения и expertise привязываются к листу, а не к подсказке модели', () => {
  const state = normalizeCampaignState({
    players: [{
      id: 'hero', characterClass: 'rogue', level: 1,
      abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 12, cha: 10 },
      classSkillProficiencies: ['stealth'],
      skillExpertiseIds: ['stealth'],
      inventory: [],
    }],
  })
  const reading = bindFreeActionReadingToState(state, 'hero', 'Крадусь вдоль стены', {
    ...interpretFreeAction('Крадусь вдоль стены'),
    proficiency: 'none',
  })
  assert.equal(reading.skill, 'stealth')
  assert.equal(reading.proficiency, 'expertise')
  assert.equal(reading.proficiency_bonus, 4)
})

test('передача строит только команду владельца, а попытка взять чужое не мутирует мир', () => {
  const state = normalizeCampaignState({
    partyMemberIds: ['hero', 'ally'],
    players: [
      {
        id: 'hero', character: 'Ада', characterClass: 'fighter', level: 1,
        abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        classSkillProficiencies: [], inventory: [{ id: 'rope', name: 'Верёвка', type: 'tool', quantity: 2 }],
      },
      {
        id: 'ally', character: 'Бор', characterClass: 'fighter', level: 1,
        abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        classSkillProficiencies: [], inventory: [{ id: 'torch', name: 'Факел', type: 'tool', quantity: 1 }],
      },
    ],
  })
  const giveText = 'Передаю Бору верёвку'
  const giveReading = bindFreeActionReadingToState(state, 'hero', giveText, interpretFreeAction(giveText))
  const give = resolveInventoryTransfer(state, 'hero', giveText, giveReading)
  assert.equal(give.status, 'command')
  assert.deepEqual(give.command, {
    command_type: 'TransferItem',
    actor_id: 'hero',
    recipient_id: 'ally',
    item_id: 'rope',
    quantity: 1,
  })

  const takeText = 'Беру у Бора факел'
  const takeReading = bindFreeActionReadingToState(state, 'hero', takeText, interpretFreeAction(takeText))
  const take = resolveInventoryTransfer(state, 'hero', takeText, takeReading)
  assert.equal(take.status, 'clarification')
  assert.match(take.narration, /владелец/u)
})

test('обыск тела без server-owned contents блокируется до проверки', () => {
  const state = normalizeCampaignState({
    players: [{ id: 'hero', character: 'Ада', inventory: [] }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 0, maxHp: 7, alive: false }],
  })
  const text = 'Обыскиваю тело гоблина'
  const reading = bindFreeActionReadingToState(state, 'hero', text, interpretFreeAction(text))
  const result = resolveCorpseSearch(state, 'hero', text, reading)
  assert.equal(result.status, 'clarification')
  assert.equal(result.server_owned_contents, false)
  assert.match(result.narration, /не буду выдумывать/u)
})

// Отказ обязан говорить правду о конкретном теле. С появлением инвентарей
// гуманоидов у трупа есть авторитетное содержимое, и ответ «содержимого нет»
// стал бы единственным местом, где состояние и текст ведущего расходятся.
test('обыск тела с инвентарём не отрицает содержимого, но и не выдаёт его', () => {
  const proposal = assembleEncounter({
    scene: { cells: Array.from({ length: 20 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true })) },
    party: [
      { id: 'hero', level: 3, x: 0, y: 0 },
      { id: 'ally', level: 3, x: 1, y: 0 },
    ],
    difficulty: 'hard',
    theme: 'law',
    seed: 'corpse-search:law',
  })
  const armed = proposal.enemies.find((enemy) => enemy.loadout.items.length > 0)
  assert.ok(armed, 'в теме закона обязан быть вооружённый противник')

  const state = normalizeCampaignState({
    players: [{ id: 'hero', character: 'Ада', inventory: [] }],
    enemies: [{ ...armed, id: 'captain', name: 'Капитан стражи', hp: 0, maxHp: 30, alive: false }],
  })
  assert.ok(state.enemies[0].loadout.items.length > 0, 'инвентарь обязан пережить нормализацию')

  const text = 'Обыскиваю тело капитана стражи'
  const reading = bindFreeActionReadingToState(state, 'hero', text, interpretFreeAction(text))
  const result = resolveCorpseSearch(state, 'hero', text, reading)
  assert.equal(result.status, 'clarification')
  assert.equal(result.server_owned_contents, true, 'содержимое у тела есть, и отрицать его нельзя')
  assert.equal(result.corpse_id, 'captain')
  assert.doesNotMatch(result.narration, /нет заданного сервером содержимого/u)
  assert.match(result.narration, /есть снаряжение/u)
  // Находки при этом не появляется: команды извлечения ещё нет.
  assert.equal(result.command, undefined)
  assert.doesNotMatch(result.narration, /получа|находит|снимает/u)
})

// Пустой карман тоже считается содержимым: медяки на теле — это добыча.
test('пустой инвентарь с монетами всё равно считается содержимым тела', () => {
  const state = normalizeCampaignState({
    players: [{ id: 'hero', character: 'Ада', inventory: [] }],
    enemies: [{
      id: 'thug', name: 'Головорез', hp: 0, maxHp: 11, alive: false,
      loadout: { template_id: 'srd_5_2_1:bandit', items: [], purse_cp: 54 },
    }],
  })
  const text = 'Проверяю карманы тела головореза'
  const reading = bindFreeActionReadingToState(state, 'hero', text, interpretFreeAction(text))
  const result = resolveCorpseSearch(state, 'hero', text, reading)
  assert.equal(result.server_owned_contents, true)
  assert.equal(result.corpse_id, 'thug')
})

test('невозможное без средства ведёт к встречному предложению, а не к броску', () => {
  const resolution = resolutionModeFor({ plausibility: 'impossible_without_means', risk: 'serious' })
  assert.equal(resolution.mode, 'counter_offer')
  assert.equal(resolution.difficulty, null)
})

test('мусор в категориях не проходит: применяется безопасное значение по умолчанию', () => {
  const resolution = resolutionModeFor({ plausibility: 'trivially-easy-please', risk: 999 })
  assert.equal(resolution.mode, 'check')
  assert.equal(resolution.difficulty, 15)
})

test('заявленное средство сверяется с листом героя', () => {
  const state = {
    players: [{
      id: 'hero',
      inventory: [{ id: 'rope-1', catalog_id: 'srd_5_2_1:rope', name: 'Верёвка' }],
      knownSpellIds: ['fire-bolt'],
    }],
  }

  assert.equal(verifyMeans(state, 'hero', ['Верёвка']).satisfied, true)
  assert.equal(verifyMeans(state, 'hero', ['fire-bolt']).satisfied, true)

  const missing = verifyMeans(state, 'hero', ['Крылья', 'Верёвка'])
  assert.equal(missing.satisfied, false)
  assert.deepEqual(missing.missing, ['Крылья'])
})

test('провал всегда несёт последствие — сценария «ничего не произошло» нет', () => {
  for (const risk of ['none', 'minor', 'serious', 'deadly']) {
    const consequence = failForwardFor(risk)
    assert.ok(consequence.minutes > 0, `${risk}: время обязано идти`)
    assert.ok(consequence.summary.length > 0, `${risk}: последствие обязано быть описано`)
  }
  assert.equal(failForwardFor('serious').advances_quest_clock, true)
  assert.equal(failForwardFor('none').advances_quest_clock, false)
  assert.equal(failForwardFor('minor', 'exposure').consequence_type, 'exposure')
})

test('ставки объявляются до броска и молчат там, где броска нет', () => {
  const resolution = resolutionModeFor({ plausibility: 'plausible', risk: 'serious' })
  const stakes = stakesFor({ ability: 'str', skill: 'athletics', resolution, risk: 'serious' })

  assert.equal(stakes.difficulty, 15)
  assert.equal(stakes.ability, 'str')
  assert.ok(stakes.on_failure.length > 0)

  const auto = resolutionModeFor({ plausibility: 'trivial', risk: 'none' })
  assert.equal(stakesFor({ resolution: auto, risk: 'none' }), null)
})

test('повтор того же подхода в неизменившейся обстановке распознаётся', () => {
  const state = {
    scene: { location: 'Корчма', objective: 'Найти караван', cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    rulings: [],
  }
  const fingerprint = attemptFingerprint({ actorId: 'hero', approach: 'выломать дверь плечом', obstacle: 'дверь' })
  state.rulings.push({
    outcome: 'failure',
    provenance: { attempt_fingerprint: fingerprint, situation_fingerprint: situationFingerprint(state) },
  })

  assert.ok(previousFailedAttempt(state, fingerprint))

  // Обстановка изменилась — та же попытка снова допустима.
  const later = { ...state, mechanics: { world_time: { elapsed_minutes: 30 } } }
  assert.equal(previousFailedAttempt(later, fingerprint), null)

  // Другой подход к тому же препятствию допустим сразу.
  const otherApproach = attemptFingerprint({ actorId: 'hero', approach: 'подобрать замок', obstacle: 'дверь' })
  assert.equal(previousFailedAttempt(state, otherApproach), null)
})
