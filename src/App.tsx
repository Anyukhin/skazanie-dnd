import { useEffect, useRef, useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronRight, Copy, Crown, DoorOpen,
  Dices, Flame, Footprints, Gem, History, Menu, MessageSquare,
  Minus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw,
  ScrollText, Send, Settings, Shield, Sparkles, Swords, Target, Users, X,
  BrainCircuit, Check, SlidersHorizontal, Wifi, WifiOff,
  Heart,
  LockKeyhole, LogOut, ShieldCheck, RefreshCw, Store,
  Bot, PawPrint, Skull, WandSparkles,
} from 'lucide-react'
import type { Account, AgentInteraction, AiHealth, CampaignSummary, CombatMechanics, CombatSpell, EncounterProposal, Enemy, GameState, MapCell, Merchant, PendingCheck, Player, SummonedCreature } from './types'
import { getAiHealth } from './ai-client'
import { useAuth } from './auth-client'
import { AuthScreen } from './AuthScreen'
import { CharacterEditor, InventoryView } from './InventoryViews'
import { DiceTray } from './DiceTray'
import { useGameSession, type EncounterAssemblyOptions, type ShopAssemblyOptions } from './useGameSession'
import { CELL_FEET, currentTacticalTurn, mapGridDimensions, reachableCells } from './tactical-engine'
import { AgentLabView } from './AgentLabView'
import { MerchantScreen } from './MerchantView'

type View = 'room' | 'journal' | 'characters' | 'inventory' | 'merchant' | 'settings' | 'admin' | 'agent-lab'

const UI_SCALE_KEY = 'skazanie-ui-scale-v2'
const UI_SCALE_MIN = 80
const UI_SCALE_MAX = 150
const UI_SCALE_PRESETS = [80, 90, 100, 110, 115, 125, 150]
const BASE_ATTACK_ID = '__base-attack__'

type BoardCombatant = Player | SummonedCreature
type CombatMode = 'weapon' | 'magic'

function spellKind(spell?: CombatSpell | null): CombatSpell['kind'] | null {
  if (!spell) return null
  const raw = String(spell.kind ?? spell.targetType ?? '')
  if (raw === 'ally') return 'healing'
  if (raw === 'cell') return 'summon'
  if (raw === 'enemy') return 'attack'
  return raw === 'attack' || raw === 'save' || raw === 'healing' || raw === 'summon' ? raw : null
}

function spellRange(spell?: CombatSpell | null) {
  return Math.max(0, Number(spell?.range ?? spell?.rangeFeet ?? spell?.range_feet) || 0)
}

function spellActionType(spell?: CombatSpell | null): CombatSpell['actionType'] {
  const value = spell?.actionType ?? spell?.action_type
  return value === 'bonus_action' || value === 'reaction' ? value : 'action'
}

function chebyshevFeet(from: { x: number; y: number }, to: { x: number; y: number }) {
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * CELL_FEET
}

function reachableBoardCells(state: GameState, actor: BoardCombatant, remainingFeet: number) {
  const result = new Set<string>()
  const maxSteps = Math.max(0, Math.floor(remainingFeet / CELL_FEET))
  if (!maxSteps) return result
  const key = (x: number, y: number) => `${x},${y}`
  const cells = new Map(state.scene.cells.map((cell) => [key(cell.x, cell.y), cell]))
  const occupied = new Set<string>()
  state.players.forEach((item) => { if (item.id !== actor.id && item.hp > 0) occupied.add(key(item.x, item.y)) })
  ;(state.enemies ?? []).forEach((item) => { if (item.id !== actor.id && item.alive) occupied.add(key(item.x, item.y)) })
  ;(state.actors ?? []).forEach((item) => { if (item.id !== actor.id && item.alive) occupied.add(key(item.x, item.y)) })
  const start = key(actor.x, actor.y)
  const queue: Array<{ x: number; y: number; steps: number }> = [{ x: actor.x, y: actor.y, steps: 0 }]
  const visited = new Set([start])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current.steps >= maxSteps) continue
    for (const [x, y] of [[current.x + 1, current.y], [current.x - 1, current.y], [current.x, current.y + 1], [current.x, current.y - 1]]) {
      const position = key(x, y)
      const cell = cells.get(position)
      if (visited.has(position) || occupied.has(position) || !cell?.revealed || (cell.type !== 'floor' && cell.type !== 'door')) continue
      visited.add(position)
      result.add(position)
      queue.push({ x, y, steps: current.steps + 1 })
    }
  }
  return result
}

function canonicalLocationKey(value: unknown) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 180).toLocaleLowerCase('ru')
}

function locationsMatch(left: unknown, right: unknown) {
  return canonicalLocationKey(left) === canonicalLocationKey(right)
}

function merchantIsAtLocation(merchantLocation: unknown, sceneLocation: unknown) {
  const merchantKey = canonicalLocationKey(merchantLocation)
  return !merchantKey || merchantKey === canonicalLocationKey(sceneLocation)
}

function combatState(state: GameState): CombatMechanics {
  return state.mechanics?.combat ?? {}
}

function currentTurnActorId(state: GameState) {
  const combat = combatState(state)
  if (state.engine_mode !== 'enforce' || !combat.active || !combat.initiative?.length) return state.activePlayerId
  return combat.initiative[Math.max(0, Number(combat.active_index) || 0)]?.actor_id ?? state.activePlayerId
}

function inferredCombatItem(item: Player['inventory'][number]) {
  if (item.combat) return item
  const text = `${item.name} ${item.properties}`.toLocaleLowerCase('ru')
  const combat = /динамит|dynamite/u.test(text)
    ? { kind: 'thrown-area' as const, ability: 'dex' as const, damage: '3d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex' as const, saveDc: 12, halfOnSave: true }
    : /гранат|бомб|grenade|bomb/u.test(text)
      ? { kind: 'thrown-area' as const, ability: 'dex' as const, damage: '2d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex' as const, saveDc: 12, halfOnSave: true }
      : /арбалет|crossbow/u.test(text)
        ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d8', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
        : /длинн.{0,3}лук|longbow/u.test(text)
          ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600, twoHanded: true, ammunition: true }
          : /лук|bow/u.test(text)
            ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
            : null
  return combat ? { ...item, combat } : null
}

function loadUiScale() {
  const saved = Number(window.localStorage.getItem(UI_SCALE_KEY))
  return Number.isFinite(saved) && saved >= UI_SCALE_MIN && saved <= UI_SCALE_MAX ? saved : 115
}

const clampUiScale = (value: number) => Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value / 5) * 5))

const featureIcons: Record<NonNullable<MapCell['feature']>, React.ReactNode> = {
  chest: <Gem size={16} />,
  altar: <Flame size={17} />,
  torch: <Flame size={15} />,
  rune: <Sparkles size={16} />,
  stairs: <Footprints size={17} />,
  enemy: <Swords size={17} />,
}

const techFeatureIcons: Record<NonNullable<MapCell['feature']>, React.ReactNode> = {
  chest: <Store size={16} />,
  altar: <BrainCircuit size={17} />,
  torch: <Wifi size={15} />,
  rune: <Target size={16} />,
  stairs: <DoorOpen size={17} />,
  enemy: <Swords size={17} />,
}

function Logo() {
  return <div className="logo"><div className="logo-mark"><Dices size={21} /></div><span>СКАЗАНИЕ</span></div>
}

function PlayerCard({ player, selected, turn, accessible, onClick }: { player: Player; selected: boolean; turn: boolean; accessible: boolean; onClick: () => void }) {
  return (
    <button className={`player-card ${selected ? 'active' : ''} ${accessible ? '' : 'locked'}`} onClick={onClick} disabled={!accessible}>
      <div className="avatar portrait-avatar" style={{ '--avatar': player.color, backgroundImage: `url(${player.portrait})`, backgroundPosition: player.portraitPosition } as React.CSSProperties}>
        <span className={`presence ${player.online ? 'online' : ''}`} />
      </div>
      <div className="player-meta">
        <div className="player-name-row"><strong>{player.character}</strong>{turn && <Crown size={12} />}{!accessible && <LockKeyhole size={11} />}</div>
        <span>{player.role}</span>
        <div className="hp-line"><i style={{ width: `${player.hp / player.maxHp * 100}%` }} /><small>{player.hp}/{player.maxHp}</small></div>
      </div>
      <Shield className="armor-icon" size={15} /><b className="armor-value">{player.armor}</b>
    </button>
  )
}

function Sidebar({ players, selectedPlayerId, turnPlayerId, accessibleHeroIds, merchantAvailable, isAdmin, onSelect, collapsed, onToggle, view, onNavigate, aiConnected }: {
  players: Player[]; selectedPlayerId: string; turnPlayerId: string; accessibleHeroIds: string[]; merchantAvailable: boolean; isAdmin: boolean; onSelect: (id: string) => void; collapsed: boolean; onToggle: () => void; view: View; onNavigate: (view: View) => void; aiConnected: boolean
}) {
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-top">
        <Logo />
        <button
          className="icon-button collapse-button"
          onClick={onToggle}
          aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
        >
          {collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
        </button>
      </div>
      <nav className="main-nav">
        <button className={`nav-item ${view === 'room' ? 'active' : ''}`} data-tooltip="Игровая комната" aria-label="Игровая комната" onClick={() => onNavigate('room')}><MapSymbol /><span>Игровая комната</span></button>
        <button className={`nav-item ${view === 'journal' ? 'active' : ''}`} data-tooltip="Журнал кампании" aria-label="Журнал кампании" onClick={() => onNavigate('journal')}><ScrollText size={18} /><span>Журнал кампании</span></button>
        <button className={`nav-item ${view === 'characters' ? 'active' : ''}`} data-tooltip="Персонажи" aria-label="Персонажи" onClick={() => onNavigate('characters')}><BookOpen size={18} /><span>Персонажи</span></button>
        <button className={`nav-item ${view === 'inventory' ? 'active' : ''}`} data-tooltip="Инвентарь" aria-label="Инвентарь" onClick={() => onNavigate('inventory')}><BackpackIcon /><span>Инвентарь</span></button>
        <button className={`nav-item ${view === 'merchant' ? 'active' : ''} ${merchantAvailable ? '' : 'unavailable'}`} data-tooltip={merchantAvailable ? 'Доступный торговец' : 'В этой локации нет торговца'} aria-label="Торговец" onClick={() => onNavigate('merchant')}><Store size={18} /><span>Торговец</span>{merchantAvailable && <i className="merchant-nav-dot" />}</button>
        {isAdmin && <button className={`nav-item ${view === 'admin' ? 'active' : ''}`} data-tooltip="Управление миром" aria-label="Управление миром" onClick={() => onNavigate('admin')}><ShieldCheck size={18} /><span>Управление миром</span></button>}
        {isAdmin && <button className={`nav-item ${view === 'agent-lab' ? 'active' : ''}`} data-tooltip="Лаборатория агентов" aria-label="Открыть лабораторию агентов в отдельном окне" onClick={() => { const url = new URL(window.location.href); url.searchParams.set('agentLab', '1'); window.open(url.toString(), 'skazanie-agent-lab', 'width=1500,height=950') }}><BrainCircuit size={18} /><span>Лаборатория агентов</span></button>}
      </nav>
      <div className="sidebar-section">
        <div className="section-label"><span>ОТРЯД · {players.filter(p => p.online).length} В СЕТИ</span><MoreHorizontal size={17} /></div>
        <div className="players-list">
          {players.map((player) => <PlayerCard key={player.id} player={player} selected={player.id === selectedPlayerId} turn={player.id === turnPlayerId} accessible={accessibleHeroIds.includes(player.id)} onClick={() => onSelect(player.id)} />)}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} data-tooltip="Настройки" aria-label="Настройки" onClick={() => onNavigate('settings')}><Settings size={18} /><span>Настройки</span></button>
        <div className={`demo-badge ${aiConnected ? 'connected' : ''}`}><Sparkles size={14} /><span><b>{aiConnected ? 'Агент подключён' : 'Демо-режим'}</b><small>{aiConnected ? 'RouterAI · инструменты' : 'Локальный рассказчик'}</small></span></div>
      </div>
    </aside>
  )
}

function MapSymbol() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>
}

function BackpackIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 8V6a5 5 0 0 1 10 0v2M5 9h14l1 12H4L5 9Z"/><path d="M8 13h8v5H8z"/></svg>
}

type EnemyVisualKind = 'construct' | 'undead' | 'beast' | 'mystic' | 'raider'

function enemyVisualKind(enemy: Enemy): EnemyVisualKind {
  const signature = `${enemy.name} ${enemy.stat_block_id ?? ''}`.toLocaleLowerCase('ru')
  if (/(дрон|робот|андроид|автомат|мех|голем|конструкт|страж|construct|golem|guardian|drone|robot)/u.test(signature)) return 'construct'
  if (/(скелет|нежит|призрак|зомби|упыр|undead|skeleton|ghost|wraith|zombie)/u.test(signature)) return 'undead'
  if (/(волк|звер|крыса|паук|медвед|beast|wolf|rat|spider|bear)/u.test(signature)) return 'beast'
  if (/(маг|чарод|колдун|жрец|шаман|культист|mage|caster|warlock|cultist|shaman)/u.test(signature)) return 'mystic'
  return 'raider'
}

