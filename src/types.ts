export type Speaker = 'narrator' | 'player' | 'system'

export type Message = {
  id: string
  speaker: Speaker
  author: string
  text: string
  timestamp: string
  roll?: { roll_id?: string; value: number; modifier: number; total: number; difficulty?: number; label: string; success: boolean; ability?: string | null; actor_id?: string }
  /** Ставки хода: что проверялось, против какой СЛ и чем грозил провал. */
  stakes?: { skill?: string; ability?: string; difficulty?: number; difficulty_category?: string; on_failure?: string }
  turnConsumed?: boolean
}

export type RollResult = NonNullable<Message['roll']>

/**
 * A free d20 roll made from the game table. It intentionally lives outside
 * Message.roll: free rolls have no difficulty and therefore no success or
 * failure state.
 */
export type DiceRollEvent = {
  id: string
  kind: 'free' | 'party'
  /* Свободный бросок теперь любой обычной костью, а не только d20. Набор
     закрыт на сервере (`PUBLIC_DIE_SIDES`), клиент выбирает из него. */
  sides: 4 | 6 | 8 | 10 | 12 | 20 | 100
  value: number
  playerId: string
  playerName: string
  rolledAt: number
}

export type PendingCheck = {
  check_id?: string
  label: string
  modifier: number
  difficulty: number
  sides: 20
  ability?: string | null
  action: string
  playerId: string
  status: 'ready' | 'rolling' | 'resolving'
  result?: RollResult
}

export type AgentInteractionOption = {
  id: string
  label: string
  description?: string
}

export type PartyDecisionPolicy = {
  schemaVersion: number
  policyVersion: string
  voterScope: 'account' | 'hero'
  decisionTtlMs: number
  quorumMode: 'majority_of_active_voters'
  disconnectAction: 'abstain'
  expiryResolution: 'plurality_first_option'
  visibility: 'party'
}

export type AgentInteraction = {
  id: string
  type: 'vote' | 'roll' | 'choice'
  title: string
  description: string
  options: AgentInteractionOption[]
  votes: Record<string, string>
  status: 'open' | 'resolved'
  resolvedOptionId?: string
  eligibleActorIds?: string[]
  eligibleVoterIds?: string[]
  voterByActorId?: Record<string, string>
  activeVoterIds?: string[]
  abstainedVoterIds?: string[]
  abstentions?: Record<string, string>
  requiredVotes?: number
  voterScope?: 'account' | 'hero'
  policy?: PartyDecisionPolicy
  policyVersion?: string
  difficulty?: number
  roll?: DiceRollEvent
  resolutionPrompt: string
  createdAt: number
  expiresAt?: number
  resolutionReason?: string
}

export type Player = {
  id: string
  name: string
  character: string
  role: string
  characterClass?: DndClassKey
  subclass?: string
  selectedFeatureIds?: string[]
  classSkillProficiencies?: string[]
  knownSpellIds?: string[]
  preparedSpellIds?: string[]
  hitPointIncreases?: number[]
  characterSetupRequired?: boolean
  abilityGeneration?: CharacterAbilityGeneration
  characterSheet?: {
    schema_version: number
    level: number
    experience: number
    experience_for_next_level: number | null
    proficiency_bonus: number
    passive_perception: number
    armor_class: { value: number }
    speed: { value: number }
    hit_points: { value: number; hitDie: number }
  } | null
  color: string
  initials: string
  portrait: string
  portraitPosition: string
  level: number
  species: string
  background: string
  alignment: string
  experience: number
  speed: number
  proficiency: number
  abilities: AbilityScores
  traits: string
  ideals: string
  bonds: string
  flaws: string
  backstory: string
  features: string
  notes: string
  currency: Currency
  inventory: InventoryItem[]
  inventoryLoad?: {
    weight: number
    capacity: number
    encumbered: boolean
    remaining: number
    attuned: number
    attunement_limit: number
  }
  combatSpells?: CombatSpell[]
  combatActions?: CombatAction[]
  hp: number
  maxHp: number
  armor: number
  online: boolean
  x: number
  y: number
}

export type AbilityScores = {
  str: number
  dex: number
  con: number
  int: number
  wis: number
  cha: number
}

export type Currency = {
  copper: number
  silver: number
  gold: number
  platinum: number
}

export type MechanicsSupport = 'verified' | 'partial' | 'heuristic' | 'ruling-only'

