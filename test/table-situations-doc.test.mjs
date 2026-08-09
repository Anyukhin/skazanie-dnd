// Сторож каталога ситуаций `docs/dnd-table-situations.md`.
//
// Каталог — вход в планирование волны 2б: по нему выбирают, каким брифом
// закрывается какая дыра. Держится он на абсолютах («время двигает три вещи и ни
// одной больше», «события — нет», «нет ни в одной форме»), и ровно эти абсолюты
// разошлись с кодом в первой же ревизии: у мировых минут оказалось девять живых
// потребителей вместо трёх, исполненное расписание NPC всё-таки пишет факт памяти
// мира, а «спутник» существует — как состояние `pact-familiar`. Документ без
// сторожа расходится с кодом молча, а следующий шаг цепочки (время суток и погода)
// строится именно на разделе про время.
//
// Поэтому здесь сверка текста не с текстом, а с кодом:
//   1. каждый живой потребитель `elapsed_minutes` обязан быть назван в сквозном
//      пробеле про время — пропадёт в коде или появится новый, тест покраснеет;
//   2. опровергнутые кодом формулировки не должны вернуться;
//   3. заголовки ситуаций, строки сводной таблицы и итоговый счёт сходятся.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// `core.autocrlf=true`, и на свежей выгрузке рабочая копия приходит с CRLF.
// Разбор ниже якорится на конец строки, поэтому переводы нормализуются на входе:
// иначе сторож зеленел бы у автора и краснел у всех остальных.
const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const DOC = source('docs/dnd-table-situations.md')
/** Документ переносится по 80 колонок, поэтому фразы ищутся в схлопнутом виде. */
const FLAT = DOC.replace(/\s+/g, ' ')

/** Тело `appendTimeAdvance` + `appendWorldTimeConsequences` — всё, что двигает время внутри движка. */
function worldTimeBlock() {
  const rules = source('server/rules-engine.mjs')
  const start = rules.indexOf('const appendTimeAdvance =')
  const end = rules.indexOf('const damageTurnKey =', start)
  assert.ok(start !== -1 && end > start, 'в rules-engine не найден блок последствий мирового времени')
  return rules.slice(start, end)
}