function EnemyGlyph({ kind }: { kind: EnemyVisualKind }) {
  if (kind === 'construct') return <Bot size={17} />
  if (kind === 'undead') return <Skull size={17} />
  if (kind === 'beast') return <PawPrint size={17} />
  if (kind === 'mystic') return <WandSparkles size={17} />
  return <Swords size={17} />
}

function boardVisualTheme(state: GameState) {
  const signature = [state.scene.location, state.scene.theme, state.campaignConcept?.era, state.campaignConcept?.technologyLevel].filter(Boolean).join(' ').toLocaleLowerCase('ru')
  if (/(станци|косм|орбит|кибер|техно|футур|звезд|sci.?fi|space|station)/u.test(signature)) return 'map-theme-tech'
  if (/(лес|чащ|джунг|болот|природ|роща|forest|wild|jungle|swamp)/u.test(signature)) return 'map-theme-wild'
  return 'map-theme-ruins'
}

function DungeonMap({ state, players, turnActorId, canAct, tacticalBusy, tacticalError, autoAttackRoll, onClearTacticalError, onStartCombat, onMove, onAttack, onAreaAttack, onCastSpell, onChangeWeapon, onFinishTurn }: {
  state: GameState
  players: Player[]
  turnActorId: string
  canAct: boolean
  tacticalBusy: boolean
  tacticalError: string | null
  autoAttackRoll: boolean
  onClearTacticalError: () => void
  onStartCombat: () => void
  onMove: (actorId: string, x: number, y: number) => void
  onAttack: (actorId: string, enemyId: string, itemId?: string) => void
  onAreaAttack: (actorId: string, itemId: string, x: number, y: number) => void
  onCastSpell: (actorId: string, spellId: string, target: { targetId: string } | { x: number; y: number }) => void
  onChangeWeapon: (actorId: string, itemId: string) => void
  onFinishTurn: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [combatMode, setCombatMode] = useState<CombatMode>('weapon')
  const [selectedItemId, setSelectedItemId] = useState(BASE_ATTACK_ID)
  const [selectedSpellId, setSelectedSpellId] = useState('')
  const [aimCell, setAimCell] = useState<{ x: number; y: number } | null>(null)
  const [pendingAttack, setPendingAttack] = useState<{ kind: 'target'; enemyId: string } | { kind: 'area'; x: number; y: number } | null>(null)
  const drag = useRef<{ pointerId: number; startX: number; startRotation: number } | null>(null)
  const { columns, rows } = mapGridDimensions(state.scene.cells)
  const rotationFit = 1 - .22 * Math.abs(Math.sin(rotation * Math.PI / 180))
  const enforce = state.engine_mode === 'enforce'
  const combat = combatState(state)
  const combatActive = Boolean(combat.active && combat.initiative?.length)
  const activeHero = players.find((player) => player.id === turnActorId)
  const activeSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const active: BoardCombatant | undefined = activeHero ?? activeSummon
  const activeName = activeHero?.character ?? activeSummon?.name ?? 'участник боя'
  const combatItems = (activeHero?.inventory ?? []).map(inferredCombatItem).filter((item): item is NonNullable<typeof item> => Boolean(item && item.quantity > 0))
  const selectedItem = selectedItemId === BASE_ATTACK_ID ? undefined : combatItems.find((item) => item.id === selectedItemId)
  const weaponSelectionId = selectedItem?.id ?? BASE_ATTACK_ID
  const spells = activeHero?.combatSpells ?? []
  const selectedSpell = spells.find((spell) => spell.id === selectedSpellId) ?? spells[0]
  const selectedSpellKind = spellKind(selectedSpell)
  const selectedSpellRange = spellRange(selectedSpell)
  const selectedSpellAction = spellActionType(selectedSpell)
  const activeResources = ((state.mechanics as { resources?: Record<string, Record<string, { current?: number; max?: number }>> } | undefined)?.resources?.[turnActorId] ?? {})
  const selectedSpellPool = selectedSpell?.slotResource ? activeResources[selectedSpell.slotResource] : undefined
  const spellSlotReady = !selectedSpell?.slotResource || Number(selectedSpellPool?.current ?? 0) > 0
  const genericProfile = active as (BoardCombatant & { attackRange?: number; rangeFeet?: number; attack_profile?: { kind?: 'melee' | 'ranged'; range_feet?: number; normal_range_feet?: number } }) | undefined
  const baseRangeFeet = Math.max(CELL_FEET, Number(genericProfile?.attack_profile?.range_feet ?? genericProfile?.attackRange ?? genericProfile?.rangeFeet) || CELL_FEET)
  const attackRangeFeet = Math.max(CELL_FEET, Number(selectedItem?.combat?.longRange ?? selectedItem?.combat?.normalRange) || baseRangeFeet)
  const normalRangeFeet = Math.max(CELL_FEET, Number(selectedItem?.combat?.normalRange ?? genericProfile?.attack_profile?.normal_range_feet) || attackRangeFeet)
  const areaRadiusFeet = selectedItem?.combat?.kind === 'thrown-area' ? Number(selectedItem.combat.radius) || 5 : 0
  const equippedWeapon = activeHero?.inventory.find((item) => item.type === 'weapon' && item.equipped)
  const needsWeaponChange = Boolean(selectedItem?.type === 'weapon' && !selectedItem.equipped && equippedWeapon && equippedWeapon.id !== selectedItem.id)
  const economy = combat.action_economy?.[turnActorId]
  const authoritativeMovementSpent = economy?.movement_remaining != null
    ? Math.max(0, (active?.speed ?? 0) - economy.movement_remaining)
    : economy?.movement_spent ?? (economy?.movement === false ? active?.speed ?? 0 : 0)
  const tacticalState = enforce ? {
    ...state,
    activePlayerId: turnActorId,
    tacticalTurn: {
      sceneTurn: state.scene.turn,
      actorId: turnActorId,
      movementSpent: authoritativeMovementSpent,
      actionUsed: economy?.action === false,
    },
  } : state
  const selected = canAct && !tacticalBusy && active ? turnActorId : null
  const tactical = currentTacticalTurn(tacticalState)
  const remainingFeet = Math.max(0, (active?.speed ?? 0) - tactical.movementSpent)
  const movementAvailable = !enforce || economy?.movement !== false
  const reachable = selected && active && movementAvailable
    ? enforce ? reachableBoardCells(state, active, remainingFeet) : activeHero ? reachableCells(tacticalState, selected) : new Set<string>()
    : new Set<string>()
  const actionReady = !tactical.actionUsed && (!enforce || economy?.action !== false)
  const bonusReady = !enforce || economy?.bonus_action !== false
  const reactionReady = !enforce || economy?.reaction !== false
  const spellEconomyReady = spellSlotReady && (selectedSpellAction === 'bonus_action' ? bonusReady : selectedSpellAction === 'reaction' ? reactionReady : actionReady)
  const selectedCommandReady = combatMode === 'magic' ? spellEconomyReady : actionReady
  const aliveEnemies = (state.enemies ?? []).filter((enemy) => enemy.alive)
  const showStartCombat = enforce && aliveEnemies.length > 0 && !combatActive
  const projectileTarget = pendingAttack?.kind === 'area' ? pendingAttack : aimCell
  const projectileEnd = pendingAttack?.kind === 'target'
    ? state.enemies?.find((enemy) => enemy.id === pendingAttack.enemyId) ?? null
    : projectileTarget
  const trajectory = active && projectileEnd ? { x1: (active.x + .5) / columns * 100, y1: (active.y + .5) / rows * 100, x2: (projectileEnd.x + .5) / columns * 100, y2: (projectileEnd.y + .5) / rows * 100 } : null
  const visualTheme = boardVisualTheme(state)

  useEffect(() => {
    const defaultItem = combatItems.find((item) => item.equipped) ?? combatItems[0]
    setSelectedItemId(defaultItem?.id ?? BASE_ATTACK_ID)
    setSelectedSpellId(spells[0]?.id ?? '')
    setCombatMode('weapon')
  }, [turnActorId])
  useEffect(() => {
    if (selectedSpell && selectedSpell.id !== selectedSpellId) setSelectedSpellId(selectedSpell.id)
  }, [selectedSpell?.id, selectedSpellId])
  useEffect(() => { setPendingAttack(null); setAimCell(null) }, [selectedItemId, selectedSpellId, combatMode, turnActorId, combat.round])

  const chooseTarget = (enemyId: string) => {
    if (!selected || needsWeaponChange || selectedItem?.combat?.kind === 'thrown-area') return
    if (autoAttackRoll) onAttack(selected, enemyId, selectedItem?.id)
    else setPendingAttack({ kind: 'target', enemyId })
  }
  const chooseArea = (x: number, y: number) => {
    if (!selected || !selectedItem || selectedItem.combat?.kind !== 'thrown-area') return
    if (autoAttackRoll) onAreaAttack(selected, selectedItem.id, x, y)
    else setPendingAttack({ kind: 'area', x, y })
  }
  const castAtTarget = (targetId: string) => {
    if (!selected || !selectedSpell || !spellEconomyReady) return
    onCastSpell(selected, selectedSpell.id, { targetId })
  }
  const castAtCell = (x: number, y: number) => {
    if (!selected || !selectedSpell || selectedSpellKind !== 'summon' || !spellEconomyReady) return
    onCastSpell(selected, selectedSpell.id, { x, y })
  }
  const rollPreparedAttack = () => {
    if (!selected || !pendingAttack) return
    if (pendingAttack.kind === 'target') onAttack(selected, pendingAttack.enemyId, selectedItem?.id)
    else if (selectedItem) onAreaAttack(selected, selectedItem.id, pendingAttack.x, pendingAttack.y)
    setPendingAttack(null)
  }

  const startRotation = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, .map-cell.move-target')) return
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startRotation: rotation }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const moveRotation = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    event.preventDefault()
    setRotation(drag.current.startRotation + (event.clientX - drag.current.startX) * .45)
  }
  const stopRotation = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
    setDragging(false)
  }

  return (
    <div className={`map-stage ${visualTheme}`}>
      <div className="map-atmosphere map-atmosphere-one" />
      <div className="map-atmosphere map-atmosphere-two" />
      <div
        className={'map-scroll ' + (dragging ? 'dragging' : '')}
        style={{ transform: 'scale(' + zoom * rotationFit + ') rotate(' + rotation + 'deg)' }}
        onPointerDown={startRotation}
        onPointerMove={moveRotation}
        onPointerUp={stopRotation}
        onPointerCancel={stopRotation}
        role="group"
        aria-label={`Тактическая карта. Активный участник: ${activeName}`}
      >
        <div className="map-grid" style={{ gridTemplateColumns: 'repeat(' + columns + ', var(--cell))', gridTemplateRows: 'repeat(' + rows + ', var(--cell))' }}>
          {trajectory && <svg className="projectile-trajectory" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1={trajectory.x1} y1={trajectory.y1} x2={trajectory.x2} y2={trajectory.y2} /></svg>}
          {state.scene.cells.map((cell) => {
            const player = players.find((item) => item.x === cell.x && item.y === cell.y && item.hp > 0)
            const enemy = state.enemies?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
            const summon = state.actors?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
            const attackDistanceFeet = enemy && active
              ? chebyshevFeet(active, enemy)
              : Number.POSITIVE_INFINITY
            const spellDistanceFeet = enemy && active ? chebyshevFeet(active, enemy) : Number.POSITIVE_INFINITY
            const enemyInWeaponRange = attackDistanceFeet >= CELL_FEET && attackDistanceFeet <= attackRangeFeet
            const enemyInSpellRange = spellDistanceFeet <= selectedSpellRange
            const canWeaponTargetEnemy = Boolean(selected && combatMode === 'weapon' && actionReady && enemyInWeaponRange && selectedItem?.combat?.kind !== 'thrown-area' && !needsWeaponChange)
            const canSpellTargetEnemy = Boolean(selected && combatMode === 'magic' && selectedSpell && (selectedSpellKind === 'attack' || selectedSpellKind === 'save') && spellEconomyReady && enemyInSpellRange)
            const cellKey = cell.x + ',' + cell.y
            const canMoveHere = reachable.has(cellKey)
            const canThrowHere = Boolean(selected && combatMode === 'weapon' && actionReady && selectedItem?.combat?.kind === 'thrown-area' && active && chebyshevFeet(active, cell) <= normalRangeFeet && cell.revealed && cell.type !== 'wall')
            const occupied = Boolean(player || enemy || summon)
            const canSummonHere = Boolean(selected && combatMode === 'magic' && selectedSpell && selectedSpellKind === 'summon' && spellEconomyReady && active && chebyshevFeet(active, cell) <= selectedSpellRange && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && !occupied)
            const canAimHere = canThrowHere || canSummonHere
            const inBlastArea = Boolean(projectileTarget && areaRadiusFeet && chebyshevFeet(projectileTarget, cell) <= areaRadiusFeet)
            const cellIsInteractive = (canMoveHere || canAimHere) && !occupied
            const CellElement: 'button' | 'div' = cellIsInteractive ? 'button' : 'div'
            const cellFeedback = (state.mapFeedback ?? []).filter((item) => item.x === cell.x && item.y === cell.y)
            const cellLabel = canSummonHere ? `Призвать ${selectedSpell?.summon?.name ?? selectedSpell?.summonName ?? 'существо'} в клетку ${cell.x}, ${cell.y}` : canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку ${cell.x}, ${cell.y}` : canMoveHere ? `Переместить ${activeName} в клетку ${cell.x}, ${cell.y}` : undefined
            const enemyKind = enemy ? enemyVisualKind(enemy) : null
            return (
              <CellElement
                key={cell.x + '-' + cell.y}
                type={cellIsInteractive ? 'button' : undefined}
                className={'map-cell ' + cell.type + ' parity-' + ((cell.x + cell.y) % 2 ? 'odd' : 'even') + ' ' + (cell.revealed ? '' : 'hidden') + ' ' + (canMoveHere && !canAimHere ? 'move-target' : '') + ' ' + (canAimHere ? 'aim-target' : '') + ' ' + (canSummonHere ? 'summon-target' : '') + ' ' + (inBlastArea ? 'blast-area' : '')}
                data-cell={cellKey}
                aria-label={cellLabel}
                onPointerEnter={() => { if (canAimHere) setAimCell({ x: cell.x, y: cell.y }) }}
                onPointerLeave={() => { if (canAimHere && !pendingAttack) setAimCell(null) }}
                onPointerDown={(event) => { if (canMoveHere || canAimHere) event.stopPropagation() }}
                onPointerUp={(event) => { if (canMoveHere || canAimHere) event.stopPropagation() }}
                onClick={(event) => {
                  if (!selected || (!canMoveHere && !canAimHere)) return
                  event.stopPropagation()
                  if (canSummonHere) castAtCell(cell.x, cell.y)
                  else if (canThrowHere) chooseArea(cell.x, cell.y)
                  else onMove(selected, cell.x, cell.y)
                }}
                onKeyDown={(event) => {
                  if (!selected || (!canMoveHere && !canAimHere) || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  if (canSummonHere) castAtCell(cell.x, cell.y)
                  else if (canThrowHere) chooseArea(cell.x, cell.y)
                  else onMove(selected, cell.x, cell.y)
                }}
              >
                {cell.revealed && cell.feature && cell.feature !== 'enemy' && <span className={'feature ' + cell.feature}>{(visualTheme === 'map-theme-tech' ? techFeatureIcons : featureIcons)[cell.feature]}</span>}
                {enemy && cell.revealed && (
                  <button
                    className={'enemy-token ' + (canWeaponTargetEnemy || canSpellTargetEnemy || canThrowHere ? 'targetable' : '')}
                    data-enemy-kind={enemyKind}
                    style={{ '--counter-rotation': -rotation + 'deg' } as React.CSSProperties}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                    onMouseEnter={() => setAimCell({ x: enemy.x, y: enemy.y })}
                    onMouseLeave={() => { if (!pendingAttack) setAimCell(null) }}
                    onClick={(event) => { event.stopPropagation(); if (canThrowHere) chooseArea(cell.x, cell.y); else if (canSpellTargetEnemy) castAtTarget(enemy.id); else if (canWeaponTargetEnemy) chooseTarget(enemy.id) }}
                    disabled={tacticalBusy || (!canWeaponTargetEnemy && !canSpellTargetEnemy && !canThrowHere)}
                    aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${enemy.name}` : `${canSpellTargetEnemy ? 'Наложить заклинание на' : 'Атаковать'} ${enemy.name}, ${enemy.hp} из ${enemy.maxHp} ОЗ`}
                    title={!selectedCommandReady ? 'Нужная часть экономики хода уже потрачена' : combatMode === 'magic' ? !selectedSpell ? 'У героя нет боевых заклинаний' : !enemyInSpellRange ? `Цель вне дальности (${selectedSpellRange} фт)` : selectedSpellKind === 'healing' ? 'Лечение выбирает союзника' : selectedSpellKind === 'summon' ? 'Призыв выбирает свободную клетку' : `Сотворить «${selectedSpell.name}»` : needsWeaponChange ? 'Сначала смените экипированное оружие' : !enemyInWeaponRange ? `Цель вне дальности (${attackRangeFeet} фт)` : attackDistanceFeet > normalRangeFeet ? 'Дальний диапазон: бросок с помехой' : selectedItem ? `Атаковать: ${selectedItem.name}` : 'Базовая атака'}
                  >
                    <span className="enemy-emblem"><EnemyGlyph kind={enemyKind ?? 'raider'} /></span>
                    <span className="enemy-nameplate">{enemy.name}</span>
                    <span className="enemy-health"><i style={{ width: enemy.hp / enemy.maxHp * 100 + '%' }} /></span>
                    <small className="enemy-health-value">{enemy.hp}</small>
                  </button>
                )}
                {player && cell.revealed && (() => {
                  const healingDistance = active ? chebyshevFeet(active, player) : Number.POSITIVE_INFINITY
                  const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && selectedSpellKind === 'healing' && spellEconomyReady && healingDistance <= selectedSpellRange)
                  return <button
                    className={'map-token hero-token ' + (selected === player.id ? 'selected' : '') + ' ' + (player.id === turnActorId ? 'active-turn' : '') + ' ' + (canHeal ? 'targetable healing-target' : '')}
                    style={{ '--token': player.color, '--counter-rotation': -rotation + 'deg', backgroundImage: 'url(' + player.portrait + ')', backgroundPosition: player.portraitPosition } as React.CSSProperties}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                    onMouseEnter={() => { if (canHeal) setAimCell({ x: player.x, y: player.y }) }}
                    onMouseLeave={() => { if (!pendingAttack) setAimCell(null) }}
                    onClick={(event) => { event.stopPropagation(); if (canThrowHere) chooseArea(cell.x, cell.y); else if (canHeal) castAtTarget(player.id) }}
                    aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${player.character}` : canHeal ? `Наложить ${selectedSpell?.name} на ${player.character}` : player.character + (player.id === turnActorId ? ', активный герой' : '')}
                    aria-disabled={!canHeal && !canThrowHere}
                    title={canHeal ? `Исцелить: ${selectedSpell?.name}` : undefined}
                  >
                    <span className="map-token-hp"><i style={{ width: Math.max(0, player.hp / player.maxHp * 100) + '%' }} /></span>
                    <small className="map-token-hp-value">{player.hp}</small>
                    {selected === player.id && <span className="token-label">{player.character}<small>{player.hp} ОЗ · {remainingFeet} фт</small></span>}
                  </button>
                })()}
                {summon && cell.revealed && (() => {
                  const healingDistance = active ? chebyshevFeet(active, summon) : Number.POSITIVE_INFINITY
                  const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && selectedSpellKind === 'healing' && spellEconomyReady && healingDistance <= selectedSpellRange)
                  return <button
                    className={'map-token summon-token ' + (selected === summon.id ? 'selected active-turn' : '') + ' ' + (canHeal ? 'targetable healing-target' : '')}
                    style={{ '--token': '#70a78b', '--counter-rotation': -rotation + 'deg' } as React.CSSProperties}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                    onMouseEnter={() => { if (canHeal) setAimCell({ x: summon.x, y: summon.y }) }}
                    onMouseLeave={() => { if (!pendingAttack) setAimCell(null) }}
                    onClick={(event) => { event.stopPropagation(); if (canThrowHere) chooseArea(cell.x, cell.y); else if (canHeal) castAtTarget(summon.id) }}
                    aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${summon.name}` : canHeal ? `Наложить ${selectedSpell?.name} на ${summon.name}` : `${summon.name}, призванный союзник${summon.id === turnActorId ? ', активный участник' : ''}`}
                    aria-disabled={!canHeal && !canThrowHere}
                    title={canHeal ? `Исцелить: ${selectedSpell?.name}` : `Призвано заклинанием ${summon.sourceSpellId}`}
                  >
                    <Sparkles size={15} />
                    <span className="map-token-hp"><i style={{ width: Math.max(0, summon.hp / summon.maxHp * 100) + '%' }} /></span>
                    <small className="map-token-hp-value">{summon.hp}</small>
                    {selected === summon.id && <span className="token-label">{summon.name}<small>{summon.hp} ОЗ · {remainingFeet} фт</small></span>}
                  </button>
                })()}
                {cellFeedback.map((item) => <span key={item.id} className={'map-feedback ' + item.kind}>{item.text}</span>)}
              </CellElement>
            )
          })}
        </div>
      </div>
      {combatActive && <section className="initiative-ribbon" aria-label={`Раунд ${combat.round ?? 1}, порядок инициативы`} aria-live="polite">
        <header>РАУНД <b>{combat.round ?? 1}</b></header>
        <ol>{combat.initiative?.map((entry, index) => {
          const hero = state.players.find((player) => player.id === entry.actor_id)
          const enemy = state.enemies?.find((item) => item.id === entry.actor_id)
          const summon = state.actors?.find((item) => item.id === entry.actor_id)
          const kind = summon ? 'summon' : enemy ? 'enemy' : 'hero'
          const name = hero?.character ?? summon?.name ?? enemy?.name ?? entry.actor_id
          const defeated = hero ? hero.hp <= 0 : summon ? !summon.alive || summon.hp <= 0 : enemy ? !enemy.alive || enemy.hp <= 0 : false
          return <li key={entry.actor_id} className={`${kind} ${index === combat.active_index ? 'active' : ''} ${defeated ? 'defeated' : ''}`} aria-current={index === combat.active_index ? 'step' : undefined} title={`${name}: инициатива ${entry.total ?? 'не указана'}`}>
            <span>{index + 1}</span><strong>{name}</strong><small>{kind === 'hero' ? 'ГЕРОЙ' : kind === 'enemy' ? 'ВРАГ' : 'ПРИЗЫВ'}</small>{entry.total != null && <em>{entry.total}</em>}
          </li>
        })}</ol>
      </section>}
      <div className="map-legend">
        <span><i className="legend-dot party" />Отряд</span><span><i className="legend-dot summon" />Призыв</span><span><i className="legend-dot danger" />Враг</span><span><i className="legend-dot interest" />Интерес</span>
      </div>
      <div className="tactical-control" aria-label={`Управление ходом: ${activeName}`}>
        {!enforce && aliveEnemies.length > 0 && <div className="combat-mode-notice" role="note"><ShieldCheck size={13} /><span><b>Ограниченный режим боя</b><small>Для инициативы, магии и призывов включите «enforce» в управлении миром.</small></span></div>}
        <div className="combat-mode-tabs" role="tablist" aria-label="Тип боевого действия">
          <button role="tab" aria-selected={combatMode === 'weapon'} className={combatMode === 'weapon' ? 'active' : ''} onClick={() => setCombatMode('weapon')} disabled={!active || tacticalBusy}><Swords size={13} />Оружие</button>
          <button role="tab" aria-selected={combatMode === 'magic'} className={combatMode === 'magic' ? 'active' : ''} onClick={() => setCombatMode('magic')} disabled={!spells.length || tacticalBusy} title={spells.length ? 'Открыть боевые заклинания' : 'У активного участника нет боевых заклинаний'}><Sparkles size={13} />Магия</button>
        </div>
        {combatMode === 'weapon' ? <label className="combat-item-picker"><Target size={14} /><span><small>ОРУЖИЕ / АТАКА</small><select value={weaponSelectionId} disabled={!active || tacticalBusy} onChange={(event) => setSelectedItemId(event.target.value)} aria-label="Выбрать оружие или базовую атаку"><option value={BASE_ATTACK_ID}>Базовая атака · {baseRangeFeet} фт</option>{combatItems.map((item) => <option key={item.id} value={item.id}>{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</option>)}</select></span></label>
          : <label className="combat-item-picker spell-picker"><Sparkles size={14} /><span><small>БОЕВАЯ МАГИЯ</small><select value={selectedSpell?.id ?? ''} disabled={!spells.length || tacticalBusy} onChange={(event) => setSelectedSpellId(event.target.value)} aria-label="Выбрать боевое заклинание">{spells.map((spell) => <option key={spell.id} value={spell.id}>{spell.name}</option>)}</select></span></label>}
        {combatMode === 'magic' && selectedSpell && <div className={`spell-summary ${spellSlotReady ? '' : 'unavailable'}`} role="note" aria-label={`Параметры заклинания ${selectedSpell.name}`}><strong>{selectedSpell.name}</strong><p>{!spellSlotReady ? 'Нет свободной ячейки нужного уровня.' : selectedSpell.description || (selectedSpellKind === 'summon' ? 'Выберите свободную клетку для призыва.' : selectedSpellKind === 'healing' ? 'Выберите союзника на карте.' : 'Выберите противника на карте.')}</p><div><span>{selectedSpellRange} фт</span><span>{(selectedSpell.slotLevel ?? selectedSpell.slot_level ?? selectedSpell.level ?? 0) > 0 ? `ячейка ${selectedSpell.slotLevel ?? selectedSpell.slot_level ?? selectedSpell.level}` : 'заговор'}</span>{selectedSpellPool && <span>{Number(selectedSpellPool.current ?? 0)}/{Number(selectedSpellPool.max ?? 0)} ячеек</span>}<span>{selectedSpell.concentration ? 'концентрация' : 'без концентрации'}</span><span>{selectedSpellAction === 'bonus_action' ? 'бонусное' : selectedSpellAction === 'reaction' ? 'реакция' : 'действие'}</span></div></div>}
        <div className="action-economy" aria-label="Экономика текущего хода">
          <span className={remainingFeet > 0 && movementAvailable ? 'ready' : 'spent'} title={`Осталось движения: ${remainingFeet} футов`}><Footprints size={13} /><small>ДВИЖЕНИЕ</small><b>{remainingFeet} фт</b></span>
          <span className={actionReady ? 'ready' : 'spent'} title={actionReady ? 'Действие доступно' : 'Действие потрачено'}><Swords size={13} /><small>ДЕЙСТВИЕ</small><b>{actionReady ? 'готово' : 'потрачено'}</b></span>
          <span className={bonusReady ? 'ready' : 'spent'} title={bonusReady ? 'Бонусное действие доступно' : 'Бонусное действие потрачено'}><Sparkles size={13} /><small>БОНУСНОЕ</small><b>{bonusReady ? 'готово' : 'потрачено'}</b></span>
          <span className={reactionReady ? 'ready' : 'spent'} title={reactionReady ? 'Реакция доступна' : 'Реакция потрачена'}><RefreshCw size={13} /><small>РЕАКЦИЯ</small><b>{reactionReady ? 'готова' : 'потрачена'}</b></span>
        </div>
        {combatMode === 'weapon' && <div className="weapon-timing"><small>{selectedItem ? needsWeaponChange ? `Сначала убрать ${equippedWeapon?.name}: смена займёт действие` : selectedItem.equipped ? 'Оружие уже в руках' : selectedItem.type === 'weapon' ? 'Достанется перед атакой · 0 ходов' : `Область ${areaRadiusFeet} фт · расходуется 1 шт.` : `Базовая атака · дальность ${baseRangeFeet} фт`}</small>{selectedItem && needsWeaponChange && <button disabled={!canAct || tacticalBusy || !actionReady} onClick={() => selected && onChangeWeapon(selected, selectedItem.id)}>Сменить оружие</button>}</div>}
        {pendingAttack && combatMode === 'weapon' && <button className="manual-attack-roll" disabled={tacticalBusy} onClick={rollPreparedAttack}><Dices size={15} />Бросить кубик атаки</button>}
        {showStartCombat
          ? <button className="start-combat-button" disabled={!canAct || tacticalBusy} onClick={onStartCombat}><Swords size={14} />Начать бой</button>
          : <button disabled={!canAct || tacticalBusy || (enforce && !combatActive)} onClick={onFinishTurn}><Check size={14} />Завершить ход</button>}
        {tacticalBusy && <p className="tactical-command-status"><RefreshCw className="spinning" size={12} />Сервер рассчитывает ход…</p>}
        {tacticalError && <div className="tactical-command-error" role="alert"><span>{tacticalError}</span><button onClick={onClearTacticalError} aria-label="Закрыть ошибку"><X size={12} /></button></div>}
      </div>
      <div className="zoom-control">
        <span className="map-drag-label">ЛКМ · ВРАЩЕНИЕ</span>
        <button onClick={() => setZoom(value => Math.max(.7, value - .1))} aria-label="Уменьшить масштаб карты"><Minus size={16} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(value => Math.min(1.3, value + .1))} aria-label="Увеличить масштаб карты"><Plus size={16} /></button>
      </div>
    </div>
  )
}
function SceneHeader({ title, location, objective, turn, chapter, onReset }: { title: string; location: string; objective: string; turn: number; chapter: number; onReset: () => void }) {
  return (
    <div className="scene-header">
      <div className="scene-title"><span>ГЛАВА {chapter} · ХОД {turn}</span><h1>{title}</h1><p><Target size={13} />{location}</p></div>
      <div className="objective"><small>ТЕКУЩАЯ ЦЕЛЬ</small><strong>{objective}</strong></div>
      <button className="icon-button reset-button" onClick={onReset} title="Начать демо заново"><RotateCcw size={17} /></button>
    </div>
  )
}

