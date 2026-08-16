/**
 * Снаряжение противника в бою: чем существо бьёт на самом деле и что оно тратит.
 *
 * Шаг A1 (`server/enemy-loadouts.mjs`) выдал противнику вещи **до** боя, но
 * вещь там лежала мёртвым грузом: скимитар в инвентаре и скимитар в
 * `action_profiles` были двумя независимыми записями, а зелье лечения в кармане
 * гоблина существовало только для того, чтобы его сняли с тела. Здесь та же
 * вещь начинает участвовать в бою.
 *
 * ## Привязка `npc_weapon_binding` и её сторож
 *
 * Привязка связывает **боевое действие стат-блока** с **экземпляром предмета**
 * из инвентаря. Она нужна ровно для трёх вещей: расход боеприпаса при выстреле,
 * недоступность действия при потере оружия и нанесение яда на конкретный
 * клинок.
 *
 * Привязка не создаётся молча. Сторож проверяет, что формула действия совпадает
 * с каталожной формулой связанного оружия: тот же вид (ближний/дальний), тот же
 * тип урона и те же кости. Плоская добавка не сверяется — это модификатор
 * характеристики существа, и он у каждого свой. Если формулы разошлись и
 * расхождение **не** объявлено в `NPC_ATTACK_FORMULA_DEVIATIONS`, привязки
 * не будет вовсе: движок продолжит считать удар по стат-блоку, но вещь к нему
 * не подключится. Отказ выбран нарочно — молча подключить «секиру» к действию
 * с кубами кинжала значит начать расходовать не то и разоружать не тем.
 *
 * Расхождения в SRD 5.2.1 настоящие и их одиннадцать: у капитана стражи длинный
 * меч бьёт 2к10, у багбира моргенштерн — 2к8. Это дизайн стат-блока, а не
 * ошибка привязки: редакция масштабирует урон существом, а не базовым оружием.
 * Каждое такое расхождение записано поимённо вместе с обеими формулами, поэтому
 * тихая правка стат-блока роняет сторож, а не проходит незамеченной.
 *
 * ## Что тратится
 *
 * - **Боеприпас.** У дальнего режима каталога стоит `ammunition: true` — лук,
 *   арбалет, праща. Выстрел снимает **одну стрелу**, а не комплект: в инвентаре
 *   лежат пачки по двадцать, и путать пачку с выстрелом значило бы разоружить
 *   разведчика вторым же ходом. Кончились — дальний профиль недоступен, и
 *   существо переходит в ближний бой.
 * - **Метательное оружие не из руки.** Дротики орка и багбира лежат пучком, и
 *   брошенный дротик из пучка уходит. Единственное **надетое** оружие так не
 *   тратится: копьё гладиатора одно, и разоружать существо его же ходом
 *   планировщик не станет — это осознанная граница, а не забытая ветка.
 *
 * ## Закрытый список расходников
 *
 * Тактики не выбирает модель. Расходных тактик ровно три — зелье, склянка и
 * яд, — и каждая привязана к конкретной каталожной записи со статусом
 * `verified`; четвёртая, расход боеприпасов, вещи из кармана не тратит и живёт
 * привязкой выше. Всё остальное, что лежит у противника в карманах, остаётся
 * добычей: набор лекаря стабилизирует героя с 0 хитов и противнику бесполезен,
 * фляга масла даёт выгоду только вместе с последующим огнём, которого
 * детерминированная политика не планирует.
 *
 * Модуль — **лист**: он читает каталог предметов и таблицы шага A1, но ничего
 * из боевого слоя не импортирует. Иначе `rules-engine` и `npc-turn-scheduler`
 * замкнулись бы на него кольцом — оба уже импортируют движок.
 */
import { catalogItem } from './item-catalog.mjs'
import { AMMUNITION_BY_WEAPON, WEAPON_CATALOG_BY_ACTION } from './enemy-loadouts.mjs'

export const NPC_EQUIPMENT_POLICY_ID = 'npc-equipment-v1'
export const NPC_EQUIPMENT_EVENT_SCHEMA_VERSION = 1

/**
 * Ниже этой доли хитов существо тянется за зельем. В процентах, а не долей:
 * порог сравнивается целыми (`hp * 100 <= maxHp * 30`), чтобы ровно тридцать
 * процентов не зависели от того, как легло двоичное представление `0.3`.
 */
export const NPC_HEALING_POTION_HP_PERCENT = 30

