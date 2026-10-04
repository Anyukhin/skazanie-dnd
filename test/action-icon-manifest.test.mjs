import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { iconIdsOnDisk, manifestIsCurrent, manifestSource } from '../tools/build-icon-manifest.mjs'
import { combatActionsFor } from '../server/combat-actions.mjs'
import { speciesBenefitsFor } from '../server/character-creation-catalog.mjs'
import { pngContractFailures } from './png-asset-contract.mjs'

const manifestPath = new URL('../src/action-icons.ts', import.meta.url)
const iconDirectory = new URL('../public/assets/ui/action-icons/', import.meta.url)
const rightsSource = new URL('../data/asset-rights.json', import.meta.url)
const classActionCatalog = JSON.parse(readFileSync(new URL('../data/dndsu-class-actions-1-12.json', import.meta.url), 'utf8'))

// Снимок `tmp/art-2026-10/nonspell-actions.json` на 2026-10-04: 157 новых
// рисунков действий. Сам tmp/ игнорируется и в чистый CI не попадает, поэтому
// тест хранит проверяемый контракт здесь, а рабочий набор всё равно получает
// из каталога и combatActionsFor ниже.
const NEW_ACTION_IDS = new Set([
  'barbarian-put-berserka-beshenstvo', 'barbarian-put-burevestnika-aura-buri',
  'barbarian-put-bushuyuschego-v-boyu-bronya-bushuyuschego-v-boyu', 'barbarian-put-bushuyuschego-v-boyu-nalet-bushuyuschego-v-boyu',
  'barbarian-put-velikana-probuzhdenie-moschi', 'barbarian-put-velikana-stihiynyy-tesak',
  'barbarian-put-dikoy-magii-dikaya-magiya', 'barbarian-put-dikoy-magii-nestabilnaya-otdacha',
  'barbarian-put-zverya-forma-zverya', 'barbarian-put-zverya-zaraznaya-yarost',
  'barbarian-put-predka-hranitelya-schit-predkov', 'barbarian-put-totemnogo-voina-totemnyy-duh',
  'barbarian-put-fanatika-fanatichnoe-prisutstvie',
  'bard-kollegiya-doblesti-boevoe-vdohnovenie', 'bard-kollegiya-duhov-istorii-duhov',
  'bard-kollegiya-duhov-istorii-s-togo-sveta', 'bard-kollegiya-znaniy-ostroe-slovtso',
  'bard-kollegiya-krasnorechiya-trevozhaschie-slova', 'bard-kollegiya-mechey-roscherk-klinka',
  'bard-kollegiya-ocharovaniya-mantiya-vdohnoveniya', 'bard-kollegiya-ocharovaniya-mantiya-velichiya',
  'bard-kollegiya-sozidaniya-ozhivlyayuschee-vystuplenie', 'bard-kollegiya-shepotov-mantiya-shepotov',
  'cleric-domen-buri-gnev-buri', 'cleric-domen-voyny-boevoy-svyaschennik',
  'cleric-domen-voyny-bozhestvennyy-kanal-blagoslovenie-boga-voyny', 'cleric-domen-magii-bozhestvennyy-kanal-ograzhdenie-magiey',
  'cleric-domen-mira-zaschitnaya-svyaz', 'cleric-domen-obmana-bozhestvennyy-kanal-dvulichnost',
  'cleric-domen-poryadka-golos-avtoriteta', 'cleric-domen-poryadka-voploschenie-zakona',
  'cleric-domen-prirody-sderzhivanie-stihiy', 'cleric-domen-sveta-zaschischayuschaya-vspyshka',
  'cleric-domen-sumerek-shagi-nochi', 'cleric-domen-upokoeniya-krug-smerti',
  'cleric-domen-upokoeniya-strazh-na-poroge-smerti',
  'druid-krug-dikogo-ognya-prizhigayuschee-plamya', 'druid-krug-dikogo-ognya-prizyv-duha-dikogo-ognya',
  'druid-krug-zvezd-kosmicheskoe-znamenie', 'druid-krug-zvezd-zvezdnyy-oblik',
  'druid-krug-luny-boevoy-dikiy-oblik', 'druid-krug-pastyrya-totem-duhov',
  'druid-krug-snov-skrytye-puti', 'druid-krug-snov-uteshenie-letnego-dvora',
  'druid-krug-spor-gribkovaya-infektsiya', 'druid-krug-spor-oreol-spor',
  'druid-krug-spor-rasprostranenie-spor',
  'fighter-kavalerist-derzhat-stroy', 'fighter-kavalerist-nepokolebimaya-metka', 'fighter-kavalerist-zaschitnyy-manevr',
  'bait-and-switch', 'brace', 'disarming-attack', 'distracting-strike', 'evasive-footwork', 'feinting-attack',
  'goading-attack', 'grappling-strike', 'lunging-attack', 'maneuvering-attack', 'menacing-attack', 'parry',
  'precision-attack', 'pushing-attack', 'quick-toss', 'rally', 'riposte', 'sweeping-attack', 'trip-attack',
  'fighter-misticheskiy-luchnik-stranstvuyuschaya-strela', 'fighter-misticheskiy-rytsar-boevaya-magiya',
  'fighter-misticheskiy-rytsar-svyaz-s-oruzhiem', 'fighter-psi-voin-adept-telekinetik', 'fighter-psi-voin-psionicheskaya-sila',
  'fighter-runnyy-rytsar-mosch-velikana', 'fighter-runnyy-rytsar-runicheskiy-schit',
  'fighter-rytsar-purpurnogo-drakona-vdohnovlyayuschiy-vsplesk', 'fighter-rytsar-eha-eho-muchenik',
  'fighter-rytsar-eha-manifest-eha', 'fighter-samuray-boevoy-duh',
  'monk-put-astralnogo-tela-lik-astralnogo-tela', 'monk-put-astralnogo-tela-ruki-astralnogo-tela',
  'monk-put-astralnogo-tela-tors-astralnogo-tela', 'monk-put-voshodyaschego-drakona-aspekt-virma',
  'monk-put-voshodyaschego-drakona-uchenik-drakona', 'monk-put-kenseya-put-kenseya', 'monk-put-kenseya-zaostrennyy-klinok',
  'monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni', 'monk-put-pyanogo-mastera-pyanaya-pohodka',
  'monk-put-solnechnoy-dushi-luch-siyayuschego-solntsa', 'monk-put-solnechnoy-dushi-udar-pylayuschey-dugi',
  'monk-put-teni-shag-teni',
  'paladin-klyatva-drevnih-bozhestvennyy-kanal', 'paladin-klyatva-iskupleniya-aura-zaschitnika',
  'paladin-klyatva-iskupleniya-bozhestvennyy-kanal', 'paladin-klyatva-korony-bozhestvennaya-predannost',
  'paladin-klyatva-korony-bozhestvennyy-kanal', 'paladin-klyatva-mesti-bozhestvennyy-kanal',
  'paladin-klyatva-mesti-neumolimyy-mstitel', 'paladin-klyatva-predannosti-bozhestvennyy-kanal',
  'paladin-klyatva-slavy-bozhestvennyy-kanal',
  'ranger-naezdnik-na-dreyke-dreyk-kompanon', 'ranger-ohotnik-dobycha-ohotnika',
  'ranger-povelitel-zverey-isklyuchitelnaya-dressirovka', 'ranger-povelitel-zverey-pervichnyy-sputnik',
  'ranger-povelitel-zverey-sputnik-sledopyta', 'ranger-povelitel-zverey-zverinaya-yarost',
  'ranger-strannik-gorizonta-efirnyy-shag', 'ranger-strannik-gorizonta-planarnyy-voin',
  'ranger-strannik-fey-zamanivayuschiy-tryuk', 'ranger-ubiytsa-chudovisch-dobycha-ubiytsy',
  'ranger-ubiytsa-chudovisch-vrag-zaklinatelya', 'ranger-hranitel-roya-izvivayuschayasya-volna',
  'rogue-vor-bystrye-ruki', 'rogue-klinok-dushi-klinki-dushi', 'rogue-klinok-dushi-psihicheskie-klinki',
  'rogue-klinok-dushi-psionicheskaya-sila', 'rogue-kombinator-master-taktiki', 'rogue-misticheskiy-lovkach-uluchshennaya-volshebnaya-ruka',
  'rogue-skaut-zachinschik', 'rogue-syschik-pronitsatelnyy-boy', 'rogue-syschik-vnimatelnyy-vzglyad',
  'rogue-fantom-chastitsa-dushi-usopshego',
  'sorcerer-aberrantnyy-razum-telepaticheskaya-rech', 'sorcerer-dikaya-magiya-podchinenie-udachi',
  'sorcerer-zavodnaya-dusha-vosstanovlenie-balansa', 'sorcerer-lunnoe-charodeystvo-ubyvanie-i-rost',
  'sorcerer-tenevaya-magiya-gonchaya-durnogo-znameniya', 'sorcerer-shtormovoe-koldovstvo-burnaya-magiya',
  'sorcerer-shtormovoe-koldovstvo-upravlenie-shtormom', 'breath-weapon',
  'warlock-arhifeya-charuyuschaya-zaschita', 'warlock-arhifeya-feyskoe-prisutstvie', 'warlock-arhifeya-tumannoe-ischeznovenie',
  'warlock-bezdonnyy-schupaltse-iz-glubin', 'warlock-bezdonnyy-zaschitnyy-izgib',
  'warlock-vedmovskoy-klinok-proklyatie-vedmovskogo-klinka', 'warlock-vedmovskoy-klinok-proklyatyy-dospeh',
  'warlock-velikiy-drevniy-entropicheskaya-opeka', 'warlock-geniy-sosud-geniya', 'warlock-geniy-spasitelnyy-sosud',
  'warlock-geniy-stihiynyy-dar', 'warlock-nebozhitel-lechaschiy-svet', 'warlock-nezhit-omertvevshaya-obolochka',
  'warlock-nezhit-uzhasayuschiy-oblik',
  'wizard-voennaya-magiya-magicheskoe-otrazhenie', 'wizard-magiya-graviturgii-agressivnoe-prityazhenie',
  'wizard-magiya-hronurgii-hrono-sdvig', 'wizard-orden-pistsov-probuzhdenie-razuma', 'wizard-orden-pistsov-volshebnoe-pero',
  'wizard-pesn-klinka-pesn-klinka', 'wizard-pesn-klinka-pesn-zaschity', 'wizard-shkola-illyuzii-sobstvennaya-illyuzornost',
  'wizard-shkola-ograzhdeniya-proektsiya-zaschity', 'wizard-shkola-ocharovaniya-instinktivnoe-ocharovanie',
  'fighter-indomitable', 'paladin-aura-of-protection',
])

