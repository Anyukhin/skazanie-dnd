import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

/**
 * Строка боевой хроники — единственное, чем механика говорит со столом словами.
 * Тестов у неё не было ни одного: `battleEventText` живёт в `src/app-shared.tsx`
 * рядом с JSX, а корпус запускает интерфейс только через `tsc` во временный
 * каталог, и эмитированный `react/jsx-runtime` оттуда не разрешается.
 *
 * Поэтому среда интерфейса подменяется заглушкой: модуль компилируется как
 * есть, а все его внешние импорты — среда JSX, хуки React и набор значков —
 * переписываются на одну пустышку рядом. Компоненты и хуки тест не вызывает,
 * проверяется чистая функция; подмена нужна лишь для того, чтобы модуль вообще
 * загрузился. Так под сторожем оказывается настоящий исходник, а не его копия.
 *
 * Держит он два обещания шага «враги пускают в ход снаряжение»: лечение без
 * величины называется словами, а не «+0», и лечение самого себя не превращается
 * в двух участников на доске.
 *
 * И третье — прозрачность боевой хроники. Повод из живой партии: багбир метнул
 * копьё с 25 футов, событие несло и название действия, и вид урона, а строка
 * напечатала «Багбир 1 атакует Тэсса: 18 против КД 16 — попадание, 8 урона», и
 * стол принял дальний бросок за удар вплотную. Строка обязана отвечать «кто,
 * чем, как, исход» — и ровно в тех границах, что и раньше: числа стат-блока
 * противника остаются закрытыми.
 */
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-battle-text-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sharedPath = fileURLToPath(new URL('../src/app-shared.tsx', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--jsx', 'react-jsx', '--outDir', buildDir, sharedPath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
writeFileSync(
  join(buildDir, 'ui-runtime.mjs'),
  [
    'export const Fragment = Symbol("fragment")',
    'export const jsx = () => null',
    'export const jsxs = () => null',
    'export const useEffect = () => {}',
    'export const useRef = (value) => ({ current: value })',
    'export const useState = (value) => [value, () => {}]',
    'export const CircleAlert = () => null',
    'export const X = () => null',
    '',
  ].join('\n'),
)
const modulePath = join(buildDir, 'app-shared.mjs')
writeFileSync(modulePath, readFileSync(join(buildDir, 'app-shared.js'), 'utf8')
  .replace(/from (["'])(?:react\/jsx-runtime|react|lucide-react)\1/gu, 'from "./ui-runtime.mjs"'))
const { DAMAGE_TYPE_LABELS, battleEventText, damageAmountText, damageTypeLabel } = await import(pathToFileURL(modulePath).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

/** Отряд из одного героя и опознанный союзник-противник рядом. */
function state({ healthKnown = 'banded' } = {}) {
  return {
    players: [{ id: 'hero', character: 'Ада' }],
    enemies: [{ id: 'foe', name: 'Берсерк', healthKnown }],
    actors: [],
  }
}

test('лечение без величины называется словами, а не нулём', () => {
  // Ровно тот случай, ради которого сервер снимает число: зелье противника.
  // Величины в записи нет, и «+0 ОЗ» означало бы, что склянка не сработала.
  const text = battleEventText(state(), { id: 'b1', type: 'healing', actorId: 'foe', targetId: 'foe' })
  assert.equal(text, 'Берсерк лечит себя: раны затягиваются.')
  assert.equal(text.includes('+0'), false)
  assert.equal(/\d/u.test(text), false, 'в записи без величины не должно быть чисел вовсе')

  // Опознанному существу число приходит и печатается вместе с полосой ОЗ.
  assert.equal(
    battleEventText(state({ healthKnown: 'exact' }), {
      id: 'b2', type: 'healing', actorId: 'foe', targetId: 'foe', healing: 10, hpBefore: 8, hpAfter: 18,
    }),
    'Берсерк лечит себя: +10 ОЗ · 8 → 18.',
  )
})

test('лечение себя и лечение другого — две разные строки', () => {
  assert.equal(
    battleEventText(state(), {
      id: 'b3', type: 'healing', actorId: 'hero', targetId: 'hero', healing: 7, hpBefore: 3, hpAfter: 10,
      spellId: 'cure-wounds', spellName: 'Лечение ран',
    }),
    'Ада лечит себя заклинанием «Лечение ран»: +7 ОЗ · 3 → 10.',
  )
  // Тот же герой, но цель другая: имя цели обязано вернуться в строку.
  const other = battleEventText({
    ...state(),
    players: [{ id: 'hero', character: 'Ада' }, { id: 'ally', character: 'Бор' }],
  }, { id: 'b4', type: 'healing', actorId: 'hero', targetId: 'ally', healing: 7, hpBefore: 3, hpAfter: 10 })
  assert.equal(other, 'Ада лечит Бор: +7 ОЗ · 3 → 10.')
  assert.equal(other.includes('себя'), false)
})

/** Стол того самого случая: багбир, герой и опознанный гоблин рядом. */
function tableState({ foeKnown = 'exact' } = {}) {
  return {
    players: [{ id: 'hero', character: 'Тэсса' }, { id: 'archer', character: 'Мирра' }],
    enemies: [
      { id: 'foe', name: 'Багбир 1', healthKnown: foeKnown },
      { id: 'goblin', name: 'Гоблин 2', healthKnown: 'exact' },
    ],
    actors: [],
  }
}

test('брошенное копьё называется броском, а не безымянной атакой', () => {
  // Ровно та запись, что приехала из живой партии, — только теперь с видом
  // атаки и расстоянием, которые сервер и раньше знал, но не называл.
  assert.equal(
    battleEventText(tableState(), {
      id: 'a1', type: 'attack', actorId: 'foe', targetId: 'hero',
      attackKind: 'thrown', actionName: 'Метательное копьё', distanceFeet: 25,
      roll: { total: 18, difficulty: 16, hit: true },
      damage: 8, damageType: 'piercing', hpBefore: 30, hpAfter: 22,
    }),
    'Багбир 1 мечет в Тэсса («Метательное копьё», 25 фт): 18 против КД 16 — попадание, 8 колющего · ОЗ 30 → 22.',
  )
})

test('удар, выстрел и бросок различаются глаголом', () => {
  const attack = (extra) => battleEventText(tableState(), {
    id: 'a2', type: 'attack', actorId: 'hero', targetId: 'goblin',
    roll: { die: 14, modifier: 5, total: 19, difficulty: 15, hit: true },
    damage: 8, damageType: 'slashing', ...extra,
  })
  assert.match(attack({ attackKind: 'melee', itemName: 'Длинный меч' }), /^Тэсса бьёт Гоблин 2 \(«Длинный меч»\)/u)
  assert.match(attack({ attackKind: 'ranged', itemName: 'Длинный лук', distanceFeet: 60 }), /^Тэсса стреляет в Гоблин 2 \(«Длинный лук», 60 фт\)/u)
  assert.match(attack({ attackKind: 'thrown', itemName: 'Дротик', distanceFeet: 20 }), /^Тэсса мечет в Гоблин 2 \(«Дротик», 20 фт\)/u)
  // Расстояние у ближнего удара всегда одно и то же и в строку не идёт.
  assert.equal(attack({ attackKind: 'melee', itemName: 'Длинный меч', distanceFeet: 5 }).includes('фт'), false)
})

test('свой бросок разбирается на кость и модификатор, чужой остаётся итогом', () => {
  const mine = battleEventText(tableState(), {
    id: 'a3', type: 'attack', actorId: 'archer', targetId: 'goblin', attackKind: 'ranged',
    itemName: 'Длинный лук', distanceFeet: 60,
    roll: { die: 9, modifier: 6, total: 15, difficulty: 15, hit: true },
    damage: 6, damageType: 'piercing', hpBefore: 12, hpAfter: 6,
  })
  assert.equal(
    mine,
    'Мирра стреляет в Гоблин 2 («Длинный лук», 60 фт): к20 9+6=15 против КД 15 — попадание, 6 колющего · ОЗ 12 → 6.',
  )

  // У удара противника проекция снимает кость и модификатор: это числа его
  // стат-блока. Строка обязана обойтись итогом, а не печатать «к20 0+0=18».
  const theirs = battleEventText(tableState(), {
    id: 'a4', type: 'attack', actorId: 'foe', targetId: 'hero', attackKind: 'melee',
    actionName: 'Моргенштерн', roll: { total: 18, difficulty: 16, hit: true }, damage: 11, damageType: 'bludgeoning',
  })
  assert.equal(theirs, 'Багбир 1 бьёт Тэсса («Моргенштерн»): 18 против КД 16 — попадание, 11 дробящего.')
  assert.equal(theirs.includes('к20'), false)
})

test('дальний выстрел объявляется один раз, а не дважды', () => {
  const text = battleEventText(tableState(), {
    id: 'a5', type: 'attack', actorId: 'archer', targetId: 'goblin', attackKind: 'ranged',
    itemName: 'Длинный лук', distanceFeet: 175, longRange: true,
    rollMode: 'disadvantage', disadvantageReasons: ['дальний диапазон'],
    roll: { die: 9, modifier: 6, total: 15, difficulty: 15, hit: false },
  })
  assert.equal(
    text,
    'Мирра стреляет в Гоблин 2 («Длинный лук», 175 фт, дальний выстрел с помехой): к20 9+6=15 против КД 15 — промах.',
  )
  // Та же причина в скобке после исхода была бы вторым пересказом одного факта.
  assert.equal(text.match(/дальн/gu).length, 1)
})

test('причина преимущества и помехи печатается словами сервера', () => {
  assert.equal(
    battleEventText(tableState(), {
      id: 'a6', type: 'attack', actorId: 'foe', targetId: 'hero', attackKind: 'melee', actionName: 'Моргенштерн',
      rollMode: 'advantage', advantageReasons: ['позиция выше цели', 'тактика стаи', 'цель сбита с ног'],
      roll: { total: 21, difficulty: 16, hit: true }, damage: 8, damageType: 'bludgeoning',
    }),
    'Багбир 1 бьёт Тэсса («Моргенштерн»): 21 против КД 16 — попадание (преимущество: позиция выше цели, тактика стаи), 8 дробящего.',
  )
  // Причина не пришла — режим всё равно назван: молчать о нём нельзя.
  assert.match(
    battleEventText(tableState(), {
      id: 'a7', type: 'attack', actorId: 'foe', targetId: 'hero', attackKind: 'melee',
      rollMode: 'disadvantage', roll: { total: 9, difficulty: 16, hit: false },
    }),
    /— промах \(с помехой\)\.$/u,
  )
})

test('границы скрытности от новых полей не сдвинулись', () => {
  // Неопознанный противник действует: чисел его броска в строке нет вовсе,
  // но поступок назван — копьё в воздухе стол видит своими глазами.
  const unknownActor = battleEventText(tableState({ foeKnown: 'banded' }), {
    id: 'a8', type: 'attack', actorId: 'foe', targetId: 'hero', attackKind: 'thrown',
    actionName: 'Метательное копьё', distanceFeet: 25,
    roll: { total: 18, difficulty: 16, hit: true }, damage: 8, damageType: 'piercing', hpBefore: 30, hpAfter: 22,
  })
  assert.equal(
    unknownActor,
    'Багбир 1 мечет в Тэсса («Метательное копьё», 25 фт) — попадание, 8 колющего · ОЗ 30 → 22.',
  )
  assert.equal(unknownActor.includes('КД'), false)

  // Неопознанный противник — цель: КД и его ОЗ закрыты, как и были.
  const unknownTarget = battleEventText({
    players: [{ id: 'hero', character: 'Тэсса' }],
    enemies: [{ id: 'foe', name: 'Багбир 1', healthKnown: 'banded' }],
    actors: [],
  }, {
    id: 'a9', type: 'attack', actorId: 'hero', targetId: 'foe', attackKind: 'melee', itemName: 'Длинный меч',
    roll: { die: 14, modifier: 5, total: 19, hit: true }, damage: 8, damageType: 'slashing',
  })
  assert.equal(unknownTarget, 'Тэсса бьёт Багбир 1 («Длинный меч»): к20 14+5=19 — попадание, 8 рубящего.')
  assert.equal(unknownTarget.includes('КД'), false)
  assert.equal(unknownTarget.includes('ОЗ'), false)
})

test('запись без новых полей печатается прежней строкой', () => {
  // Бой, сыгранный до появления вида атаки: глагол остаётся нейтральным, вид
  // урона не выдумывается, разбор броска не изобретается из нулей.
  assert.equal(
    battleEventText(tableState(), {
      id: 'a10', type: 'attack', actorId: 'foe', targetId: 'hero',
      roll: { total: 18, difficulty: 16, hit: true }, damage: 8, hpBefore: 30, hpAfter: 22,
    }),
    'Багбир 1 атакует Тэсса: 18 против КД 16 — попадание, 8 урона · ОЗ 30 → 22.',
  )
  assert.equal(
    battleEventText(tableState(), {
      id: 'a11', type: 'attack', actorId: 'foe', targetId: 'hero', roll: { total: 9, difficulty: 16, hit: false },
    }),
    'Багбир 1 атакует Тэсса: 9 против КД 16 — промах.',
  )
})

test('атака без вида всё равно называет, чем била', () => {
  // Луч заклинания и удар легендарного действия вида атаки не несут: их
  // событие приходит другим путём. «Чем» при этом известно, и терять его
  // ради неизвестного «как» нельзя.
  assert.equal(
    battleEventText(tableState(), {
      id: 'a17', type: 'attack', actorId: 'hero', targetId: 'goblin',
      spellId: 'fire-bolt', spellName: 'Огненный луч',
      roll: { die: 12, modifier: 6, total: 18, difficulty: 15, hit: true }, damage: 5, damageType: 'fire',
    }),
    'Тэсса атакует Гоблин 2 («Огненный луч»): к20 12+6=18 против КД 15 — попадание, 5 огненного.',
  )
  // Расстояние без вида атаки не печатается: неизвестно, дальний это удар или
  // обычные пять футов на длине руки.
  assert.equal(
    battleEventText(tableState(), {
      id: 'a18', type: 'attack', actorId: 'foe', targetId: 'hero', distanceFeet: 5,
      roll: { total: 12, difficulty: 16, hit: false },
    }).includes('фт'),
    false,
  )
})

test('вид урона называется по-русски одним словарём на всех', () => {
  assert.equal(damageAmountText(8, 'piercing'), '8 колющего')
  assert.equal(damageTypeLabel('piercing'), 'Колющий')
  // Незнакомый и отсутствующий вид не превращаются в выдумку.
  assert.equal(damageAmountText(8, 'chronomancy'), '8 урона')
  assert.equal(damageAmountText(8), '8 урона')
  assert.equal(damageTypeLabel('chronomancy'), '')
  // Оба словаря обязаны знать одни и те же виды: иначе строка журнала и
  // подпись под фишкой разойдутся на первом же незнакомом ключе.
  for (const key of Object.keys(DAMAGE_TYPE_LABELS)) {
    assert.notEqual(damageAmountText(1, key), '1 урона', `${key} обязан иметь форму для строки урона`)
  }
})

test('спасбросок и область называют характеристику и вид урона', () => {
  assert.equal(
    battleEventText(tableState(), {
      id: 'a12', type: 'spell-save', actorId: 'hero', targetId: 'goblin', spellName: 'Огненные ладони', ability: 'dex',
      roll: { die: 7, modifier: 2, total: 9, difficulty: 13, hit: false }, result: 'failure',
      damage: 6, damageType: 'fire', hpBefore: 12, hpAfter: 6,
    }),
    'Гоблин 2: спасбросок ЛОВ от «Огненные ладони» 7 + 2 = 9 против СЛ 13 — провал · 6 огненного · ОЗ 12 → 6.',
  )
  assert.equal(
    battleEventText(tableState(), {
      id: 'a13', type: 'area-attack', actorId: 'hero', itemName: 'Алхимическая граната',
      area: { x: 4, y: 0, radiusFeet: 10 }, ability: 'dex', savingThrowDifficulty: 12, damageType: 'fire',
    }),
    'Тэсса применяет «Алхимическая граната» в области радиусом 10 фт · спасбросок ЛОВ против СЛ 12 · урон огонь.',
  )
})

test('реакция называется по имени, а не ключом события', () => {
  assert.equal(
    battleEventText(tableState(), {
      id: 'a14', type: 'reaction', actorId: 'hero', targetId: 'hero',
      actionId: 'uncanny-dodge', actionName: 'Невероятное уклонение', preventedDamage: 5,
    }),
    'Тэсса отвечает реакцией «Невероятное уклонение», урон снижен на 5.',
  )
  // Раньше здесь печаталось само слово `reaction`: строка возвращала тип
  // события, если ветки под него не нашлось.
  assert.equal(
    battleEventText(tableState(), { id: 'a15', type: 'reaction', actorId: 'hero', targetId: 'hero' }),
    'Тэсса отвечает реакцией.',
  )
  assert.equal(
    battleEventText(tableState(), {
      id: 'a16', type: 'reaction', actorId: 'hero', targetId: 'foe', countered: true, spellName: 'Огненный шар',
    }),
    'Тэсса обрывает «Огненный шар»: заклинание Багбир 1 не срабатывает.',
  )
})

test('ни одна запись журнала не печатает свой служебный ключ', () => {
  // Пять типов возвращались из функции собой же — «reaction», «beast-tamed» и
  // прочие ключи движка вместо человеческой строки.
  const types = [
    'move', 'attack', 'area-attack', 'equipment', 'spell', 'spell-save', 'spell-damage', 'healing', 'action',
    'reaction', 'summon', 'summon-end', 'turn-end', 'combat-start', 'combat-end', 'encounter-created',
    'encounter-ended', 'death-save', 'death-save-damage', 'hero-stabilized', 'concentration-save',
    'concentration-end', 'max-hp-reduction', 'max-hp-reduction-prevented', 'max-hp-increase', 'beast-tamed',
    'npc-item', 'parley', 'parley-rejected', 'parley-settled', 'truce', 'truce-broken', 'captive-taken',
    'loot-container', 'loot-taken',
  ]
  for (const type of types) {
    const text = battleEventText(tableState(), { id: `t-${type}`, type, actorId: 'hero', targetId: 'goblin' })
    assert.notEqual(text, type, `тип ${type} остался без человеческой строки`)
    assert.equal(/[a-z]{3}/u.test(text), false, `в строке типа ${type} осталось служебное слово: ${text}`)
  }
})

test('поступок противника со снаряжением называет подпись сервера, а не вещь', () => {
  assert.equal(
    battleEventText(state(), { id: 'b5', type: 'npc-item', actorId: 'foe', label: 'прикладывается к склянке' }),
    'Берсерк прикладывается к склянке.',
  )
  // Подписи нет — строка всё равно остаётся человеческой и вещь не называет.
  assert.equal(
    battleEventText(state(), { id: 'b6', type: 'npc-item', actorId: 'foe' }),
    'Берсерк пускает в ход своё снаряжение.',
  )
})