/** Маркер израсходованной за бой тактики: `npc-tactic-used:<tactic>`. */
export const NPC_TACTIC_CONDITION_PREFIX = 'npc-tactic-used:'

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

/**
 * Объявленные расхождения формулы стат-блока с каталогом.
 *
 * Ключ — `<stat_block_id>|<action_id>`. Обе формулы записаны целиком: сторож
 * сверяет их с живыми данными и падает, если стат-блок или каталог изменились.
 * Так запись не превращается в вечное разрешение «здесь можно как угодно».
 */
export const NPC_ATTACK_FORMULA_DEVIATIONS = Object.freeze({
  'srd_5_2_1:goblin-minion|scimitar': Object.freeze({
    catalog_id: 'srd_5_2_1:scimitar', profile_damage: '1d4+2', catalog_damage: '1d6',
    reason: 'Гоблин-налётчик — ослабленный вариант стат-блока: скимитар в его руках бьёт меньшей костью, чем базовое оружие.',
  }),
  'srd_5_2_1:bugbear|morningstar': Object.freeze({
    catalog_id: 'srd_5_2_1:morningstar', profile_damage: '2d8+2', catalog_damage: '1d8',
    reason: 'SRD 5.2.1 масштабирует урон существом, а не оружием: у багбира моргенштерн бьёт удвоенной костью.',
  }),
  'srd_5_2_1:warrior-veteran|heavy-crossbow': Object.freeze({
    catalog_id: 'srd_5_2_1:heavy-crossbow', profile_damage: '2d10+1', catalog_damage: '1d10',
    reason: 'Урон дальней атаки ветерана задан стат-блоком и вдвое превышает каталожный арбалет.',
  }),
  'srd_5_2_1:guard-captain|longsword': Object.freeze({
    catalog_id: 'srd_5_2_1:longsword', profile_damage: '2d10+4', catalog_damage: '1d8',
    reason: 'Стат-блок капитана стражи объявляет свой урон длинного меча; каталог описывает вещь, а не удар офицера.',
  }),
  'srd_5_2_1:guard-captain|javelin-melee': Object.freeze({
    catalog_id: 'srd_5_2_1:javelin', profile_damage: '3d6+4', catalog_damage: '1d6',
    reason: 'То же масштабирование: дротик в руке капитана стражи бьёт втрое большей костью.',
  }),
  'srd_5_2_1:guard-captain|javelin-ranged': Object.freeze({
    catalog_id: 'srd_5_2_1:javelin', profile_damage: '3d6+4', catalog_damage: '1d6',
    reason: 'Брошенный дротик капитана стражи наследует урон стат-блока, а не каталожную кость.',
  }),
  'srd_5_2_1:knight|heavy-crossbow': Object.freeze({
    catalog_id: 'srd_5_2_1:heavy-crossbow', profile_damage: '2d10', catalog_damage: '1d10',
    reason: 'Дальняя атака рыцаря объявлена стат-блоком без модификатора характеристики и удвоенной костью.',
  }),
  'srd_5_2_1:gladiator|spear-melee': Object.freeze({
    catalog_id: 'srd_5_2_1:spear', profile_damage: '2d6+4', catalog_damage: '1d6',
    reason: 'Копьё гладиатора бьёт по стат-блоку арены, а не по каталожной кости древкового оружия.',
  }),
  'srd_5_2_1:gladiator|spear-ranged': Object.freeze({
    catalog_id: 'srd_5_2_1:spear', profile_damage: '2d6+4', catalog_damage: '1d6',
    reason: 'Брошенное копьё гладиатора наследует тот же урон стат-блока.',
  }),
  'srd_5_2_1:tough-boss|warhammer': Object.freeze({
    catalog_id: 'srd_5_2_1:warhammer', profile_damage: '2d8+3', catalog_damage: '1d8',
    reason: 'Босс громил бьёт молотом по стат-блоку — удвоенной костью против каталожной.',
  }),
  'srd_5_2_1:tough-boss|heavy-crossbow': Object.freeze({
    catalog_id: 'srd_5_2_1:heavy-crossbow', profile_damage: '2d10+2', catalog_damage: '1d10',
    reason: 'Дальняя атака босса громил задана стат-блоком и вдвое превышает каталожный арбалет.',
  }),
})

