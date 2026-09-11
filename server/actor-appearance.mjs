const PROFILES = Object.freeze(['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast'])
const EQUIPMENT = Object.freeze(['unknown', 'unarmed', 'sword', 'sword-shield', 'bow', 'staff', 'dagger'])
const HIDDEN_VISIBILITIES = new Set(['gm_only', 'npc_private'])
const PUBLIC_VISIBILITIES = new Set(['public', 'party'])
const VISIBILITY_KEYS = Object.freeze(['visibility', 'visibility_level', 'visibilityLevel'])
const PRIVATE_FLAGS = Object.freeze(['hidden', 'private', 'gm_only', 'npc_private', 'secret', 'unrevealed', 'private_notes', 'gm_notes'])

/**
 * Оформление намеренно выводится из небольшого публичного словаря. Модулю
 * никогда не нужны стат-блок существа или инвентарь NPC.
 */
export const ACTOR_APPEARANCE_SCHEMA_VERSION = 1
export const ACTOR_APPEARANCE_PROFILES = PROFILES
export const ACTOR_APPEARANCE_EQUIPMENT = EQUIPMENT

function text(value, maximum = 240) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maximum).toLocaleLowerCase('ru-RU')
}

export function publicAppearanceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const declared = VISIBILITY_KEYS
    .filter((key) => value[key] != null)
    .map((key) => text(value[key], 40))
  return declared.every((visibility) => PUBLIC_VISIBILITIES.has(visibility))
    && !declared.some((visibility) => HIDDEN_VISIBILITIES.has(visibility))
    && !PRIVATE_FLAGS.some((key) => Boolean(value[key]))
}

function itemDescription(item) {
  return text(`${item?.catalog_id ?? item?.catalogId ?? ''} ${item?.name ?? ''}`)
}

function itemIsShield(item) {
  if (!publicAppearanceRecord(item)) return false
  return /(?:^|[:\s_-])shield(?:$|[:\s_-])|щит/iu.test(itemDescription(item))
}

function itemIsWeapon(item) {
  if (!publicAppearanceRecord(item)) return false
  if (text(item.type, 40) === 'weapon') return true
  return /(?:^|[:\s])\b((?:short|long)?sword|scimitar|rapier|dagger|shortbow|longbow|(?:hand|heavy|light)?-?crossbow|quarterstaff)\b/iu.test(itemDescription(item))
}

function equipmentForItem(item) {
  if (!publicAppearanceRecord(item)) return 'unknown'
  const description = itemDescription(item)
  if (!description) return 'unknown'
  if (/\b(?:shortbow|longbow|bow)\b|(?:^|\s)(?:короткий|длинный)?\s*лук(?:$|\s)/iu.test(description)) return 'bow'
  if (/quarterstaff|посох/iu.test(description)) return 'staff'
  if (/dagger|кинжал/iu.test(description)) return 'dagger'
  if (/shortsword|longsword|sword|scimitar|rapier|меч|сабл|рапир|скимитар/iu.test(description)) return 'sword'
  return 'unknown'
}

/**
 * @param {unknown} items
 * @returns {boolean}
 */
function publicShieldIn(items) {
  return (Array.isArray(items) ? items : []).some((item) => item?.equipped === true && itemIsShield(item))
}

/**
 * Классифицирует снимок снаряжения по публичным записям вещей.
 *
 * @param {unknown} items
 * @returns {'unknown'|'unarmed'|'sword'|'sword-shield'|'bow'|'staff'|'dagger'}
 */
export function equipmentForPublicItems(items) {
  const worn = (Array.isArray(items) ? items : []).filter((item) => publicAppearanceRecord(item) && item?.equipped === true)
  const weapons = worn.filter(itemIsWeapon)
  if (weapons.length === 0) return 'unarmed'
  if (weapons.length !== 1) return 'unknown'
  const equipment = equipmentForItem(weapons[0])
  return equipment === 'sword' && publicShieldIn(worn) ? 'sword-shield' : equipment
}

/**
 * @param {unknown} value
 * @returns {{version: 1, equipment: string}|undefined}
 */
export function normalizeAttackVisual(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !EQUIPMENT.includes(String(value.equipment))) return undefined
  return { version: 1, equipment: String(value.equipment) }
}

/**
 * Снимок события строится из авторитетной вещи или публичного текста действия
 * NPC. Закрытая привязка оружия NPC этим API намеренно не принимается.
 *
 * @param {{item?: object|null, items?: unknown, attackKind?: unknown, itemName?: unknown, actionName?: unknown, unarmed?: boolean}} [input]
 * @returns {{version: 1, equipment: string}}
 */