function DiceCheckCard({ check, onRoll, onCancel }: { check: PendingCheck; onRoll: () => void; onCancel: () => void }) {
  const rolling = check.status === 'rolling'
  const resolving = check.status === 'resolving'
  const shownValue = check.result?.value ?? (rolling ? '…' : 20)
  return (
    <div className={`dice-check ${rolling ? 'rolling' : ''} ${resolving ? 'resolving' : ''}`}>
      <div className="dice-copy">
        <span>ТРЕБУЕТСЯ ПРОВЕРКА</span>
        <strong>{check.label}</strong>
        <small>Сложность {check.difficulty} · модификатор {check.modifier >= 0 ? '+' : ''}{check.modifier}</small>
      </div>
      <button className="d20-button" onClick={onRoll} disabled={check.status !== 'ready'} aria-label={`Бросить d20: ${check.label}`}>
        <i><b>{shownValue}</b><small>d20</small></i>
        <span>{rolling ? 'Кость катится…' : resolving ? `Итого ${check.result?.total}` : 'Бросить кубик'}</span>
      </button>
      <button className="cancel-check" onClick={onCancel} disabled={check.status === 'rolling'}>{check.status === 'resolving' ? 'Отменить зависшее разрешение' : 'Отказаться от действия'}</button>
      <p>{resolving ? 'Рассказчик учитывает результат и продолжает сцену…' : 'Нажми на кость — результат будет честно определён сервером.'}</p>
    </div>
  )
}