export type CombatSpell = {
  id: string
  name: string
  englishName?: string
  kind: 'attack' | 'save' | 'area-save' | 'damage' | 'area-damage' | 'healing' | 'summon' | 'buff' | 'debuff' | 'utility' | 'teleport'
  attackKind?: 'melee' | 'ranged'
  level: number
  target: 'enemy' | 'ally' | 'self' | 'point' | 'creature'
  range: number
  actionType: 'action' | 'bonus_action' | 'reaction' | 'long_cast'
  slotResource?: string
  spellcastingAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  concentration?: boolean
  description?: string
  damage?: string | null
  damageType?: string
  damageTypes?: string[]
  halfOnSave?: boolean
  healing?: string
  addAbilityModifier?: boolean
  saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  conditions?: string[]
  radius?: number
  areaShape?: 'sphere' | 'cone' | 'line' | 'cube' | 'cylinder'
  duration?: string
  durationRounds?: number
  castingTime?: string
  rangeText?: string
  ritual?: boolean
  prepared?: boolean
  sourceUrl?: string
  mechanicsAccuracy?: 'verified-dndsu' | 'heuristic'
  mechanicsSupport?: MechanicsSupport
  supportNote?: string
  requiresWeaponAttack?: boolean
  weaponCantrip?: 'booming-blade' | 'green-flame-blade'
  beamScaling?: boolean
  damageIfTargetWounded?: string
  automaticHit?: boolean
  projectileCount?: number
  upcastProjectilesPerLevel?: number
  maxTargets?: number
  upcastTargetsPerLevel?: number
  armorClassBonus?: number
  armorClassBase?: number
  armorClassAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  temporaryHp?: number
  temporaryHpPerSlotLevel?: number
  temporaryHpDice?: string
  temporaryHpPerUpcastLevel?: number
  temporaryHpAbilityModifier?: boolean
  grantsDashOnCast?: boolean
  meleeRetaliationDamage?: number
  meleeRetaliationDamagePerSlotLevel?: number
  hitPointPoolDice?: string
  hitPointPoolUpcastDice?: string
  areaOrigin?: 'self' | 'point'
  createsAreaEffect?: {
    difficultTerrain?: boolean
    triggerOnEnter?: boolean
    triggerOnTurnEnd?: boolean
    saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
    condition?: string
    permanent?: boolean
  }
  upcastHealingDicePerLevel?: number
  upcastDicePerLevel?: number
  pushFeet?: number
  reactionMoveAway?: boolean
  deafenedAutoSave?: boolean
  repeatSaveAtTurnEnd?: boolean
  repeatSaveOnDamage?: boolean
  damageRepeatSaveAdvantage?: boolean
  immuneCreatureTypes?: string[]
  requiredCreatureTypes?: string[]
  minimumIntelligence?: number
  saveAdvantageIfHostile?: boolean
  breakOnDamageFromSourceAllies?: boolean
  requiresLanguage?: boolean
  spellOptions?: string[]
  onHitSaveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  onHitConditions?: string[]
  onHitConditionDuration?: string
  secondaryBurst?: {
    radius: number
    damage: string
    damageType: string
    saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
    halfOnSave?: boolean
    upcastDicePerLevel?: number
  }
  nextWeaponHit?: {
    meleeOnly?: boolean
    rangedOnly?: boolean
    advantage?: boolean
    damage?: string
    damageType?: string
    upcastDicePerLevel?: number
    saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
    saveAdvantageForLarge?: boolean
    conditions?: string[]
    pushFeet?: number
    proneOnFailedSave?: boolean
    burst?: {
      radius: number
      damage: string
      damageType: string
      saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
      halfOnSave?: boolean
      upcastDicePerLevel?: number
      maximumDice?: number
    }
    speedBonus?: number
    endConcentrationOnHit?: boolean
  }
  weaponHitBonusDamage?: string
  hitBonusDamage?: string
  summon?: {
    name: string
    hp: number
    armor: number
    speed: number
    attackName: string
    damage: string
    damageType: string
    range: number
  }
  /** Compatibility aliases accepted from older room projections. */
  slotLevel?: number
  saveDc?: number
  summonName?: string
  targetType?: 'attack' | 'save' | 'healing' | 'summon' | 'enemy' | 'ally' | 'cell'
  rangeFeet?: number
  range_feet?: number
  slot_level?: number
  action_type?: 'action' | 'bonus_action' | 'reaction'
}

export type InventoryItem = {
  id: string
  catalog_id?: string
  base_price_cp?: number
  sellable?: boolean
  quest_item?: boolean
  name: string
  type: 'weapon' | 'armor' | 'consumable' | 'tool' | 'quest' | 'treasure' | 'document' | 'other'
  quantity: number
  weight: number
  equipped: boolean
  requires_attunement?: boolean
  attuned_to?: string | null
  rarity: 'обычный' | 'необычный' | 'редкий' | 'очень редкий' | 'легендарный' | 'сюжетный'
  description: string
  properties: string
  image: string
  imagePosition?: string
  imagePrompt?: string
  imageStatus?: 'ready' | 'queued' | 'generating' | 'failed'
  charges?: { current: number; max: number }
  capabilities?: {
    equippable: boolean
    equip_slot: string | null
    usable: boolean
    use: {
      kind: string
      action_type: 'action' | 'bonus_action' | null
      target: 'self' | 'party'
      range_feet: number
      charges_per_use?: number
    } | null
    charges: { current: number; max: number } | null
    requires_attunement: boolean
  }
  combat?: {
    kind: 'melee' | 'ranged' | 'thrown-area'
    ability?: 'str' | 'dex'
    damage: string
    damageType: string
    normalRange: number
    longRange?: number
    radius?: number
    saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
    saveDc?: number
    halfOnSave?: boolean
    twoHanded?: boolean
    ammunition?: boolean
  }
}

export type MerchantPricingPolicy = {
  mode: 'catalog' | 'catalog_with_agent_adjustment'
  catalog_id: string
  buy_markup_percent?: number
  sell_rate_percent?: number
  agent_adjustment_limit_percent?: number
  description?: string
}

export type MerchantStockItem = {
  stock_id: string
  catalog_id: string
  name: string
  type: InventoryItem['type']
  quantity: number
  base_price_cp: number
  weight?: number
  rarity?: InventoryItem['rarity']
  description?: string
  properties?: string
  image?: string
  imagePosition?: string
}

export type MerchantService = {
  service_id: string
  name: string
  description?: string
  kind: 'appraisal' | 'lodging' | 'repair' | 'transport' | 'training' | 'other'
  base_price_cp: number
  duration_minutes: number
  available: boolean
  requires_presence: boolean
  tags?: string[]
}

export type Merchant = {
  id: string
  name: string
  title?: string
  description?: string
  greeting?: string
  voice?: string
  initials?: string
  portrait?: string
  location: string
  location_id?: string
  available: boolean
  purse_cp?: number
  stock: MerchantStockItem[]
  services?: MerchantService[]
  restock?: { enabled: boolean; interval_minutes: number; last_restock_world_minute: number | null }
  pricing: MerchantPricingPolicy
}

export type EncounterDifficulty = 'easy' | 'medium' | 'hard'
export type EncounterTheme = 'generic' | 'undead' | 'beasts' | 'goblinoids' | 'raiders'

export type EncounterProposalEnemy = {
  id: string
  name: string
  stat_block_id?: string
  hp?: number
  maxHp?: number
  armor?: number
  speed?: number
  attackBonus?: number
  damageDice?: string | number
  damageBonus?: number
  initiativeBonus?: number
  x?: number
  y?: number
  alive?: boolean
  image?: string
  source_url?: string
  creature_type?: string
  traits?: MonsterTrait[]
  action_profiles?: MonsterActionProfile[]
}