/**
 * Закрытый список тактик. Ключ — каталожная запись, значение — что именно
 * сервер умеет с ней сделать в ход существа.
 *
 * `combat_action` дублирует каталожный `use.combat_action` намеренно: тактика
 * обязана знать, чем платит, ещё до того, как движок прочитает профиль. Если
 * каталог и тактика разойдутся, вещь закрывается целиком (`npcUsableItems`), а
 * сторож `test/npc-equipment.test.mjs` показывает расхождение поимённо.
 */
export const NPC_ITEM_TACTICS = Object.freeze({
  'srd_5_2_1:potion-of-healing': Object.freeze({
    tactic: 'heal', use_kind: 'healing', combat_action: 'bonus_action', once_per_combat: true,
    label: 'прикладывается к склянке',
  }),
  'srd_5_2_1:acid': Object.freeze({
    tactic: 'flask', use_kind: 'thrown_flask', combat_action: 'action', once_per_combat: false,
    label: 'мечет склянку кислоты',
  }),
  'srd_5_2_1:alchemists-fire': Object.freeze({
    tactic: 'flask', use_kind: 'thrown_flask', combat_action: 'action', once_per_combat: false,
    label: 'мечет склянку алхимического огня',
  }),
  'srd_5_2_1:poison-basic': Object.freeze({
    tactic: 'coat', use_kind: 'coat_weapon', combat_action: 'bonus_action', once_per_combat: true,
    label: 'смазывает лезвие ядом',
  }),
})

export const NPC_ITEM_TACTIC_IDS = Object.freeze(['heal', 'flask', 'coat'])

export function npcItemTacticFor(catalogId) {
  const tactic = NPC_ITEM_TACTICS[text(catalogId, 120)]
  return tactic ?? null
}

function loadoutItems(enemy) {
  return Array.isArray(enemy?.loadout?.items) ? enemy.loadout.items : []
}

export function npcLoadoutItem(enemy, itemInstanceId) {
  const expected = text(itemInstanceId, 160)
  if (!expected) return null
  return loadoutItems(enemy).find((item) => text(item?.item_instance_id, 160) === expected
    && integer(item?.quantity, 1) > 0) ?? null
}

/** Кости выражения без плоской добавки: `2d6+4` → `2d6`. */
function damageDiceOf(expression) {
  const match = /^\s*(\d+)d(\d+)/u.exec(String(expression ?? ''))
  return match ? `${Number(match[1])}d${Number(match[2])}` : ''
}

function combatModes(snapshotCombat) {
  const combat = snapshotCombat && typeof snapshotCombat === 'object' && !Array.isArray(snapshotCombat) ? snapshotCombat : null
  if (!combat) return []
  const modes = Array.isArray(combat.modes) ? combat.modes.filter((mode) => mode && typeof mode === 'object') : []
  return modes.length ? modes : [{ id: combat.kind, ...combat }]
}

/**
 * Режим оружия, которым исполняется это действие стат-блока: совпадают вид,
 * тип урона и кости. `null` — совпадения нет.
 */
function matchingMode(profile, snapshotCombat) {
  const kind = String(profile?.kind) === 'ranged' ? 'ranged' : 'melee'
  const damageType = text(profile?.damage_type, 40).toLowerCase()
  const dice = damageDiceOf(profile?.damage_expression)
  if (!dice) return null
  return combatModes(snapshotCombat).find((mode) => String(mode.kind) === kind
    && text(mode.damageType, 40).toLowerCase() === damageType
    && damageDiceOf(mode.damage) === dice) ?? null
}

/** Любой режим нужного вида — для объявленного расхождения формулы. */
function modeOfKind(profile, snapshotCombat) {
  const kind = String(profile?.kind) === 'ranged' ? 'ranged' : 'melee'
  const damageType = text(profile?.damage_type, 40).toLowerCase()
  return combatModes(snapshotCombat).find((mode) => String(mode.kind) === kind
    && text(mode.damageType, 40).toLowerCase() === damageType) ?? null
}

export function npcAttackFormulaDeviationKey(statBlockId, actionId) {
  return `${text(statBlockId, 120)}|${text(actionId, 120)}`
}

/**
 * Разбор одной привязки без чтения инвентаря: чистая сверка формул.
 * Возвращает `{ ok, mode, deviation, reason }`, где `reason` — почему привязка
 * запрещена.
 *
 * @param {{stat_block_id?: string}} enemy
 * @param {Record<string, any>} profile действие стат-блока
 * @param {Record<string, any>} snapshotCombat боевой снимок каталожной вещи
 */
