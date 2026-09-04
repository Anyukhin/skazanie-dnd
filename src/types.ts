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
  /**
   * Врезка «Пока вас не было…»: что мир сделал за спиной отряда, пока шло
   * время. Строки и заголовок собраны на сервере (`server/offscreen-world.mjs`);
   * своей сборки у клиента нет, иначе стол и ведущий читали бы разный монтаж.
   */
  offscreen?: OffscreenChronicleCard
  /**
   * Конверт в летописи: отправленное письмо, доставка, возврат или пришедший
   * ответ. Поля собраны на сервере (`server/courier-letters.mjs`); своей сборки
   * у клиента нет, иначе «от кого» и «кому» читались бы по-разному у стола и у
   * ведущего.
   */
  letter?: LetterChronicleCard
  /**
   * Ступень приручения зверя: подпустил, поел с руки, пошёл с отрядом. Подписи
   * собраны на сервере (`server/beast-taming.mjs`); своей сборки у клиента нет,
   * иначе лестница читалась бы по-разному у стола и у ведущего.
   */
  beast?: BeastChronicleCard
  turnConsumed?: boolean
}

/** Карточка хода мира в летописи. Детерминированные 1–3 строки и номер дня. */
export type OffscreenChronicleCard = {
  title: string
  day: number
  elapsed_minutes: number
  lines: string[]
}

/** Что именно случилось с письмом. Список закрыт сервером. */
export type LetterChronicleKind = 'sent' | 'delivered' | 'returned' | 'answered' | 'unanswered'

/** Карточка-конверт в летописи. */
export type LetterChronicleCard = {
  kind: LetterChronicleKind
  title: string
  from: string
  to: string
  text: string
}

/** Ступень лестницы приручения. Список закрыт сервером. */
export type BeastChronicleKind = 'calmed' | 'fed' | 'tamed'

/** Карточка ступени приручения в летописи. */
export type BeastChronicleCard = {
  kind: BeastChronicleKind
  title: string
  name: string
  diet_label?: string
  text: string
}

export type RollResult = NonNullable<Message['roll']>

/**
 * A free d20 roll made from the game table. It intentionally lives outside
 * Message.roll: free rolls have no difficulty and therefore no success or
 * failure state.
 */
export type DiceRollEvent = {
  id: string
  /* `tavern` — кость, брошенная за игровым столом внутри мира: соперник по
     костям и ответ героя ложатся в тот же лоток, что и свободный бросок. */
  kind: 'free' | 'party' | 'tavern'
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
  skill?: string | null
  advantage?: boolean
  disadvantage?: boolean
  action: string
  playerId: string
  status: 'ready' | 'rolling' | 'resolving'
  result?: RollResult
  resolutionKey?: string
  /** Предложение ведущего, которое игрок принимает нажатием на бросок. */
  proposal?: {
    summary: string
    approach: string
    cost: string
    on_success: string
    on_failure: string
  }
  /**
   * Команда доски, ждущая броска: вторая фаза повторяет **ту же** команду с
   * серверным `roll_id`, а не пересобирает свободное действие. Пусто — обычная
   * проверка свободной фразы.
   */
  command?: TwoPhaseCheckCommand
}

export type CombatActionProposal = {
  id: string
  kind: 'approach_attack'
  actor_id: string
  target_id: string
  title: string
  path: Array<{ x: number; y: number }>
  to: { x: number; y: number }
  movement_feet: number
  cost: string
  consequence: string
}

/**
 * Команды доски, у которых первая фаза возвращает карточку броска вместо
 * результата. Список закрыт и обязан совпадать с серверным: карточку выдают
 * `parleyCheckCard`, `guardEscapeCheckCard`, `tavernDiceCheckCard` и `beastTamingCheckCard`
 * (`server/game-orchestrator.mjs`), и команда, которой здесь нет, получает
 * карточку от сервера и молча теряет её на клиенте — ход после этого не
 * доиграть ничем, кроме перезагрузки.
 */
export type TwoPhaseCheckCommand =
  | { command_type: 'ProposeParley'; actor_id: string; skill: 'persuasion' | 'intimidation' }
  | { command_type: 'ResolveGuardEncounter'; actor_id: string; resolution: GuardResolution; skill: 'stealth' | 'athletics' }
  | { command_type: 'AnswerTavernDiceRound'; actor_id: string; approach: TavernDiceApproach }
  | { command_type: 'CalmBeast'; actor_id: string; beast_id: string }
  | { command_type: 'OperateSceneObject'; actor_id: string; prop_id: string; intent: SceneObjectIntent }

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
  destinationLocationId?: string
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
  backgroundId?: string
  backgroundAbilityChoice?: { mode: string; abilities: string[] }
  backgroundChoices?: { tools: string[]; languages: string[] }
  backgroundSkillProficiencies?: string[]
  backgroundBenefits?: Record<string, unknown> | null
  speciesBenefits?: Record<string, unknown> | null
  starterEquipmentPolicyId?: string
  starterEquipmentPolicyVersion?: number
  starterEquipmentChoices?: Record<string, string[]>
  speciesChoices?: Record<string, string[]>
  speciesSkillProficiencies?: string[]
  speciesToolProficiencies?: string[]
  speciesLanguages?: string[]
  speciesSpellIds?: string[]
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

export type ItemRechargeProfile = {
  schema_version: 1
  trigger: 'dawn'
  formula: '1d6+1'
}