/** Server-authored encounter plan committed together with authoritative combat state. */
export type EncounterProposal = {
  proposal_id?: string
  proposal_version?: number
  version?: string
  source?: string | Record<string, unknown>
  difficulty?: EncounterDifficulty
  theme?: EncounterTheme
  xp_budget?: number
  xp_spent?: number
  threat?: { budget_xp?: number; spent_xp?: number; unspent_xp?: number; utilization_bps?: number; quantity?: number; quantity_cap?: number }
  enemies?: EncounterProposalEnemy[]
}

export type MerchantQuoteBreakdown = {
  catalog_base_unit_cp: number
  merchant_adjustment_percent?: number
  merchant_adjustment_cp?: number
  bargain_adjustment_percent?: number
  bargain_adjustment_cp?: number
  /** Поправка за славу отряда у фракций торговца; 0 — фракций нет или отряд им безразличен. */
  reputation_adjustment_percent?: number
  final_unit_price_cp: number
}

export type MerchantQuote = {
  quote_id?: string
  direction: 'buy' | 'sell'
  actor_id?: string
  stock_id?: string
  item_id?: string
  quantity: number
  unit_price_cp: number
  total_price_cp: number
  breakdown?: MerchantQuoteBreakdown
  can_afford?: boolean
  can_sell?: boolean
  appraisal_required?: boolean
  can_appraise?: boolean
  price_provenance?: 'catalog' | 'server_appraisal_policy'
  reason?: string
  available_quantity?: number
  max_quantity?: number
  expires_at?: string
  state_version?: number
  expected_state_version?: number
}

export type MerchantBargainResult = {
  attempted: boolean
  success: boolean
  discount_percent?: number
  modifier_percent?: number
  message?: string
}

export type MerchantServiceQuote = {
  quote_id?: string
  direction: 'service'
  actor_id: string
  merchant_id: string
  service_id: string
  service: MerchantService
  price_cp: number
  can_afford: boolean
  available: boolean
  /** Почему услуга недоступна — например, отряд с дурной славой. */
  unavailable_reason?: string
  state_version: number
  expected_state_version: number
}

export type MerchantView = {
  merchant: Merchant
  actor_id: string
  balance?: Currency
  balance_cp?: number
  merchant_purse_cp: number
  buy_quotes: MerchantQuote[]
  sell_quotes: MerchantQuote[]
  service_quotes?: MerchantServiceQuote[]
  bargain?: MerchantBargainResult | null
  pricing_explanation?: string
  state_version: number
  expected_state_version: number
}

export type EconomyLogEntry = {
  id: string
  type: 'bargain' | 'purchase' | 'sale' | 'service' | 'appraisal' | 'merchant-created' | 'merchant-configured' | 'merchant-restocked' | 'merchant-economy-clock' | 'merchant-moved' | 'merchant-availability'
  actorId?: string
  merchantId?: string
  stockId?: string
  catalogId?: string | null
  itemId?: string | null
  itemName?: string | null
  quantity?: number
  unitPriceCp?: number
  totalPriceCp?: number
  baseUnitPriceCp?: number
  success?: boolean
  rollTotal?: number
  difficulty?: number
  pricingAdjustmentBps?: number
  priceProvenance?: 'catalog' | 'custom' | 'server_appraisal_policy'
  policyId?: string
  location?: string
  locationBefore?: string
  locationAfter?: string
  stockPositions?: number
  stockIds?: string[]
  totalQuantityAdded?: number
  changedFields?: string[]
  resetBargains?: boolean
  availableBefore?: boolean
  availableAfter?: boolean
  requestFingerprint?: string | null
}

export type MapCell = {
  x: number
  y: number
  type: 'wall' | 'floor' | 'water' | 'door'
  revealed: boolean
  feature?: 'chest' | 'altar' | 'torch' | 'rune' | 'stairs' | 'enemy'
    | 'table' | 'chair' | 'bed' | 'bookshelf' | 'fireplace' | 'barrel' | 'crate'
    | 'tree' | 'bush' | 'rock' | 'mushroom' | 'bones' | 'grave' | 'pillar'
    | 'statue' | 'campfire' | 'wagon' | 'well' | 'console'
  material?: 'stone' | 'wood' | 'earth' | 'grass' | 'sand' | 'metal' | 'marble' | 'ice'
  variant?: number
  pattern?: 'small-room' | 'great-hall' | 'keep' | 'courtyard' | 'crypt' | 'cave-cluster' | 'village' | 'bridge' | 'natural'
  edge_mask?: string
}

/* --- Тактическая карта -----------------------------------------------------
 * Зеркало серверного контракта `server/tactical-map.mjs`: клетки хранятся
 * типизированными слоями, стены живут на рёбрах, предметы отвязаны от клетки
 * (`docs/tactical-map-plan.md`, разделы 4 и 5). Порядок значений в
 * перечислениях — часть формата хранения: код равен индексу.
 */

export type TacticalSurface = 'none' | 'water' | 'ice' | 'oil' | 'mud' | 'rubble'
export type TacticalMaterial = 'stone' | 'wood' | 'earth' | 'grass' | 'sand' | 'marble' | 'metal' | 'ice'
export type TacticalEdgeKind = 'none' | 'wall' | 'door' | 'window' | 'rail' | 'ledge' | 'loophole' | 'grate'
export type TacticalCover = 'none' | 'half' | 'three_quarters'
export type TacticalDoorState = 'open' | 'closed' | 'locked' | 'broken'
export type TacticalZoneKind = 'interior' | 'exterior'
export type TacticalFloorDirection = 'horizontal' | 'vertical'
export type TacticalSpawnRole = 'party' | 'enemy' | 'neutral'
/** Ребро смотрит только на восток или на юг: канонизация даёт ему один ключ. */
export type TacticalEdgeDirection = 'e' | 's'

/** Логическое представление клетки: остальной код о слоях не знает. */
export type TacticalCell = {
  x: number
  y: number
  /** Можно ли войти. */
  passable: boolean
  /** 1 или 2; 2 — труднопроходимая местность. */
  moveCost: number
  surface: TacticalSurface
  hazardId: string | null
  material: TacticalMaterial
  /** Шаг 5 футов, знаковое. */
  elevation: number
  /** Идентификатор зоны, пустая строка — зоны нет. */
  zone: string
  variant: number
  revealed: boolean
}