export function npcWeaponBindingCheck(enemy, profile, snapshotCombat) {
  const matched = matchingMode(profile, snapshotCombat)
  if (matched) return { ok: true, mode: matched, deviation: null, reason: null }
  const key = npcAttackFormulaDeviationKey(enemy?.stat_block_id, profile?.id)
  const deviation = NPC_ATTACK_FORMULA_DEVIATIONS[key] ?? null
  if (!deviation) return { ok: false, mode: null, deviation: null, reason: 'formula-mismatch' }
  const mode = modeOfKind(profile, snapshotCombat)
  if (!mode) return { ok: false, mode: null, deviation, reason: 'formula-mismatch' }
  // Объявленное расхождение обязано описывать **это** расхождение, а не любое.
  if (damageDiceOf(deviation.profile_damage) !== damageDiceOf(profile?.damage_expression)
    || damageDiceOf(deviation.catalog_damage) !== damageDiceOf(mode.damage)) {
    return { ok: false, mode: null, deviation, reason: 'deviation-stale' }
  }
  return { ok: true, mode, deviation, reason: null }
}

/**
 * Сколько выстрелов в комплекте боеприпасов. В каталоге стрелы лежат пачками
 * (`ammunition.amount`), а в инвентаре считаются пачками же — поэтому «сколько
 * осталось стрел» и «сколько осталось пачек» это два разных числа, и путать их
 * нельзя: у разведчика с двумя колчанами сорок выстрелов, а не два.
 *
 * Читается **живой** каталог, а не замороженный снимок экземпляра, — и это
 * осознанная граница, а не забытая ветка: поля `ammunition` в снимке нет
 * вовсе (`createItemInstance` кладёт туда `catalog_id`, версию схемы каталога,
 * имя, тип, вес, описание, цену, статус механики и — только у оружия —
 * `combat`), так что брать размер пачки оттуда попросту неоткуда: у пачки
 * стрел там нет даже `combat`. Соседняя формула оружия снимок предпочитает, и
 * расхождение настоящее — оно названо в `docs/known-limitations.md` вместе с
 * тем, что оно задевает: нестрелянный колчан после будущей перебалансировки
 * пачки. Записанный бой это не трогает — в `NpcEquipmentSpent` уезжают
 * абсолютные числа.
 */
function bundleAmountFor(catalogId) {
  return Math.max(1, integer(catalogItem(catalogId)?.ammunition?.amount, 1))
}

/**
 * Остаток выстрелов в экземпляре боеприпасов.
 *
 * Считается по `charges` — тому же полю, которым набор лекаря считает свои
 * применения. Пока не выстрелили ни разу, поля нет, и остаток выводится из
 * числа пачек (см. границу у `bundleAmountFor`). Каталог здесь читается живым,
 * как и профиль использования у героя: в событие расхода уезжают уже
 * посчитанные числа, поэтому replay старого боя не зависит от будущей
 * перебалансировки пачки.
 */
function ammunitionShotsLeft(item) {
  if (!item) return 0
  const charges = item.charges && typeof item.charges === 'object' ? integer(item.charges.current, Number.NaN) : Number.NaN
  if (Number.isSafeInteger(charges)) return Math.max(0, charges)
  return Math.max(0, integer(item.quantity, 1)) * bundleAmountFor(text(item.catalog_id, 120))
}

/**
 * Что тратит выстрел или бросок этого действия.
 * `null` — ничего: ближний бой и единственное надетое метательное оружие.
 */
function expenditureFor(item, mode) {
  if (String(mode?.kind) !== 'ranged') return null
  if (mode.ammunition === true) return 'ammunition'
  // Единственное надетое метательное оружие существо не выбрасывает: иначе
  // планировщик разоружал бы гладиатора его же ходом.
  if (mode.thrown === true && item?.equipped !== true) return 'thrown'
  return null
}

/**
 * Привязки всех боевых действий существа. Действия без каталожного оружия
 * (укус, коготь, паутина) и действия с непроверенной формулой сюда не попадают:
 * их удар по-прежнему считает стат-блок, но вещи за ними нет.
 *
 * @param {Record<string, any>} enemy запись противника из состояния
 * @returns {Array<Record<string, any>>}
 */