/** Тело одного метода класса оркестратора (отступ в два пробела — граница). */
function orchestratorMethod(name) {
  const module = source('server/autonomous-orchestrator.mjs')
  const start = module.indexOf(`async ${name}(campaignId`)
  assert.notEqual(start, -1, `в autonomous-orchestrator нет метода ${name}`)
  const rest = module.slice(start)
  const end = rest.indexOf('\n  async ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Раздел одной ситуации: от `### A1.` до следующего заголовка любого уровня. */
function situation(id) {
  const lines = DOC.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`))
  assert.notEqual(start, -1, `в каталоге нет ситуации ${id}`)
  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith('#'))
  return lines.slice(start, offset === -1 ? lines.length : start + 1 + offset).join('\n')
}

/** Один пункт из «Пяти сквозных пробелов», схлопнутый по пробелам. */
function crossCuttingGap(number) {
  const start = DOC.indexOf(`\n${number}. **`)
  assert.notEqual(start, -1, `в сквозных пробелах нет пункта ${number}`)
  const next = DOC.indexOf(`\n${number + 1}. **`, start + 1)
  const tail = next === -1 ? DOC.indexOf('\n## ', start + 1) : next
  return DOC.slice(start, tail === -1 ? DOC.length : tail).replace(/\s+/g, ' ')
}

/**
 * Живые потребители мировых минут. `code` опознаёт контур в коде, `markers` —
 * то, чем он обязан быть назван в документе. Пары держатся вместе намеренно:
 * список нельзя сократить, не сократив документ.
 */
const WORLD_CLOCK_CONSUMERS = Object.freeze([
  {
    title: 'просроченные обещания NPC',
    code: () => worldTimeBlock().includes('npcPromiseDeadlineEvents(state, elapsedMinutes)'),
    markers: ['npcPromiseDeadlineEvents'],
  },
  {
    title: 'восстановление стабилизированного героя через 1к4 часа',
    code: () => worldTimeBlock().includes("'StableRecoveryScheduled'")
      && worldTimeBlock().includes("reason: 'stable-recovery-after-1d4-hours'"),
    markers: ['StableRecoveryScheduled', 'StableRecoveryProgressed', 'HealingApplied'],
  },
  {
    title: 'добивание нокаут-отдыха',
    code: () => worldTimeBlock().includes("'KnockoutRecoveryProgressed'")
      && worldTimeBlock().includes("reason: 'knockout'"),
    markers: ['KnockoutRecoveryProgressed', 'RestCompleted'],
  },
  {
    title: 'перезарядка предметов на рассвете',
    code: () => worldTimeBlock().includes('resolveItemDawnRecharge(state, elapsedMinutes'),
    markers: ['server/item-dawn-recharge.mjs'],
  },
  {
    title: 'смена времени суток и погоды',
    code: () => worldTimeBlock().includes('worldClockEventDrafts(state, elapsedMinutes)')
      && source('server/weather.mjs').includes('export function worldClockEventDrafts'),
    markers: ['worldClockEventDrafts', 'server/weather.mjs'],
  },
  {
    title: 'пополнение склада торговца',
    code: () => source('server/merchant-economy.mjs').includes('export function planMerchantEconomyClock')
      && source('server/merchant-economy.mjs').includes('state?.mechanics?.world_time?.elapsed_minutes')
      && source('server/index.mjs').includes('async function runMerchantEconomyClock'),
    markers: ['planMerchantEconomyClock', 'runMerchantEconomyClock', 'RestockMerchant'],
  },
  {
    title: 'исполнение расписаний NPC в окне start/end',
    code: () => orchestratorMethod('advanceTime').includes('elapsed_minutes')
      && orchestratorMethod('advanceTime').includes('executeNpcSchedules'),
    markers: ['executeNpcSchedules'],
  },
  {
    title: 'доступность и место NPC на текущую минуту',
    code: () => source('server/npc-social.mjs').includes('export function npcProfileAtWorldTime')
      && source('server/npc-social.mjs').includes('export function campaignElapsedMinutes'),
    markers: ['npcProfileAtWorldTime'],
  },
  {
    title: 'отпечаток обстановки, запрещающий перекатывать провал',
    code: () => /export function situationFingerprint[\s\S]{0,600}world_time\?\.elapsed_minutes/
      .test(source('server/free-action-adjudication.mjs')),
    markers: ['situationFingerprint'],
  },
  {
    title: 'горизонт памяти мира по минуте записи',
    code: () => /function inTime\(item, maximum\)[\s\S]{0,200}recorded_at_minutes\) <= maximum/
      .test(source('server/world-memory.mjs'))
      && source('server/world-memory.mjs').includes('export function worldMemoryForViewer'),
    markers: ['worldMemoryForViewer', 'recorded_at_minutes'],
  },
])

const NUMERALS = Object.freeze(['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать'])

/** Формулировки, опровергнутые кодом. Возврат любой из них — регресс документа. */
const REFUTED_CLAIMS = Object.freeze([
  ['и ни одной больше', 'мировые минуты двигают девять контуров, а не три'],
  ['Фигурки двигаются, события — нет', 'executeNpcSchedules пишет RecordWorldFact на каждое сработавшее расписание'],
  ['не порождают событий', 'факт памяти мира о расписании рождается — нет только механического последствия'],
  ['нет ни в одной форме', 'pact-chain вешает состояние pact-familiar, а find-familiar лежит в каталоге заклинаний'],
])

test('каждый живой потребитель мировых минут назван в сквозном пробеле про время', () => {
  const gap = crossCuttingGap(3)
  for (const consumer of WORLD_CLOCK_CONSUMERS) {
    assert.ok(consumer.code(), `контур «${consumer.title}» пропал из кода — перепишите пункт 3 каталога ситуаций`)
    for (const marker of consumer.markers) {
      assert.ok(gap.includes(marker), `пункт 3 каталога ситуаций не называет «${consumer.title}» (нет маркера ${marker})`)
    }
  }
})

test('счёт потребителей времени в документе совпадает со списком сторожа', () => {
  const gap = crossCuttingGap(3)
  const numeral = NUMERALS[WORLD_CLOCK_CONSUMERS.length]
  assert.ok(numeral, 'потребителей стало больше девяти — обновите словарь числительных')
  assert.ok(
    gap.includes(`${numeral} потребител`),
    `пункт 3 обязан называть число потребителей словом «${numeral}»`,
  )
})

test('опровергнутые кодом формулировки не возвращаются в каталог', () => {
  for (const [phrase, why] of REFUTED_CLAIMS) {
    assert.ok(!FLAT.includes(phrase), `в каталоге снова стоит «${phrase}», хотя ${why}`)
  }
})

test('D5 признаёт запись о расписании, которую код действительно делает', () => {
  const schedules = orchestratorMethod('executeNpcSchedules')
  assert.ok(schedules.includes("command_type: 'RecordWorldFact'"), 'расписания перестали писать факт мира')
  assert.ok(schedules.includes("predicate: 'npc_scheduled_action_executed'"), 'предикат факта расписания переименован')
  const d5 = situation('D5')
  for (const marker of ['RecordWorldFact', 'npc_scheduled_action_executed']) {
    assert.ok(d5.includes(marker), `D5 занижает готовность контура: нет упоминания ${marker}`)
  }
})

test('F1 не отрицает спутника, который в коде есть', () => {
  const actions = source('server/combat-actions.mjs')
  assert.ok(actions.includes("action('pact-chain'"), 'действие pact-chain исчезло — перепишите F1')
  assert.ok(actions.includes("condition: 'pact-familiar'"), 'состояние pact-familiar исчезло — перепишите F1')
  assert.ok(source('data/dndsu-spells-0-6.json').includes('"find-familiar"'), 'find-familiar пропал из каталога заклинаний')
  assert.ok(
    !source('data/dndsu-spell-mechanics-overrides.json').includes('find-familiar'),
    'у find-familiar появился серверный override — фамильяр стал исполнимым, статус F1 надо пересмотреть',
  )
  const f1 = situation('F1')
  for (const marker of ['pact-chain', 'pact-familiar', 'find-familiar']) {
    assert.ok(f1.includes(marker), `F1 обещает отсутствие спутника, не упомянув ${marker}`)
  }
})

test('каждый путь и раздел плана, на которые ссылается каталог, существуют', () => {
  const cited = [...new Set([...DOC.matchAll(/`((?:docs|server|src|data|test|prompts|tools)\/[A-Za-z0-9_./-]+)`/g)]
    .map(([, path]) => path))]
  assert.ok(cited.length >= 40, 'ссылки на файлы пропали из каталога — проверьте разбор')
  for (const path of cited) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `каталог ссылается на несуществующий ${path}`)
  }
  // Заголовок каталога однажды сослался на несуществующий раздел «ПИВОТ» плана —
  // именно туда пошёл бы следующий агент за постановкой задачи.
  const planHeadings = new Set([...source('docs/experience-upgrade-plan-2.md').matchAll(/^#{2,3} (.+)$/gm)]
    .map(([, heading]) => heading.trim()))
  for (const heading of [...DOC.matchAll(/«(Этап [IVX]+[^»]*)»/g)].map(([, quoted]) => quoted)) {
    assert.ok(planHeadings.has(heading), `каталог цитирует раздел плана «${heading}», которого в плане нет`)
  }
  assert.ok(!DOC.includes('раздел ПИВОТ'), 'в шапке снова стоит ссылка на раздел плана, которого на этой ветке нет')
})

test('заголовки ситуаций, сводная таблица и итог сходятся', () => {
  const headings = [...DOC.matchAll(/^### ([A-F]\d+)\..*? — \*\*([^*]+)\*\*/gm)]
    .map(([, id, status]) => [id, status.split(',')[0].split(' ')[0]])
  const rows = [...DOC.matchAll(/^\| ([A-F]\d+) \| [^|]+ \| ([^|]+?) \| [^|]*\|$/gm)]
    .map(([, id, status]) => [id, status.trim()])

  assert.ok(headings.length >= 40, 'каталог ситуаций внезапно опустел — проверьте разбор заголовков')
  assert.equal(rows.length, headings.length, 'в сводной таблице не столько строк, сколько ситуаций в теле документа')

  const byRow = new Map(rows)
  for (const [id, status] of headings) {
    assert.equal(byRow.get(id), status, `статус ${id} в теле документа и в сводной таблице разошёлся`)
  }

  const totals = DOC.match(/Итого (\d+) ситуаций: (\d+) работают, (\d+) частично, (\d+) нет\./)
  assert.ok(totals, 'в каталоге нет строки итога')
  const counted = { работает: 0, частично: 0, нет: 0 }
  for (const [, status] of headings) {
    assert.ok(status in counted, `неизвестный статус «${status}» — допустимы только работает/частично/нет`)
    counted[status] += 1
  }
  assert.deepEqual(
    totals.slice(1, 5).map(Number),
    [headings.length, counted.работает, counted.частично, counted.нет],
    'строка итога разошлась с фактическими статусами ситуаций',
  )
})