function AgentInteractionCard({ interaction, players, playerId, canContinue, onVote, onRoll, onContinue }: {
  interaction: AgentInteraction
  players: Player[]
  playerId: string
  canContinue: boolean
  onVote: (optionId: string) => void
  onRoll: () => void
  onContinue: () => void
}) {
  const selected = interaction.votes[playerId]
  const resolved = interaction.status === 'resolved'
  const winner = interaction.options.find((option) => option.id === interaction.resolvedOptionId)
  return (
    <section className={['agent-interaction', 'agent-interaction--' + interaction.type, resolved ? 'resolved' : ''].join(' ')} aria-label="Групповое решение">
      <div className="agent-interaction__head">
        <span><BrainCircuit size={15} />Решение отряда</span>
        <strong>{interaction.title}</strong>
        <p>{interaction.description}</p>
      </div>
      {interaction.type === 'roll' ? (
        <button className="agent-roll" onClick={onRoll} disabled={resolved}>
          <Dices size={22} /><span><b>{resolved ? 'Выпало ' + (interaction.roll?.value ?? '?') : 'Бросить кубик судьбы'}</b><small>Сложность {interaction.difficulty ?? 12} · один бросок на отряд</small></span>
        </button>
      ) : (
        <div className="agent-options">
          {interaction.options.map((option) => {
            const votes = Object.values(interaction.votes).filter((vote) => vote === option.id).length
            return <button key={option.id} className={[selected === option.id ? 'selected' : '', winner?.id === option.id ? 'winner' : ''].join(' ')} onClick={() => onVote(option.id)} disabled={resolved}>
              <span>{option.label}</span><small>{votes} / {players.filter((player) => player.online).length}</small>
            </button>
          })}
        </div>
      )}
      {resolved && <button className="agent-continue" onClick={onContinue} disabled={!canContinue}><Sparkles size={14} />Продолжить историю: {winner?.label}</button>}
    </section>
  )
}

function ChatPanel({ messages, isNarrating, pendingCheck, interaction, players, currentPlayerId, canAct, canFinishTurn, turnName, onSend, onFinishTurn, onRoll, onCancelCheck, onVote, onRollInteraction, onContinueInteraction, open, onToggle, suggestions }: {
  messages: ReturnType<typeof useGameSession>['state']['messages']; isNarrating: boolean; pendingCheck: PendingCheck | null; interaction?: AgentInteraction | null; players: Player[]; currentPlayerId: string; canAct: boolean; canFinishTurn: boolean; turnName: string; onSend: (text: string) => void; onFinishTurn: () => void; onRoll: () => void; onCancelCheck: () => void; onVote: (optionId: string) => void; onRollInteraction: () => void; onContinueInteraction: () => void; open: boolean; onToggle: () => void; suggestions: string[]
}) {
  const [text, setText] = useState('')
  const [suggestionsOpen, setSuggestionsOpen] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isNarrating])

  const submit = () => {
    if (!text.trim()) return
    onSend(text)
    setText('')
  }

  if (!open) {
    return <button className="chat-closed" onClick={onToggle}><MessageSquare size={19} /><span>История</span><b>{messages.length}</b></button>
  }

  return (
    <section className="chat-panel">
      <div className="chat-head">
        <div><MessageSquare size={17} /><strong>История приключения</strong><span className="live-dot">В ЭФИРЕ</span></div>
        <button className="icon-button" onClick={onToggle} aria-label="Свернуть историю"><ChevronDown size={20} /></button>
      </div>
      <div className="messages">
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.speaker}`}>
            <div className="message-avatar">{message.speaker === 'narrator' ? <Sparkles size={15} /> : message.author.slice(0, 2).toUpperCase()}</div>
            <div className="message-body">
              <div className="message-meta"><strong>{message.author}</strong><time>{message.timestamp}</time></div>
              <p>{message.text}</p>
              {message.roll && (
                <div className={`roll-result ${message.roll.success ? 'success' : 'failure'}`}>
                  <Dices size={18} /><span><small>{message.roll.label}</small><b>d20: {message.roll.value} <i>+ {message.roll.modifier}</i></b></span><strong>{message.roll.total}</strong>
                  <em>{message.roll.success ? 'УСПЕХ' : 'ОСЛОЖНЕНИЕ'}</em>
                </div>
              )}
              {message.speaker === 'narrator' && message.turnConsumed != null && <small className={`turn-resolution ${message.turnConsumed ? 'spent' : 'kept'}`}>{message.turnConsumed ? 'Ход передан следующему герою' : 'Можно продолжить ход'}</small>}
            </div>
          </article>
        ))}
        {isNarrating && <div className="typing"><span /><span /><span /> Рассказчик меняет мир…</div>}
        <div ref={endRef} />
      </div>
      {interaction ? <div className="composer"><AgentInteractionCard interaction={interaction} players={players} playerId={currentPlayerId} canContinue={canAct} onVote={onVote} onRoll={onRollInteraction} onContinue={onContinueInteraction} /></div> : pendingCheck ? (canAct ? <DiceCheckCard check={pendingCheck} onRoll={onRoll} onCancel={onCancelCheck} /> : <div className="turn-wait"><LockKeyhole size={18} /><span><b>Бросок выполняет владелец героя</b><small>Ожидаем игрока: {turnName}</small></span></div>) : <div className="composer">
        <div className="suggestions-row">
          <button className="ideas-toggle" onClick={() => setSuggestionsOpen(value => !value)}><Sparkles size={14} />Идеи хода<ChevronRight className={suggestionsOpen ? 'rotated' : ''} size={14} /></button>
          {suggestionsOpen && suggestions.map((action) => <button key={action} onClick={() => setText(action)}>{action}</button>)}
        </div>
        <div className="input-row">
          <button className="end-turn-button" onClick={onFinishTurn} disabled={isNarrating || !canFinishTurn}><Check size={15} />Завершить ход</button>
          <div className="input-wrap">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }}
              placeholder={canAct ? 'Что делает ваш герой? Опишите действие своими словами…' : `Сейчас ходит ${turnName}`}
              rows={1}
              disabled={isNarrating || !canAct}
            />
            <span>Enter — отправить · Shift+Enter — новая строка</span>
          </div>
          <button className="send-button" onClick={submit} disabled={!text.trim() || isNarrating || !canAct} aria-label="Отправить действие"><Send size={19} /></button>
        </div>
      </div>}
    </section>
  )
}

function PlayerHud({ player, hazards = [], onCharacter, onInventory }: { player: Player; hazards?: Array<{ id: string; label?: string; severity?: string; description?: string }>; onCharacter: () => void; onInventory: () => void }) {
  return (
    <aside className="player-hud">
      <div className="hud-identity">
        <div className="hud-portrait" style={{ backgroundImage: `url(${player.portrait})`, backgroundPosition: player.portraitPosition }} />
        <span><small>ВАШ ГЕРОЙ</small><strong>{player.character}</strong><em>{player.role}</em></span>
      </div>
      <div className="hud-vitals">
        <span><Heart size={14} /><b>{player.hp}/{player.maxHp}</b><small>ЗДОРОВЬЕ</small></span>
        <span><Shield size={14} /><b>{player.armor}</b><small>КЛАСС БРОНИ</small></span>
        <span><Footprints size={14} /><b>{player.speed}</b><small>СКОРОСТЬ</small></span>
      </div>
      <div className="hud-actions">
        <button onClick={onCharacter}><BookOpen size={14} />Лист героя</button>
        <button onClick={onInventory}><BackpackIcon />Инвентарь <b>{player.inventory.length}</b></button>
      </div>
      {hazards.length > 0 && <div className="hud-hazards"><Flame size={13} /><span><small>АКТИВНАЯ ОПАСНОСТЬ</small><b>{hazards.map((hazard) => hazard.label || hazard.id).join(', ')}</b></span></div>}
    </aside>
  )
}

function InviteModal({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard?.writeText(`${location.origin}?room=${code}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть приглашение" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><Users size={23} /></div>
        <span className="eyebrow">ПРИГЛАШЕНИЕ В ОТРЯД</span>
        <h2 id="invite-modal-title">Соберите героев</h2>
        <p>Откройте эту ссылку в другой вкладке, чтобы проверить синхронизацию игрового состояния в MVP.</p>
        <div className="invite-code"><span>{code}</span><button onClick={copy}><Copy size={16} />{copied ? 'Скопировано' : 'Копировать'}</button></div>
        <small className="modal-note">В полной версии ссылка будет работать между разными устройствами.</small>
      </div>
    </div>
  )
}