export function attackVisualFor(input = {}) {
  const item = input.item && typeof input.item === 'object' && !Array.isArray(input.item) ? input.item : null
  let equipment = item
    ? equipmentForItem(item)
    : input.unarmed === true
      ? 'unarmed'
      : equipmentForAction(input.actionName ?? input.itemName, input.attackKind)
  if (item && equipment === 'sword' && publicShieldIn(input.items)) equipment = 'sword-shield'
  return { version: ACTOR_APPEARANCE_SCHEMA_VERSION, equipment }
}

function equipmentForAction(actionName, attackKind) {
  const action = text(actionName)
  const kind = String(attackKind ?? '')
  const knownKind = ['melee', 'ranged', 'thrown'].includes(kind)
  if (/безоруж|unarmed|fist|кулак/iu.test(action)) return !knownKind || kind === 'melee' ? 'unarmed' : 'unknown'
  if (/\b(?:shortbow|longbow|bow)\b|(?:^|\s)(?:короткий|длинный)?\s*лук(?:$|\s)/iu.test(action)) return !knownKind || kind === 'ranged' ? 'bow' : 'unknown'
  if (/quarterstaff|staff|посох/iu.test(action)) return !knownKind || kind === 'melee' ? 'staff' : 'unknown'
  if (/dagger|кинжал/iu.test(action)) return !knownKind || kind !== 'ranged' ? 'dagger' : 'unknown'
  if (/shortsword|longsword|sword|scimitar|rapier|меч|сабл|рапир|скимитар/iu.test(action)) {
    if (knownKind && kind !== 'melee') return 'unknown'
    return /щит|shield/iu.test(action) ? 'sword-shield' : 'sword'
  }
  // Одного вида атаки недостаточно для определения оружия: ranged может быть
  // заклинанием или действием с закрытой привязкой метательного оружия.
  return 'unknown'
}

function looksMaskedIdentity(actor) {
  if (actor?.masked === true || actor?.is_masked === true || actor?.identity_masked === true
    || actor?.identityMasked === true || actor?.masked_identity === true
    || actor?.identified === false || actor?.identity_known === false) return true
  const name = text(actor?.name, 160)
  return !name || /^(?:\?+|unknown|неизвестн|неопознан|безымянн|скрыт|маскир|masked|тайн(?:ый|ое|ая)|враг|существо|creature|enemy)(?:\s|$)/iu.test(name)
}

/**
 * Выводит грубый профиль из публичных полей личности/класса. `creature_type`
 * намеренно отсутствует: замаскированное имя нельзя восстановить по нему.
 *
 * @param {{kind?: unknown, name?: unknown, role?: unknown, characterClass?: unknown, character_class?: unknown, class_id?: unknown, masked?: boolean, is_masked?: boolean, identity_masked?: boolean, identityMasked?: boolean, masked_identity?: boolean, identified?: boolean, identity_known?: boolean}} [actor]
 * @returns {'warrior'|'mage'|'rogue'|'goblin'|'skeleton'|'beast'}
 */
export function actorProfileFor(actor = {}) {
  const kind = text(actor.kind, 30)
  const identity = kind === 'hero'
    ? text(actor.characterClass ?? actor.character_class ?? actor.class_id ?? actor.role, 160)
    : text(actor.role ?? actor.name, 160)
  if (kind !== 'hero' && looksMaskedIdentity(actor)) return kind === 'summon' ? 'beast' : 'warrior'
  if (/goblin|гоблин/iu.test(identity)) return 'goblin'
  if (/skeleton|скелет|undead|нежить|зомби/iu.test(identity)) return 'skeleton'
  if (/beast|звер|wolf|волк|bear|медвед|boar|кабан/iu.test(identity)) return 'beast'
  if (/wizard|mage|sorcer|warlock|cleric|druid|волшеб|маг|чарод|колдун|жрец|друид/iu.test(identity)) return 'mage'
  if (/rogue|ranger|scout|плут|следопыт|разведчик/iu.test(identity)) return 'rogue'
  return kind === 'summon' ? 'beast' : 'warrior'
}

/**
 * @param {unknown} kind
 * @param {unknown} actor
 * @returns {{version: 1, profile: string, equipment: string}}
 */
export function actorAppearanceFor(kind, actor = {}) {
  const source = actor && typeof actor === 'object' && !Array.isArray(actor) ? actor : {}
  const appearanceKind = text(kind, 30)
  const profile = actorProfileFor({
    kind: appearanceKind,
    name: source.name,
    role: source.role,
    characterClass: source.characterClass,
    character_class: source.character_class,
    class_id: source.class_id,
    masked: source.masked,
    is_masked: source.is_masked,
    identity_masked: source.identity_masked,
    identityMasked: source.identityMasked,
    masked_identity: source.masked_identity,
    identified: source.identified,
    identity_known: source.identity_known,
  })
  const equipment = appearanceKind === 'hero' ? equipmentForPublicItems(source.inventory) : 'unknown'
  return { version: ACTOR_APPEARANCE_SCHEMA_VERSION, profile, equipment }
}