export type TacticalEdge = {
  /** Клетка-владелец ребра: та, у которой меньше индекс. */
  x: number
  y: number
  dir: TacticalEdgeDirection
  kind: TacticalEdgeKind
  blocksMove: boolean
  blocksSight: boolean
  cover: TacticalCover
  doorId: string | null
}

export type TacticalDoor = {
  id: string
  x: number
  y: number
  dir: TacticalEdgeDirection
  /** Начальное состояние; дальнейшее живёт в состоянии сцены. */
  state: TacticalDoorState
  lockDc: number
  keyItemId: string | null
}

export type SceneObjectIntent = 'inspect' | 'open' | 'take' | 'use'

export type TacticalProp = {
  id: string
  assetId: string
  /** Дробная координата в клетках. */
  x: number
  y: number
  rotation: number
  scale: number
  /** Занимаемые клетки; отделён от визуального размера, может быть пустым. */
  footprint: Array<{ x: number; y: number }>
  zOrder: number
  blocksMove: boolean
  blocksSight: boolean
  cover: TacticalCover
  destructible: boolean
  hp: number
  interactive: boolean
  state: string
  /** Разрешённая игроку часть серверного контракта взаимодействия. */
  interaction?: {
    kind: string
    verbs: SceneObjectIntent[]
    pointOfInterest: boolean
  }
  /** Переходные поля старой проекции; новых глаголов клиент из них не сочиняет. */
  interactionKind?: string
  interactionVerbs?: SceneObjectIntent[]
}

export type TacticalZone = {
  id: string
  kind: TacticalZoneKind
  material: TacticalMaterial
  lightLevel: string
  /** Направление непрерывного рисунка настила внутри зоны. */
  floorDirection: TacticalFloorDirection
  label: string
}

export type TacticalSpawnPoint = { id: string; x: number; y: number; role: TacticalSpawnRole }

export type TacticalBounds = { minX: number; minY: number; maxX: number; maxY: number }

/** Плотная сетка: индекс клетки `i = y * width + x`. */
export type TacticalLayers = {
  /** Битсет: клетка существует. */
  present: Uint8Array
  passable: Uint8Array
  revealed: Uint8Array
  moveCost: Uint8Array
  surface: Uint8Array
  material: Uint8Array
  variant: Uint8Array
  elevation: Int8Array
  /** Индекс в zones[] со сдвигом на единицу; 0 — зоны нет. */
  zoneId: Uint8Array
}

export type TacticalMap = {
  version: string
  locationId: string
  seed: string
  generator: { id: string; version: string }
  width: number
  height: number
  bounds: TacticalBounds
  layers: TacticalLayers
  /** Индекс клетки → hazardId. */
  hazards: Record<string, string>
  /** Только непустые рёбра, ключ вида `x,y,dir`. */
  edges: Record<string, TacticalEdge>
  doors: TacticalDoor[]
  props: TacticalProp[]
  zones: TacticalZone[]
  spawnPoints: TacticalSpawnPoint[]
  combatBounds: TacticalBounds | null
  theme: string
  tilesetId: string
  overlays: { compass: boolean; scaleBar: boolean; roomLabels: Array<{ zoneId: string; label: string }> }
  sizeClass: string
  /**
   * Клиентская производная, которой нет в серверном контракте: отпечаток
   * местности без слоя `revealed`. Служит ключом кэша тайлов — раскрытие
   * учитывается отдельно, потайлово.
   */
  terrainHash: string
}

/**
 * Сериализованная карта из проекции сервера: слои сжаты в base64 либо в одно
 * число, рёбра упакованы. Разбирается `decodeTacticalMap`.
 */
export type SerializedTacticalMap = Record<string, unknown>

/**
 * Дельта раскрытия из `server/reveal-delta.mjs`: интервалы индексов `[начало,
 * длина]`, а не список координат. `baseHash` называет карту, к которой дельта
 * применима, — наложить её на другую нельзя.
 */
export type SerializedRevealDelta = {
  version?: string
  baseHash?: string
  width?: number
  revealed?: Array<[number, number]>
  hidden?: Array<[number, number]>
  /**
   * Значения слоёв затронутых клеток: одно число на однородный слой, иначе
   * base64 по байту на клетку. Проекция обезличивает нераскрытую клетку,
   * поэтому без них собранная из дельты карта расходилась бы с проекцией.
   * Порядок клеток — сначала интервалы `revealed`, затем `hidden`.
   */
  values?: {
    material?: string | number
    variant?: string | number
    surface?: string | number
  }
}

export type DndClassKey = 'barbarian' | 'bard' | 'cleric' | 'druid' | 'fighter' | 'monk' | 'paladin' | 'ranger' | 'rogue' | 'sorcerer' | 'warlock' | 'wizard'

export type CombatAction = {
  id: string
  name: string
  category: 'common' | 'class'
  target: 'self' | 'ally' | 'enemy' | 'creature'
  actionType: 'action' | 'bonus_action' | 'reaction' | 'free'
  range: number
  description: string
  resource?: string
  cost?: number
  requiresWeapon?: boolean
  concentration?: boolean
  minimumLevel?: number
  sourceUrl?: string
  mechanicsSupport?: MechanicsSupport
  supportNote?: string
  effect?: Record<string, unknown>
}

export type Enemy = {
  id: string
  name: string
  /** Exact combat statistics are present only when server-side knowledge reveals them. */
  hp?: number
  maxHp?: number
  armor?: number
  speed?: number
  attackBonus?: number
  damageDice?: number
  damageBonus?: number
  healthStatus?: 'unharmed' | 'wounded' | 'bloodied' | 'critical' | 'defeated'
  healthKnown?: 'banded' | 'exact'
  initiativeBonus?: number
  stat_block_id?: string
  creature_type?: string
  image?: string
  source_url?: string
  traits?: MonsterTrait[]
  action_profiles?: MonsterActionProfile[]
  attack_profile?: MonsterActionProfile
  x: number
  y: number
  alive: boolean
}

