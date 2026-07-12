import type { InventoryItem, Player } from './types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function findValue(root: unknown, candidates: string[]): unknown {
  const wanted = new Set(candidates.map((item) => item.toLowerCase()))
  const queue: unknown[] = [root]
  let visited = 0
  while (queue.length && visited < 900) {
    const current = queue.shift()
    visited += 1
    if (Array.isArray(current)) queue.push(...current.slice(0, 100))
    if (!isRecord(current)) continue
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && value !== '' && value !== null && value !== undefined) return value
      if (typeof value === 'object' && value) queue.push(value)
    }
  }
  return undefined
}

function text(value: unknown, fallback: string) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || fallback
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : '').filter(Boolean).join(', ') || fallback
  return fallback
}

function number(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function importedInventory(value: unknown): InventoryItem[] | undefined {
  const lines = Array.isArray(value)
    ? value.map((item) => isRecord(item) ? text(item.name ?? item.title, '') : text(item, '')).filter(Boolean)
    : typeof value === 'string' ? value.split(/\n|;/).map((item) => item.trim()).filter(Boolean) : []
  if (!lines.length) return undefined
  return lines.slice(0, 80).map((name, index) => ({
    id: `imported-${Date.now()}-${index}`,
    name,
    type: 'other',
    quantity: 1,
    weight: 0,
    equipped: false,
    rarity: 'обычный',
    description: 'Предмет импортирован из листа персонажа Long Story Short. Описание можно дополнить вручную.',
    properties: 'Свойства не указаны.',
    image: '',
    imageStatus: 'queued',
  }))
}

export function importCharacterJson(raw: string, current: Player): Partial<Player> {
  if (raw.length > 2_000_000) throw new Error('Файл слишком большой. Максимум — 2 МБ.')
  const source = JSON.parse(raw) as unknown

  if (isRecord(source) && source.character === current.character && isRecord(source.abilities)) {
    return source as Partial<Player>
  }

  const abilitiesObject = findValue(source, ['abilities', 'abilityScores', 'stats'])
  const ability = (short: keyof Player['abilities'], long: string) => {
    if (isRecord(abilitiesObject)) return number(abilitiesObject[short] ?? abilitiesObject[long] ?? abilitiesObject[long.toUpperCase()], current.abilities[short])
    return number(findValue(source, [short, long, long.toUpperCase(), `${short}Score`, `${long}Score`]), current.abilities[short])
  }
  const inventory = importedInventory(findValue(source, ['inventory', 'equipment', 'gear', 'equipmentList']))

  return {
    character: text(findValue(source, ['characterName', 'character_name', 'charName', 'name']), current.character),
    name: text(findValue(source, ['playerName', 'player_name']), current.name),
    role: text(findValue(source, ['classAndLevel', 'classLevel', 'charClass', 'class', 'classes']), current.role),
    species: text(findValue(source, ['race', 'species', 'ancestry']), current.species),
    background: text(findValue(source, ['background', 'origin']), current.background),
    alignment: text(findValue(source, ['alignment']), current.alignment),
    level: number(findValue(source, ['level', 'characterLevel', 'lvl']), current.level),
    experience: number(findValue(source, ['experience', 'experiencePoints', 'xp']), current.experience),
    hp: number(findValue(source, ['currentHp', 'currentHP', 'hpCurrent', 'hitPointsCurrent']), current.hp),
    maxHp: number(findValue(source, ['maxHp', 'maximumHp', 'hpMax', 'hitPointsMax']), current.maxHp),
    armor: number(findValue(source, ['armorClass', 'ac', 'armor']), current.armor),
    speed: number(findValue(source, ['speed', 'walkingSpeed']), current.speed),
    proficiency: number(findValue(source, ['proficiencyBonus', 'proficiency']), current.proficiency),
    abilities: {
      str: ability('str', 'strength'), dex: ability('dex', 'dexterity'), con: ability('con', 'constitution'),
      int: ability('int', 'intelligence'), wis: ability('wis', 'wisdom'), cha: ability('cha', 'charisma'),
    },
    traits: text(findValue(source, ['personalityTraits', 'traits']), current.traits),
    ideals: text(findValue(source, ['ideals']), current.ideals),
    bonds: text(findValue(source, ['bonds']), current.bonds),
    flaws: text(findValue(source, ['flaws']), current.flaws),
    backstory: text(findValue(source, ['backstory', 'characterHistory', 'history']), current.backstory),
    features: text(findValue(source, ['features', 'featuresAndTraits', 'abilitiesAndFeatures']), current.features),
    notes: text(findValue(source, ['notes', 'additionalNotes']), current.notes),
    ...(inventory ? { inventory } : {}),
  }
}