function clientCatalogActionIds() {
  const source = readFileSync(new URL('../src/combat-actions.ts', import.meta.url), 'utf8')
  return [...source.matchAll(/^\s+id: '([a-z0-9-]+)', classKey: '([a-z]+)', name: '([^']+)'.*actionType: '([a-z_]+)'/gmu)]
    .map((match) => match[1])
}

function allRuntimeActionIds() {
  const ids = new Set(JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8')).spells.map((spell) => String(spell.id)))
  for (const entry of classActionCatalog.classes) {
    for (const subclass of [null, ...entry.subclasses]) {
      const actor = {
        characterClass: entry.classKey,
        level: 12,
        abilities: {},
        ...(subclass ? { subclass: subclass.id } : {}),
      }
      for (const action of combatActionsFor(actor)) ids.add(String(action.id))
    }
  }
  const dragonborn = speciesBenefitsFor('dragonborn', 'dnd_5e_2014', { 'dragon-ancestry': ['red'] })
  assert.ok(dragonborn, 'реальный профиль speciesBenefits драконорождённого должен разрешаться')
  for (const action of combatActionsFor({ level: 12, abilities: {}, speciesBenefits: dragonborn })) ids.add(String(action.id))
  for (const id of clientCatalogActionIds()) ids.add(id)
  return ids
}

test('манифест иконок не отстал от каталога', () => {
  // Картинку легко положить и забыть пересобрать список — тогда она молча не
  // покажется. Тест ловит это, а не полагается на память.
  assert.equal(manifestIsCurrent(), true, 'запусти pnpm icons:manifest — список разошёлся с public/assets/ui/action-icons')
})

test('в манифесте только те идентификаторы, под которые есть файлы', () => {
  const ids = iconIdsOnDisk()
  const source = readFileSync(manifestPath, 'utf8')
  assert.ok(ids.length > 0, 'хотя бы один рисунок должен быть')
  for (const id of ids) assert.ok(source.includes(`'${id}',`), `${id} отсутствует в манифесте`)
  // Обратная сторона: в списке нет того, чего нет на диске.
  const listed = [...source.matchAll(/^\s{2}'([^']+)',$/gmu)].map((match) => match[1])
  assert.deepEqual(listed, ids, 'состав манифеста должен совпадать с каталогом')
})

test('идентификаторы рисунков совпадают с идентификаторами движка', () => {
  assert.equal(NEW_ACTION_IDS.size, 157, 'инвентарь должен содержать ровно 157 новых значков действий')
  const available = new Set(iconIdsOnDisk())
  const known = allRuntimeActionIds()
  const missing = [...known].filter((id) => !available.has(id)).sort()
  const extra = [...available].filter((id) => !known.has(id)).sort()
  assert.deepEqual({ missing, extra }, {
    missing: [],
    extra: [],
  }, 'каждое рабочее действие и заклинание должны иметь PNG, а каталог не должен содержать лишних идентификаторов')
})

test('все рисунки действий и заклинаний имеют полный PNG-контракт', () => {
  const failures = []
  for (const id of iconIdsOnDisk()) {
    const path = new URL(`${id}.png`, iconDirectory)
    if (!existsSync(path)) {
      failures.push(`${id}: файл отсутствует`)
      continue
    }
    const errors = pngContractFailures(readFileSync(path), { spanMin: 210, spanMax: 225 })
    if (errors.length) failures.push(`${id}: ${errors.join('; ')}`)
  }
  assert.deepEqual(failures, [], 'все рисунки должны быть PNG RGBA 256×256 с прозрачными углами, bbox 82–88%, центром и размером до 120 КБ')
})

test('каждый значок действия имеет уникальное содержимое и зарегистрированный хеш', () => {
  const rights = JSON.parse(readFileSync(rightsSource, 'utf8'))
  const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const contentOwners = new Map()
  for (const id of iconIdsOnDisk()) {
    const bytes = readFileSync(new URL(`${id}.png`, iconDirectory))
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${id}: нужен PNG`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relative = `ui/action-icons/${id}.png`
    const tuple = declaredRights.get(relative)
    assert.ok(tuple, `${relative}: права не зарегистрированы`)
    assert.equal(tuple[1], hash, `${relative}: хеш разошёлся с реестром прав`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром прав`)
    const owners = contentOwners.get(hash) ?? []
    owners.push(id)
    contentOwners.set(hash, owners)
  }
  const duplicates = [...contentOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(duplicates, [], 'каждому действию и заклинанию нужен собственный рисунок, а не байтовая копия')
  assert.equal(contentOwners.size, iconIdsOnDisk().length)
})

test('манифест собирается детерминированно и отсортирован', () => {
  const ids = iconIdsOnDisk()
  assert.deepEqual([...ids].sort(), ids, 'список должен быть отсортирован — иначе дифф скачет')
  assert.equal(manifestSource(ids), manifestSource(ids))
})