export function npcWeaponBindings(enemy) {
  const profiles = Array.isArray(enemy?.action_profiles) ? enemy.action_profiles : []
  const items = loadoutItems(enemy)
  // Инвентарь по шаблону получают не все: у зверя, слизня и старого сохранения
  // его нет вовсе, и «оружие потеряно» там означало бы, что укус волка стал
  // недоступен. Привязка заводится только там, где инвентарь действительно
  // собирался, — тогда отсутствие вещи однозначно читается как утрата.
  const templateId = text(enemy?.loadout?.template_id, 120)
  const bindings = []
  if (!templateId) return bindings
  for (const profile of profiles) {
    const actionId = text(profile?.id, 120)
    const catalogId = WEAPON_CATALOG_BY_ACTION[actionId]
    if (!actionId || !catalogId) continue
    // Кандидат ищется по каталожному идентификатору, а его отсутствие — не
    // «привязки не было», а «вещь кончилась»: израсходованный пучок дротиков
    // и выбитый меч выглядят из состояния одинаково и одинаково закрывают
    // действие. Формула такой вещи сверяется по живому каталогу: снимка уже
    // нет, а ответ у ветки всё равно один — действие недоступно.
    const item = items.find((candidate) => text(candidate?.catalog_id, 120) === catalogId) ?? null
    const check = npcWeaponBindingCheck(enemy, profile, item?.snapshot?.combat ?? catalogItem(catalogId)?.combat)
    if (!check.ok) continue
    const ammunitionCatalogId = AMMUNITION_BY_WEAPON[catalogId] ?? null
    const ammunition = ammunitionCatalogId
      ? items.find((candidate) => text(candidate?.catalog_id, 120) === ammunitionCatalogId) ?? null
      : null
    bindings.push(Object.freeze({
      schema_version: NPC_EQUIPMENT_EVENT_SCHEMA_VERSION,
      policy_id: NPC_EQUIPMENT_POLICY_ID,
      action_id: actionId,
      kind: String(profile?.kind) === 'ranged' ? 'ranged' : 'melee',
      item_instance_id: item ? text(item.item_instance_id, 160) : '',
      catalog_id: catalogId,
      item_name: text(item?.snapshot?.name, 120) || text(catalogItem(catalogId)?.name, 120) || catalogId,
      item_quantity: item ? integer(item.quantity, 1) : 0,
      equipped: item?.equipped === true,
      expends: expenditureFor(item, check.mode),
      ammunition_instance_id: ammunition ? text(ammunition.item_instance_id, 160) : null,
      ammunition_catalog_id: ammunitionCatalogId,
      ammunition_name: ammunition ? text(ammunition.snapshot?.name, 120) : null,
      ammunition_quantity: ammunition ? integer(ammunition.quantity, 1) : 0,
      ammunition_shots_left: ammunitionShotsLeft(ammunition),
      deviation: check.deviation ? npcAttackFormulaDeviationKey(enemy?.stat_block_id, actionId) : null,
    }))
  }
  return bindings
}

export function npcWeaponBindingFor(enemy, actionId) {
  const expected = text(actionId, 120)
  if (!expected) return null
  return npcWeaponBindings(enemy).find((binding) => binding.action_id === expected) ?? null
}

/**
 * Ближнее оружие существа по **экземпляру** из инвентаря — то, на что кладётся
 * яд. Поиск идёт по вещи, а не по действию, потому что мажут клинок, а не
 * строку стат-блока: у капитана стражи один и тот же дротик стоит за двумя
 * действиями, и ответ обязан быть одинаковым, каким бы из них он ни ударил.
 */
export function npcMeleeWeaponBindingForItem(enemy, itemInstanceId) {
  const expected = text(itemInstanceId, 160)
  if (!expected) return null
  return npcWeaponBindings(enemy).find((binding) => binding.item_instance_id === expected
    && binding.kind === 'melee'
    && binding.item_quantity > 0) ?? null
}

/**
 * Почему действие стат-блока сейчас недоступно. `null` — доступно.
 *
 * Отвечает только про привязанные действия: у укуса и паутины вещи нет, и
 * запрещать их нечем.
 */
export function npcActionUnavailableReason(enemy, actionId) {
  const binding = npcWeaponBindingFor(enemy, actionId)
  if (!binding) return null
  if (binding.item_quantity <= 0) return 'weapon-lost'
  if (binding.expends === 'ammunition' && binding.ammunition_shots_left <= 0) return 'ammunition-spent'
  return null
}

export const NPC_ACTION_UNAVAILABLE_MESSAGES = Object.freeze({
  'weapon-lost': 'Существо потеряло оружие этого действия',
  'ammunition-spent': 'У существа кончились боеприпасы для этого действия',
})