export type SummonedCreature = {
  id: string
  name: string
  kind?: 'summon'
  ownerId: string
  controllerId: string
  faction: 'party'
  hp: number
  maxHp: number
  armor: number
  speed: number
  x: number
  y: number
  alive: boolean
  sourceSpellId: string
  sourceEffectId?: string
  turnRule?: 'after-owner' | 'shared' | 'own-initiative'
  attack_profile: {
    name?: string
    kind?: 'melee' | 'ranged'
    range_feet?: number
    normal_range_feet?: number
    attack_modifier?: number
    damage_expression?: string
    damage_type?: string
  }
}

export type TacticalTurn = {
  sceneTurn: number
  actorId: string
  movementSpent: number
  actionUsed: boolean
}

export type MapFeedback = {
  id: string
  x: number
  y: number
  text: string
  kind: 'damage' | 'miss' | 'move' | 'defeat'
}

export type BattleEvent = {
  id: string
  sceneTurn?: number
  round?: number
  type: 'move' | 'attack' | 'area-attack' | 'equipment' | 'spell' | 'spell-save' | 'spell-damage' | 'healing' | 'action' | 'reaction' | 'summon' | 'summon-end' | 'turn-end' | 'combat-start' | 'combat-end' | 'encounter-created' | 'encounter-ended' | 'death-save' | 'death-save-damage' | 'hero-stabilized' | 'concentration-save' | 'concentration-end' | 'max-hp-reduction' | 'max-hp-reduction-prevented'
  actorId?: string
  actorKind?: 'player' | 'enemy' | 'summon' | 'system'
  targetId?: string
  participantIds?: string[]
  reason?: string
  encounterId?: string
  difficulty?: string
  theme?: string
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  /** Клиент может достроить путь для анимации; старые проекции журнала его не содержат. */
  path?: Array<{ x: number; y: number }>
  distanceFeet?: number
  roll?: { die?: number; modifier?: number; total: number; difficulty?: number; hit: boolean }
  rollMode?: 'normal' | 'advantage' | 'disadvantage'
  rollDice?: number[]
  advantageReasons?: string[]
  disadvantageReasons?: string[]
  /** Почему удар вышел таким. Признаки серверные; журнал боя видит вся партия. */
  packTactics?: boolean
  charge?: boolean
  bloodiedFrenzy?: boolean
  damage?: number
  damageType?: string
  healing?: number
  hpBefore?: number
  hpAfter?: number
  maximumHpBefore?: number
  maximumHpAfter?: number
  successes?: number
  failures?: number
  result?: string
  modifierSources?: string[]
  auraSourceId?: string
  auraBonus?: number
  indomitableBonus?: number
  indomitableOriginalTotal?: number
  critical?: boolean
  itemId?: string
  itemName?: string
  spellId?: string
  spellName?: string
  ability?: string
  automaticSuccess?: boolean
  immunity?: string | null
  actionId?: string
  actionName?: string
  area?: { x: number; y: number; radiusFeet: number }
}

export type Scene = {
  title: string
  location: string
  location_id?: string
  mood: string
  objective: string
  turn: number
  cells: MapCell[]
  /**
   * Каноническая карта сцены. Отсутствует у старой проекции — тогда доска
   * работает по `cells`.
   *
   * Отсутствует и тогда, когда сервер уже знает, что эта карта у клиента есть:
   * вместо неё приходит `map_delta` или `map_unchanged`, а `map_hash` называет
   * карту. Разбирает это `src/scene-map-cache.ts`, и до доски сцена доходит
   * всегда с полем `map`.
   */
  map?: SerializedTacticalMap
  /** Хеш карты, которая ушла игроку, — ключ клиентского кэша. */
  map_hash?: string
  /** Интервалы раскрытия поверх карты `map_delta.baseHash`. */
  map_delta?: SerializedRevealDelta
  /** Карта не менялась: она уже есть у клиента под `map_hash`. */
  map_unchanged?: boolean
  theme?: string
  danger?: 'низкая' | 'средняя' | 'высокая'
  scene_kind?: 'settlement' | 'wilderness' | 'dungeon' | 'road' | 'other'
  settlement_type?: 'village' | 'town' | 'city' | 'outpost' | 'traveling' | null
}

export type AdventureState = {
  chapter: number
  currentHook?: string
  lastTransition?: string
  unresolvedThreads?: string[]
  visitedLocations: string[]
  history: Array<{ chapter: number; title: string; location: string; objective: string; outcome: string }>
}

export type WorldMapRegion = {
  id: string
  name: string
  biome: 'plains' | 'forest' | 'mountains' | 'marsh' | 'desert' | 'tundra' | 'coast' | 'wastes'
  x: number
  y: number
  radius: number
}

export type WorldMapLocation = {
  id: string
  name: string
  kind: 'capital' | 'city' | 'town' | 'village' | 'port' | 'fortress' | 'ruin' | 'dungeon' | 'landmark' | 'wilds'
  x: number
  y: number
  regionId: string
  summary: string
  known: boolean
  visited: boolean
}

export type WorldMapRoute = {
  id: string
  from: string
  to: string
  kind: 'road' | 'trail' | 'river' | 'sea' | 'pass'
  distance: number
  danger: 'низкая' | 'средняя' | 'высокая'
  discovered: boolean
}

export type WorldMapState = {
  version: number
  seed: string
  name: string
  width: number
  height: number
  currentLocationId: string
  regions: WorldMapRegion[]
  locations: WorldMapLocation[]
  routes: WorldMapRoute[]
}

export type SceneTransition = {
  scene: Scene
  adventure: AdventureState
  worldMap?: WorldMapState
  transition: string
  arrival: string
  entrance: { x: number; y: number }
}

export type CampaignConcept = {
  preset?: string
  era: string
  genre: string
  tone: string
  premise: string
  themes: string
  boundaries: string
  magicLevel: string
  technologyLevel: string
  startingLocation: string
  openingSituation: string
  worldSummary?: string
  worldHistory?: string
  generatedBy?: string
  /** Стол заранее объявил, что развязка арки открывает следующую, а не финал. */
  arc_chain?: boolean
  arc?: { arc_number?: number; target_scenes?: number; preset?: string }
  /** Закрытые арки этой кампании: номер, финальная сцена и эпилог. */
  arc_history?: Array<{
    arc_number?: number
    final_chapter?: number
    final_location?: string
    epilogue?: string
    concluded_at?: string | null
  }>
}