function CampaignModal({ state, isAdmin, onSwitch, onClose }: { state: GameState; isAdmin: boolean; onSwitch: (code: string, room?: { version?: number; state?: GameState | null }) => Promise<void>; onClose: () => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([])
  const [heroLibrary, setHeroLibrary] = useState<Player[]>(state.players)
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [partyName, setPartyName] = useState('')
  const [code, setCode] = useState('')
  const [world, setWorld] = useState({ preset: '', era: '', genre: '', tone: '', premise: '', themes: '', boundaries: '', magicLevel: '', technologyLevel: '', startingLocation: '', openingSituation: '' })
  const [selectedHeroIds, setSelectedHeroIds] = useState<string[]>([])
  const [newHeroes, setNewHeroes] = useState<Player[]>([])
  const [heroDraft, setHeroDraft] = useState({ name: '', character: '', role: 'Искатель приключений', species: 'Человек', background: 'Странник', backstory: '', speed: '30', maxHp: '10', armor: '12' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const campaignsResponse = await fetch('/api/campaigns')
    const campaignsBody = await campaignsResponse.json() as { campaigns?: CampaignSummary[]; error?: string }
    if (!campaignsResponse.ok) throw new Error(campaignsBody.error || 'Не удалось загрузить кампании')
    setCampaigns(campaignsBody.campaigns ?? [])
    if (isAdmin) {
      const heroesResponse = await fetch('/api/heroes')
      const heroesBody = await heroesResponse.json() as { heroes?: Player[] }
      if (heroesResponse.ok && heroesBody.heroes?.length) setHeroLibrary(heroesBody.heroes)
    }
  }
  useEffect(() => { load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Ошибка загрузки')) }, [])

  const toggleHero = (heroId: string) => setSelectedHeroIds((current) => current.includes(heroId) ? current.filter((id) => id !== heroId) : [...current, heroId])
  const addHero = () => {
    if (!heroDraft.name.trim() || !heroDraft.character.trim() || !heroDraft.role.trim()) { setError('Укажите игрока, имя героя и его роль или класс.'); return }
    const character = heroDraft.character.trim()
    const index = newHeroes.length
    const hero: Player = {
      id: 'hero-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)).replace(/-/g, '').slice(0, 20),
      name: heroDraft.name.trim(), character, role: heroDraft.role.trim() + ' · ур. 1', species: heroDraft.species.trim() || 'Человек', background: heroDraft.background.trim() || 'Странник',
      alignment: 'Не определено', level: 1, experience: 0, speed: Math.max(5, Math.min(120, Number(heroDraft.speed) || 30)), proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, traits: '', ideals: '', bonds: '', flaws: '', backstory: heroDraft.backstory.trim(), features: '', notes: '',
      currency: { copper: 0, silver: 0, gold: 0, platinum: 0 }, inventory: [], hp: Math.max(1, Number(heroDraft.maxHp) || 10), maxHp: Math.max(1, Number(heroDraft.maxHp) || 10), armor: Math.max(1, Math.min(30, Number(heroDraft.armor) || 12)), online: true, x: 0, y: 0,
      color: ['#d79b5b', '#758f78', '#8b789e', '#9a745d'][index % 4], initials: character.slice(0, 2).toLocaleUpperCase('ru'), portrait: '/assets/party-portraits.png', portraitPosition: ['0% 0%', '100% 0%', '0% 100%', '100% 100%'][index % 4],
    }
    setNewHeroes((current) => [...current, hero])
    setSelectedHeroIds((current) => [...current, hero.id])
    setHeroDraft({ name: '', character: '', role: 'Искатель приключений', species: 'Человек', background: 'Странник', backstory: '', speed: '30', maxHp: '10', armor: '12' })
    setError('')
  }

  const validateStep = () => {
    setError('')
    if (step === 1 && code && !/^[A-Z0-9-]{3,24}$/.test(code)) { setError('Код комнаты должен содержать 3–24 латинских буквы, цифры или дефисы — либо оставьте его пустым для автогенерации.'); return false }
    if (step === 2 && selectedHeroIds.length < 1) { setError('Выберите существующего героя или создайте нового.'); return false }
    return true
  }

  const create = async () => {
    if (!validateStep()) return
    const allHeroes = [...heroLibrary, ...newHeroes]
    const players = selectedHeroIds.map((id) => allHeroes.find((hero) => hero.id === id)).filter((hero): hero is Player => Boolean(hero))
    setBusy(true)
    setError('')
    try {
      const resolvedCode = code || `WORLD-${(globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)).replace(/-/g, '').slice(0, 8).toUpperCase()}`
      const response = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: resolvedCode, name: name.trim(), bootstrap: { partyName: partyName.trim(), world, players } }) })
      const body = await response.json() as { version?: number; state?: GameState | null; error?: string }
      if (!response.ok) throw new Error(body.error || 'Не удалось создать кампанию')
      await onSwitch(resolvedCode, body)
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось создать кампанию') }
    finally { setBusy(false) }
  }

  const chosenHeroes = [...heroLibrary, ...newHeroes].filter((hero) => selectedHeroIds.includes(hero.id))
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={'modal campaign-modal ' + (wizard ? 'campaign-wizard' : '')} role="dialog" aria-modal="true" aria-labelledby="campaign-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть выбор кампании" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><ScrollText size={23} /></div>
        <span className="eyebrow">КАМПАНИИ И ГРУППЫ</span>
        <h2 id="campaign-modal-title">{wizard ? 'Создание нового мира' : 'Выберите приключение'}</h2>
        {!wizard ? <>
          <div className="campaign-list">
            {campaigns.map((campaign) => <button key={campaign.code} className={campaign.code === state.sessionCode ? 'active' : ''} onClick={async () => { setBusy(true); setError(''); try { await onSwitch(campaign.code); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка переключения') } finally { setBusy(false) } }} disabled={busy}>
              <span><b>{campaign.name}</b><small>{campaign.partyName} · {campaign.memberCount} участников{campaign.setting ? ' · ' + campaign.setting : ''}</small></span><em>{campaign.code}</em>
            </button>)}
            {!campaigns.length && !error && <p className="campaign-empty">Доступных кампаний пока нет.</p>}
          </div>
          {isAdmin && <button className="campaign-start-wizard" onClick={() => setWizard(true)}><Plus size={15} />Создать полностью новую кампанию</button>}
        </> : <>
          <div className="campaign-steps"><span className={step >= 1 ? 'active' : ''}>1 · Мир</span><i /><span className={step >= 2 ? 'active' : ''}>2 · Герои</span><i /><span className={step >= 3 ? 'active' : ''}>3 · Пролог</span></div>
          {step === 1 && <div className="world-creator">
            <div className="world-auto-note"><Sparkles size={15} /><span><b>Все поля необязательны.</b> Оставьте их пустыми, и рассказчик сам случайно придумает мир, его историю и первую сцену.</span></div>
            <div className="field-grid three"><label><span>Название кампании · необязательно</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Придумает рассказчик" /></label><label><span>Название группы · необязательно</span><input value={partyName} onChange={(event) => setPartyName(event.target.value)} placeholder="Новый отряд" /></label><label><span>Код комнаты · необязательно</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="Создастся автоматически" maxLength={24} /></label></div>
            <label><span>Пресет или своё описание · необязательно</span><input list="world-preset-options" value={world.preset} onChange={(event) => setWorld({ ...world, preset: event.target.value })} placeholder="Например: фэнтези, далёкое будущее — или любое своё описание" /><datalist id="world-preset-options"><option value="Классическое фэнтези" /><option value="Тёмное фэнтези" /><option value="Далёкое будущее" /><option value="Космическая опера" /><option value="Современная мистика" /><option value="Постапокалипсис" /></datalist></label>
            <div className="field-grid"><label><span>Эпоха · необязательно</span><input value={world.era} onChange={(event) => setWorld({ ...world, era: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Жанр · необязательно</span><input value={world.genre} onChange={(event) => setWorld({ ...world, genre: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Тон истории · необязательно</span><input value={world.tone} onChange={(event) => setWorld({ ...world, tone: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Уровень магии · необязательно</span><input value={world.magicLevel} onChange={(event) => setWorld({ ...world, magicLevel: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Уровень технологий · необязательно</span><input value={world.technologyLevel} onChange={(event) => setWorld({ ...world, technologyLevel: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Стартовая локация · необязательно</span><input value={world.startingLocation} onChange={(event) => setWorld({ ...world, startingLocation: event.target.value })} placeholder="На усмотрение рассказчика" /></label></div>
            <label><span>Основа мира и желаемая история</span><textarea value={world.premise} onChange={(event) => setWorld({ ...world, premise: event.target.value })} placeholder="Что существует в мире, о чём должна быть кампания, какие конфликты интересны?" /></label>
            <label><span>С чего начинается первая сцена</span><textarea value={world.openingSituation} onChange={(event) => setWorld({ ...world, openingSituation: event.target.value })} placeholder="Например: герои прибывают на станцию в момент исчезновения дипломатического корабля" /></label>
            <div className="field-grid"><label><span>Темы и мотивы</span><input value={world.themes} onChange={(event) => setWorld({ ...world, themes: event.target.value })} placeholder="Исследование, политика, выживание…" /></label><label><span>Границы контента</span><input value={world.boundaries} onChange={(event) => setWorld({ ...world, boundaries: event.target.value })} placeholder="Что не должно появляться в истории" /></label></div>
          </div>}
          {step === 2 && <div className="hero-creator">
            <p>Выберите героев из библиотеки или создайте новых. Рассказчик получит их роли, прошлое и личные мотивы до написания пролога.</p>
            <div className="hero-library">{heroLibrary.map((hero) => <button key={hero.id} className={selectedHeroIds.includes(hero.id) ? 'selected' : ''} onClick={() => toggleHero(hero.id)}><span style={{ '--hero-color': hero.color } as React.CSSProperties}>{hero.initials}</span><div><b>{hero.character}</b><small>{hero.name} · {hero.role}</small><em>{hero.backstory || hero.background}</em></div>{selectedHeroIds.includes(hero.id) && <Check size={15} />}</button>)}</div>
            {newHeroes.length > 0 && <div className="new-hero-list">{newHeroes.map((hero) => <span key={hero.id}><Check size={13} />{hero.character}<button onClick={() => { setNewHeroes((current) => current.filter((item) => item.id !== hero.id)); setSelectedHeroIds((current) => current.filter((id) => id !== hero.id)) }}><X size={12} /></button></span>)}</div>}
            <div className="new-hero-form"><strong><Plus size={14} />Новый герой</strong><div className="field-grid three"><label><span>Игрок</span><input value={heroDraft.name} onChange={(event) => setHeroDraft({ ...heroDraft, name: event.target.value })} /></label><label><span>Имя героя</span><input value={heroDraft.character} onChange={(event) => setHeroDraft({ ...heroDraft, character: event.target.value })} /></label><label><span>Класс или роль</span><input value={heroDraft.role} onChange={(event) => setHeroDraft({ ...heroDraft, role: event.target.value })} /></label><label><span>Вид</span><input value={heroDraft.species} onChange={(event) => setHeroDraft({ ...heroDraft, species: event.target.value })} /></label><label><span>Происхождение</span><input value={heroDraft.background} onChange={(event) => setHeroDraft({ ...heroDraft, background: event.target.value })} /></label><label><span>Скорость, футы</span><input type="number" value={heroDraft.speed} onChange={(event) => setHeroDraft({ ...heroDraft, speed: event.target.value })} /></label><label><span>Макс. ОЗ</span><input type="number" value={heroDraft.maxHp} onChange={(event) => setHeroDraft({ ...heroDraft, maxHp: event.target.value })} /></label><label><span>Класс брони</span><input type="number" value={heroDraft.armor} onChange={(event) => setHeroDraft({ ...heroDraft, armor: event.target.value })} /></label></div><label><span>Предыстория и личный мотив</span><textarea value={heroDraft.backstory} onChange={(event) => setHeroDraft({ ...heroDraft, backstory: event.target.value })} /></label><button onClick={addHero}><Plus size={13} />Добавить героя в кампанию</button></div>
          </div>}
          {step === 3 && <div className="campaign-review"><span><Sparkles size={22} /></span><h3>Рассказчик готов создать историю</h3><p>Он получит только ваши необязательные пожелания и выбранные листы героев. Всё, что осталось пустым, он придумает сам.</p><dl><div><dt>Мир</dt><dd>{[world.preset, world.era, world.genre].filter(Boolean).join(' · ') || 'Полная автоматическая генерация'}</dd></div><div><dt>Начало</dt><dd>{world.openingSituation || 'Придумает рассказчик'}</dd></div><div><dt>Герои</dt><dd>{chosenHeroes.map((hero) => hero.character).join(', ')}</dd></div></dl><small>После создания откроется первая уникальная сцена с новой историей мира, прологом, целью и картой.</small></div>}
          <div className="campaign-wizard-actions"><button onClick={() => step === 1 ? setWizard(false) : setStep((current) => current - 1)}>{step === 1 ? 'К списку кампаний' : 'Назад'}</button>{step < 3 ? <button className="primary" onClick={() => { if (validateStep()) setStep((current) => current + 1) }}>Продолжить<ChevronRight size={14} /></button> : <button className="primary" onClick={() => { void create() }} disabled={busy}><Sparkles size={14} />{busy ? 'Рассказчик создаёт мир…' : 'Создать мир и написать пролог'}</button>}</div>
        </>}
        {error && <div className="admin-error">{error}</div>}
      </div>
    </div>
  )
}
function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-header"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
}

function battleEventText(state: GameState, event: NonNullable<GameState['battleLog']>[number]) {
  const actorName = (id?: string) => state.players.find((player) => player.id === id)?.character
    ?? state.actors?.find((actor) => actor.id === id)?.name
    ?? state.enemies?.find((enemy) => enemy.id === id)?.name
    ?? id
    ?? 'Участник'
  if (event.type === 'combat-start') {
    const participants = (event.participantIds ?? []).map(actorName).join(', ')
    return participants ? `Бой начался. Участники: ${participants}.` : 'Бой начался, порядок инициативы определён.'
  }
  if (event.type === 'combat-end') return `Бой завершён в раунде ${event.round ?? 1}${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'move') return `${actorName(event.actorId)} перемещается на ${event.distanceFeet ?? 0} фт.`
  if (event.type === 'turn-end') return `${actorName(event.actorId)} завершает ход.`
  if (event.type === 'attack') {
    const outcome = event.roll?.hit ? `попадание${event.damage != null ? `, ${event.damage} урона` : ''}` : 'промах'
    const hp = event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    return `${actorName(event.actorId)} атакует ${actorName(event.targetId)}: ${event.roll?.total ?? '?'} против КД ${event.roll?.difficulty ?? '?'} — ${outcome}${hp}.`
  }
  return event.type
}

function JournalView({ state }: { state: GameState }) {
  const narratorCount = state.messages.filter((message) => message.speaker === 'narrator').length
  const battleLog = state.battleLog ?? []
  const completedChapters = state.adventure?.history ?? []
  const currentChapter = state.adventure?.chapter ?? completedChapters.length + 1
  return (
    <section className="section-page">
      <PageHeader eyebrow="ЛЕТОПИСЬ ПРИКЛЮЧЕНИЯ" title="Журнал кампании" description="Общая память отряда: реплики, решения, броски и последствия." />
      <div className="journal-stats">
        <div><ScrollText size={18} /><span><b>{state.messages.length + battleLog.length}</b><small>событий</small></span></div>
        <div><Sparkles size={18} /><span><b>{narratorCount}</b><small>сцен рассказчика</small></span></div>
        <div><History size={18} /><span><b>{state.scene.turn}</b><small>текущий ход</small></span></div>
      </div>
      <div className="journal-layout">
        <aside className="chapter-list"><span>ГЛАВЫ</span>
          {completedChapters.map((chapter) => <button key={`${chapter.chapter}-${chapter.location}`}><i>{String(chapter.chapter).padStart(2, '0')}</i><b>{chapter.title}</b><small>{chapter.outcome || chapter.location}</small></button>)}
          <button className="active"><i>{String(currentChapter).padStart(2, '0')}</i><b>{state.scene.title}</b><small>{state.scene.location}</small></button>
        </aside>
        <div className="journal-feed">
          {state.messages.map((message, index) => (
            <article className={`journal-entry ${message.speaker}`} key={message.id}>
              <div className="journal-marker">{message.speaker === 'narrator' ? <Sparkles size={15} /> : index + 1}</div>
              <div><div className="message-meta"><strong>{message.author}</strong><time>{message.timestamp}</time></div><p>{message.text}</p>
              {message.roll && <span className={`compact-roll ${message.roll.success ? 'success' : ''}`}><Dices size={14} />{message.roll.label}: <b>{message.roll.total}</b></span>}</div>
            </article>
          ))}
          {battleLog.length > 0 && <section className="combat-journal" aria-label="Боевая хроника">
            <header><Swords size={15} /><strong>Боевая хроника</strong><span>{battleLog.length}</span></header>
            {battleLog.map((event) => <article className="combat-journal-entry" key={event.id}>
              <i>{event.round ?? event.sceneTurn ?? '·'}</i>
              <div><small>{event.type === 'attack' ? 'АТАКА' : event.type === 'move' ? 'ПЕРЕМЕЩЕНИЕ' : event.type === 'turn-end' ? 'ХОД' : 'БОЙ'}</small><p>{battleEventText(state, event)}</p></div>
            </article>)}
          </section>}
        </div>
      </div>
    </section>
  )
}

function CharactersView({ players, selectedId, turnId, accessibleHeroIds, onSelect, onEdit }: { players: Player[]; selectedId: string; turnId: string; accessibleHeroIds: string[]; onSelect: (id: string) => void; onEdit: (id: string) => void }) {
  const active = players.find((player) => player.id === selectedId) ?? players[0]
  const canEdit = accessibleHeroIds.includes(active.id)
  return (
    <section className="section-page">
      <PageHeader eyebrow="ВАШ ОТРЯД" title="Персонажи" description="Герои кампании, их состояние и положение в текущей сцене." />
      <div className="character-actions-bar"><span>Выбран: <b>{active.character}</b></span><button disabled={!canEdit} onClick={() => onEdit(active.id)}>{canEdit ? <PencilIcon /> : <LockKeyhole size={14} />}{canEdit ? 'Открыть и редактировать лист' : 'Нет доступа к герою'}</button></div>
      <div className="character-grid">
        {players.map((player) => (
          <button key={player.id} disabled={!accessibleHeroIds.includes(player.id)} className={`character-sheet ${selectedId === player.id ? 'active' : ''} ${accessibleHeroIds.includes(player.id) ? '' : 'locked'}`} onClick={() => onSelect(player.id)}>
            <div className="character-art" style={{ backgroundImage: `url(${player.portrait})`, backgroundPosition: player.portraitPosition }}><span className={player.online ? 'online' : ''}>{player.online ? 'В СЕТИ' : 'НЕ В СЕТИ'}</span></div>
            <div className="character-info"><small>{player.name} играет за</small><h2>{player.character}</h2><p>{player.role}</p>
              <div className="character-stats"><span><b>{player.hp}</b> / {player.maxHp}<small>ЗДОРОВЬЕ</small></span><span><b>{player.armor}</b><small>КЛАСС БРОНИ</small></span><span><b>{player.x}:{player.y}</b><small>КООРДИНАТЫ</small></span></div>
            </div>
            {turnId === player.id && <em><Crown size={13} />Сейчас ходит</em>}
          </button>
        ))}
      </div>
      <div className="asset-note"><WandIcon /><div><b>Визуальные образы управляются игровым движком</b><p>У каждого существа есть тип, координаты и ссылка на ассет. Рассказчик может вызвать инструмент появления сущности; интерфейс подставит подходящую модель автоматически.</p></div></div>
    </section>
  )
}

function WandIcon() { return <div className="wand-icon"><Sparkles size={21} /></div> }

function PencilIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="m15 5 4 4L8 20H4v-4L15 5Z"/><path d="m13 7 4 4"/></svg> }

function ToggleRow({ icon, title, description, value, onChange }: { icon: React.ReactNode; title: string; description: string; value: boolean; onChange: () => void }) {
  return <button className="setting-row" onClick={onChange}><span className="setting-icon">{icon}</span><span><b>{title}</b><small>{description}</small></span><i className={value ? 'on' : ''}><u /></i></button>
}

function SettingsView({ health, uiScale, autoAttackRoll, onUiScaleChange, onAutoAttackRollChange }: { health: AiHealth | null; uiScale: number; autoAttackRoll: boolean; onUiScaleChange: (value: number) => void; onAutoAttackRollChange: (value: boolean) => void }) {
  const [scaleInput, setScaleInput] = useState(String(uiScale))

  useEffect(() => setScaleInput(String(uiScale)), [uiScale])

  const commitScaleInput = () => {
    const parsed = Number(scaleInput.replace('%', '').trim())
    if (Number.isFinite(parsed)) onUiScaleChange(clampUiScale(parsed))
    else setScaleInput(String(uiScale))
  }

  const hasPreset = UI_SCALE_PRESETS.includes(uiScale)


  return (
    <section className="section-page settings-page">
      <PageHeader eyebrow="ПАРАМЕТРЫ КАМПАНИИ" title="Настройки" description="Рассказчик, отображение сцены и локальные предпочтения." />
      <div className="settings-grid">
        <div className="settings-card ai-card">
          <div className="settings-card-title"><BrainCircuit size={20} /><span><b>ИИ-рассказчик</b><small>Серверное подключение</small></span><em className={health?.configured ? 'connected' : ''}>{health?.configured ? <Wifi size={14} /> : <WifiOff size={14} />}{health?.configured ? 'ПОДКЛЮЧЁН' : 'НЕДОСТУПЕН'}</em></div>
          <div className="provider-info"><span>ПРОВАЙДЕР<strong>{health?.provider ?? 'RouterAI'}</strong></span><span>МОДЕЛЬ<strong>{health?.model ?? 'Проверка подключения…'}</strong></span><span>РЕЖИМ<strong>{health?.engineMode ?? 'legacy'}</strong></span><span>RULESET<strong>{health?.rulesetId ?? 'не выбран'}</strong></span></div>
          <div className="tools-list"><small>ДОСТУПНЫЕ ИНСТРУМЕНТЫ</small><div>{(health?.tools ?? ['roll_check', 'reveal_area', 'update_objective', 'spawn_entity', 'grant_item']).map((tool) => <span key={tool}><Check size={11} />{tool}</span>)}</div></div>
          <p className="secure-note"><Shield size={14} />Ключ RouterAI хранится только в серверном `.env` и не передаётся в браузер.</p>
        </div>
        <div className="settings-card"><div className="settings-card-title"><SlidersHorizontal size={20} /><span><b>Интерфейс игры</b><small>Настройки этого устройства</small></span></div>
          <label className="ui-scale-setting">
            <span><b>Масштаб интерфейса</b><small>Текст, иконки и основные панели адаптируются вместе</small></span>
            <div className="ui-scale-value">
              <input value={scaleInput} inputMode="numeric" aria-label="Масштаб интерфейса в процентах" onChange={(event) => setScaleInput(event.currentTarget.value)} onBlur={commitScaleInput} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
              <span>%</span>
            </div>
            <input className="ui-scale-range" type="range" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step="5" value={uiScale} onInput={(event) => onUiScaleChange(Number(event.currentTarget.value))} aria-label="Размер текста и иконок" />
            <select value={uiScale} onChange={(event) => onUiScaleChange(Number(event.currentTarget.value))} aria-label="Готовый масштаб интерфейса">
              {!hasPreset && <option value={uiScale}>{uiScale}%</option>}
              {UI_SCALE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}%{preset === 100 ? ' · компактный' : preset === 115 ? ' · стандартный' : preset === 125 ? ' · крупный' : preset === 150 ? ' · максимальный' : ''}</option>)}
            </select>
            <span className="ui-scale-marks"><i>{UI_SCALE_MIN}%</i><i>100%</i><i>125%</i><i>{UI_SCALE_MAX}%</i></span>
          </label>
          <ToggleRow icon={<Dices size={17} />} title="Автобросок при атаке" description="Включено — цель сразу атакуется; выключено — появляется отдельная кнопка кубика" value={autoAttackRoll} onChange={() => onAutoAttackRollChange(!autoAttackRoll)} />
        </div>
      </div>
    </section>
  )
}

function AdminView({ account, state, onUpdateWorld, onSetEngineMode, onAssembleEncounter, onAssembleMerchant, onMoveMerchant, onSetMerchantAvailability, onReset }: { account: Account; state: GameState; onUpdateWorld: (patch: { campaign?: string; partyName?: string; partyMemberIds?: string[]; scene?: Partial<GameState['scene']> }) => void; onSetEngineMode: (mode: NonNullable<GameState['engine_mode']>) => Promise<void>; onAssembleEncounter: (options: EncounterAssemblyOptions) => Promise<EncounterProposal>; onAssembleMerchant: (options: ShopAssemblyOptions) => Promise<Merchant>; onMoveMerchant: (merchantId: string, location: string) => Promise<void>; onSetMerchantAvailability: (merchantId: string, available: boolean) => Promise<void>; onReset: () => void }) {
  const [users, setUsers] = useState<Account[]>([])
  const [error, setError] = useState('')
  const [engineMode, setEngineMode] = useState<NonNullable<GameState['engine_mode']>>(state.engine_mode ?? 'legacy')
  const [engineModeBusy, setEngineModeBusy] = useState(false)
  const [shopBusy, setShopBusy] = useState(false)
  const [shopError, setShopError] = useState('')
  const [shopMessage, setShopMessage] = useState('')
  const [shopSettlement, setShopSettlement] = useState<ShopAssemblyOptions['settlementType']>('town')
  const [shopTheme, setShopTheme] = useState<ShopAssemblyOptions['theme']>('general')
  const [shopBudgetGold, setShopBudgetGold] = useState(200)
  const [encounterDifficulty, setEncounterDifficulty] = useState<EncounterAssemblyOptions['difficulty']>('medium')
  const [encounterTheme, setEncounterTheme] = useState<EncounterAssemblyOptions['theme']>('generic')
  const [encounterBusy, setEncounterBusy] = useState(false)
  const [encounterError, setEncounterError] = useState('')
  const [encounterProposal, setEncounterProposal] = useState<EncounterProposal | null>(null)
  const [campaign, setCampaign] = useState(state.campaign)
  const [partyName, setPartyName] = useState(state.partyName ?? 'Отряд героев')
  const [partyMemberIds, setPartyMemberIds] = useState(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
  const [scene, setScene] = useState({ title: state.scene.title, location: state.scene.location, mood: state.scene.mood, objective: state.scene.objective })

  const loadUsers = async () => {
    const response = await fetch('/api/admin/users')
    const body = await response.json() as { users?: Account[]; error?: string }
    if (!response.ok) throw new Error(body.error || 'Не удалось загрузить игроков')
    setUsers(body.users ?? [])
  }

  useEffect(() => { loadUsers().catch((reason) => setError(reason instanceof Error ? reason.message : 'Ошибка')) }, [])
  useEffect(() => {
    setCampaign(state.campaign)
    setPartyName(state.partyName ?? 'Отряд героев')
    setEngineMode(state.engine_mode ?? 'legacy')
    setPartyMemberIds(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
    setScene({ title: state.scene.title, location: state.scene.location, mood: state.scene.mood, objective: state.scene.objective })
    setEncounterProposal(null)
    setEncounterError('')
  }, [state.sessionCode])

  useEffect(() => { setEngineMode(state.engine_mode ?? 'legacy') }, [state.engine_mode])

  const updateAccess = async (user: Account, patch: Partial<Pick<Account, 'heroIds' | 'role'>>) => {
    setError('')
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    const body = await response.json() as { user?: Account; error?: string }
    if (!response.ok || !body.user) { setError(body.error || 'Не удалось изменить доступ'); return }
    setUsers((current) => current.map((item) => item.id === body.user!.id ? body.user! : item))
  }

  const saveWorld = () => {
    if (!partyMemberIds.length) { setError('В группе должен остаться хотя бы один герой.'); return }
    setError('')
    onUpdateWorld({ campaign, partyName, partyMemberIds, scene })
  }

  const changeEngineMode = async (mode: NonNullable<GameState['engine_mode']>) => {
    const previous = state.engine_mode ?? 'legacy'
    setEngineMode(mode)
    setEngineModeBusy(true)
    setError('')
    try {
      await onSetEngineMode(mode)
    } catch (reason) {
      setEngineMode(previous)
      setError(reason instanceof Error ? reason.message : 'Не удалось переключить режим движка')
    } finally {
      setEngineModeBusy(false)
    }
  }

  const runShopAction = async (action: () => Promise<void>, success: string) => {
    setShopBusy(true)
    setShopError('')
    setShopMessage('')
    try {
      await action()
      setShopMessage(success)
    } catch (reason) {
      setShopError(reason instanceof Error ? reason.message : 'Не удалось изменить торговца')
    } finally {
      setShopBusy(false)
    }
  }

  const assembleCurrentShop = async () => {
    setShopBusy(true)
    setShopError('')
    setShopMessage('')
    try {
      const merchant = await onAssembleMerchant({
        settlementType: shopSettlement,
        theme: shopTheme,
        budgetCp: Math.max(1, Math.min(10_000, Math.floor(shopBudgetGold || 1))) * 100,
      })
      setShopMessage(`ShopAssembler создал лавку «${merchant.name}» в текущей сцене.`)
    } catch (reason) {
      setShopError(reason instanceof Error ? reason.message : 'ShopAssembler не смог создать лавку')
    } finally {
      setShopBusy(false)
    }
  }

  const assembleCurrentEncounter = async () => {
    setEncounterBusy(true)
    setEncounterError('')
    setEncounterProposal(null)
    try {
      setEncounterProposal(await onAssembleEncounter({ difficulty: encounterDifficulty, theme: encounterTheme }))
    } catch (reason) {
      setEncounterError(reason instanceof Error ? reason.message : 'EncounterAssembler не смог собрать столкновение')
    } finally {
      setEncounterBusy(false)
    }
  }

  const combatActive = Boolean(state.mechanics?.combat?.active)

  return (
    <section className="section-page admin-page">
      <PageHeader eyebrow="ПОЛНЫЙ ДОСТУП" title="Управление кампанией" description="Управляйте доступом, составом текущей группы и состоянием мира." />
      {error && <div className="admin-error">{error}</div>}
      <div className="admin-layout">
        <div className="admin-card admin-users"><div className="admin-card-head"><span><Users size={18} /><b>Игроки и герои</b></span><button onClick={() => loadUsers().catch(() => undefined)}><RefreshCw size={14} />Обновить</button></div>
          <div className="admin-user-list">{users.map((user) => <article key={user.id} className="admin-user"><div><strong>{user.name}</strong><small>{user.email}</small><em>{user.role === 'admin' ? 'АДМИНИСТРАТОР' : 'ИГРОК'}</em></div><div className="admin-hero-access">{state.players.map((hero) => <label key={hero.id}><input type="checkbox" checked={user.role === 'admin' || user.heroIds.includes(hero.id)} disabled={user.role === 'admin'} onChange={() => updateAccess(user, { heroIds: user.heroIds.includes(hero.id) ? user.heroIds.filter((id) => id !== hero.id) : [...user.heroIds, hero.id] })} /><span>{hero.character}</span></label>)}</div>{user.id !== account.id && <button className="role-button" onClick={() => updateAccess(user, { role: user.role === 'admin' ? 'player' : 'admin' })}>{user.role === 'admin' ? 'Сделать игроком' : 'Сделать администратором'}</button>}</article>)}</div>
        </div>
        <div className="admin-card admin-world"><div className="admin-card-head"><span><Sparkles size={18} /><b>Состояние мира</b></span></div>
          <label className="engine-mode-field"><span>Режим игрового движка</span><select value={engineMode} disabled={engineModeBusy} onChange={(event) => { void changeEngineMode(event.target.value as NonNullable<GameState['engine_mode']>) }}><option value="legacy">legacy · локальная совместимость</option><option value="shadow">shadow · серверная проверка в фоне</option><option value="enforce">enforce · сервер решает механику</option></select><small>{engineModeBusy ? 'Синхронизируем состояние кампании…' : engineMode === 'enforce' ? 'Карта, кубики, урон и ходы NPC выполняются только сервером.' : 'Тактическая карта использует прежний локальный движок.'}</small></label>
          <label><span>Кампания</span><input value={campaign} onChange={(event) => setCampaign(event.target.value)} /></label>
          <label><span>Название группы</span><input value={partyName} onChange={(event) => setPartyName(event.target.value)} /></label>
          <div className="party-editor">
            <span>СОСТАВ ГРУППЫ</span>
            <p>Герои в резерве сохраняют лист и инвентарь, но не появляются на карте и не получают ход.</p>
            {state.players.map((hero) => {
              const included = partyMemberIds.includes(hero.id)
              return <button key={hero.id} className={included ? 'included' : ''} onClick={() => setPartyMemberIds((current) => included ? current.filter((id) => id !== hero.id) : [...current, hero.id])}>
                <span><b>{hero.character}</b><small>{hero.name} · скорость {hero.speed} фт</small></span>
                <em>{included ? 'УЧАСТВУЕТ' : 'РЕЗЕРВ'}</em>
              </button>
            })}
          </div>
          <label><span>Название сцены</span><input value={scene.title} onChange={(event) => setScene({ ...scene, title: event.target.value })} /></label>
          <label><span>Локация</span><input value={scene.location} onChange={(event) => setScene({ ...scene, location: event.target.value })} /></label>
          <label><span>Настроение</span><input value={scene.mood} onChange={(event) => setScene({ ...scene, mood: event.target.value })} /></label>
          <label><span>Текущая цель</span><textarea value={scene.objective} onChange={(event) => setScene({ ...scene, objective: event.target.value })} /></label>
          <button className="admin-save" onClick={saveWorld}><Check size={15} />Сохранить мир</button>
          <button className="admin-reset" onClick={onReset}><RotateCcw size={15} />Сбросить демо-кампанию</button>
          <p>Листы и инвентари всех героев доступны администратору через разделы «Персонажи» и «Инвентарь».</p>
        </div>
        <div className="admin-card admin-encounters">
          <div className="admin-card-head"><span><Swords size={18} /><b>Столкновения и EncounterAssembler</b></span><em>{combatActive ? 'БОЙ ИДЁТ' : 'ГОТОВ К СБОРКЕ'}</em></div>
          <p>Сервер подберёт существ по бюджету опыта, разместит их на карте и запустит инициативу. Состав столкновения нельзя подменить из браузера.</p>
          {state.engine_mode !== 'enforce' && <div className="shop-admin-warning"><ShieldCheck size={15} />Сначала включите режим enforce.</div>}
          {combatActive && <div className="encounter-admin-warning"><Swords size={15} />Завершите текущее столкновение, прежде чем собирать новое.</div>}
          {encounterError && <div className="admin-error">{encounterError}</div>}
          {encounterProposal && <div className="encounter-admin-success"><Check size={15} /><span><b>Столкновение собрано</b><small>{encounterProposal.enemies?.length ?? 0} противников{encounterProposal.xp_spent != null ? ` · ${encounterProposal.xp_spent}${encounterProposal.xp_budget != null ? ` / ${encounterProposal.xp_budget}` : ''} XP` : ''}</small></span></div>}
          <div className="encounter-assembler-controls">
            <label><span>Сложность для группы</span><select value={encounterDifficulty} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterDifficulty(event.target.value as EncounterAssemblyOptions['difficulty'])}><option value="easy">Лёгкая</option><option value="medium">Средняя</option><option value="hard">Тяжёлая</option></select></label>
            <label><span>Тема противников</span><select value={encounterTheme} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterTheme(event.target.value as EncounterAssemblyOptions['theme'])}><option value="generic">Любые подходящие</option><option value="undead">Нежить</option><option value="beasts">Звери</option><option value="goblinoids">Гоблиноиды</option></select></label>
            <button onClick={() => { void assembleCurrentEncounter() }} disabled={encounterBusy || combatActive || state.engine_mode !== 'enforce'}>{encounterBusy ? <RefreshCw className="spinning" size={15} /> : <Swords size={15} />}{encounterBusy ? 'Собираем столкновение…' : 'Собрать столкновение'}</button>
          </div>
          {encounterProposal?.enemies?.length ? <div className="encounter-proposal-list">{encounterProposal.enemies.map((enemy) => <span key={enemy.id}><b>{enemy.name}</b><small>{enemy.hp != null ? `${enemy.hp} HP` : 'HP рассчитано сервером'}{enemy.armor != null ? ` · КД ${enemy.armor}` : ''}</small></span>)}</div> : null}
        </div>
        <div className="admin-card admin-merchants">
          <div className="admin-card-head"><span><Store size={18} /><b>Торговцы и ShopAssembler</b></span><em>{state.merchants?.length ?? 0} в кампании</em></div>
          <p>Сборщик выбирает только позиции серверного каталога. Цены, лимиты количества и политика магазина проверяются Rules Engine.</p>
          {state.engine_mode !== 'enforce' && <div className="shop-admin-warning"><ShieldCheck size={15} />Сначала включите режим enforce.</div>}
          {shopError && <div className="admin-error">{shopError}</div>}
          {shopMessage && <div className="shop-admin-success"><Check size={14} />{shopMessage}</div>}
          <div className="shop-assembler-controls">
            <label><span>Тип поселения</span><select value={shopSettlement} disabled={shopBusy} onChange={(event) => setShopSettlement(event.target.value as ShopAssemblyOptions['settlementType'])}><option value="village">Деревня</option><option value="town">Городок</option><option value="city">Большой город</option><option value="outpost">Застава</option><option value="traveling">Странствующая лавка</option></select></label>
            <label><span>Профиль лавки</span><select value={shopTheme} disabled={shopBusy} onChange={(event) => setShopTheme(event.target.value as ShopAssemblyOptions['theme'])}><option value="general">Общие товары</option><option value="provisions">Припасы</option><option value="arms">Оружие и защита</option><option value="healing">Лечение</option></select></label>
            <label><span>Бюджет склада, зм</span><input type="number" min="1" max="10000" value={shopBudgetGold} disabled={shopBusy} onChange={(event) => setShopBudgetGold(Number(event.target.value) || 1)} /></label>
            <button onClick={() => { void assembleCurrentShop() }} disabled={shopBusy || state.engine_mode !== 'enforce'}>{shopBusy ? <RefreshCw className="spinning" size={15} /> : <Sparkles size={15} />}{shopBusy ? 'Собираем лавку…' : 'Собрать лавку для текущей сцены'}</button>
          </div>
          <div className="shop-admin-list">
            {(state.merchants ?? []).map((merchant) => <article key={merchant.id}>
              <div><strong>{merchant.name}</strong><span>{merchant.title || 'Торговец'} · {merchant.stock.length} позиций</span><small>{merchant.location || 'Локация не задана'}</small></div>
              <em className={merchant.available ? 'available' : ''}>{merchant.available ? 'ОТКРЫТ' : 'ЗАКРЫТ'}</em>
              <div className="shop-admin-actions">
                <button disabled={shopBusy || locationsMatch(merchant.location, state.scene.location) || state.engine_mode !== 'enforce'} onClick={() => { void runShopAction(() => onMoveMerchant(merchant.id, state.scene.location), `${merchant.name} перемещён в «${state.scene.location}».`) }}>Переместить сюда</button>
                <button disabled={shopBusy || state.engine_mode !== 'enforce'} onClick={() => { void runShopAction(() => onSetMerchantAvailability(merchant.id, !merchant.available), merchant.available ? `${merchant.name} закрывает торговлю.` : `${merchant.name} снова доступен.`) }}>{merchant.available ? 'Закрыть' : 'Открыть'}</button>
              </div>
            </article>)}
            {!state.merchants?.length && <div className="shop-admin-empty">В кампании ещё нет торговцев. ShopAssembler создаст первого для «{state.scene.location}».</div>}
          </div>
        </div>
      </div>
    </section>
  )
}

function WaitingForHero({ account, onRefresh, onLogout }: { account: Account; onRefresh: () => Promise<Account | null>; onLogout: () => void }) {
  const [checking, setChecking] = useState(false)
  return <main className="waiting-screen"><div className="waiting-card"><div className="modal-icon"><Shield size={23} /></div><span className="eyebrow">АККАУНТ СОЗДАН</span><h1>Ожидаем назначения героя</h1><p>{account.name}, администратор ещё не открыл вам доступ к персонажу. После назначения здесь автоматически появятся лист героя, предметы и игровая комната.</p><button onClick={async () => { setChecking(true); await onRefresh(); setChecking(false) }}><RefreshCw className={checking ? 'spinning' : ''} size={16} />{checking ? 'Проверяем…' : 'Проверить доступ'}</button><button className="waiting-logout" onClick={onLogout}>Выйти из аккаунта</button></div></main>
}

function GameApp({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const { state, tacticalBusy, tacticalError, merchantBusy, merchantError, merchantView, merchantNarration, clearTacticalError, submitAction, rollPendingCheck, cancelPendingCheck, rollFreeDie, voteAgentInteraction, rollAgentInteraction, continueAgentInteraction, startCombat, movePlayer, attackEnemy, throwAreaItem, castSpell, changeWeapon, finishMapTurn, switchCampaign, setEngineMode, loadMerchant, bargainWithMerchant, buyFromMerchant, sellToMerchant, appraiseWithMerchant, assembleMerchant, assembleEncounter, moveMerchant, setMerchantAvailability, reset, updatePlayer, addItem, updateItem, removeItem, updateWorld } = useGameSession()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 920)
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth > 680)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [campaignsOpen, setCampaignsOpen] = useState(false)
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('agentLab') === '1' ? 'agent-lab' : 'room')
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [uiScale, setUiScale] = useState(loadUiScale)
  const [autoAttackRoll, setAutoAttackRoll] = useState(() => window.localStorage.getItem('skazanie-auto-attack-roll') !== 'false')
  const isAdmin = account.role === 'admin'
  const partyIdSet = new Set(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
  const partyPlayers = state.players.filter((player) => partyIdSet.has(player.id))
  const accessibleHeroIds = isAdmin ? partyPlayers.map((player) => player.id) : account.heroIds.filter((id) => partyIdSet.has(id))
  const [selectedHeroId, setSelectedHeroId] = useState(accessibleHeroIds[0])

  useEffect(() => { getAiHealth().then(setAiHealth).catch(() => setAiHealth(null)) }, [])
  useEffect(() => {
    window.localStorage.setItem(UI_SCALE_KEY, String(uiScale))
  }, [uiScale])
  useEffect(() => { window.localStorage.setItem('skazanie-auto-attack-roll', String(autoAttackRoll)) }, [autoAttackRoll])
  useEffect(() => {
    if (!accessibleHeroIds.includes(selectedHeroId)) setSelectedHeroId(accessibleHeroIds[0])
  }, [state.sessionCode, state.partyMemberIds?.join(',')])

  const navigate = (next: View) => {
    setView(next)
    if (window.innerWidth <= 680) setSidebarCollapsed(true)
  }
  const activePlayer = partyPlayers.find((player) => player.id === selectedHeroId && accessibleHeroIds.includes(player.id)) ?? partyPlayers.find((player) => accessibleHeroIds.includes(player.id)) ?? partyPlayers[0] ?? state.players[0]
  const availableMerchants = (state.merchants ?? []).filter((merchant) => merchant.available && merchantIsAtLocation(merchant.location, state.scene.location))
  const turnActorId = currentTurnActorId(state)
  const turnPlayer = partyPlayers.find((player) => player.id === turnActorId)
  const turnEnemy = state.enemies?.find((enemy) => enemy.id === turnActorId)
  const turnSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const turnActorName = turnPlayer?.character ?? turnSummon?.name ?? turnEnemy?.name ?? 'участник боя'

  const canControlHero = Boolean(turnPlayer && partyIdSet.has(turnActorId) && (isAdmin || account.heroIds.includes(turnActorId)))
  const summonControllerIds = turnSummon ? [turnSummon.ownerId, turnSummon.controllerId] : []
  const canControlSummon = Boolean(turnSummon && turnSummon.faction === 'party' && (isAdmin || summonControllerIds.some((id) => account.heroIds.includes(id))))
  const canAct = !tacticalBusy && (canControlHero || canControlSummon)
  const canFinishTurn = canAct && (state.engine_mode !== 'enforce' || Boolean(state.mechanics?.combat?.active))

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`} style={{
      '--ui-readable-scale': uiScale / 100,
      '--ui-sidebar-width': `${Math.round(276 + Math.max(0, uiScale - 100) * .4)}px`,
      '--ui-hud-width': `${Math.round(246 + Math.max(0, uiScale - 100) * .25)}px`,
    } as React.CSSProperties}>
      <Sidebar players={partyPlayers} selectedPlayerId={activePlayer.id} turnPlayerId={turnActorId} accessibleHeroIds={accessibleHeroIds} merchantAvailable={availableMerchants.length > 0} isAdmin={isAdmin} onSelect={setSelectedHeroId} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(value => !value)} view={view} onNavigate={navigate} aiConnected={Boolean(aiHealth?.configured)} />
      <main className="game-main">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? 'Открыть меню' : 'Закрыть меню'} aria-expanded={!sidebarCollapsed}><Menu size={20} /></button>
          <button className="campaign-title" onClick={() => setCampaignsOpen(true)} title="Переключить кампанию или группу"><span>КАМПАНИЯ · {state.partyName}</span><strong>{state.campaign}</strong><ChevronDown size={15} /></button>
          <div className="top-actions">
            <div className="session-code"><i />КОМНАТА <b>{state.sessionCode}</b></div>
            <button className="invite-button" onClick={() => setInviteOpen(true)}><Users size={17} />Пригласить</button>
            <div className="account-chip"><span>{account.name}<small>{activePlayer.character}</small></span><button onClick={onLogout} title="Выйти"><LogOut size={15} /></button></div>
          </div>
        </header>
        {view === 'room' && <div className="game-area">
          <SceneHeader {...state.scene} chapter={state.adventure?.chapter ?? 1} onReset={reset} />
          <DungeonMap state={state} players={partyPlayers} turnActorId={turnActorId} canAct={canAct} tacticalBusy={tacticalBusy} tacticalError={tacticalError} autoAttackRoll={autoAttackRoll} onClearTacticalError={clearTacticalError} onStartCombat={() => startCombat(turnActorId)} onMove={movePlayer} onAttack={attackEnemy} onAreaAttack={throwAreaItem} onCastSpell={castSpell} onChangeWeapon={changeWeapon} onFinishTurn={finishMapTurn} />
          <DiceTray latestRoll={state.lastDiceRoll} onRoll={() => rollFreeDie(activePlayer.id)} />
          <div className="turn-indicator"><span>{turnEnemy ? 'ХОД ПРОТИВНИКА' : turnSummon ? 'ХОД ПРИЗЫВА' : 'ХОД ИГРОКА'}</span><strong>{turnActorName}</strong><i /></div>
          <PlayerHud player={activePlayer} hazards={((state.mechanics as { hazards?: Record<string, Array<{ id: string; label?: string; severity?: string; description?: string }>> } | undefined)?.hazards?.[activePlayer.id] ?? [])} onCharacter={() => { setEditingPlayerId(activePlayer.id) }} onInventory={() => navigate('inventory')} />
          <ChatPanel messages={state.messages} isNarrating={state.isNarrating} pendingCheck={state.pendingCheck} interaction={state.agentInteraction} players={partyPlayers} currentPlayerId={activePlayer.id} canAct={canAct} canFinishTurn={canFinishTurn} turnName={turnActorName} onSend={submitAction} onFinishTurn={() => { if (state.engine_mode === 'enforce') finishMapTurn(); else submitAction('Заканчиваю свой ход') }} onRoll={rollPendingCheck} onCancelCheck={cancelPendingCheck} onVote={(optionId) => voteAgentInteraction(activePlayer.id, optionId)} onRollInteraction={() => { void rollAgentInteraction(activePlayer.id) }} onContinueInteraction={continueAgentInteraction} open={chatOpen} onToggle={() => setChatOpen(value => !value)} suggestions={state.suggestions} />
        </div>}
        {view === 'journal' && <JournalView state={state} />}
        {view === 'characters' && <CharactersView players={partyPlayers} selectedId={activePlayer.id} turnId={turnActorId} accessibleHeroIds={accessibleHeroIds} onSelect={setSelectedHeroId} onEdit={setEditingPlayerId} />}
        {view === 'inventory' && <InventoryView player={activePlayer} onAdd={(item) => addItem(activePlayer.id, item)} onUpdate={(id, patch) => updateItem(activePlayer.id, id, patch)} onRemove={(id) => removeItem(activePlayer.id, id)} />}
        {view === 'merchant' && <MerchantScreen merchants={availableMerchants} player={activePlayer} sceneLocation={state.scene.location} stateVersion={state.state_version ?? 0} engineMode={state.engine_mode ?? 'legacy'} view={merchantView} narration={merchantNarration} busy={merchantBusy} error={merchantError} onLoad={loadMerchant} onBargain={bargainWithMerchant} onBuy={buyFromMerchant} onSell={sellToMerchant} onAppraise={appraiseWithMerchant} />}
        {view === 'settings' && <SettingsView health={aiHealth} uiScale={uiScale} autoAttackRoll={autoAttackRoll} onUiScaleChange={setUiScale} onAutoAttackRollChange={setAutoAttackRoll} />}
        {view === 'admin' && isAdmin && <AdminView account={account} state={state} onUpdateWorld={updateWorld} onSetEngineMode={setEngineMode} onAssembleEncounter={assembleEncounter} onAssembleMerchant={assembleMerchant} onMoveMerchant={moveMerchant} onSetMerchantAvailability={setMerchantAvailability} onReset={reset} />}
        {view === 'agent-lab' && isAdmin && <AgentLabView state={state} />}
      </main>
      {inviteOpen && <InviteModal code={state.sessionCode} onClose={() => setInviteOpen(false)} />}
      {campaignsOpen && <CampaignModal state={state} isAdmin={isAdmin} onSwitch={switchCampaign} onClose={() => setCampaignsOpen(false)} />}
      {editingPlayerId && <CharacterEditor player={state.players.find((player) => player.id === editingPlayerId) ?? activePlayer} onClose={() => setEditingPlayerId(null)} onSave={(patch) => updatePlayer(editingPlayerId, patch)} />}
    </div>
  )
}

function App() {
  const auth = useAuth()
  if (!auth.user) return <AuthScreen loading={auth.loading} error={auth.error} setupRequired={auth.setupRequired} onLogin={auth.login} onRegister={auth.register} onSetupAdmin={auth.setupAdmin} />
  if (auth.user.role !== 'admin' && auth.user.heroIds.length === 0) return <WaitingForHero account={auth.user} onRefresh={auth.refresh} onLogout={auth.logout} />
  return <GameApp account={auth.user} onLogout={auth.logout} />
}

export default App
