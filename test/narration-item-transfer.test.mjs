import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'

/**
 * Живой eval 2026-07-28 поймал: рассказчик описал, как NPC «ныряет под стойку
 * и достаёт потрёпанный свиток — обещанное сокровище». Предмет появился у
 * персонажа без единого подтверждённого события. Лексический Verifier это
 * пропускал: паттерн изменения мира знал про огонь, двери и телепортацию,
 * но не про вещи.
 */
function briefWithout(events = []) {
  return buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: { scene: { title: 'Трактир', location: 'Трактир «Пустой кубок»' } },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

const ITEM_GRANTED = {
  event_type: 'ItemGranted', actor_id: 'hero', target_ids: ['hero'],
  payload: { item: { id: 'item:map', name: 'Карта старых троп' } },
  visibility: 'public', source_rule_ids: [],
}

// Утверждения о переходе вещи: без события их быть не может.
const TRANSFER_CLAIMS = [
  'Мира ныряет под стойку и достаёт потрёпанный свиток.',
  'Хозяйка протягивает Аде карту старых троп.',
  'Мира вручает герою ключ от чёрного хода.',
  'Стражник передаёт Рену письмо с печатью.',
  'Ада получает кошель с монетами.',
  'Рен забирает кинжал со стола.',
  'Ада подбирает факел и идёт дальше.',
  'В пыли Рен находит серебряное кольцо.',
  'Мира вкладывает в ладонь Ады склянку с зельем.',
  'Хозяйка выкладывает на стойку связку ключей.',
]

// Речь о вещах, которая ничего не меняет: упоминание, наблюдение, обещание,
// уже принадлежащее снаряжение. Ни одно из них не должно стать нарушением.
const SAFE_MENTIONS = [
  'Мира обещает показать карту старых троп к вечеру.',
  'Рен смотрит на свиток в руках хозяйки.',
  'Ада держит меч наготове и молчит.',
  'На стойке пылится связка ключей, до которой никому нет дела.',
  'Разговор всё время возвращается к пропавшему каравану с зерном.',
  'Мира кивает в сторону северной стены и понижает голос.',
  'В зале пахнет дымом и кислым элем.',
  'Хозяйка вспоминает про карту, но за ней не тянется.',
  'Ада отдаёт должное осторожности хозяйки.',
  'Стражник передаёт слухи дальше по цепочке.',
  // Ловушки морфологии: «достаточно» — не «достаёт», «находится» — не
  // «находит», «получается» — не «получает».
  'Света достаточно, чтобы разглядеть карту на стене.',
  'Ключ от чёрного хода находится у хозяйки, и она об этом не забывает.',
  'Разговор о свитке получается натянутым.',
  'Меч по-прежнему находится в ножнах.',
  'Достаточно одного взгляда на монеты, чтобы понять цену молчания.',
]

test('Verifier ловит переход вещи, которого нет в подтверждённых событиях', () => {
  const brief = briefWithout()
  for (const claim of TRANSFER_CLAIMS) {
    const result = verifyNarration(claim, brief)
    assert.equal(result.valid, false, `не поймано: «${claim}»`)
    assert.ok(
      result.violations.some((violation) => violation.code === 'ITEM_TRANSFER_NOT_IN_BRIEF'),
      `нет кода ITEM_TRANSFER_NOT_IN_BRIEF для «${claim}»`,
    )
  }
})

test('Verifier не трогает упоминание вещей без перехода владения', () => {
  const brief = briefWithout()
  for (const mention of SAFE_MENTIONS) {
    const result = verifyNarration(mention, brief)
    assert.equal(result.valid, true, `ложное срабатывание на «${mention}»: ${JSON.stringify(result.violations)}`)
  }
})

test('подтверждённое событие о предмете разрешает рассказать о передаче', () => {
  const brief = briefWithout([ITEM_GRANTED])
  const result = verifyNarration('Хозяйка протягивает Аде карту старых троп.', brief)
  assert.equal(result.valid, true, JSON.stringify(result.violations))
})

// Найдено при работе над предметами: первая ветка WORLD_CHANGE_ASSERTION_PATTERN
// была написана через `\b(?:вспых\w*|…)\b`, а `\b` и `\w` в JS — только ASCII.
// Между двумя кириллическими буквами границы слова не существует, поэтому
// ветка не срабатывала ни разу за всё время: ловила только вторая, про двери
// и занавес. «Факел вспыхивает» проходило мимо запрета.
const WORLD_CHANGES = [
  'Факел вспыхивает жарким пламенем.',
  'Балка над головой рухнула в проход.',
  'Стена разрушена, за ней виден коридор.',
  'Фигура исчезает в темноте.',
  'Посреди зала появился незнакомец в плаще.',
  'Ада телепортируется на другой конец зала.',
  'Дверь в кладовую открывается сама собой.',
]

const WORLD_SAFE = [
  'Ада молча смотрит на хозяйку.',
  'В зале пахнет дымом и кислым элем.',
  'На её лице появилась улыбка, быстрая и неискренняя.',
  'Мира понижает голос почти до шёпота.',
  'Разговор затихает сам собой.',
]

test('запрет изменений мира ловит огонь, обрушение и появление — не только двери', () => {
  const constrained = buildNarrationBrief({
    visible_events: [], visible_state_changes: [],
    known_environment: { scene: { location: 'Трактир' } },
    permitted_npc_reactions: [], narration_constraints: ['no-unconfirmed-world-changes'],
  })
  for (const claim of WORLD_CHANGES) {
    const result = verifyNarration(claim, constrained)
    assert.ok(
      result.violations.some((violation) => violation.code === 'WORLD_CHANGE_NOT_IN_BRIEF'),
      `не поймано изменение мира: «${claim}»`,
    )
  }
  for (const safe of WORLD_SAFE) {
    const result = verifyNarration(safe, constrained)
    assert.equal(result.valid, true, `ложное срабатывание на «${safe}»: ${JSON.stringify(result.violations)}`)
  }
})

/**
 * Проверено 2026-07-28 и отклонено: расширять словарь предметов именами из
 * brief нельзя. Единственный источник имён вне событий — свободный текст
 * (обещания, цели, резюме), а рядом с ним в brief лежат имена героев и NPC.
 * Взяв слова оттуда, проверка начала бы ловить «Ада получает…» как переход
 * вещи. Тест закрепляет обе половины вывода: выдуманное имя не ловится, и
 * обычная фраза с именем героя нарушением не становится.
 */
test('выдуманное имя вещи вне словаря не ловится — и это осознанная граница', () => {
  const named = buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    known_environment: {
      scene: { title: 'Трактир', location: 'Трактир' },
      story_context: {
        active_quests: [], active_threads: [], recent_summaries: [],
        heroes: [{ id: 'hero', name: 'Ада' }], present_npcs: [],
        open_promises: [{ npc: 'Мира', direction: 'npc_to_party', text: 'Мира обещала принести хрустальный фиал Нирна.' }],
      },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
  assert.equal(verifyNarration('Мира протягивает Аде хрустальный фиал Нирна.', named).valid, true)
  // Обратная сторона той же границы — ради неё она и выбрана.
  assert.equal(verifyNarration('Ада получает известие от стражника.', named).valid, true)
  assert.equal(verifyNarration('Мира находит нужные слова и успокаивает зал.', named).valid, true)
})

/**
 * `open_promises` лежит в brief, и рассказчик о них знает — на этом держится
 * связность мира. Но объявить обещание закрытым может только событие:
 * иначе игрок считает дело сделанным, а сервер держит нить открытой.
 */
const PROMISE_CLAIMS = [
  'Мира выполнила своё обещание и больше ничего не должна.',
  'Хозяйка сдержала слово, данное на прошлой неделе.',
  'Обещание нарушено: Мира и не собиралась помогать.',
  'Уговор исполнен, теперь отряд свободен.',
]

const PROMISE_SAFE = [
  'Мира напоминает про обещанную карту и просит подождать до вечера.',
  'Обещание всё ещё висит между ними невысказанным.',
  'Ада ждёт обещанного, но не торопит хозяйку.',
  'Разговор о данном слове откладывается до утра.',
]

test('исполнение обещания без события — нарушение, а упоминание — нет', () => {
  const brief = briefWithout()
  for (const claim of PROMISE_CLAIMS) {
    const result = verifyNarration(claim, brief)
    assert.ok(
      result.violations.some((violation) => violation.code === 'PROMISE_RESOLUTION_NOT_IN_BRIEF'),
      `не поймано закрытие обещания: «${claim}»`,
    )
  }
  for (const safe of PROMISE_SAFE) {
    const result = verifyNarration(safe, brief)
    assert.equal(result.valid, true, `ложное срабатывание на «${safe}»: ${JSON.stringify(result.violations)}`)
  }
})

test('подтверждённое NpcPromiseResolved разрешает рассказать об исходе обещания', () => {
  const resolved = briefWithout([{
    event_type: 'NpcPromiseResolved', actor_id: 'npc:mira', target_ids: ['hero'],
    payload: { promise_id: 'promise:map', status: 'fulfilled' },
    visibility: 'party', source_rule_ids: [],
  }])
  const result = verifyNarration('Мира выполнила своё обещание и приносит карту старых троп.', resolved)
  assert.equal(
    result.violations.some((violation) => violation.code === 'PROMISE_RESOLUTION_NOT_IN_BRIEF'),
    false,
    JSON.stringify(result.violations),
  )
})

test('переход вещи ловится и под общим запретом изменений мира', () => {
  const constrained = buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    known_environment: { scene: { location: 'Трактир' } },
    permitted_npc_reactions: [],
    narration_constraints: ['no-unconfirmed-world-changes'],
  })
  const result = verifyNarration('Мира достаёт потрёпанный свиток и кладёт его перед Адой.', constrained)
  assert.equal(result.valid, false)
  assert.ok(result.violations.some((violation) => violation.code === 'ITEM_TRANSFER_NOT_IN_BRIEF'))
})