export type GameState = {
  sessionCode: string
  campaign: string
  campaignConcept?: CampaignConcept
  worldMap?: WorldMapState
  partyName?: string
  partyMemberIds?: string[]
  partyDecisionPolicy?: PartyDecisionPolicy
  players: Player[]
  presence?: {
    transport: 'sse'
    connected_users: number
    connected_heroes: number
    online_hero_ids: string[]
    typing_actor_ids?: string[]
  }
  /** Серверный дедлайн текущей фазы боя; клиент только отображает его. */
  turn_clock?: {
    actor_ids: string[]
    round: number
    active_index: number
    turn_id: string
    started_at: string
    deadline_at: string
    duration_ms: number
    reaction_window_id?: string
  } | null
  enemies?: Enemy[]
  actors?: SummonedCreature[]
  merchants?: Merchant[]
  tacticalTurn?: TacticalTurn
  mapFeedback?: MapFeedback[]
  /** Deterministic combat facts recorded without invoking the narrator. */
  battleLog?: BattleEvent[]
  /** Bounded committed bargain/purchase/sale facts for replay and agent context. */
  economyLog?: EconomyLogEntry[]
  messages: Message[]
  scene: Scene
  activePlayerId: string
  isNarrating: boolean
  pendingCheck: PendingCheck | null
  agentInteraction?: AgentInteraction | null
  /** Optional so rooms saved before the dice tray was added remain valid. */
  lastDiceRoll?: DiceRollEvent | null
  state_version?: number
  ruleset_id?: string
  ruleset_version?: string
  enabled_rule_packs?: string[]
  enabled_house_rules?: string[]
  ruleset_locked_at?: string | null
  engine_mode?: 'enforce'
  mechanics?: GameMechanics
  /**
   * Серверный прогноз удара для того, кто сейчас ходит. Только чтение: цифры
   * считает Rules Engine тем же кодом, что и сам бросок, клиент их не выводит.
   */
  combatForecast?: {
    actor_id: string
    targets: Record<string, AttackForecast[]>
  }
  rulings?: Array<Record<string, unknown>>
  entities?: Array<Record<string, unknown>>
  adventure?: AdventureState
  worldMemory?: WorldMemoryProjection
  /**
   * Optional viewer-safe contract introduced by server PR #18. Coordinates
   * are authoritative; raw HP, goals and beliefs are deliberately absent.
   */
  scene_npcs?: SceneNpcProjection[]
  /**
   * Уже отфильтрованная сервером социальная проекция. Клиент не читает
   * persistence-профили напрямую и не пытается повторять visibility policy.
   */
  social?: SocialProjection
  autonomy?: {
    schema_version?: number
    pacing?: {
      beat: number
      phase: 'breather' | 'development' | 'escalation' | 'climax'
      tension: number
      last_intent_type?: string
    }
    travel_history?: Array<{
      travel_id: string
      from: string
      to: string
      distance_band: 'near' | 'regional' | 'far'
      duration_minutes: number
      risk_score: number
      random_encounter: boolean
      /** `server-travel-v2`: граф мира или текстовая ветка совместимости. */
      source?: 'graph' | 'legacy_text'
      /** Заполнен только для одного прямого маршрута графа. */
      route_id?: string | null
      /** Известной дороги нет, путь оценён напрямик по координатам. */
      no_route?: boolean
    }>
    downtime_history?: Array<{
      downtime_id: string
      kind: string
      duration_minutes: number
      participant_ids: string[]
    }>
    /**
     * Слава отряда у фракций — ступенями, не числом: сервер намеренно не
     * отдаёт сырой счёт (`server/viewer-projection.mjs`, `publicAutonomyFor`).
     */
    reputation_standing?: Array<{ faction_id: string; tier: ReputationTier }>
  }
}

export type ReputationTier = 'reviled' | 'distrusted' | 'unknown' | 'respected' | 'honoured'

export type SceneNpcStance = 'neutral' | 'friendly' | 'wary' | 'hostile' | 'panicked'

export type SceneNpcProjection = {
  id: string
  name: string
  role: string
  location_id: string
  x: number
  y: number
  anchor_prop_id: string | null
  /** Unknown future values render with the neutral fallback, never as enemies. */
  stance: SceneNpcStance | (string & {})
  alive: boolean
  health_status: 'unharmed' | 'hurt' | 'bloodied' | 'dead'
}

export type SocialProjection = {
  schema_version?: number
  npcs?: Array<{
    id: string
    name: string
    role?: string
    location?: string
    public_summary?: string
    voice?: string
    available?: boolean
    tags?: string[]
    inventory?: Array<{ id: string; name: string; quantity: number; description?: string }>
  }>
  relationship_tiers?: Record<string, Record<string, 'hostile' | 'unfriendly' | 'neutral' | 'friendly' | 'trusted'>>
  conversations?: Array<{
    id: string
    npc_id: string
    hero_id: string
    player_message: string
    npc_reply: string
    stance: 'friendly' | 'neutral' | 'guarded' | 'hostile'
    disclosed_fact_ids: string[]
    disclosed_claim_ids: string[]
    visibility: 'party' | 'specific_player'
    check?: {
      check_id: string
      npc_id: string
      skill: 'persuasion' | 'deception' | 'intimidation' | 'insight'
      ability: string
      roll_id: string
      total: number
      modifier: number
      success: boolean
      degree: 'strong_success' | 'success' | 'failure' | 'severe_failure'
    }
  }>
  promises?: Array<{
    id: string
    npc_id: string
    hero_id: string
    direction: 'npc_to_party' | 'party_to_npc'
    text: string
    due_hint?: string
    status: 'open' | 'fulfilled' | 'broken' | 'cancelled'
    visibility: 'party' | 'specific_player'
    source_conversation_id?: string
  }>
}