/**
 * Что списать из инвентаря за одну атаку этим действием. `null` — ничего.
 *
 * У боеприпасов расходуется выстрел, а не пачка: `shots_*` считает стрелы,
 * `quantity_*` — колчаны, которые с них останутся телу. Оба числа уезжают в
 * событие целиком, поэтому редьюсер ничего не досчитывает и повторное
 * применение того же события даёт тот же остаток.
 *
 * @returns {{item_instance_id: string, catalog_id: string, item_name: string,
 *   reason: string, quantity_before: number, quantity_after: number,
 *   shots_before: number, shots_after: number} | null}
 */
export function npcAttackExpenditureFor(enemy, actionId) {
  const binding = npcWeaponBindingFor(enemy, actionId)
  if (!binding || !binding.expends) return null
  if (binding.expends !== 'ammunition') {
    if (!binding.item_instance_id || binding.item_quantity <= 0) return null
    return {
      item_instance_id: binding.item_instance_id,
      catalog_id: binding.catalog_id,
      item_name: binding.item_name,
      reason: binding.expends,
      quantity_before: binding.item_quantity,
      quantity_after: binding.item_quantity - 1,
      shots_before: binding.item_quantity,
      shots_after: binding.item_quantity - 1,
    }
  }
  if (!binding.ammunition_instance_id || binding.ammunition_shots_left <= 0) return null
  const bundle = bundleAmountFor(binding.ammunition_catalog_id)
  const shotsAfter = binding.ammunition_shots_left - 1
  return {
    item_instance_id: binding.ammunition_instance_id,
    catalog_id: binding.ammunition_catalog_id,
    item_name: binding.ammunition_name || '',
    reason: 'ammunition',
    quantity_before: binding.ammunition_quantity,
    quantity_after: shotsAfter > 0 ? Math.max(1, Math.ceil(shotsAfter / bundle)) : 0,
    shots_before: binding.ammunition_shots_left,
    shots_after: shotsAfter,
  }
}

/**
 * Расходники противника, с которыми сервер умеет что-то сделать в бою.
 * Каталог читается живым — так же, как его читает путь героя
 * (`itemLifecycleProfile`): в событие уезжает уже разобранный профиль, поэтому
 * replay не зависит от будущей правки записи.
 */
export function npcUsableItems(enemy) {
  const usable = []
  for (const item of loadoutItems(enemy)) {
    const catalogId = text(item?.catalog_id, 120)
    const tactic = npcItemTacticFor(catalogId)
    if (!tactic || integer(item?.quantity, 1) <= 0) continue
    const entry = catalogItem(catalogId)
    // Каталог — источник истины и для вида применения, и для цены хода.
    // Тактика объявляет оба поля своей копией, поэтому расхождение закрывает
    // вещь целиком, а не молча меняет то, чем существо платит.
    if (!entry?.use || entry.mechanics_status !== 'verified') continue
    if (entry.use.kind !== tactic.use_kind || String(entry.use.combat_action ?? '') !== tactic.combat_action) continue
    usable.push({
      item_instance_id: text(item.item_instance_id, 160),
      catalog_id: catalogId,
      item_name: text(item.snapshot?.name, 120) || entry.name,
      quantity: integer(item.quantity, 1),
      tactic: tactic.tactic,
      label: tactic.label,
      once_per_combat: tactic.once_per_combat === true,
      use: entry.use,
    })
  }
  return usable
}

export function npcUsableItemFor(enemy, itemInstanceId) {
  const expected = text(itemInstanceId, 160)
  return npcUsableItems(enemy).find((candidate) => candidate.item_instance_id === expected) ?? null
}

export function npcTacticCondition(tactic) {
  return `${NPC_TACTIC_CONDITION_PREFIX}${text(tactic, 40)}`
}

/**
 * Пора ли существу тянуться за зельем. Порог сравнивается целыми числами:
 * ровно тридцать процентов не должны зависеть от двоичного представления `0.3`.
 * Побеждённое существо не пьёт — у него уже нет хода.
 */
export function npcNeedsHealingPotion(enemy) {
  const hp = Math.max(0, integer(enemy?.hp, 0))
  const maximum = Math.max(1, integer(enemy?.maxHp ?? enemy?.max_hp, 1))
  return hp > 0 && hp * 100 <= maximum * NPC_HEALING_POTION_HP_PERCENT
}