export type ItemUseOptions = {
  targetId?: string
  chargesToSpend?: number
  to?: { x: number; y: number }
  useMode?: 'spill'
  weaponId?: string
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
  activated?: boolean
  requires_attunement?: boolean
  attuned_to?: string | null
  rarity: 'обычный' | 'необычный' | 'редкий' | 'очень редкий' | 'легендарный' | 'сюжетный'
  /**
   * Откуда вещь взялась. Ключи серверные (`ITEM_ORIGIN_KINDS`,
   * `server/item-catalog.mjs`), подпись для стола сервер отдаёт отдельно.
   * У чужой вещи поле может отсутствовать вовсе: краденое соседа по столу
   * проекция снимает поимённо, а не подменяет вежливым «неизвестно».
   */
  origin?: 'enemy_loadout' | 'purchased' | 'found' | 'looted' | 'stolen' | 'gifted' | 'reward' | 'unknown'
  description: string
  properties: string
  image: string
  imagePosition?: string
  imagePrompt?: string
  imageStatus?: 'ready' | 'queued' | 'generating' | 'failed'
  charges?: { current: number; max: number }
  recharge?: ItemRechargeProfile
  capabilities?: {
    equippable: boolean
    equip_slot: string | null
    usable: boolean
    use: {
      kind: string
      action_type: 'action' | 'bonus_action' | null
      target: 'self' | 'party' | 'creature' | 'enemy' | 'point'
      range_feet: number
      charges_per_use?: number
      spell_id?: string
      min_charges_to_spend?: number
      max_charges_to_spend?: number
      default_charges_to_spend?: number
      requires_equipped?: boolean
      combat_only?: boolean
      point_target?: boolean
      use_modes?: Array<'target' | 'spill'>
      requires_weapon?: boolean
    } | null
    activatable?: boolean
    activation?: {
      schema_version: 1
      action_type: 'bonus_action' | null
      requires_equipped: boolean
      requires_attunement: boolean
    } | null
    activated?: boolean
    /**
     * Боеприпасы, посчитанные сервером (`itemViewerCapabilities`).
     * У пачки снарядов это остаток выстрелов, у дальнобойного оружия — какой
     * снаряд оно просит. Клиент их только складывает: какой лук чем стреляет и
     * сколько штук в пачке, знает каталог, и второй такой таблицы в браузере
     * быть не должно — иначе счётчик разошёлся бы с серверным отказом.
     */
    ammunition?: {
      role: 'ammunition'
      shots: number
      per_bundle: number
      unit: string
    } | {
      role: 'weapon'
      catalog_id: string
      unit: string
    }
    charges: { current: number; max: number } | null
    recharge: ItemRechargeProfile | null
    requires_attunement: boolean
    mechanics_status?: 'verified' | 'partial' | 'ruling-only'
    limitation?: string
  }
  combat?: {
    kind: 'melee' | 'ranged' | 'thrown-area'
    ability?: 'str' | 'dex'
    /** Разрешённые серверным профилем характеристики (finesse: Сила или Ловкость). */
    abilities?: Array<'str' | 'dex'>
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
    /**
     * Канонические варианты одного оружия. UI передаёт лишь `id` и
     * характеристику; Rules Engine заново проверяет их по каталогу.
     */
    modes?: Array<{
      id: 'melee' | 'ranged' | 'thrown' | 'two-handed'
      kind: 'melee' | 'ranged'
      ability: 'str' | 'dex'
      damage: string
      damageType: string
      normalRange: number
      longRange?: number
      twoHanded?: boolean
      thrown?: boolean
      ammunition?: boolean
    }>
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

export type EncounterDifficulty = 'easy' | 'medium' | 'hard' | 'deadly'
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
  difficulty_label?: string
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
  /** Скидка скупщика. Приходит только у краденого и только от скупщика. */
  stolen_adjustment_percent?: number
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
  /** Купить нельзя вовсе — например, отряд ищет стража. Причина рядом. */
  can_buy?: boolean
  can_sell?: boolean
  /**
   * Почему лавка закрыта для отряда: розыск или дурная слава. Поле отдельное от
   * `reason` (тот про сам предмет: надет, сюжетный, не оценён) — без него отказ
   * по розыску показывался игроку как «Недостаточно монет».
   */
  unavailable_reason?: string
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

/**
 * `pray` объявляется сервером только у святыни (`sceneShrineVerbsFor`,
 * `server/scene-interactions.mjs`) и в отличие от остальных глаголов бросает
 * кость: молитва идёт двухфазной проверкой Религии.
 */
export type SceneObjectIntent = 'inspect' | 'open' | 'lockpick' | 'take' | 'use' | 'topple' | 'ignite' | 'pray'

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
  /**
   * Предмет ведёт на другой этаж локации: лестница, люк. Необязателен —
   * одноэтажная карта поля не несёт.
   */
  transition?: { toLevel: number; label?: string }
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
  /** Этаж карты: 0 — этаж входа, +1 вверх, −1 подвал. */
  levelIndex: number
  /** Подпись этажа для игрока: «Второй этаж», «Винный погреб». */
  levelLabel: string
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
  /**
   * Босс: существо с легендарными действиями. Признак и полосу запаса
   * выставляет сервер (`publicEnemyFor`), клиент их не выводит — иначе рамка
   * появлялась бы там, где действий вне хода нет. Пипсы — качественная
   * величина; ни СЛ заклинаний, ни список магии сюда не приходят вовсе.
   */
  boss?: boolean
  legendary?: { uses: number; used: number }
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
  type: 'move' | 'attack' | 'area-attack' | 'equipment' | 'spell' | 'spell-save' | 'spell-damage' | 'healing' | 'action' | 'reaction' | 'summon' | 'summon-end' | 'turn-end' | 'combat-start' | 'combat-end' | 'encounter-created' | 'encounter-ended' | 'death-save' | 'death-save-damage' | 'hero-stabilized' | 'concentration-save' | 'concentration-end' | 'max-hp-reduction' | 'max-hp-reduction-prevented' | 'max-hp-increase' | 'beast-tamed' | 'npc-item' | 'parley' | 'parley-rejected' | 'parley-settled' | 'truce' | 'truce-broken' | 'captive-taken' | 'loot-container' | 'loot-taken'
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
  /**
   * Вид атаки: удар, выстрел или бросок. Считает его сервер — герою по
   * выбранному режиму оружия, существу по его действию стат-блока, — и от него
   * зависит глагол строки хроники. У боя, сыгранного до появления признака,
   * поля нет, и строка остаётся прежней нейтральной «атакует».
   */
  attackKind?: 'melee' | 'ranged' | 'thrown'
  /** Выстрел за пределы обычной дальности: он же помеха на бросок. */
  longRange?: boolean
  /** Насколько реакция срезала урон и было ли перебито заклинание. */
  preventedDamage?: number
  countered?: boolean
  /** СЛ спасброска у областной атаки: своя вещь героя, число с её карточки. */
  savingThrowDifficulty?: number
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
  itemSavingThrowBonus?: number
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
  /**
   * Снаряжение противника: закрытая тактика сервера и её готовая подпись.
   * Ни имени вещи, ни каталожного ключа здесь нет — карман живого противника
   * закрыт до обыска тела, и журнал показывает поступок, а не инвентарь.
   */
  tactic?: string
  label?: string
  /**
   * Контейнер добычи: журнал называет вид, имя и число предметов, но не то,
   * что именно внутри. Содержимое отряд узнаёт, подойдя (`loot_containers`).
   */
  containerId?: string
  containerKind?: string
  containerName?: string
  recipientId?: string
  itemCount?: number
  /**
   * Что осталось в контейнере после обыска. Признак нужен интерфейсу, чтобы не
   * принять неполный обыск за опустошённое тело: `loot-taken` пишется в обоих
   * случаях, а метка «уже забрал такой-то» честна только при нулевом остатке.
   */
  remainingCount?: number
  statusAfter?: string
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
  /**
   * Активный этаж локации. Отсутствует у старой проекции и у одноэтажных
   * локаций — тогда это этаж входа (`index = 0`).
   */
  level?: { index: number; label?: string }
  /**
   * Этажи, на которых партия уже побывала: из них строится индикатор на доске.
   * Неактивные этажи в проекцию не входят, здесь только номера и подписи.
   */
  levels?: Array<{ index: number; label?: string }>
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

export type WorldMapCityDistrict = {
  id: string
  name: string
  x: number
  y: number
  bounds: { x: number; y: number; width: number; height: number }
  summary: string
  history?: string
  storyHooks?: string[]
}

export type WorldMapCityPlace = {
  id: string
  name: string
  kind: 'civic' | 'harbor' | 'market' | 'temple' | 'archive' | 'gate' | 'tower' | 'garden' | 'workshop' | 'infrastructure' | 'inn' | 'other'
  districtId: string
  x: number
  y: number
  summary: string
  history?: string
  storyHooks?: string[]
}

export type WorldMapCityOverview = {
  version: number
  name: string
  summary: string
  image: string
  imageAlt?: string
  width: number
  height: number
  districts: WorldMapCityDistrict[]
  places: WorldMapCityPlace[]
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
  /** Краткая история места, доступная вместе с открытой точкой карты. */
  history?: string
  /** До трёх сюжетных нитей, которые могут развиться вокруг места. */
  storyHooks?: string[]
  /** Авторский обзор стартового города; клики меняют только локальный выбор UI. */
  cityOverview?: WorldMapCityOverview
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
  /** Авторская сеть уже связна и не дополняется процедурными дорогами. */
  routesComplete?: boolean
  regions: WorldMapRegion[]
  locations: WorldMapLocation[]
  routes: WorldMapRoute[]
  /** Заранее подготовленный декоративный фон из public/assets. */
  backgroundImage?: string
  backgroundAlt?: string
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

/**
 * Отчёт режима подготовки ассетов. Картинки готовятся заранее: во время игры
 * генерация выключена решением владельца, а подготовка работает всегда.
 */
export type AssetPreparationReport = {
  policy_id: string
  runtime_image_generation: boolean
  generator_configured: boolean
  /** Потолок общий на все виды картинок: платит стол один раз за всю пачку. */
  maximum_batch: number
  npc_portraits: Array<{ id: string; name: string; role: string; has_portrait: boolean }>
  location_illustrations: Array<{ id: string; name: string; kind: string; source: string; has_illustration: boolean }>
  items_without_illustration: Array<{ id: string; name: string; owner_id: string }>
  items_note: string
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
  /**
   * Детерминированные подсказки «что можно сделать». Сервер собирает их из уже
   * спроецированной комнаты, поэтому скрытого в них нет по построению. В бою
   * список пуст: там действия перечисляет хотбар.
   */
  suggested_actions?: Array<{ id: string; text: string }>
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
  pendingAction?: { proposal: CombatActionProposal; action: string; playerId: string; status: 'ready' | 'submitting'; idempotencyKey: string } | null
  agentInteraction?: AgentInteraction | null
  /** Optional so rooms saved before the dice tray was added remain valid. */
  lastDiceRoll?: DiceRollEvent | null
  state_version?: number
  ruleset_id?: string
  ruleset_version?: string
  enabled_rule_packs?: string[]
  enabled_house_rules?: string[]
  ruleset_locked_at?: string | null
  ruleset_selection_locked?: boolean
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
   * Летопись поступков отряда. Приходит **только администратору**: игрок
   * узнаёт о молве в игре, из уст NPC, а серверная проекция вырезает эту
   * ветку целиком (`campaignStateForViewer`).
   */
  world_deeds?: WorldDeedsProjection
  /**
   * Пленные отряда. В отличие от летописи поступков, эта ветка игроку
   * принадлежит: он видит, кого держит, — но не то, чего пленный ещё не сказал.
   */
  captives?: CaptivesProjection
  /**
   * Контейнеры добычи текущего яруса. Опустошённые сюда не приезжают вовсе, а
   * содержимое — только у того контейнера, до которого дотягивается герой
   * игрока: «обыскать» обязано оставаться поступком, а не формальностью поверх
   * уже прочитанного списка.
   */
  loot_containers?: LootContainersProjection
  /**
   * Звери сцены и спутники отряда: кого можно уговорить, против какой СЛ и кто
   * уже идёт следом. Ветка принадлежит игроку целиком, кроме стат-блока и CR.
   */
  beasts?: BeastsProjection
  /**
   * Закон и розыск. Форма зависит от зрителя: игроку приезжают приметы мира и
   * встреча со стражей, ведущему — лента по краям. Общий тип держит обе ветки
   * необязательными, потому что второй проекции у клиента нет и быть не должно.
   */
  law?: LawProjection
  /**
   * Жизнь таверны: кости и выпивка. Приезжает только в сцене заведения, и
   * только собранной сервером карточкой — характера соперника, его пассивных
   * значений и чужого счёта здесь нет.
   */
  tavern?: TavernProjection | null
  /**
   * Благословения: несёт ли герой малое благословение, прошли ли сутки с
   * прошлого обращения и у кого в этой сцене можно попросить. Приезжает всегда
   * — в отличие от таверны, святыня и жрец встречаются где угодно.
   */
  blessings?: BlessingProjection | null
  /**
   * Взлом отмычками: умеет ли **этот** герой вскрывать замки и что показать,
   * если не умеет. Карточку собирает сервер целиком; ни СЛ замка, ни
   * запертости сундуков в ней нет и не будет.
   */
  lockpicking?: LockpickingProjection | null
  /**
   * Ходы мира за спиной отряда. Ветка одинакова у игрока и у ведущего: «Пока
   * вас не было…» — монтаж для всего стола.
   */
  offscreen_world?: OffscreenWorldProjection
  /**
   * Почта отряда: кому уже написали, где сейчас курьер и сколько стоит письмо
   * каждому известному адресату. Запечатанного ответа здесь нет — он приходит
   * вместе со статусом «получен ответ».
   */
  courier_letters?: CourierLettersProjection
  /**
   * Время суток и погода. Ветка одинакова у игрока и у ведущего: небо над
   * отрядом тайной не является.
   */
  weather?: WeatherProjection
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
  /**
   * Сущности и утверждения приходят только администратору: слухи пишутся с
   * видимостью `gm_only`, и `worldMemoryForViewer` отсекает их у игрока.
   */
  entities?: Array<{ id: string; kind?: string; name: string }>
  epistemic_claims?: Array<{
    id: string
    kind?: 'belief' | 'rumor'
    holder_entity_id: string
    predicate?: string
    claim: string
    summary?: string
    truth_status?: 'unknown' | 'confirmed' | 'refuted'
    recorded_at_minutes?: number
  }>
}

/** Один поступок отряда: место, время кампании и свидетели. Только для ведущего. */
export type WorldDeedEntry = {
  id: string
  kind: string
  alignment: 'dark' | 'bright'
  severity: 'grave' | 'major' | 'minor'
  actor_names?: string[]
  subject?: string
  location_name?: string
  at_minutes: number
  witness_ids?: string[]
  secret?: boolean
  summary?: string
  spread_at_minutes?: number
  reputation_faction_ids?: string[]
  /**
   * Готовые для карточки поля ленты (`worldDeedsFeed`, `server/world-deeds.mjs`):
   * русская подпись вида из `DEED_KINDS` и число свидетелей. Приходят только
   * ведущему — вместе со всей летописью.
   */
  label?: string
  witness_count?: number
}

export type WorldDeedsProjection = { schema_version?: number; deeds?: WorldDeedEntry[] }

/**
 * Одна запись хода мира: что именно случилось, пока отряда не было. Подпись
 * вида (`label`) приходит с сервера — своей таблицы у клиента нет.
 */
export type OffscreenWorldEntry = {
  kind: 'quest_clock' | 'quest_deadline' | 'quest_expired' | 'faction_move' | 'rumor_spread'
  label?: string
  summary: string
  quest_id?: string
  quest_title?: string
  faction_id?: string
  faction_name?: string
  move_kind?: 'reinforced_posts' | 'moved_camp' | 'took_hostage' | ''
  npc_id?: string
  npc_name?: string
  count?: number
}

/** Один ход мира: минута кампании, игровой день, что случилось и строки врезки. */
export type OffscreenWorldStep = {
  id: string
  at_minutes: number
  elapsed_minutes: number
  day: number
  entries: OffscreenWorldEntry[]
  lines: string[]
  policy_id?: string
}

/**
 * Лента «Пока вас не было…». Форма у стола и у ведущего одна: в ход мира
 * попадают только party-видимые задания, фракции и NPC, поэтому прятать в ней
 * нечего (`server/offscreen-world.mjs`).
 */
export type OffscreenWorldProjection = { schema_version?: number; steps?: OffscreenWorldStep[] }

/**
 * Пленный отряда. Приходит и игроку, и ведущему, но не одинаково: серверная
 * проекция вырезает `known_fact_ids` — то, чего пленный ещё не сказал, — и
 * оставляет вместо него счётчик `pending_knowledge`. Иначе допрос перестал бы
 * быть проверкой: ответ читался бы прямо из состояния.
 */
export type CaptiveEntry = {
  id: string
  npc_id: string
  actor_id?: string
  name: string
  role?: string
  temper?: string
  origin: 'surrendered' | 'knocked_out'
  status: 'held' | 'released' | 'handed_over' | 'dead'
  band_id?: string
  taken_at_minutes?: number
  location_name?: string
  revealed_fact_ids?: string[]
  interrogations?: number
  last_fed_at_minutes?: number
  neglected_at_minutes?: number | null
  resolved_at_minutes?: number | null
  resolution?: string
  disposition?: 'ally' | 'informant' | 'none'
  /** Сколько зацепок пленный ещё держит при себе. Само знание остаётся у ведущего. */
  pending_knowledge?: number
  /** Только у ведущего: идентификаторы нераскрытых фактов. */
  known_fact_ids?: string[]
}

export type CaptivesProjection = { schema_version?: number; captives?: CaptiveEntry[] }

/**
 * Предмет в контейнере добычи. Форму задаёт сервер (`lootItemForViewer`,
 * `server/loot-containers.mjs`): ни владельца, ни происхождения здесь нет — в
 * происхождении лежит идентификатор стат-блока противника, а его отряд узнаёт
 * только опознанием врага.
 */
export type LootItemCard = {
  item_instance_id: string
  catalog_id?: string
  name: string
  type?: string
  rarity?: string
  weight: number
  quantity: number
  description?: string
  mechanics_status?: string
  base_price_cp?: number
  image?: string
  charges?: { current: number; max: number }
  requires_attunement?: boolean
}

/**
 * Контейнер добычи в текущей сцене. `items` приходит только тогда, когда герой
 * игрока до контейнера дотягивается: `can_inspect` — тот же признак, и он
 * решается сервером, а не расстоянием, посчитанным в браузере.
 */
export type LootContainerCard = {
  schema_version?: number
  id: string
  kind: 'corpse' | 'captive' | 'abandoned' | 'cache'
  name: string
  status: 'available' | 'emptied'
  /**
   * Кем контейнер был. Ключ нужен интерфейсу ровно для портрета павшего: имя
   * противника и так стоит в `name`, а стат-блок сюда не уезжает вовсе.
   */
  source_enemy_id?: string
  x: number | null
  y: number | null
  /**
   * Раскрыта ли клетка контейнера. Тот же туман, что и у клетки доски: метка
   * добычи на карте гаснет вместе с нераскрытой клеткой, и панель под туманом
   * не печатает ни клетку, ни футы — иначе карточка проговаривала бы словами
   * разведку, которой отряд не делал. Решает сервер; координаты приезжают и
   * закрытыми — они нужны доске, чтобы знать, где не рисовать метку.
   */
  cell_revealed?: boolean
  item_count: number
  total_weight: number
  can_inspect: boolean
  /**
   * Сколько футов до контейнера. Считает сервер — второй геометрии доски в
   * браузере не заводится. `undefined` значит «померить нечем»: у контейнера
   * нет клетки или герой ещё не встал на карту.
   */
  distance_feet?: number
  items?: LootItemCard[]
}

export type LootContainersProjection = {
  schema_version?: number
  reach_feet?: number
  /**
   * Цена обыска в экономике хода. Решает сервер тем же признаком, что и правило
   * (`validateLootContainerCommand`): идёт бой — обыск стоит действия. Кнопка
   * называет цену до нажатия и своей таблицы правил не держит.
   */
  action_cost?: 'action' | null
  /**
   * Потрачено ли уже действие этого героя в этом ходу. Вторая половина цены:
   * без неё кнопка называла цену, ничего не зная о том, есть ли чем платить, и
   * обещала «Взять — действие» там, где движок ответит `ACTION_SPENT`. Читается
   * из той же `action_economy`, по которой отказывает `assertTurn`.
   */
  action_spent?: boolean
  containers?: LootContainerCard[]
}

/** Ступень приручения и повадка зверя. Оба списка закрыты сервером. */
export type BeastStage = 'wary' | 'calmed' | 'fed' | 'tamed'
export type BeastDiet = 'predator' | 'herbivore'

/**
 * Зверь в реестре отряда. Стат-блока и CR здесь нет намеренно: серверная
 * проекция их вырезает — подойти к волку не то же самое, что опознать его как
 * строку бестиария (`beastForViewer`, `server/beast-taming.mjs`).
 */
export type BeastEntry = {
  id: string
  actor_id: string
  name: string
  diet: BeastDiet
  diet_label?: string
  stage: BeastStage
  stage_label?: string
  status: 'wild' | 'companion'
  attempts?: number
  bites?: number
  location_name?: string
  met_at_minutes?: number
  calmed_at_minutes?: number | null
  fed_at_minutes?: number | null
  tamed_at_minutes?: number | null
  scared_at_minutes?: number | null
  /** Только у ведущего: из чего сложилась объявленная СЛ. */
  stat_block_id?: string
  challenge_rating?: string
}

/** Одно слагаемое объявленной СЛ: почему с этим зверем именно так трудно. */
export type BeastDifficultyPart = { id: string; label: string; shift: number }

/**
 * Зверь, к которому отряд может подойти прямо сейчас. Всё посчитано сервером:
 * СЛ, её слагаемые и повод отказа. Своей формулы сложности у клиента нет.
 */
export type BeastCandidate = {
  id: string
  actor_id: string
  name: string
  diet: BeastDiet
  diet_label?: string
  stage: BeastStage
  stage_label?: string
  wounded?: boolean
  broken_morale?: boolean
  difficulty: number
  skill?: string
  ability?: string
  attempts?: number
  bites_on_failure?: boolean
  parts?: BeastDifficultyPart[]
  /**
   * Досягаемость по каждому герою отряда: ключ — идентификатор героя. Общей
   * строки «до зверя далеко» здесь нет намеренно: команду движок принимает от
   * действующего героя, и панель обязана читать строку того, кто жмёт кнопку,
   * а не того, кто просто стоит ближе. `distance_feet: null` — сцена без
   * клеток: расстояния в ней не существует.
   */
  reach_by_hero?: Record<string, { distance_feet: number | null; out_of_reach: boolean }>
  /** С какого расстояния зверю протягивают руку. Считает сервер. */
  reach_feet?: number
  /** `combat_active` или `beast_down`: почему подойти нельзя. */
  blocked_reason?: string
}

export type BeastCompanionCard = {
  id: string
  name: string
  scare_cooldown_minutes: number
  /** `combat_active` или `scare_cooldown`: почему спутник сейчас не отгоняет. */
  blocked_reason?: string
}

export type BeastsProjection = {
  schema_version?: number
  beasts?: BeastEntry[]
  candidates?: BeastCandidate[]
  companions?: BeastCompanionCard[]
  /** Идёт ли прямо сейчас страж лагеря: преимущество на Восприятие на привале. */
  watch_advantage?: boolean
}

/** Чем можно ответить страже. Список закрыт сервером (`server/law-and-order.mjs`). */
export type GuardResolution = 'fine' | 'surrender' | 'fight' | 'flee'

export type GuardEncounterOption = {
  id: GuardResolution
  label: string
  summary: string
  fine_cp?: number
  difficulty?: number
}

/**
 * Встреча со стражей у игрока. Ступени розыска, очков и реестра преступлений
 * здесь нет намеренно: сервер их не отдаёт, и клиент их не выводит — розыск
 * игрок узнаёт по офицеру перед собой и по приметам вокруг.
 */
export type GuardEncounterCard = {
  id: string
  place_name?: string
  officer_name?: string
  officer_rank?: string
  demand?: string
  fine_cp?: number
  escape_dc?: number
  escape_attempts?: number
  options?: GuardEncounterOption[]
  /** Только у ведущего: точная ступень розыска в этом краю. */
  level?: number
}

/** Одна строка ленты закона у ведущего: край, ступень и что за отрядом числится. */
export type WantedRegionEntry = {
  region_id: string
  region_name?: string
  level: number
  label?: string
  points: number
  crime_count?: number
  last_crime_at_minutes?: number | null
  next_decay_in_minutes?: number | null
  here?: boolean
  /** Последнее снятие розыска в этом краю: вира, сдача или амнистия ведущего. */
  cleared?: { at_minutes?: number; reason?: string } | null
  crimes?: Array<{
    id: string
    kind: string
    points: number
    place_name?: string
    at_minutes?: number
    witnesses?: number
    summary?: string
    cleared_at_minutes?: number | null
    cleared_reason?: string | null
  }>
}

/**
 * Закон и розыск. У игрока — только приметы мира и открытая встреча со стражей;
 * у ведущего — лента по краям со ступенями и реестром преступлений.
 */
export type LawProjection = {
  schema_version?: number
  signs?: string[]
  encounter?: GuardEncounterCard | null
  regions?: WantedRegionEntry[]
}

/** Как герой отвечает на бросок соперника. Список закрыт сервером (`server/tavern-life.mjs`). */
export type TavernDiceApproach = 'fair' | 'cheat' | 'watch'

/** Открытый раунд: кость соперника уже на столе, и её надо перебить. */
export type TavernRoundCard = {
  id: string
  hero_id: string
  npc_id: string
  npc_name?: string
  /** Ставка, **уже** ушедшая из кошелька на стол при открытии раунда. */
  stake_cp: number
  npc_total: number
  /**
   * Сколько нужно показать, чтобы забрать банк. Считает сервер.
   *
   * Поля «почему раунд уже не доиграть» здесь нет, и это не пропуск: касса
   * соперника закрепляет выплату за раундом с самого открытия
   * (`tavernFreePurseFor`, `server/tavern-life.mjs`), поэтому тупиков не бывает,
   * а исходов у раунда ровно два — ответить или сдаться. Единственное, что
   * закрывает ответ, — запрет входа, и о нём говорит своё поле карточки
   * (`TavernProjection.ejected`).
   */
  target: number
}

/**
 * Карточка заведения. Всё уже посчитано сервером: с кем можно сыграть, какие
 * ставки открыты, сколько стоит кружка и против какой СЛ пойдёт следующая.
 * Честен соперник или шулер — не приезжает никогда: это узнают Проницательностью.
 */
export type TavernProjection = {
  schema_version?: number
  place_name?: string
  location_id?: string
  opponents?: Array<{
    id: string
    name: string
    role?: string
    /**
     * Самая крупная ставка, которую этот сосед может закрыть своим кошельком.
     * `0` — он на мели. Считает сервер: своей таблицы касс у доски нет.
     */
    max_stake_cp?: number
  }>
  stakes?: Array<{ stake_cp: number; label: string }>
  approaches?: TavernDiceApproach[]
  round?: TavernRoundCard | null
  drink_price_cp?: number
  drinks?: number
  /** `null` — следующая кружка ещё безопасна. */
  next_drink_dc?: number | null
  social_bonus?: number
  ejected?: boolean
}

/**
 * Карточка благословений. Всё уже посчитано сервером: цена требы, СЛ молитвы,
 * срок и то, прошли ли сутки. Своей арифметики суток у клиента нет.
 */
export type BlessingProjection = {
  schema_version?: number
  /** Идентификатор состояния — тот же, что придёт в `mechanics.conditions`. */
  condition?: string
  attack_bonus?: number
  donation_cp?: number
  prayer_dc?: number
  prayer_skill?: string
  location_id?: string
  /** Несёт ли герой благословение прямо сейчас. */
  blessed?: boolean
  /** Прошли ли сутки с прошлого обращения — молитвы или требы. */
  available?: boolean
  /** Сколько минут кампании ждать, если ещё не прошли. */
  waits_minutes?: number
  priests?: Array<{ id: string; name: string; role?: string }>
  /** Чем кончилось прошлое обращение. `null` — герой ещё не обращался. */
  last?: {
    source?: 'shrine' | 'priest'
    granted?: boolean
    place_name?: string
    npc_name?: string
    at_minutes?: number
  } | null
}

/**
 * Взлом отмычками. Карточка отвечает на один вопрос — умеет ли этот герой, —
 * и приносит **готовую строку отказа**: она обязана совпасть с той, которой
 * движок отвергнет команду, иначе кнопка и сервер разойдутся в объяснении.
 *
 * СЛ замка и запертости здесь нет намеренно: сложность игроку не объявляется, а
 * запертость сундука выводится из сида и в проекцию не едет.
 */
export type LockpickingProjection = {
  schema_version?: number
  policy_id?: string
  tool_id?: string
  tool_name?: string
  /** Владеет ли герой воровскими инструментами. */
  proficient?: boolean
  /** Почему нельзя. Пустая строка — можно. */
  blocked_reason?: string
}

/** Куда едет письмо: к известному NPC или к фракции. Список закрыт сервером. */
export type LetterAddresseeKind = 'npc' | 'faction'

/**
 * Состояние письма. Подпись к нему приходит с сервера готовой.
 *
 * `unanswered` — письмо дошло, а отвечать уже некому: адресата убили или увели
 * между доставкой и ответом. Это не `returned`: возврат означает, что письмо не
 * прочитал никто.
 */
export type LetterStatus = 'in_transit' | 'delivered' | 'answered' | 'returned' | 'unanswered'

/**
 * Один известный адресат с уже посчитанной дорогой. Цену и срок считает сервер
 * по дорогам карты мира — своей арифметики дальности у клиента нет.
 */
export type LetterAddressee = {
  kind: LetterAddresseeKind
  id: string
  name: string
  role?: string
  place_name?: string
  leagues: number
  fee_cp: number
  travel_minutes: number
  /** `true` — адресат стоит перед отрядом: это разговор, а не письмо. */
  unreachable?: boolean
}

/**
 * Письмо в публичной форме. Текста ответа здесь нет, пока он не пришёл: до
 * этого он запечатан и не принадлежит ни игроку, ни ведущему.
 */
export type LetterCard = {
  id: string
  hero_id: string
  hero_name?: string
  addressee_kind: LetterAddresseeKind
  addressee_id: string
  addressee_name: string
  place_name?: string
  leagues: number
  fee_cp: number
  body: string
  promise_text?: string
  status: LetterStatus
  status_label: string
  sent_at_minutes: number
  delivery_due_minutes: number
  reply_due_minutes: number
  delivered_at_minutes?: number | null
  answered_at_minutes?: number | null
  returned_at_minutes?: number | null
  return_reason?: string
  /** Появляется только вместе со статусом «получен ответ». */
  reply?: string
}

/** Почта отряда: письма в дороге, доставленные и уже отвеченные. */
export type CourierLettersProjection = {
  schema_version?: number
  letters?: LetterCard[]
  addressees?: LetterAddressee[]
  base_fee_cp?: number
  fee_per_league_cp?: number
  body_limit?: number
  open_limit?: number
}

/** Время суток по серверным часам кампании (`server/weather.mjs`). */
export type DayPhaseId = 'morning' | 'day' | 'evening' | 'night'

/** Погода. Список закрыт сервером — клиент своей таблицы не держит. */
export type WeatherConditionId = 'clear' | 'overcast' | 'rain' | 'fog' | 'storm'

/**
 * Небо над отрядом. Всё уже посчитано сервером: и строка индикатора, и подписи
 * действующих помех. Клиент только показывает — своей таблицы погоды у него нет
 * и быть не должно, иначе она разошлась бы с броском.
 */
export type WeatherProjection = {
  schema_version?: number
  policy_id?: string
  /** Игровой день кампании, начиная с первого. */
  day: number
  /** Часы и минуты мировых часов: «18:20». */
  clock: string
  phase: DayPhaseId
  phase_label: string
  weather: WeatherConditionId
  weather_label: string
  weather_summary: string
  biome: string
  region_name: string
  /** Под крышей погоды нет: все помехи этого модуля выключены. */
  indoors: boolean
  /** Готовая строка шапки сцены: «Вечер · Дождь». */
  indicator: string
  /** Русские подписи действующих помех и преимуществ. */
  effects: string[]
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
  /** Ключ хода, в котором плут уже нанёс урон Скрытой атакой. */
  sneak_attack_turn_key?: string
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

/** Исходы перемирия. Список закрыт сервером (`server/parley.mjs`). */
export type ParleyOutcome = 'withdraw' | 'tribute' | 'surrender' | 'resume'

/**
 * Перемирие посреди боя. Приходит в проекции внутри `mechanics.combat`, потому
 * что это состояние боя, а не отдельный слой: пока оно есть, очередь заморожена.
 */
export type TruceState = {
  schema_version?: number
  policy_id?: string
  leader_id: string
  leader_name?: string
  hero_id?: string
  hero_name?: string
  skill?: 'persuasion' | 'intimidation'
  difficulty?: number
  total?: number
  round?: number
  established_at_minutes?: number
  outcomes: ParleyOutcome[]
  tribute_cp?: number
}

export type CombatMechanics = {
  active?: boolean
  round?: number
  initiative?: CombatInitiativeEntry[]
  active_index?: number
  action_economy?: Record<string, CombatActionEconomy>
  reaction_window?: CombatReactionWindow | null
  truce?: TruceState | null
  parley_attempts?: number
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
  hit_point_dice?: Record<string, { schema_version: 1; maximum: number; spent: number; die_size: 6 | 8 | 10 | 12 }>
  resting?: Record<string, {
    kind: 'short' | 'long'
    schema_version?: 2
    policy_id?: string
    rest_id?: string
    started_at_minutes?: number
    minimum_duration_minutes?: number
    reason?: 'knockout'
    recovery_minutes_remaining?: number
  }>
  concentration?: Record<string, { effect_id?: string; source_rule_ids?: string[] }>
  /** Временные хиты по участникам; у неопознанного врага ключа нет. */
  temporary_hp?: Record<string, number>
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

export type RestCommand =
  | { command_type: 'StartRest'; actor_id: string; kind: 'short' | 'long' }
  | { command_type: 'SpendHitPointDie'; actor_id: string }
  | { command_type: 'CompleteRest'; actor_id: string }

export type CampaignSummary = {
  code: string
  name: string
  partyName: string
  memberCount: number
  playerCount: number
  setting?: string
  rulesetId?: 'dnd_5e_2014' | 'srd_5_2_1'
  rulesetVersion?: string
  lifecycleStatus?: 'setup' | 'active' | 'paused' | 'completed' | 'failed' | 'archived'
  membershipRole?: 'admin' | 'owner' | 'player' | 'legacy'
  updatedAt: string | null
}

export type SuggestedAction = {
  label: string
  prompt: string
}

export type AiTurnResult = {
  action_proposal?: CombatActionProposal
  narration: string
  provider: string
  model: string
  check?: Pick<PendingCheck, 'check_id' | 'label' | 'modifier' | 'difficulty' | 'sides' | 'ability' | 'skill' | 'advantage' | 'disadvantage' | 'proposal'> | null
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
  installedRulesets?: RulesetProfileDescriptor[]
  characterCreation?: CharacterCreationCatalog
}

export type CampaignRecap = {
  text: string
  version: number
  provider: string
}

export type CampaignRecapResponse = {
  recap: CampaignRecap | null
  reason?: string
}

export type CampaignAiSettings = {
  model: string
  narratorStyle: 'neutral' | 'formal' | 'ironic'
  improvMode: 'chaos' | 'story'
}

export type CampaignAiSettingsResponse = {
  settings: CampaignAiSettings
  availableModels: string[]
  narratorStyles: Array<{ id: CampaignAiSettings['narratorStyle']; label: string }>
  improvModes: Array<{ id: CampaignAiSettings['improvMode']; label: string; description: string }>
  architectGenerationsToday: number
  architectAlertThreshold: number
  canManage: boolean
  ruleset: CampaignRulesetSettings
  error?: string
}

export type RulesetProfileDescriptor = {
  id: 'dnd_5e_2014' | 'srd_5_2_1'
  version: string
  editionFamily: '5e_2014' | '5e_2024'
  label: string
  description: string
  mechanicsStatus: 'partial'
  availability: 'preview' | 'active'
  limitations: string[]
  ruleCount?: number
}

export type CampaignRulesetSettings = {
  current: {
    id: RulesetProfileDescriptor['id']
    version: string
    label: string
    mechanicsStatus: 'partial'
    availability: 'preview' | 'active'
  }
  available: RulesetProfileDescriptor[]
  canChange: boolean
  locked: boolean
  lockReason: string | null
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
  ruleset_id: RulesetProfileDescriptor['id']
  edition_family: RulesetProfileDescriptor['editionFamily']
  import_schema: 'skazanie.character'
  import_schema_version: 1
  ability_policy: {
    policy_id: string
    policy_version: number
    method: 'standard_array'
    bonus_source: 'background' | 'species'
    standard_array: number[]
    origin_bonus_profiles: Array<{
      id: string
      label: string
      bonuses: number[]
      fixed_bonuses?: Partial<CharacterAbilityScores>
      choice_count?: number
      choice_amount?: number
      excluded_choices?: string[]
    }>
    species_options: Array<{
      id: string
      label: string
      race_id?: string
      race_label?: string
      subrace_id?: string | null
      subrace_label?: string | null
      base_speed: number
      size?: 'small' | 'medium'
      bonus_profile_id?: string
      languages?: string[]
      language_choice_count?: number
      trait_summaries?: string[]
      choice_groups?: Array<{
        id: string
        label: string
        kind: 'language' | 'skill' | 'tool' | 'cantrip' | 'ancestry'
        count: number
        options: Array<{
          id: string
          label: string
          damage_type?: string
          shape?: 'line' | 'cone'
          distance_feet?: number
        }>
      }>
      mechanics?: Record<string, unknown>
      source_url?: string
    }>
  }
  /** Последствия предыстории сервер пересчитывает по id выбранного ruleset. */
  backgrounds?: {
    policy_id: string
    ability_modes: Array<{ id: string; label: string; increases: number[] }>
    language_options: Array<{ id: string; name: string }>
    options: Array<{
      id: string
      name: string
      englishName: string
      summary: string
      abilityOptions: string[]
      skillProficiencies: string[]
      toolProficiency?: { id: string; name: string } | null
      toolProficiencies: Array<{ id: string; name: string }>
      toolChoice?: { group: string; count: number; options: Array<{ id: string; name: string; catalogId?: string }> }
      languageChoiceCount?: number
      originFeat?: { id: string; name: string } | null
      feature?: { id: string; name: string; supported: boolean } | null
      equipment: { summary: string; gold: number; alternativeGold?: number } | null
      sourceUrl?: string
    }>
    /** Черта происхождения записывается, но движком пока не исполняется. */
    origin_feats_supported: boolean
    background_features_supported: boolean
  }
  starter_equipment?: {
    schema_version: number
    ruleset_id: string
    policy_id: string
    policy_version: number
    choice_policy: string
    classes: Array<StarterEquipmentClass>
  } | null
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
    starter_equipment: StarterEquipmentClass | null
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

export type StarterEquipmentItem = {
  catalog_id?: string
  name?: string
  description?: string
  quantity?: number
  equipped?: boolean
}

export type StarterEquipmentClass = {
  class_id: DndClassKey
  fixed_items?: StarterEquipmentItem[]
  fixed_narrative_items?: StarterEquipmentItem[]
  choice_groups: Array<{
    id: string
    label: string
    count: number
    options: Array<{
      id: string
      label: string
      summary: string
      items?: StarterEquipmentItem[]
      narrative_items?: StarterEquipmentItem[]
    }>
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