/**
 * Память мира в проекции игрока. Сервер уже отфильтровал её по видимости и по
 * личному знанию героя (`worldMemoryForViewer`), поэтому здесь описано только
 * то, что игроку показывать можно.
 */
export type WorldMemoryProjection = {
  quests?: Array<{
    id: string
    title: string
    summary?: string
    status?: string
    objectives?: string[]
    clock?: { current: number; max: number; label?: string } | null
  }>
  threads?: Array<{ id: string; title: string; summary?: string; status?: string }>
  summaries?: Array<{ id: string; kind?: string; title: string; summary: string }>
}

export type CombatInitiativeEntry = {
  actor_id: string
  total?: number
  modifier?: number
  /** The kept d20 result; persisted so the initiative roll stays visible after replay. */
  roll?: number
  dice?: number[]
  roll_id?: string
  shared_with?: string
}

export type MonsterTrait = {
  id: string
  name: string
  damage_expression?: string
}

export type MonsterActionProfile = {
  id: string
  name: string
  kind: 'melee' | 'ranged'
  attack_modifier: number
  damage_expression?: string
  damage_amount?: number
  damage_type: string
  range_feet: number
  normal_range_feet?: number
  uses?: number
  tactical_priority?: number
  on_hit?: {
    save_ability?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
    save_dc?: number
    damage_expression?: string
    damage_type?: string
    half_on_save?: boolean
    condition?: string
    duration?: string
  }
}

export type CombatActionEconomy = {
  action?: boolean
  bonus_action?: boolean
  reaction?: boolean
  movement?: boolean
  movement_spent?: number
  movement_remaining?: number
  movement_bonus?: number
  extra_actions?: number
  surged_action_only?: boolean
  /** Сколько атак оружием уже сделано внутри текущего действия «Атака». */
  attacks_used?: number
  /** Сколько их даёт одно действие: 1, либо больше с «Дополнительной атакой». */
  attacks_allowed?: number
}

export type CombatReactionWindow = {
  id: string
  trigger: 'attack-hit' | 'attack-missed' | string
  actor_id: string
  source_actor_id: string
  target_id: string
  source_previous_position?: { x: number; y: number }
  action_ids: string[]
  action_options: Array<{ id: string; name: string; description?: string; resource?: string | null; slot_level?: number; cost?: number; requires_beneficiary?: boolean }>
  damage?: { raw_amount?: number; applied_amount?: number; damage_type?: string; resistant?: boolean; temporary_hp_before?: number; temporary_hp_after?: number; temporary_hp_absorbed?: number; hp_before?: number; hp_after?: number } | null
  pending_spell?: { id: string; name: string; level: number; slot_level?: number; source_url?: string }
  trigger_roll?: { kept?: number; modifier?: number; total?: number; armor_class?: number; difficulty?: number; ability?: string; save_event_type?: string; hit?: boolean; critical?: boolean }
  fighter_level?: number
}

/** Прогноз одного варианта удара по одной цели. Все значения серверные. */
export type AttackForecast = {
  action_id: string
  label: string
  item_id: string | null
  attack_modifier: number
  armor_class: number | null
  cover_bonus: number
  cover_label: string | null
  distance_feet: number | null
  range_feet: number
  in_range: boolean
  unreachable_reason: string | null
  advantage: boolean
  disadvantage: boolean
  advantage_sources: string[]
  disadvantage_sources: string[]
  hit_chance: number | null
  critical_chance: number | null
  average_damage: number
}

export type CombatMechanics = {
  active?: boolean
  round?: number
  initiative?: CombatInitiativeEntry[]
  active_index?: number
  action_economy?: Record<string, CombatActionEconomy>
  reaction_window?: CombatReactionWindow | null
}

export type GameMechanics = Record<string, unknown> & {
  combat?: CombatMechanics
  campaign_lifecycle?: {
    schema_version: 1
    status: 'setup' | 'active' | 'paused' | 'completed' | 'failed' | 'archived'
    reason?: string | null
    paused_at?: string | null
    concluded_at?: string | null
    archived_at?: string | null
    epilogue?: string | null
    epilogue_fact_keys?: string[]
    changed_by?: string | null
  }
  death?: {
    campaign_status: 'active' | 'party_defeated'
    heroes: Record<string, {
      status: 'dead' | 'resolved'
      resolution?: 'resurrected' | 'replaced' | null
      died_at?: string | null
      resolved_at?: string | null
      replacement_name?: string | null
    }>
    saving_throws: Record<string, {
      successes: number
      failures: number
      stable: boolean
      recovery_minutes_remaining?: number
    }>
  }
  encounter?: (EncounterProposal & { id?: string; encounter_id?: string; status?: 'staged' | 'active' | 'ended'; enemy_ids?: string[]; outcome?: string }) | null
  resources?: Record<string, Record<string, { current: number; max: number }>>
  resting?: Record<string, { kind: 'short' | 'long'; reason?: 'knockout'; recovery_minutes_remaining?: number }>
  concentration?: Record<string, { effect_id?: string; source_rule_ids?: string[] }>
  conditions?: Record<string, Array<{ id: string; duration?: string | null; source_actor?: string | null; effect_id?: string | null; repeat_save_timing?: 'turn-end' | null; repeat_save_on_damage?: boolean; damage_save_advantage?: boolean; break_on_damage_from_source_allies?: boolean; save_ability?: string | null; save_dc?: number | null; spell_id?: string | null; spell_option?: string | null; last_used_turn?: string | null }>>
  active_effects?: Array<{
    id: string
    effect_id?: string
    spell_id?: string
    source_actor?: string
    center?: { x: number; y: number }
    cells?: Array<{ x: number; y: number }>
    radius_feet?: number
    area_shape?: string
    difficult_terrain?: boolean
    trigger_on_enter?: boolean
    trigger_on_turn_end?: boolean
    save_ability?: string | null
    save_dc?: number
    condition?: string | null
    concentration?: boolean
    expires_round?: number
  }>
  /**
   * Прогрессия по вехам. Сервер считает заслуженный уровень, но не выдаёт его
   * сам: `LevelUp` требует выбора подкласса и умений, и это решение игрока.
   */
  progression?: {
    milestones: Array<{ id: string; milestone: string; encounter_id: string }>
    milestones_since_level: number
    milestones_per_level: number
    level_up_available: boolean
  }
}

export type CampaignSummary = {
  code: string
  name: string
  partyName: string
  memberCount: number
  playerCount: number
  setting?: string
  lifecycleStatus?: 'setup' | 'active' | 'paused' | 'completed' | 'failed' | 'archived'
  membershipRole?: 'admin' | 'owner' | 'player' | 'legacy'
  updatedAt: string | null
}

export type SuggestedAction = {
  label: string
  prompt: string
}

export type AiTurnResult = {
  narration: string
  provider: string
  model: string
  check?: { check_id?: string; label: string; modifier: number; difficulty: number; sides: 20 } | null
  effects: {
    roll: Message['roll'] | null
    reveal: Array<{ x: number; y: number }>
    spawn: Array<{ x: number; y: number; kind: NonNullable<MapCell['feature']>; label: string }>
    objective: string | null
    grantItems: Array<InventoryItem & { ownerId: string }>
    hazards?: Array<{ operation: 'apply' | 'remove'; targetId: string; hazard: { id: string; label: string; source: string; description: string; severity: string; requiresCheck: boolean; escapeAbility: string; escapeDifficulty: number; endCondition: string } }>
    scene?: SceneTransition | null
    interaction?: AgentInteraction | null
  }
  turn_id?: string | null
  engine_mode?: 'enforce'
  state_version?: number
  mechanics?: GameEvent[]
  visible_state_changes?: Array<Record<string, unknown>>
  authoritative_state?: GameState
  verification?: { valid: boolean; violations?: Array<Record<string, unknown>> }
  ruling?: Record<string, unknown> | null
  /** Ставки свободного действия: характеристика, СЛ и цена провала. */
  stakes?: {
    ability?: string
    skill?: string
    difficulty?: number
    difficulty_category?: string
    on_failure?: string
    policy?: string
  } | null
  explanation?: Record<string, unknown> | null
  explanation_url?: string
  idempotent_replay?: boolean
  narration_message_id?: string | null
  turn_consumed?: boolean
  room_version?: number
  agent_trace?: Array<{ agent: string; mode?: string; output?: Record<string, unknown> }>
}

export type GameEvent = {
  event_id?: string
  campaign_id?: string
  command_id?: string
  event_type: string
  actor_id?: string | null
  target_ids?: string[]
  payload?: Record<string, unknown>
  source_rule_ids?: string[]
  ruling_id?: string | null
  state_version_before?: number
  state_version_after?: number
  visibility?: 'public' | 'party' | 'specific_player' | 'gm_only' | 'npc_private'
}

/**
 * Эфемерная, уже отфильтрованная для зрителя механика подтверждённой команды.
 * В GameState она не сохраняется: авторитетная модель чтения не меняется,
 * а доска может проиграть только фактически зафиксированные события.
 */
export type CombatVisualBatch = {
  id: string
  events: GameEvent[]
  npcTurns: Array<{
    actor_id?: string
    kind?: string
    tactic?: string
    target_id?: string
    state_version?: number
  }>
}

export type AiHealth = {
  configured: boolean
  provider: string
  model: string
  fallbackModels?: string[]
  models?: Array<{
    model: string
    primary: boolean
    state: 'unknown' | 'ready' | 'cooldown' | 'retry-ready'
    failures: number
    last_error_code: string | null
    retry_after_ms: number
  }>
  imageModel?: string
  tools: string[]
  engineMode?: 'enforce'
  rulesetId?: string
  ruleCount?: number
  characterCreation?: CharacterCreationCatalog
}

export type CampaignAiSettings = {
  model: string
  narratorStyle: 'neutral' | 'formal' | 'ironic'
}

export type CampaignAiSettingsResponse = {
  settings: CampaignAiSettings
  availableModels: string[]
  narratorStyles: Array<{ id: CampaignAiSettings['narratorStyle']; label: string }>
  canManage: boolean
  error?: string
}

export type CharacterAbilityScores = {
  str: number
  dex: number
  con: number
  int: number
  wis: number
  cha: number
}

export type CharacterAbilityGeneration = {
  policyId: string
  policyVersion: number
  method: 'standard_array'
  baseScores: CharacterAbilityScores
  originBonusProfileId: string
  originBonuses: CharacterAbilityScores
  speciesOptionId: string
}

export type CharacterCreationCatalog = {
  schema_version: number
  import_schema: 'skazanie.character'
  import_schema_version: 1
  ability_policy: {
    policy_id: string
    policy_version: number
    method: 'standard_array'
    standard_array: number[]
    origin_bonus_profiles: Array<{ id: string; label: string; bonuses: number[] }>
    species_options: Array<{ id: string; label: string; base_speed: number }>
  }
  classes: Array<{
    id: DndClassKey
    label: string
    source_url: string
    subclass_level: number
    subclasses: Array<{ id: string; name: string; sourceUrl?: string }>
    class_skills: {
      choice_count: number
      options: Array<{ id: string; name: string; ability: keyof CharacterAbilityScores }>
    } | null
    feature_choice_groups: Array<{
      id: string
      name: string
      choiceCount: number
      options: Array<{ id: string; name: string }>
    }>
    spell_selection: {
      classKey: DndClassKey
      spellcastingAbility: keyof CharacterAbilityScores | null
      mode: 'known' | 'prepared' | 'spellbook'
      cantrips: number
      spellsKnown: number
      preparedLimit: number
      spellbookMinimum: number
      maximumSpellLevel: number
      spells: Array<{
        id: string
        name: string
        level: number
        description?: string
        casting_time?: string
        range_text?: string
        mechanics_support?: 'verified' | 'partial' | 'heuristic' | 'ruling-only'
      }>
    } | null
  }>
}

export type Account = {
  id: string
  email: string
  name: string
  heroIds: string[]
  campaignMemberships?: Array<{
    campaignId: string
    role: 'owner' | 'player'
    heroIds: string[]
    joinedAt?: number
  }>
  role: 'admin' | 'player'
  engineMode?: 'enforce' | null
  createdAt?: number
}
