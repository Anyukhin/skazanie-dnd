import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronRight, Copy, Crown, DoorOpen,
  Dices, Flame, Footprints, Gem, History, Menu, MessageSquare,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw,
  ScrollText, Send, Settings, Shield, Sparkles, Swords, Target, Users, X,
  BrainCircuit, Check, Compass, SlidersHorizontal, Wifi, WifiOff,
  Heart, HeartCrack, HelpCircle,
  LockKeyhole, LogOut, ShieldCheck, RefreshCw, Store,
  Bot, PawPrint, Skull, WandSparkles, Globe2,
} from 'lucide-react'
import type { Account, AgentInteraction, AiHealth, CampaignSummary, CombatAction, CombatMechanics, CombatReactionWindow, CombatSpell, EncounterProposal, Enemy, GameState, MapCell, Merchant, Message, PendingCheck, Player, SummonedCreature } from './types'
import { fetchWithTimeout, getAiHealth } from './ai-client'
import { useAuth } from './auth-client'
import { AuthScreen } from './AuthScreen'
import { CharacterEditor, InventoryView } from './InventoryViews'
import { CharacterCreationWizard } from './CharacterCreationWizard'
import { DiceTray } from './DiceTray'
import { useGameSession, type ConnectionState, type EncounterAssemblyOptions, type ShopAssemblyOptions } from './useGameSession'
import { CELL_FEET, currentTacticalTurn, mapGridDimensions } from './tactical-engine'
import { battleRollPresentation, boardPositionKey, buildMovementPaths, conditionPresentation, evaluateCombatTarget, mechanicsSupportPresentation, movementCellReason, type MovementPath } from './tactical-ui'
import { fallbackCombatActions, fallbackCombatResources } from './combat-actions'
import { fallbackCombatSpells, fallbackSpellResources } from './combat-spells'
import { AgentLabView } from './AgentLabView'
import { MerchantScreen } from './MerchantView'
import { CombatIcon } from './CombatIcon'
import { TacticalBoard, type BoardCellHint, type BoardCellNode } from './TacticalBoard'
import type { BoardOverlayCell } from './board-render'
import { sceneTacticalMap } from './tactical-map-client'
import { WorldMapView } from './WorldMapView'

// Торговли здесь нет намеренно: она открывается модальным окном поверх комнаты,
// а не отдельным разделом. Второго пути к ней быть не должно.
type View = 'room' | 'world-map' | 'journal' | 'characters' | 'inventory' | 'settings' | 'admin' | 'agent-lab'

const UI_SCALE_KEY = 'skazanie-ui-scale-v3'
const RAIL_HEIGHT_KEY = 'skazanie-rail-height-v1'
const SERVER_WIDTH_KEY = 'skazanie-server-width-v1'
const DETAIL_WIDTH_KEY = 'skazanie-detail-width-v1'
const SCENIC_BACKDROP_KEY = 'skazanie-scenic-backdrop-v1'
const UI_SCALE_MIN = 80
const UI_SCALE_MAX = 150
const UI_SCALE_PRESETS = [80, 90, 100, 110, 115, 125, 150]
const BASE_ATTACK_ID = '__base-attack__'
const SPELL_OPTION_LABELS: Record<string, string> = {
  approach: 'Подойди',
  drop: 'Брось',
  flee: 'Убегай',
  grovel: 'Падай',
  halt: 'Стой',
  acid: 'Кислота',
  bludgeoning: 'Дробящий',
  cold: 'Холод',
  fire: 'Огонь',
  lightning: 'Молния',
  necrotic: 'Некротический',
  piercing: 'Колющий',
  poison: 'Яд',
  radiant: 'Излучение',
  slashing: 'Рубящий',
  thunder: 'Звук',
}

type BoardCombatant = Player | SummonedCreature
type CombatMode = 'weapon' | 'magic' | 'action'
type CombatDeck = 'common' | 'weapon' | 'magic' | 'class' | 'items'
type PendingCombatCommand =
  | { kind: 'target'; targetId: string }
  | { kind: 'area'; x: number; y: number }
  | { kind: 'spell-target'; targetId: string }
  | { kind: 'spell-point'; x: number; y: number }
  | { kind: 'action-target'; targetId: string }

function spellKind(spell?: CombatSpell | null): CombatSpell['kind'] | null {
  if (!spell) return null
  const raw = String(spell.kind ?? spell.targetType ?? '')
  if (raw === 'ally') return 'healing'
  if (raw === 'cell') return 'summon'
  if (raw === 'enemy') return 'attack'
  return ['attack', 'save', 'area-save', 'damage', 'area-damage', 'healing', 'summon', 'buff', 'debuff', 'utility', 'teleport'].includes(raw) ? raw as CombatSpell['kind'] : null
}

function spellRange(spell?: CombatSpell | null) {
  return Math.max(0, Number(spell?.range ?? spell?.rangeFeet ?? spell?.range_feet) || 0)
}

function spellActionType(spell?: CombatSpell | null): CombatSpell['actionType'] {
  const value = spell?.actionType ?? spell?.action_type
  return value === 'bonus_action' || value === 'reaction' || value === 'long_cast' ? value : 'action'
}

function chebyshevFeet(from: { x: number; y: number }, to: { x: number; y: number }) {
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * CELL_FEET
}

function boardCellInCone(cell: { x: number; y: number }, origin: { x: number; y: number }, toward: { x: number; y: number }, rangeFeet: number) {
  const directionX = toward.x - origin.x
  const directionY = toward.y - origin.y
  const targetX = cell.x - origin.x
  const targetY = cell.y - origin.y
  if ((!directionX && !directionY) || (!targetX && !targetY) || chebyshevFeet(origin, cell) > rangeFeet) return false
  const dot = directionX * targetX + directionY * targetY
  const cross = Math.abs(directionX * targetY - directionY * targetX)
  return dot > 0 && cross * 2 <= dot
}

function boardCellInDirectedCube(cell: { x: number; y: number }, origin: { x: number; y: number }, toward: { x: number; y: number }, edgeFeet: number) {
  const directionX = toward.x - origin.x
  const directionY = toward.y - origin.y
  if (!directionX && !directionY) return false
  const targetX = cell.x - origin.x
  const targetY = cell.y - origin.y
  const cells = Math.max(1, Math.floor(edgeFeet / CELL_FEET))
  const halfWidth = Math.floor((cells - 1) / 2)
  if (Math.abs(directionX) >= Math.abs(directionY)) {
    const forward = targetX * Math.sign(directionX)
    return forward >= 1 && forward <= cells && Math.abs(targetY) <= halfWidth
  }
  const forward = targetY * Math.sign(directionY)
  return forward >= 1 && forward <= cells && Math.abs(targetX) <= halfWidth
}

function hasClearBoardTrajectory(state: GameState, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cells = new Map(state.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  let x = from.x
  let y = from.y
  const dx = Math.abs(to.x - x)
  const sx = x < to.x ? 1 : -1
  const dy = -Math.abs(to.y - y)
  const sy = y < to.y ? 1 : -1
  let error = dx + dy
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
    if (x === to.x && y === to.y) return true
    const cell = cells.get(`${x},${y}`)
    if (!cell || cell.type === 'wall') return false
  }
  return true
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
  const leftObject = left && typeof left === 'object' ? left as { location_id?: unknown; location?: unknown } : null
  const rightObject = right && typeof right === 'object' ? right as { location_id?: unknown; location?: unknown } : null
  const leftId = String(leftObject?.location_id ?? '').trim()
  const rightId = String(rightObject?.location_id ?? '').trim()
  if (leftId && rightId) return leftId === rightId
  return canonicalLocationKey(leftObject?.location ?? left) === canonicalLocationKey(rightObject?.location ?? right)
}

function merchantIsAtLocation(merchantLocation: unknown, sceneLocation: unknown) {
  const merchantObject = merchantLocation && typeof merchantLocation === 'object'
    ? merchantLocation as { location_id?: unknown; location?: unknown }
    : null
  const merchantKey = canonicalLocationKey(merchantObject?.location ?? merchantLocation)
  const merchantId = String(merchantObject?.location_id ?? '').trim()
  return (!merchantKey && !merchantId) || locationsMatch(merchantLocation, sceneLocation)
}

function combatState(state: GameState): CombatMechanics {
  return state.mechanics?.combat ?? {}
}

function currentTurnActorId(state: GameState) {
  const combat = combatState(state)
  if (!combat.active || !combat.initiative?.length) return state.activePlayerId
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
  return Number.isFinite(saved) && saved >= UI_SCALE_MIN && saved <= UI_SCALE_MAX ? saved : 125
}

const clampUiScale = (value: number) => Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value / 5) * 5))

function loadScenicBackdrop() {
  return window.localStorage.getItem(SCENIC_BACKDROP_KEY) !== 'false'
}

function Logo() {
  return <div className="logo"><div className="logo-mark"><Dices size={21} /></div><span>СКАЗАНИЕ</span></div>
}

// Ставки приходят серверными ключами: показывать игроку `athletics · medium`
// нельзя, а переводить их на сервере значит смешивать механику с подачей.
const SKILL_LABELS: Record<string, string> = {
  acrobatics: 'Акробатика', animal_handling: 'Уход за животными', arcana: 'Магия', athletics: 'Атлетика',
  deception: 'Обман', history: 'История', insight: 'Проницательность', intimidation: 'Запугивание',
  investigation: 'Расследование', medicine: 'Медицина', nature: 'Природа', perception: 'Восприятие',
  performance: 'Выступление', persuasion: 'Убеждение', religion: 'Религия', sleight_of_hand: 'Ловкость рук',
  stealth: 'Скрытность', survival: 'Выживание',
}
const ABILITY_LABELS: Record<string, string> = {
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
}
const DIFFICULTY_LABELS: Record<string, string> = {
  trivial: 'просто', easy: 'легко', medium: 'непросто', hard: 'трудно', extreme: 'почти невозможно',
}

function stakesTitle(stakes: NonNullable<Message['stakes']>) {
  const skill = stakes.skill ? SKILL_LABELS[stakes.skill] ?? stakes.skill : ''
  const ability = stakes.ability ? ABILITY_LABELS[stakes.ability] ?? stakes.ability : ''
  const name = skill || ability || 'Проверка'
  const both = skill && ability ? `${skill} (${ability})` : name
  const category = stakes.difficulty_category ? DIFFICULTY_LABELS[stakes.difficulty_category] ?? '' : ''
  return `${both} · СЛ ${stakes.difficulty}${category ? ` · ${category}` : ''}`
}

function PlayerCard({ player, selected, turn, accessible, deathSaves, onClick }: { player: Player; selected: boolean; turn: boolean; accessible: boolean; deathSaves?: { successes: number; failures: number; stable: boolean }; onClick: () => void }) {
  // Герой на 0 ОЗ выглядел точно как здоровый: движок помечал его `unconscious`
  // и вёл спасброски от смерти, а в списке отряда об этом не было ни слова.
  const downed = player.hp <= 0
  const downedLabel = deathSaves?.stable ? 'СТАБИЛИЗИРОВАН' : 'БЕЗ СОЗНАНИЯ'
  return (
    <button className={`player-card ${selected ? 'active' : ''} ${accessible ? '' : 'locked'} ${downed ? 'downed' : ''}`} onClick={onClick} disabled={!accessible}>
      <div className="avatar portrait-avatar" style={{ '--avatar': player.color, backgroundImage: `url(${player.portrait})`, backgroundPosition: player.portraitPosition } as React.CSSProperties}>
        <span className={`presence ${player.online ? 'online' : ''}`} />
      </div>
      <div className="player-meta">
        <div className="player-name-row"><strong>{player.character}</strong>{turn && <Crown size={12} />}{!accessible && <LockKeyhole size={11} />}</div>
        <span>{player.role}</span>
        <div className="hp-line"><i style={{ width: `${Math.max(0, player.hp) / Math.max(1, player.maxHp) * 100}%` }} /><small>{player.hp}/{player.maxHp}</small></div>
        {downed && <div className="downed-line" title={deathSaves ? `Спасброски от смерти: ${deathSaves.successes} успеха, ${deathSaves.failures} провала` : undefined}>
          <HeartCrack size={11} /><span>{downedLabel}</span>
          {deathSaves && !deathSaves.stable && <em>{deathSaves.successes}✓ · {deathSaves.failures}✕</em>}
        </div>}
      </div>
      {/* Щит и число — один блок. Раньше число висело абсолютом от края карточки,
          а щит стоял в колонке сетки: их центры совпадали только на одном
          сочетании шрифта и размера иконки и разъезжались при любом другом. */}
      <span className="armor-badge"><Shield className="armor-icon" size={15} /><b className="armor-value">{player.armor}</b></span>
    </button>
  )
}

function Sidebar({ players, selectedPlayerId, turnPlayerId, accessibleHeroIds, isAdmin, deathSavesByHero, onSelect, collapsed, onToggle, view, onNavigate, aiConnected }: {
  players: Player[]; selectedPlayerId: string; turnPlayerId: string; accessibleHeroIds: string[]; isAdmin: boolean; deathSavesByHero?: Record<string, { successes: number; failures: number; stable: boolean }>; onSelect: (id: string) => void; collapsed: boolean; onToggle: () => void; view: View; onNavigate: (view: View) => void; aiConnected: boolean
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
        <button className={`nav-item ${view === 'world-map' ? 'active' : ''}`} data-tooltip="Глобальная карта" aria-label="Глобальная карта" onClick={() => onNavigate('world-map')}><Globe2 size={18} /><span>Глобальная карта</span></button>
        <button className={`nav-item ${view === 'journal' ? 'active' : ''}`} data-tooltip="Журнал кампании" aria-label="Журнал кампании" onClick={() => onNavigate('journal')}><ScrollText size={18} /><span>Журнал кампании</span></button>
        <button className={`nav-item ${view === 'characters' ? 'active' : ''}`} data-tooltip="Персонажи" aria-label="Персонажи" onClick={() => onNavigate('characters')}><BookOpen size={18} /><span>Персонажи</span></button>
        <button className={`nav-item ${view === 'inventory' ? 'active' : ''}`} data-tooltip="Инвентарь" aria-label="Инвентарь" onClick={() => onNavigate('inventory')}><BackpackIcon /><span>Инвентарь</span></button>
        {/* Пункта «Торговец» здесь больше нет: торговля открывается кнопкой в
            заголовке сцены, которая появляется, только когда торговец рядом, и
            называет его по имени. Постоянный пункт меню вёл в то же окно и в
            большинстве локаций горел «недоступен». */}
        {isAdmin && <button className={`nav-item ${view === 'admin' ? 'active' : ''}`} data-tooltip="Управление миром" aria-label="Управление миром" onClick={() => onNavigate('admin')}><ShieldCheck size={18} /><span>Управление миром</span></button>}
        {isAdmin && <button className={`nav-item ${view === 'agent-lab' ? 'active' : ''}`} data-tooltip="Лаборатория агентов" aria-label="Открыть лабораторию агентов в отдельном окне" onClick={() => { const url = new URL(window.location.href); url.searchParams.set('agentLab', '1'); window.open(url.toString(), 'skazanie-agent-lab', 'width=1500,height=950') }}><BrainCircuit size={18} /><span>Лаборатория агентов</span></button>}
      </nav>
      <div className="sidebar-section">
        <div className="section-label"><span>ОТРЯД · {players.filter(p => p.online).length} В СЕТИ{players.some((p) => p.hp <= 0) ? ` · ${players.filter((p) => p.hp <= 0).length} ПАЛИ` : ''}</span><MoreHorizontal size={17} /></div>
        <div className="players-list">
          {players.map((player) => <PlayerCard key={player.id} player={player} selected={player.id === selectedPlayerId} turn={player.id === turnPlayerId} accessible={accessibleHeroIds.includes(player.id)} deathSaves={deathSavesByHero?.[player.id]} onClick={() => onSelect(player.id)} />)}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} data-tooltip="Настройки" aria-label="Настройки" onClick={() => onNavigate('settings')}><Settings size={18} /><span>Настройки</span></button>
        {/* Об исправном агенте сообщать нечего: он подключён почти всегда, и
            плашка просто занимала угол. А вот демо-режим менять ожидания игрока
            обязан — историю в нём ведёт локальный рассказчик. Кто именно
            подключён и какая модель, видно в настройках. */}
        {!aiConnected && <div className="demo-badge"><Sparkles size={14} /><span><b>Демо-режим</b><small>Локальный рассказчик</small></span></div>}
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
  const signature = enemy.name.toLocaleLowerCase('ru')
  if (/(дрон|робот|андроид|автомат|мех|голем|конструкт|страж|construct|golem|guardian|drone|robot)/u.test(signature)) return 'construct'
  if (/(скелет|нежит|призрак|зомби|упыр|undead|skeleton|ghost|wraith|zombie)/u.test(signature)) return 'undead'
  if (/(волк|звер|крыса|паук|медвед|beast|wolf|rat|spider|bear)/u.test(signature)) return 'beast'
  if (/(маг|чарод|колдун|жрец|шаман|культист|mage|caster|warlock|cultist|shaman)/u.test(signature)) return 'mystic'
  return 'raider'
}

/* Числа лежат на самой полоске, а фон под ними по мере ранения меняется с заливки
   на пустоту. Поэтому текст рисуется дважды: светлый на всю ширину и тёмный,
   обрезанный по заливке. Контраст держится при любом остатке, без обводки — она
   на полоске в 11px превращается в грязь. */
function TokenHealthBar({ fill, label, className }: { fill: number; label?: string; className?: string }) {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0))
  return <span className={`map-token-hp ${className ?? ''}`} style={{ '--hp-fill': ratio } as React.CSSProperties}>
    <i />
    {label ? <b>{label}</b> : null}
    {label && ratio > 0 ? <span className="map-token-hp-lit"><b>{label}</b></span> : null}
  </span>
}

/**
 * Что можно творить без инициативы. Список повторяет серверный
 * `HARMFUL_SPELL_KINDS` из rules-engine: решает всё равно сервер, здесь он
 * нужен, чтобы не предлагать игроку плитку, которая заведомо вернёт отказ.
 */
const HARMFUL_SPELL_KINDS = new Set(['attack', 'damage', 'area-damage', 'save', 'area-save', 'debuff'])
const castableOutOfCombat = (spell: { kind?: string } | null | undefined) => Boolean(spell && !HARMFUL_SPELL_KINDS.has(String(spell.kind)))

/**
 * Шапка колонки описания: название и полный текст. Кнопки раскрытия нет —
 * высоту панели игрок задаёт сам, перетаскивая её верхний край.
 */
function DetailHeader({ title, description }: { title: string; description?: string }) {
  return <>
    <div className="detail-head"><strong>{title}</strong></div>
    {description ? <p>{description}</p> : null}
  </>
}

function enemyHealthPresentation(enemy: Enemy) {
  const exact = enemy.healthKnown === 'exact' && Number.isFinite(enemy.hp) && Number.isFinite(enemy.maxHp) && Number(enemy.maxHp) > 0
  const labels: Record<NonNullable<Enemy['healthStatus']>, string> = {
    unharmed: 'Не ранен',
    wounded: 'Ранен',
    bloodied: 'Тяжело ранен',
    critical: 'При смерти',
    defeated: 'Побеждён',
  }
  const ratio = Number.isFinite(enemy.hp) && Number.isFinite(enemy.maxHp) && Number(enemy.maxHp) > 0
    ? Number(enemy.hp) / Number(enemy.maxHp)
    : null
  const derivedStatus: NonNullable<Enemy['healthStatus']> = enemy.healthStatus
    ?? (!enemy.alive || ratio === 0 ? 'defeated' : ratio == null || ratio >= 1 ? 'unharmed' : ratio > .5 ? 'wounded' : ratio > .25 ? 'bloodied' : 'critical')
  /* Пока характеристики не раскрыты, точной доли нет — полоска показывает ступень
     состояния теми же долями, какими её раньше задавали классы в CSS. */
  const statusFill: Record<NonNullable<Enemy['healthStatus']>, number> = { unharmed: 1, wounded: .75, bloodied: .5, critical: .2, defeated: 0 }
  return {
    exact,
    status: derivedStatus,
    label: exact ? `${enemy.hp}/${enemy.maxHp} ОЗ` : labels[derivedStatus],
    percent: exact ? Math.max(0, Math.min(100, Number(enemy.hp) / Number(enemy.maxHp) * 100)) : null,
    fill: exact ? Math.max(0, Math.min(1, Number(enemy.hp) / Number(enemy.maxHp))) : statusFill[derivedStatus],
    /* В полоску пишем только то, что игрок имеет право знать: числа при раскрытых
       характеристиках. Слово состояния туда не влезает («Тяжело ранен» вдвое шире
       полоски), поэтому оно остаётся в подписи под токеном и в aria-label. */
    barLabel: exact ? `${enemy.hp}/${enemy.maxHp}` : '',
  }
}

function EnemyGlyph({ kind }: { kind: EnemyVisualKind }) {
  if (kind === 'construct') return <Bot size={17} />
  if (kind === 'undead') return <Skull size={17} />
  if (kind === 'beast') return <PawPrint size={17} />
  if (kind === 'mystic') return <WandSparkles size={17} />
  return <Swords size={17} />
}

function boardVisualTheme(state: GameState) {
  const materials = new Set(state.scene.cells.map((cell) => cell.material).filter(Boolean))
  const patterns = new Set(state.scene.cells.map((cell) => cell.pattern).filter(Boolean))
  if (patterns.has('cave-cluster') || patterns.has('crypt')) return 'map-theme-cave'
  if (patterns.has('small-room') && materials.has('wood')) return 'map-theme-interior'
  if (materials.has('grass')) return 'map-theme-wild'
  if (materials.has('sand')) return 'map-theme-desert'
  if (materials.has('marble')) return 'map-theme-temple'
  if (materials.has('metal')) return 'map-theme-tech'
  const signature = [state.scene.location, state.scene.theme, state.campaignConcept?.era, state.campaignConcept?.technologyLevel].filter(Boolean).join(' ').toLocaleLowerCase('ru')
  if (/(станци|косм|орбит|кибер|техно|футур|звезд|sci.?fi|space|station)/u.test(signature)) return 'map-theme-tech'
  if (/(лес|чащ|джунг|болот|природ|роща|forest|wild|jungle|swamp)/u.test(signature)) return 'map-theme-wild'
  return 'map-theme-ruins'
}

const BOARD_MAP_LIBRARY = {
  cave: { id: 'dyson-logos-cavern', url: '/assets/maps/library/dyson-logos/cave/dyson-logos-cavern.webp' },
  dungeon: { id: 'dyson-logos-dungeon', url: '/assets/maps/library/dyson-logos/dungeon/dyson-logos-dungeon.webp' },
  tavern: { id: 'dyson-logos-estate', url: '/assets/maps/library/dyson-logos/tavern/dyson-logos-estate.webp' },
  temple: { id: 'dyson-logos-temple', url: '/assets/maps/library/dyson-logos/temple/dyson-logos-temple.webp' },
  village: { id: 'dyson-logos-village', url: '/assets/maps/library/dyson-logos/village/dyson-logos-village.webp' },
} as const

function boardMapArt(state: GameState, visualTheme: string) {
  const signature = `${state.scene.location} ${state.scene.theme}`.toLocaleLowerCase('ru')
  if (/(таверн|трактир|корчм|постоял|inn|tavern|estate|усадьб|дом|зал)/u.test(signature)) return BOARD_MAP_LIBRARY.tavern
  if (/(храм|святилищ|часовн|temple|shrine)/u.test(signature) || visualTheme === 'map-theme-temple') return BOARD_MAP_LIBRARY.temple
  if (/(пещер|грот|каверн|cave|cavern)/u.test(signature) || visualTheme === 'map-theme-cave') return BOARD_MAP_LIBRARY.cave
  if (/(деревн|посел|город|улиц|village|town|settlement)/u.test(signature) || visualTheme === 'map-theme-wild') return BOARD_MAP_LIBRARY.village
  return BOARD_MAP_LIBRARY.dungeon
}

function DungeonMap({ state, players, turnActorId, canAct, tacticalBusy, tacticalError, autoAttackRoll, scenicBackdrop, onClearTacticalError, onStartCombat, onMove, onAttack, onAreaAttack, onCastSpell, onUseCombatAction, onChangeWeapon, onFinishTurn, onFreeAction, narrating, statusContent, children }: {
  state: GameState
  players: Player[]
  turnActorId: string
  canAct: boolean
  tacticalBusy: boolean
  tacticalError: string | null
  autoAttackRoll: boolean
  scenicBackdrop: boolean
  onClearTacticalError: () => void
  onStartCombat: () => void
  onMove: (actorId: string, x: number, y: number) => void
  onAttack: (actorId: string, enemyId: string, itemId?: string, knockOut?: boolean, note?: string) => void
  onAreaAttack: (actorId: string, itemId: string, x: number, y: number, note?: string) => void
  onCastSpell: (actorId: string, spellId: string, target: (({ targetId: string } | { x: number; y: number }) & { spellOption?: string; knockOut?: boolean; note?: string })) => void
  onUseCombatAction: (actorId: string, actionId: string, targetId?: string, itemId?: string, beneficiaryId?: string, note?: string) => void
  onChangeWeapon: (actorId: string, itemId: string) => void
  onFinishTurn: () => void
  onFreeAction: (text: string) => void
  narrating: boolean
  statusContent: React.ReactNode
  children?: React.ReactNode
}) {
  const [freeText, setFreeText] = useState('')
  const [openTokenLabelId, setOpenTokenLabelId] = useState<string | null>(null)
  /* Размеры панелей задаёт игрок и они переживают перезагрузку: у кого-то
     широкий монитор и хочется больше карты, у кого-то — длинные описания.
     Значения храним в тех же единицах, что и CSS, и пишем на корень документа,
     где объявлены переменные сетки. */
  const [railHeight, setRailHeight] = useState(() => Number(window.localStorage.getItem(RAIL_HEIGHT_KEY)) || 0)
  const [serverWidth, setServerWidth] = useState(() => Number(window.localStorage.getItem(SERVER_WIDTH_KEY)) || 0)
  const [detailWidth, setDetailWidth] = useState(() => Number(window.localStorage.getItem(DETAIL_WIDTH_KEY)) || 0)
  useEffect(() => {
    const root = document.documentElement.style
    if (railHeight) root.setProperty('--ui-rail-height', `${railHeight}px`)
    else root.removeProperty('--ui-rail-height')
    if (serverWidth) root.setProperty('--ui-server-column', `${serverWidth}px`)
    else root.removeProperty('--ui-server-column')
    if (detailWidth) root.setProperty('--ui-detail-width', `${detailWidth}px`)
    else root.removeProperty('--ui-detail-width')
  }, [railHeight, serverWidth, detailWidth])
  const startRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = document.querySelector('.turn-rail')?.getBoundingClientRect().height ?? 292
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerHeight * .45, Math.max(150, startHeight + (startY - moveEvent.clientY))))
      setRailHeight(next)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setRailHeight((value) => { if (value) window.localStorage.setItem(RAIL_HEIGHT_KEY, String(value)); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  /* Граница между колодой и описанием. Тянем влево — описание шире, вправо —
     больше места плиткам; за нижним пределом колода начинает прокручиваться. */
  const startDetailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = document.querySelector('.hotbar-detail')?.getBoundingClientRect().width ?? 360
    const rowWidth = document.querySelector('.hotbar-main')?.getBoundingClientRect().width ?? 1200
    const move = (moveEvent: PointerEvent) => {
      setDetailWidth(Math.round(Math.min(rowWidth * .6, Math.max(260, startWidth - (moveEvent.clientX - startX)))))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setDetailWidth((value) => { if (value) window.localStorage.setItem(DETAIL_WIDTH_KEY, String(value)); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const startServerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = document.querySelector('.server-column')?.getBoundingClientRect().width ?? 320
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerWidth * .32, Math.max(240, startWidth + (startX - moveEvent.clientX))))
      setServerWidth(next)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setServerWidth((value) => { if (value) window.localStorage.setItem(SERVER_WIDTH_KEY, String(value)); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null)
  const [combatMode, setCombatMode] = useState<CombatMode>('weapon')
  const [activeDeck, setActiveDeck] = useState<CombatDeck>('weapon')
  const [selectedItemId, setSelectedItemId] = useState(BASE_ATTACK_ID)
  const [selectedSpellId, setSelectedSpellId] = useState('')
  const [selectedSpellOption, setSelectedSpellOption] = useState('')
  const [selectedCombatActionId, setSelectedCombatActionId] = useState('')
  const [knockOut, setKnockOut] = useState(false)
  const [spellbookOpen, setSpellbookOpen] = useState(false)
  const [spellSearch, setSpellSearch] = useState('')
  const [spellLevelFilter, setSpellLevelFilter] = useState<number | 'all'>('all')
  const [hotbarSpellIds, setHotbarSpellIds] = useState<string[]>([])
  const [aimCell, setAimCell] = useState<{ x: number; y: number } | null>(null)
  const [pendingCommand, setPendingCommand] = useState<PendingCombatCommand | null>(null)
  const [hoveredMoveKey, setHoveredMoveKey] = useState<string | null>(null)
  const [pendingMoveKey, setPendingMoveKey] = useState<string | null>(null)
  const [inspectedTarget, setInspectedTarget] = useState<{ id: string; name: string; team: 'ally' | 'enemy'; hp?: number; maxHp?: number; healthLabel?: string; distanceFeet: number; allowed: boolean; reason: string | null } | null>(null)
  const { columns: cellColumns, rows: cellRows } = mapGridDimensions(state.scene.cells)
  // Канон сцены — `scene.map`; старая проекция без него собирается из клеток.
  const boardMap = useMemo(() => sceneTacticalMap(state.scene), [state.scene])
  const columns = boardMap?.width ?? cellColumns
  const rows = boardMap?.height ?? cellRows
  const irregularMap = state.scene.cells.length < columns * rows
  const combat = combatState(state)
  const combatActive = Boolean(combat.active && combat.initiative?.length)
  const activeHero = players.find((player) => player.id === turnActorId)
  const activeSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const activeEnemy = state.enemies?.find((enemy) => enemy.id === turnActorId && enemy.alive)
  const activeTurnLabel = !combatActive ? 'ИДЁТ СВОБОДНО' : activeEnemy ? 'ХОД ПРОТИВНИКА' : activeSummon ? 'ХОД ПРИЗЫВА' : 'ХОД ИГРОКА'
  const active: BoardCombatant | undefined = activeHero ?? activeSummon
  const activeName = activeHero?.character ?? activeSummon?.name ?? activeEnemy?.name ?? 'участник боя'
  const combatItems = (activeHero?.inventory ?? []).map(inferredCombatItem).filter((item): item is NonNullable<typeof item> => Boolean(item && item.quantity > 0))
  const selectedItem = selectedItemId === BASE_ATTACK_ID ? undefined : combatItems.find((item) => item.id === selectedItemId)
  const weaponSelectionId = selectedItem?.id ?? BASE_ATTACK_ID
  const projectedSpells = activeHero?.combatSpells ?? []
  const fallbackSpells = fallbackCombatSpells(activeHero)
  const spells = [...new Map([...fallbackSpells, ...projectedSpells].map((spell) => [spell.id, spell])).values()]
  const hotbarSpells = spells.filter((spell) => hotbarSpellIds.includes(spell.id) && spellActionType(spell) !== 'reaction')
  const selectedSpell = spells.find((spell) => spell.id === selectedSpellId) ?? spells[0]
  const combatActions = activeHero ? (activeHero.combatActions?.length ? activeHero.combatActions : fallbackCombatActions(activeHero)) : []
  const selectedCombatAction = combatActions.find((action) => action.id === selectedCombatActionId) ?? null
  const selectedSpellKind = spellKind(selectedSpell)
  const selectedSpellRange = spellRange(selectedSpell)
  const activeConditionIds = new Set((state.mechanics?.conditions?.[turnActorId] ?? []).map((condition) => String(condition.id)))
  const selectedSpellAction = activeConditionIds.has('metamagic-quickened') && spellActionType(selectedSpell) === 'action' ? 'bonus_action' : spellActionType(selectedSpell)
  const activeResources = {
    ...fallbackCombatResources(activeHero),
    ...fallbackSpellResources(activeHero),
    ...((state.mechanics as { resources?: Record<string, Record<string, { current?: number; max?: number }>> } | undefined)?.resources?.[turnActorId] ?? {}),
  }
  const spellPools = selectedSpell?.slotResource
    ? selectedSpell.slotResource === 'pact_slots' || selectedSpell.slotResource === 'mystic_arcanum_6'
      ? [activeResources[selectedSpell.slotResource]].filter(Boolean)
      : Array.from({ length: Math.max(0, 7 - selectedSpell.level) }, (_, index) => activeResources[`spell_slots_${selectedSpell.level + index}`]).filter(Boolean)
    : []
  const selectedSpellPool = spellPools.find((pool) => Number(pool?.current ?? 0) > 0) ?? spellPools[0]
  const spellSlotReady = !selectedSpell?.slotResource || spellPools.some((pool) => Number(pool?.current ?? 0) > 0)
  const genericProfile = active as (BoardCombatant & { attackRange?: number; rangeFeet?: number; attack_profile?: { kind?: 'melee' | 'ranged'; range_feet?: number; normal_range_feet?: number } }) | undefined
  const baseRangeFeet = Math.max(CELL_FEET, Number(genericProfile?.attack_profile?.range_feet ?? genericProfile?.attackRange ?? genericProfile?.rangeFeet) || CELL_FEET)
  const selectedAttackKind = selectedItem?.combat?.kind ?? genericProfile?.attack_profile?.kind ?? (baseRangeFeet <= CELL_FEET ? 'melee' : 'ranged')
  const knockoutEligible = combatMode === 'weapon'
    ? selectedAttackKind === 'melee'
    : combatMode === 'magic' && selectedSpell?.kind === 'attack' && selectedSpell.attackKind === 'melee'
  const attackRangeFeet = Math.max(CELL_FEET, Number(selectedItem?.combat?.longRange ?? selectedItem?.combat?.normalRange) || baseRangeFeet)
  const normalRangeFeet = Math.max(CELL_FEET, Number(selectedItem?.combat?.normalRange ?? genericProfile?.attack_profile?.normal_range_feet) || attackRangeFeet)
  const areaRadiusFeet = selectedItem?.combat?.kind === 'thrown-area' ? Number(selectedItem.combat.radius) || 5 : 0
  const spellAreaRadiusFeet = combatMode === 'magic' && selectedSpell?.target === 'point' ? Math.max(0, Number(selectedSpell.radius) || 0) : 0
  const equippedWeapon = activeHero?.inventory.find((item) => item.type === 'weapon' && item.equipped)
  const needsWeaponChange = Boolean(selectedItem?.type === 'weapon' && !selectedItem.equipped && equippedWeapon && equippedWeapon.id !== selectedItem.id)
  const economy = combat.action_economy?.[turnActorId]
  const authoritativeMovementSpent = economy?.movement_remaining != null
    ? Math.max(0, (active?.speed ?? 0) - economy.movement_remaining)
    : economy?.movement_spent ?? (economy?.movement === false ? active?.speed ?? 0 : 0)
  const tacticalState = {
    ...state,
    activePlayerId: turnActorId,
    tacticalTurn: {
      sceneTurn: state.scene.turn,
      actorId: turnActorId,
      movementSpent: authoritativeMovementSpent,
      actionUsed: economy?.action === false,
    },
  }
  // Exploration and combat share the same authoritative pathfinding, but only
  // combat spends per-turn movement. Outside initiative the selected hero can
  // walk to any revealed cell connected by a legal path.
  const selected = canAct && !tacticalBusy && active ? turnActorId : null
  const tactical = currentTacticalTurn(tacticalState)
  const movementBonus = Math.max(0, Number(economy?.movement_bonus) || 0)
  const speedFeet = (active?.speed ?? 0) + movementBonus
  const remainingFeet = Math.max(0, speedFeet - tactical.movementSpent)
  const movementAvailable = !combatActive || economy?.movement !== false
  const movementPaths = active ? buildMovementPaths(state, active, CELL_FEET) : new Map<string, MovementPath>()
  const movementLimit = combatActive ? remainingFeet : Number.POSITIVE_INFINITY
  const reachable = selected && active && movementAvailable
    ? new Set([...movementPaths.entries()].filter(([, route]) => route.costFeet <= movementLimit).map(([key]) => key))
    : new Set<string>()
  const previewMoveKey = pendingMoveKey ?? hoveredMoveKey
  const previewRoute = previewMoveKey ? movementPaths.get(previewMoveKey) ?? null : null
  const previewRouteSteps = new Map((previewRoute?.path ?? []).map((step, index) => [boardPositionKey(step.x, step.y), index + 1]))
  const actionReady = !tactical.actionUsed && economy?.action !== false
  // «Дополнительная атака» — свойство действия «Атака», а не отдельная кнопка:
  // действие уже потрачено первым ударом, но оружие бьёт ещё раз, и между
  // ударами можно перемещаться.
  const weaponAttacksUsed = Math.max(0, Number(economy?.attacks_used) || 0)
  const weaponAttacksAllowed = Math.max(1, Number(economy?.attacks_allowed) || 1)
  const weaponAttacksLeft = Math.max(0, weaponAttacksAllowed - weaponAttacksUsed)
  const weaponAttackReady = actionReady || (weaponAttacksUsed > 0 && weaponAttacksLeft > 0)
  const bonusReady = economy?.bonus_action !== false
  const reactionReady = economy?.reaction !== false
  const selectedSpellSupport = mechanicsSupportPresentation(selectedSpell?.mechanicsSupport, selectedSpell?.supportNote)
  /* Вне боя экономики хода нет, а длинное накладывание, наоборот, доступно
     только там: боевая панель его не вмещает. Совпадает с правилом движка —
     `HARMFUL_SPELL_KINDS` и проверка `long_cast` в rules-engine. */
  const spellEconomyReady = !selectedSpellSupport.blocked && selectedSpell?.prepared !== false && spellSlotReady && (combatActive
    ? selectedSpellAction !== 'long_cast' && (selectedSpellAction === 'bonus_action' ? bonusReady : selectedSpellAction === 'reaction' ? reactionReady : actionReady)
    : Boolean(selectedSpell && castableOutOfCombat(selectedSpell)))
  const selectedActionPool = selectedCombatAction?.resource ? activeResources[selectedCombatAction.resource] : undefined
  const selectedActionResourceReady = !selectedCombatAction?.resource || Number(selectedActionPool?.current ?? 0) >= Number(selectedCombatAction.cost ?? 1)
  const selectedActionSupport = mechanicsSupportPresentation(selectedCombatAction?.mechanicsSupport, selectedCombatAction?.supportNote)
  const selectedActionEconomyReady = Boolean(selectedCombatAction && !selectedActionSupport.blocked && selectedActionResourceReady && (selectedCombatAction.actionType === 'free' || (selectedCombatAction.actionType === 'bonus_action' ? bonusReady : selectedCombatAction.actionType === 'reaction' ? reactionReady : actionReady)))
  const selectedCommandReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
  /* Действие на себя цели на карте не требует, поэтому подтверждение выводится
     из самого выбора, а не хранится в `pendingCommand`: команду стирает эффект,
     который срабатывает как раз на смену выбранного заклинания. */
  const selfCastSpell = combatMode === 'magic' && selectedSpell?.target === 'self' && spellEconomyReady ? selectedSpell : null
  const selfUseAction = combatMode === 'action' && selectedCombatAction?.target === 'self' && selectedActionEconomyReady ? selectedCombatAction : null
  const selfCastReady = Boolean(selected && !tacticalBusy && (selfCastSpell || selfUseAction))
  const confirmSelfCast = (note?: string) => {
    if (!selected) return
    if (selfCastSpell) onCastSpell(selected, selfCastSpell.id, { targetId: selected, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(note ? { note } : {}) })
    else if (selfUseAction) onUseCombatAction(selected, selfUseAction.id, undefined, selfUseAction.requiresWeapon ? selectedItem?.id : undefined, undefined, note)
  }
  /* Выбор надо уметь снять. Вне боя плитка базовой атаки закрыта, и без этой
     кнопки подтверждение висело бы до следующего выбранного заклинания. */
  const cancelSelfCast = () => setCombatMode('weapon')
  const aliveEnemies = (state.enemies ?? []).filter((enemy) => enemy.alive && !(state.mechanics?.conditions?.[enemy.id] ?? []).some((condition) => condition.id === 'unconscious'))
  const opportunityThreats = combatActive && active && !activeConditionIds.has('disengaged') && !activeConditionIds.has('invisible')
    ? aliveEnemies.filter((enemy) => {
        const conditions = new Set((state.mechanics?.conditions?.[enemy.id] ?? []).map((condition) => String(condition.id)))
        const reactionAvailable = combat.action_economy?.[enemy.id]?.reaction !== false
        const threatProfile = enemy as Enemy & { attack_profile?: { range_feet?: number }; attackRange?: number }
        const range = Number(threatProfile.attack_profile?.range_feet ?? threatProfile.attackRange ?? 5) || 5
        return reactionAvailable
          && range <= CELL_FEET
          && !['incapacitated', 'unconscious', 'stunned', 'paralyzed'].some((condition) => conditions.has(condition))
          && chebyshevFeet(active, enemy) === CELL_FEET
      })
    : []
  const showStartCombat = aliveEnemies.length > 0 && !combatActive
  /* Вне боя плитки видны, но не нажимаются: выбор цели на карте закрыт по всему
     клиенту (`combatActive &&` в каждом правиле наведения), да и сервер отвергает
     атаку и боевое действие без инициативы — `COMBAT_NOT_ACTIVE` в rules-engine.
     Показывать живую плитку, которая никуда не ведёт, хуже, чем закрытую. */
  const actionsLocked = tacticalBusy || !combatActive
  const availableSpellLevels = [...new Set(spells.map((spell) => spell.level))].sort((left, right) => left - right)
  const normalizedSpellSearch = spellSearch.trim().toLocaleLowerCase('ru')
  const filteredSpellbookSpells = spells.filter((spell) => (spellLevelFilter === 'all' || spell.level === spellLevelFilter) && (!normalizedSpellSearch || `${spell.name} ${spell.englishName ?? ''} ${spell.description ?? ''}`.toLocaleLowerCase('ru').includes(normalizedSpellSearch)))
  const pendingPoint = pendingCommand?.kind === 'area' || pendingCommand?.kind === 'spell-point' ? pendingCommand : null
  const pendingTargetId = pendingCommand?.kind === 'target' || pendingCommand?.kind === 'spell-target' || pendingCommand?.kind === 'action-target'
    ? pendingCommand.targetId
    : null
  const pendingTarget = pendingTargetId
    ? [...players, ...(state.actors ?? []), ...(state.enemies ?? [])].find((actor) => actor.id === pendingTargetId) ?? null
    : null
  const projectileTarget = pendingPoint ?? aimCell
  const projectileEnd = pendingTarget ?? projectileTarget
  const trajectory = active && projectileEnd ? { x1: (active.x + .5) / columns * 100, y1: (active.y + .5) / rows * 100, x2: (projectileEnd.x + .5) / columns * 100, y2: (projectileEnd.y + .5) / rows * 100 } : null
  const activeConditions = (state.mechanics?.conditions?.[turnActorId] ?? []).map(conditionPresentation)
  const activeTeam = activeHero || activeSummon ? 'СОЮЗНИК' : 'ПРОТИВНИК'
  const activeHealth = active
    ? `${active.hp}/${active.maxHp} ОЗ`
    : activeEnemy ? enemyHealthPresentation(activeEnemy).label : '—'
  const selectedCommandName = combatMode === 'magic' && selectedSpell
    ? selectedSpell.name
    : combatMode === 'action' && selectedCombatAction ? selectedCombatAction.name : selectedItem?.name ?? 'Базовая атака'
  const pendingTargetName = pendingTarget
    ? ('character' in pendingTarget ? pendingTarget.character : pendingTarget.name)
    : pendingPoint ? `клетка ${pendingPoint.x + 1}:${pendingPoint.y + 1}` : ''
  const pendingCommandLabel = pendingCommand ? `${selectedCommandName} → ${pendingTargetName}` : ''
  // Прогноз выбирается под выбранное оружие: игрок сравнивает варианты, а не
  // смотрит на один усреднённый процент.
  const inspectedForecast = (() => {
    if (!inspectedTarget || inspectedTarget.team !== 'enemy') return null
    const entries = state.combatForecast?.targets?.[inspectedTarget.id] ?? []
    if (!entries.length) return null
    return entries.find((entry) => entry.item_id === (selectedItem?.id ?? null)) ?? entries[0]
  })()
  const latestBattleEvent = state.battleLog?.at(-1)
  const visualTheme = boardVisualTheme(state)
  const mapArt = boardMapArt(state, visualTheme)

  useEffect(() => {
    const defaultItem = combatItems.find((item) => item.equipped) ?? combatItems[0]
    setSelectedItemId(defaultItem?.id ?? BASE_ATTACK_ID)
    const storageKey = `skazanie-hotbar-spells:${turnActorId}`
    let saved: string[] = []
    try { saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') } catch { saved = [] }
    const eligible = saved.filter((id) => spells.some((spell) => spell.id === id && spell.prepared !== false && spellActionType(spell) !== 'reaction'))
    const defaults = spells.filter((spell) => !mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked && spell.prepared !== false && spell.actionType !== 'long_cast' && spellActionType(spell) !== 'reaction' && spell.kind !== 'utility').slice(0, 18).map((spell) => spell.id)
    const nextHotbar = eligible.length ? eligible : defaults
    setHotbarSpellIds(nextHotbar)
    setSelectedSpellId(nextHotbar[0] ?? spells[0]?.id ?? '')
    setSelectedCombatActionId('')
    setSpellbookOpen(false)
    setActiveDeck('weapon')
    setCombatMode('weapon')
  }, [turnActorId])
  useEffect(() => {
    if (selectedSpell && selectedSpell.id !== selectedSpellId) setSelectedSpellId(selectedSpell.id)
  }, [selectedSpell?.id, selectedSpellId])
  useEffect(() => {
    const options = selectedSpell?.spellOptions ?? []
    if (!options.length) setSelectedSpellOption('')
    else if (!options.includes(selectedSpellOption as typeof options[number])) setSelectedSpellOption(options[0])
  }, [selectedSpell?.id, selectedSpellOption])
  useEffect(() => { if (!knockoutEligible) setKnockOut(false) }, [knockoutEligible])
  useEffect(() => {
    setPendingCommand(null)
    setPendingMoveKey(null)
    setHoveredMoveKey(null)
    setInspectedTarget(null)
    setAimCell(null)
  }, [selectedItemId, selectedSpellId, selectedCombatActionId, combatMode, turnActorId, combat.round])

  const chooseTarget = (enemyId: string) => {
    if (!selected || needsWeaponChange || selectedItem?.combat?.kind === 'thrown-area') return
    if (autoAttackRoll) onAttack(selected, enemyId, selectedItem?.id, knockOut && knockoutEligible)
    else setPendingCommand({ kind: 'target', targetId: enemyId })
  }
  const chooseArea = (x: number, y: number) => {
    if (!selected || !selectedItem || selectedItem.combat?.kind !== 'thrown-area') return
    if (autoAttackRoll) onAreaAttack(selected, selectedItem.id, x, y)
    else setPendingCommand({ kind: 'area', x, y })
  }
  const castAtTarget = (targetId: string) => {
    if (!selected || !selectedSpell || !spellEconomyReady) return
    setPendingCommand({ kind: 'spell-target', targetId })
  }
  const castAtCell = (x: number, y: number) => {
    if (!selected || !selectedSpell || selectedSpell.target !== 'point' || !spellEconomyReady) return
    setPendingCommand({ kind: 'spell-point', x, y })
  }
  const selectSpell = (spell: CombatSpell) => {
    if (mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked) return
    setSelectedSpellId(spell.id)
    setSelectedSpellOption(spell.spellOptions?.[0] ?? '')
    setCombatMode('magic')
    /* Нажатие на плитку выбирает, а не применяет. Раньше заклинание на себя
       уходило на сервер прямо из клика: игрок открывал колоду посмотреть, что у
       героя есть, и случайно тратил ячейку. Теперь оно ждёт подтверждения —
       кнопку рисует `selfCastReady`, выведенный из выбора. Хранить его в
       `pendingCommand` нельзя: эффект ниже стирает команду как раз при смене
       выбранного заклинания. */
  }
  const toggleHotbarSpell = (spellId: string) => {
    const next = hotbarSpellIds.includes(spellId) ? hotbarSpellIds.filter((id) => id !== spellId) : [...hotbarSpellIds, spellId].slice(-24)
    setHotbarSpellIds(next)
    window.localStorage.setItem(`skazanie-hotbar-spells:${turnActorId}`, JSON.stringify(next))
  }
  const useActionAtTarget = (targetId: string) => {
    if (!selected || !selectedCombatAction || !selectedActionEconomyReady) return
    setPendingCommand({ kind: 'action-target', targetId })
  }
  const selectCombatAction = (action: CombatAction) => {
    if (mechanicsSupportPresentation(action.mechanicsSupport, action.supportNote).blocked) return
    if (!selected || tacticalBusy) return
    const pool = action.resource ? activeResources[action.resource] : undefined
    const resourceReady = !action.resource || Number(pool?.current ?? 0) >= Number(action.cost ?? 1)
    const economyReady = action.actionType === 'free' || (action.actionType === 'bonus_action' ? bonusReady : action.actionType === 'reaction' ? reactionReady : actionReady)
    if (!resourceReady || !economyReady) return
    setSelectedCombatActionId(action.id)
    setCombatMode('action')
    // Как и заклинание на себя: выбор, описание, и только потом подтверждение.
  }
  /* Что именно уедет по «Отправить». Ярлык показывается прямо в строке ввода,
     поэтому игрок видит выбранное действие там же, где пишет слова к нему. */
  const preparedLabel = (() => {
    if (pendingCommand?.kind === 'target') return `${selectedItem?.name ?? 'Базовая атака'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'area') return `${selectedItem?.name ?? 'Бросок'} → клетка`
    if (pendingCommand?.kind === 'spell-target') return `${selectedSpell?.name ?? 'Заклинание'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'spell-point') return `${selectedSpell?.name ?? 'Заклинание'} → клетка`
    if (pendingCommand?.kind === 'action-target') return `${selectedCombatAction?.name ?? 'Действие'} → ${pendingTargetName ?? 'цель'}`
    if (selfCastSpell) return `${selfCastSpell.name} → на себя`
    if (selfUseAction) return `${selfUseAction.name} → на себя`
    return null
  })()
  const clearPrepared = () => { setPendingCommand(null); setCombatMode('weapon') }

  const confirmPreparedCommand = (note?: string) => {
    if (!selected || !pendingCommand) return
    if (pendingCommand.kind === 'target') onAttack(selected, pendingCommand.targetId, selectedItem?.id, knockOut && knockoutEligible, note)
    else if (pendingCommand.kind === 'area' && selectedItem) onAreaAttack(selected, selectedItem.id, pendingCommand.x, pendingCommand.y, note)
    else if (pendingCommand.kind === 'spell-target' && selectedSpell) {
      onCastSpell(selected, selectedSpell.id, { targetId: pendingCommand.targetId, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(knockOut && knockoutEligible ? { knockOut: true } : {}), ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'spell-point' && selectedSpell) {
      onCastSpell(selected, selectedSpell.id, { x: pendingCommand.x, y: pendingCommand.y, ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'action-target' && selectedCombatAction) {
      onUseCombatAction(selected, selectedCombatAction.id, pendingCommand.targetId, selectedCombatAction.requiresWeapon ? selectedItem?.id : undefined, undefined, note)
    }
    setPendingCommand(null)
  }

  // Доска. Перебор клеток остаётся прежним: он занимает доли миллисекунды и
  // узким местом не является (`docs/tactical-map-plan.md`, раздел 7). Меняется
  // то, что из него выходит: местность рисует холст, массовые подсветки —
  // холст же, а DOM-узел достаётся только активной клетке: занятой фишкой,
  // досягаемой, входящей в маршрут или в область команды.
  const boardCells: BoardCellNode[] = []
  const boardOverlay: BoardOverlayCell[] = []
  // Подсказки клеток без узла: причина недоступности обязана остаться на всех
  // клетках, а узел получает только активная.
  const boardHints = new Map<string, BoardCellHint>()
  for (const cell of state.scene.cells) {
    const player = players.find((item) => item.x === cell.x && item.y === cell.y && item.hp > 0)
    const enemy = state.enemies?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
    const summon = state.actors?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
    const attackDistanceFeet = enemy && active
      ? chebyshevFeet(active, enemy)
      : Number.POSITIVE_INFINITY
    const spellDistanceFeet = enemy && active ? chebyshevFeet(active, enemy) : Number.POSITIVE_INFINITY
    const clearTrajectory = Boolean(enemy && active && hasClearBoardTrajectory(state, active, enemy))
    const enemyInWeaponRange = attackDistanceFeet >= CELL_FEET && attackDistanceFeet <= attackRangeFeet && (attackRangeFeet <= CELL_FEET || clearTrajectory)
    const enemyInSpellRange = spellDistanceFeet <= selectedSpellRange && (selectedSpellRange <= CELL_FEET || clearTrajectory)
    const canWeaponTargetEnemy = Boolean(combatActive && selected && combatMode === 'weapon' && weaponAttackReady && enemyInWeaponRange && selectedItem?.combat?.kind !== 'thrown-area' && !needsWeaponChange)
    const canSpellTargetEnemy = Boolean(combatActive && selected && combatMode === 'magic' && selectedSpell && ['enemy', 'creature'].includes(selectedSpell.target) && spellEconomyReady && enemyInSpellRange)
    const selectedActionRange = selectedCombatAction?.requiresWeapon ? attackRangeFeet : Number(selectedCombatAction?.range ?? 0)
    const enemyInActionRange = Boolean(enemy && active && chebyshevFeet(active, enemy) <= selectedActionRange && (selectedActionRange <= CELL_FEET || clearTrajectory))
    const enemyKnockedOut = Boolean(enemy && state.mechanics?.resting?.[enemy.id]?.reason === 'knockout')
    const canActionTargetEnemy = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['enemy', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && enemyInActionRange && (selectedCombatAction.id !== 'first-aid' || enemyKnockedOut))
    const targetRangeFeet = combatMode === 'magic' ? selectedSpellRange : combatMode === 'action' ? selectedActionRange : selectedItem?.combat?.kind === 'thrown-area' ? normalRangeFeet : attackRangeFeet
    const acceptedTarget = combatMode === 'magic'
      ? selectedSpell?.target === 'ally' ? 'ally' : selectedSpell?.target === 'enemy' ? 'enemy' : 'creature'
      : combatMode === 'action'
        ? selectedCombatAction?.target === 'ally' ? 'ally' : selectedCombatAction?.target === 'enemy' ? 'enemy' : 'creature'
        : 'enemy'
    const targetEconomyReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
    const targetResourceReady = combatMode === 'magic' ? spellSlotReady : combatMode === 'action' ? selectedActionResourceReady : true
    const targetEquipmentReady = combatMode !== 'weapon' || !needsWeaponChange
    const targetSpecialBlock = combatMode === 'magic' && !selectedSpell
      ? 'У героя нет выбранного боевого заклинания'
      : combatMode === 'magic' && selectedSpell?.target === 'self'
        ? 'Это заклинание применяется только на себя'
        : combatMode === 'action' && !selectedCombatAction
          ? 'Сначала выберите классовое или основное действие'
          : combatMode === 'action' && selectedCombatAction?.id === 'first-aid' && !enemyKnockedOut
            ? 'Первая помощь доступна только нокаутированной цели'
            : null
    const enemyTargetCheck = enemy ? evaluateCombatTarget({
      selected: Boolean(combatActive && selected), economyReady: targetEconomyReady,
      targetAlive: enemy.alive, targetTeam: 'enemy', acceptedTarget,
      distanceFeet: attackDistanceFeet, rangeFeet: targetRangeFeet,
      clearTrajectory: targetRangeFeet <= CELL_FEET || clearTrajectory,
      equipmentReady: targetEquipmentReady, resourceReady: targetResourceReady,
      specialBlockReason: targetSpecialBlock,
    }) : null
    const cellKey = cell.x + ',' + cell.y
    const canMoveHere = reachable.has(cellKey)
    const route = movementPaths.get(cellKey)
    const moveReason = active ? movementCellReason(state, active, cell, movementLimit, movementPaths) : null
    const routeStep = previewRouteSteps.get(cellKey)
    const opportunityRisk = Boolean(canMoveHere && opportunityThreats.some((threat) => chebyshevFeet(threat, cell) > CELL_FEET))
    const canThrowHere = Boolean(combatActive && selected && combatMode === 'weapon' && actionReady && selectedItem?.combat?.kind === 'thrown-area' && active && chebyshevFeet(active, cell) <= normalRangeFeet && hasClearBoardTrajectory(state, active, cell) && cell.revealed && cell.type !== 'wall')
    const occupied = Boolean(player || enemy || summon)
    const commandRangeVisible = Boolean(selected && targetRangeFeet > 0 && (combatActive || spellEconomyReady))
    const cellInCommandRange = Boolean(commandRangeVisible && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && chebyshevFeet(active, cell) <= targetRangeFeet && (targetRangeFeet <= CELL_FEET || hasClearBoardTrajectory(state, active, cell)))
    const moveUnavailable = Boolean(selected && movementAvailable && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && !occupied && !canMoveHere && moveReason)
    const canPointSpellHere = Boolean(selected && combatMode === 'magic' && selectedSpell?.target === 'point' && spellEconomyReady && active && chebyshevFeet(active, cell) <= selectedSpellRange && hasClearBoardTrajectory(state, active, cell) && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && (!['summon', 'teleport'].includes(selectedSpellKind ?? '') || !occupied))
    const canSummonHere = Boolean(canPointSpellHere && selectedSpellKind === 'summon')
    const canAimHere = canThrowHere || canPointSpellHere
    const blastCenter = combatMode === 'magic' && selectedSpell?.target === 'point' ? pendingPoint ?? aimCell : projectileTarget
    const blastRadius = combatMode === 'magic' ? spellAreaRadiusFeet : areaRadiusFeet
    const inBlastArea = Boolean(blastCenter && blastRadius && (selectedSpell?.areaShape === 'cone' && selectedSpell.areaOrigin === 'self' && active
      ? boardCellInCone(cell, active, blastCenter, blastRadius)
      : selectedSpell?.areaShape === 'cube' && selectedSpell.areaOrigin === 'self' && active
        ? boardCellInDirectedCube(cell, active, blastCenter, blastRadius)
        : chebyshevFeet(blastCenter, cell) <= blastRadius))
    const inPersistentSpellArea = Boolean((state.mechanics?.active_effects ?? []).some((effect) => effect.center && chebyshevFeet(effect.center, cell) <= Number(effect.radius_feet ?? 0)))
    const cellIsInteractive = (canMoveHere || canAimHere) && !occupied
    const cellFeedback = (state.mapFeedback ?? []).filter((item) => item.x === cell.x && item.y === cell.y)
    const cellLabel = canPointSpellHere ? `Наложить ${selectedSpell?.name} в клетку ${cell.x}, ${cell.y}` : canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку ${cell.x}, ${cell.y}` : canMoveHere ? `Маршрут для ${activeName}: ${route?.costFeet ?? 0} футов${opportunityRisk ? '. Это спровоцирует атаку по возможности' : ''}` : moveReason ?? undefined
    const enemyKind = enemy ? enemyVisualKind(enemy) : null
    const enemyHealth = enemy ? enemyHealthPresentation(enemy) : null
    const enemyCommandAllowed = Boolean(canWeaponTargetEnemy || canSpellTargetEnemy || canActionTargetEnemy || canThrowHere || canPointSpellHere)
    const enemyTargetReason = enemyCommandAllowed
      ? attackDistanceFeet > normalRangeFeet && combatMode === 'weapon' ? 'Допустимая цель · дальний диапазон с помехой' : 'Допустимая цель'
      : enemyTargetCheck?.reason ?? 'Выбранная команда не подходит для этой цели'
    const enemyConditions = enemy ? (state.mechanics?.conditions?.[enemy.id] ?? []).map(conditionPresentation) : []

    // Область команды и недоступный маршрут накрывают почти всю карту, поэтому
    // они рисуются на холсте: в разметке это был бы узел на каждую клетку.
    if (commandRangeVisible && cell.revealed) boardOverlay.push({ x: cell.x, y: cell.y, kind: cellInCommandRange ? 'command-range' : 'command-out-of-range' })
    if (moveUnavailable && !canAimHere && !cellInCommandRange) boardOverlay.push({ x: cell.x, y: cell.y, kind: 'move-unavailable' })

    const stateClasses = [
      canMoveHere && !canAimHere ? 'move-target' : '',
      routeStep ? 'route-step' : '',
      previewMoveKey === cellKey ? 'route-destination' : '',
      opportunityRisk && !canAimHere ? 'opportunity-risk' : '',
      canAimHere ? 'aim-target' : '',
      canSummonHere ? 'summon-target' : '',
      inPersistentSpellArea ? 'spell-terrain' : '',
      inBlastArea ? 'blast-area' : '',
      pendingPoint?.x === cell.x && pendingPoint?.y === cell.y ? 'command-center' : '',
      occupied ? player ? 'occupied-by-hero' : summon ? 'occupied-by-summon' : 'occupied-by-enemy' : '',
    ].filter(Boolean)
    const cellTitle = opportunityRisk && !canAimHere
      ? 'Опасная клетка: выход из ближнего боя вызовет атаку по возможности'
      : moveUnavailable ? moveReason ?? undefined : undefined
    if (!stateClasses.length && !cellFeedback.length) {
      if (cellTitle || cellLabel) boardHints.set(cellKey, { title: cellTitle, ariaLabel: cellLabel })
      continue
    }

    boardCells.push({
      x: cell.x,
      y: cell.y,
      className: stateClasses.join(' '),
      interactive: cellIsInteractive,
      ariaLabel: cellLabel,
      title: cellTitle,
      onPointerEnter: () => { if (canAimHere) setAimCell({ x: cell.x, y: cell.y }); else if (canMoveHere) setHoveredMoveKey(cellKey) },
      onPointerLeave: () => { if (canAimHere && !pendingCommand) setAimCell(null); if (hoveredMoveKey === cellKey) setHoveredMoveKey(null) },
      onActivate: () => {
        if (!selected || (!canMoveHere && !canAimHere)) return
        if (canPointSpellHere) castAtCell(cell.x, cell.y)
        else if (canThrowHere) chooseArea(cell.x, cell.y)
        else if (!combatActive || pendingMoveKey === cellKey) { onMove(selected, cell.x, cell.y); setPendingMoveKey(null) }
        else setPendingMoveKey(cellKey)
      },
      children: <>
        {routeStep && <span className="route-step-badge" aria-hidden="true">{routeStep}</span>}
        {/* След на клетке: лежит в плоскости доски, поэтому при любом повороте и
            наклоне точно совпадает с сеткой. Фигурка стоит стоймя и из-за этого
            перспективно смещается — позиционную правду несёт именно этот след. */}
        {occupied && cell.revealed && <span className="cell-footprint" aria-hidden="true" />}
        {/* Полоска врага лежит рядом с токеном, а не внутри него: у токена
            `clip-path` под силуэт щита, и всё, что выходит за него, срезается —
            проверено на макете, внутри кнопки полоска не видна вовсе. */}
        {enemy && cell.revealed && <TokenHealthBar fill={enemyHealth?.fill ?? 0} label={enemyHealth?.barLabel} className={`enemy-health ${enemyHealth?.status ?? ''}`} />}
        {enemy && cell.revealed && (
          <button
            className={`enemy-token ${focusedParticipantId === enemy.id ? 'initiative-focus' : ''} ${enemyCommandAllowed ? 'targetable' : combatActive ? 'unavailable-target' : ''} ${pendingTargetId === enemy.id ? 'command-selected' : ''}`}
            data-enemy-kind={enemyKind}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { setAimCell({ x: enemy.x, y: enemy.y }); setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason }) }}
            onMouseLeave={() => { if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason })}
            onBlur={() => { if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canActionTargetEnemy) useActionAtTarget(enemy.id); else if (canSpellTargetEnemy) castAtTarget(enemy.id); else if (canWeaponTargetEnemy) chooseTarget(enemy.id) }}
            aria-disabled={tacticalBusy || !enemyCommandAllowed}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${enemy.name}` : `${canActionTargetEnemy ? `Использовать ${selectedCombatAction?.name} на` : canSpellTargetEnemy ? 'Наложить заклинание на' : 'Атаковать'} ${enemy.name}. Состояние: ${enemyHealth?.label}`}
            title={enemyTargetReason}
          >
            <span className="enemy-emblem">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
            <span className="enemy-nameplate">{enemy.name}</span>
            <small className="enemy-health-value">{enemyHealth?.label}</small>
            {enemyConditions.length > 0 && <span className="token-conditions">{enemyConditions.slice(0, 3).map((condition) => <i key={condition.id} className={condition.status} title={`${condition.label} · ${condition.statusLabel}. ${condition.explanation}`}>{condition.label.slice(0, 1)}</i>)}</span>}
          </button>
        )}
        {player && cell.revealed && (() => {
          const healingDistance = active ? chebyshevFeet(active, player) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && ['ally', 'creature'].includes(selectedSpell.target) && spellEconomyReady && healingDistance <= selectedSpellRange)
          const playerKnockedOut = state.mechanics?.resting?.[player.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && player.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'stabilize' || player.hp === 0) && (selectedCombatAction.id !== 'first-aid' || playerKnockedOut))
          const playerCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere)
          const playerSpecialBlock = combatMode === 'action' && selectedCombatAction?.id === 'stabilize' && player.hp > 0
            ? 'Стабилизация нужна только герою с 0 ОЗ'
            : combatMode === 'action' && selectedCombatAction?.id === 'first-aid' && !playerKnockedOut
              ? 'Первая помощь доступна только нокаутированному союзнику'
              : combatMode === 'action' && player.id === selected ? 'Выберите другого союзника' : null
          const playerTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            targetAlive: player.hp > 0 || selectedCombatAction?.id === 'stabilize', targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, player)),
            resourceReady: targetResourceReady, specialBlockReason: playerSpecialBlock,
          })
          const playerTargetReason = playerCommandAllowed ? 'Допустимая цель' : playerTargetCheck.reason ?? 'Выбранная команда не подходит для союзника'
          const playerConditions = (state.mechanics?.conditions?.[player.id] ?? []).map(conditionPresentation)
          return <button
            className={'map-token hero-token ' + (focusedParticipantId === player.id ? 'initiative-focus ' : '') + (selected === player.id ? 'selected' : '') + ' ' + (openTokenLabelId === player.id ? 'label-open' : '') + ' ' + (player.id === turnActorId ? 'active-turn' : '') + ' ' + (canHeal || canAid ? 'targetable healing-target' : combatActive && selected && player.id !== turnActorId ? 'unavailable-target' : '') + ' ' + (pendingTargetId === player.id ? 'command-selected' : '') + ' ' + (player.maxHp > 0 && player.hp / player.maxHp <= .25 ? 'critical' : player.maxHp > 0 && player.hp / player.maxHp <= .5 ? 'wounded' : '')}
            style={{ '--token': player.color, backgroundImage: 'url(' + player.portrait + ')', backgroundPosition: player.portraitPosition } as React.CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { if (canHeal) setAimCell({ x: player.x, y: player.y }); setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason }) }}
            onMouseLeave={() => { if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason })}
            onBlur={() => { if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); setOpenTokenLabelId((current) => current === player.id ? null : player.id); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(player.id); else if (canHeal) castAtTarget(player.id) }}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${player.character}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${player.character}` : canHeal ? `Наложить ${selectedSpell?.name} на ${player.character}` : player.character + (player.id === turnActorId ? ', активный герой' : '')}
            aria-disabled={!canHeal && !canAid && !canThrowHere}
            title={playerTargetReason}
          >
            <TokenHealthBar fill={player.hp / Math.max(1, player.maxHp)} label={`${Math.max(0, player.hp)}/${Math.max(1, player.maxHp)}`} />
            {playerConditions.length > 0 && <span className="token-conditions">{playerConditions.slice(0, 3).map((condition) => <i key={condition.id} className={condition.status} title={`${condition.label} · ${condition.statusLabel}. ${condition.explanation}`}>{condition.label.slice(0, 1)}</i>)}</span>}
            {openTokenLabelId === player.id && <span className="token-label">{player.character}<small>{player.hp} ОЗ · {combatActive ? `${remainingFeet} фт` : 'свободный ход'}</small></span>}
          </button>
        })()}
        {summon && cell.revealed && (() => {
          const healingDistance = active ? chebyshevFeet(active, summon) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && ['ally', 'creature'].includes(selectedSpell.target) && spellEconomyReady && healingDistance <= selectedSpellRange)
          const summonKnockedOut = state.mechanics?.resting?.[summon.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && summon.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'first-aid' || summonKnockedOut))
          const summonCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere)
          const summonTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            targetAlive: summon.alive, targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, summon)),
            resourceReady: targetResourceReady,
            specialBlockReason: combatMode === 'action' && summon.id === selected ? 'Выберите другого союзника' : null,
          })
          const summonTargetReason = summonCommandAllowed ? 'Допустимая цель' : summonTargetCheck.reason ?? 'Выбранная команда не подходит для призыва'
          const summonConditions = (state.mechanics?.conditions?.[summon.id] ?? []).map(conditionPresentation)
          return <button
            className={'map-token summon-token ' + (focusedParticipantId === summon.id ? 'initiative-focus ' : '') + (selected === summon.id ? 'selected active-turn' : '') + ' ' + (openTokenLabelId === summon.id ? 'label-open' : '') + ' ' + (canHeal || canAid ? 'targetable healing-target' : combatActive && selected ? 'unavailable-target' : '') + ' ' + (pendingTargetId === summon.id ? 'command-selected' : '')}
            style={{ '--token': '#70a78b' } as React.CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { if (canHeal) setAimCell({ x: summon.x, y: summon.y }); setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason }) }}
            onMouseLeave={() => { if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason })}
            onBlur={() => { if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); setOpenTokenLabelId((current) => current === summon.id ? null : summon.id); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(summon.id); else if (canHeal) castAtTarget(summon.id) }}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${summon.name}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${summon.name}` : canHeal ? `Наложить ${selectedSpell?.name} на ${summon.name}` : `${summon.name}, призванный союзник${summon.id === turnActorId ? ', активный участник' : ''}`}
            aria-disabled={!canHeal && !canAid && !canThrowHere}
            title={summonTargetReason}
          >
            <Sparkles size={15} />
            <TokenHealthBar fill={summon.hp / Math.max(1, summon.maxHp)} label={`${Math.max(0, summon.hp)}/${Math.max(1, summon.maxHp)}`} />
            {summonConditions.length > 0 && <span className="token-conditions">{summonConditions.slice(0, 3).map((condition) => <i key={condition.id} className={condition.status} title={`${condition.label} · ${condition.statusLabel}. ${condition.explanation}`}>{condition.label.slice(0, 1)}</i>)}</span>}
            {openTokenLabelId === summon.id && <span className="token-label">{summon.name}<small>{summon.hp} ОЗ · {remainingFeet} фт</small></span>}
          </button>
        })()}
        {cellFeedback.map((item) => <span key={item.id} className={'map-feedback ' + item.kind}>{item.text}</span>)}
      </>,
    })
  }

  return (
    <>
      <div className="status-bar">
        {statusContent}
        <section className={`initiative-ribbon ${combatActive ? 'combat' : 'exploration'}`} aria-label={combatActive ? `Раунд ${combat.round ?? 1}, порядок инициативы` : 'Кто ведёт отряд'} aria-live="polite">
          {combatActive ? <>
            <div className={`initiative-active-chip ${activeEnemy ? 'enemy' : activeSummon ? 'summon' : 'hero'}`}>
              {activeHero
                ? <span className="initiative-active-avatar portrait" style={{ backgroundImage: `url(${activeHero.portrait})`, backgroundPosition: activeHero.portraitPosition }} />
                : activeEnemy
                  ? <span className="initiative-active-avatar enemy">{activeEnemy.image ? <img src={activeEnemy.image} alt="" /> : <EnemyGlyph kind={enemyVisualKind(activeEnemy)} />}</span>
                  : <span className="initiative-active-avatar summon"><Sparkles size={18} /></span>}
              <span><strong>{activeName}</strong><small>{activeTurnLabel}</small></span>
            </div>
            <header>РАУНД <b>{combat.round ?? 1}</b></header>
            <ol>{combat.initiative?.map((entry, index) => {
              const hero = state.players.find((player) => player.id === entry.actor_id)
              const enemy = state.enemies?.find((item) => item.id === entry.actor_id)
              const summon = state.actors?.find((item) => item.id === entry.actor_id)
              const kind = summon ? 'summon' : enemy ? 'enemy' : 'hero'
              const name = hero?.character ?? summon?.name ?? enemy?.name ?? entry.actor_id
              const defeated = hero ? hero.hp <= 0 : summon ? !summon.alive || summon.hp <= 0 : enemy ? !enemy.alive : false
              const enemyKind = enemy ? enemyVisualKind(enemy) : null
              return <li key={entry.actor_id} className={`${kind} ${index === combat.active_index ? 'active' : ''} ${defeated ? 'defeated' : ''}`} aria-current={index === combat.active_index ? 'step' : undefined}>
                <button
                  className={`initiative-avatar-button ${focusedParticipantId === entry.actor_id ? 'focused' : ''}`}
                  aria-label={`Выделить на карте: ${name}${index === combat.active_index ? ', сейчас ходит' : ''}`}
                  aria-pressed={focusedParticipantId === entry.actor_id}
                  onClick={() => setFocusedParticipantId((current) => current === entry.actor_id ? null : entry.actor_id)}
                >
                  <span className="initiative-order" aria-hidden="true">{index + 1}</span>
                  {hero
                    ? <span className="initiative-avatar portrait" style={{ backgroundImage: `url(${hero.portrait})`, backgroundPosition: hero.portraitPosition }} />
                    : enemy
                      ? <span className="initiative-avatar enemy">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
                      : <span className="initiative-avatar summon"><Sparkles size={18} /></span>}
                  {index === combat.active_index && <span className="initiative-turn-dot" aria-hidden="true" />}
                </button>
              </li>
            })}</ol>
          </> : <div className="initiative-exploration-lead">
            <span className="initiative-ribbon-label">ВЕДЁТ ОТРЯД</span>
            <div className="initiative-active-chip exploration">
              <span className="initiative-active-avatar portrait" style={{ backgroundImage: `url(${activeHero?.portrait ?? ''})`, backgroundPosition: activeHero?.portraitPosition }} />
              <span><strong>{activeName}</strong><small>{activeTurnLabel}</small></span>
            </div>
          </div>}
        </section>
      </div>
      <div
        className={`map-stage ${visualTheme} ${scenicBackdrop ? 'scenic-backdrop' : 'monotone-backdrop'}`}
        data-map-source={mapArt.id}
        style={{ '--board-art': `url("${mapArt.url}")` } as React.CSSProperties}
      >
      <div className="map-atmosphere map-atmosphere-one" />
      <div className="map-atmosphere map-atmosphere-two" />
      <TacticalBoard
        map={boardMap}
        columns={columns}
        rows={rows}
        irregular={irregularMap}
        themeKey={visualTheme}
        artUrl={scenicBackdrop ? mapArt.url : null}
        ariaLabel={`Тактическая карта, вид сверху. Колесо меняет масштаб, перетаскивание двигает полотно, двойной клик центрирует. Активный участник: ${activeName}`}
        cells={boardCells}
        cellHints={boardHints}
        overlayCells={boardOverlay}
        onBackgroundActivate={() => setOpenTokenLabelId(null)}
        decoration={trajectory
          ? <svg className="projectile-trajectory" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1={trajectory.x1} y1={trajectory.y1} x2={trajectory.x2} y2={trajectory.y2} /></svg>
          : null}
      />
      <div className="map-scale-plate">1 клетка = 5 футов</div>
      {/* Режим стоит над полем по центру: он описывает то, что происходит на
          карте, и читается раньше, чем взгляд уходит к панели действий. */}
      {!combatActive && <div className="map-mode-plate" role="status">Исследование</div>}
      <div className="map-legend">
        <span><i className="legend-dot party" />Отряд</span><span><i className="legend-dot summon" />Призыв</span><span><i className="legend-dot danger" />Враг · параметры скрыты</span><span><i className="legend-dot interest" />Интерес</span>
      </div>
      {spellbookOpen && <section className="spellbook-panel" role="dialog" aria-modal="true" aria-label={`Книга заклинаний: ${activeName}`} onPointerDown={(event) => event.stopPropagation()}>
        <header><div><BookOpen size={21} /><span><small>КНИГА ЗАКЛИНАНИЙ</small><strong>{activeName}</strong></span></div><button onClick={() => setSpellbookOpen(false)} aria-label="Закрыть книгу заклинаний"><X size={18} /></button></header>
        <div className="spellbook-tools">
          <label><Target size={15} /><input value={spellSearch} onChange={(event) => setSpellSearch(event.target.value)} placeholder="Название или эффект…" /></label>
          <nav aria-label="Фильтр по кругу"><button className={spellLevelFilter === 'all' ? 'active' : ''} onClick={() => setSpellLevelFilter('all')}>Все</button>{availableSpellLevels.map((level) => <button key={level} className={spellLevelFilter === level ? 'active' : ''} onClick={() => setSpellLevelFilter(level)}>{level === 0 ? 'З' : level}</button>)}</nav>
          <span>{filteredSpellbookSpells.length} из {spells.length}</span>
        </div>
        <div className="spellbook-grid">{filteredSpellbookSpells.map((spell) => {
          const pinned = hotbarSpellIds.includes(spell.id)
          const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote)
          /* Книга открывается и вне боя, поэтому в ней тоже действует правило
             движка: боевое заклинание без инициативы выбрать нельзя. Иначе
             выбор проходил бы, книга закрывалась, а карта молча не предлагала
             ни одной цели — тупик без объяснения. */
          const lockedOutOfCombat = !combatActive && !castableOutOfCombat(spell)
          const unavailableReason = support.blocked ? `${support.label}. ${support.explanation}` : spell.prepared === false ? 'Заклинание не изучено или не подготовлено' : spell.actionType === 'long_cast' ? `Время накладывания: ${spell.castingTime}` : lockedOutOfCombat ? 'Боевое заклинание требует инициативы: сначала начните бой' : 'Выбрать заклинание'
          return <article key={spell.id} className={`${pinned ? 'pinned' : ''} ${spell.prepared === false ? 'unprepared' : ''} support-${support.status} spell-kind-${spell.kind}`}>
            <button className="spellbook-spell" onClick={() => { selectSpell(spell); if (spell.actionType !== 'long_cast') setSpellbookOpen(false) }} disabled={support.blocked || spell.actionType === 'long_cast' || spell.prepared === false || lockedOutOfCombat} title={unavailableReason}>
              <CombatIcon id={spell.id} kind="spell" hint={`${spell.kind} ${spell.damageType ?? ''} ${spell.name}`} size={31} /><span><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spell.castingTime || '1 действие'} · {spell.rangeText || `${spell.range} фт`}</small><em>{spell.description}</em></span>
            </button>
            <button className="pin-spell" disabled={support.blocked || spell.prepared === false} onClick={() => toggleHotbarSpell(spell.id)} aria-pressed={pinned} title={support.blocked ? unavailableReason : spell.prepared === false ? 'Сначала изучите или подготовьте заклинание' : pinned ? 'Убрать с панели' : 'Закрепить на панели'}>{pinned ? <Check size={15} /> : <Plus size={15} />}</button>
            {spell.concentration && <i className="spellbook-tag">К</i>}
            {spell.prepared === false && <i className="spellbook-tag unavailable">НЕ ПОДГОТОВЛЕНО</i>}
            {support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`} title={support.explanation}>{support.shortLabel}</i>}
          </article>
        })}</div>
      </section>}
      </div>
      <aside className="server-column" aria-label="Состояние сцены">
        <div className="server-resize" role="separator" aria-orientation="vertical" aria-label="Ширина правой колонки" onPointerDown={startServerResize} onDoubleClick={() => { setServerWidth(0); window.localStorage.removeItem(SERVER_WIDTH_KEY) }} title="Потяните, чтобы изменить ширину. Двойной щелчок — вернуть обычную" />
        {combatActive && <section className="combat-context-panel" aria-label="Текущее состояние боя" aria-live="polite">
          <header><div><small>СЕЙЧАС ХОДИТ · {activeTeam}</small><strong>{activeName}</strong></div><span><Heart size={13} />{activeHealth}</span></header>
          <div className="combat-context-conditions" aria-label="Состояния активного участника">{activeConditions.length ? activeConditions.map((condition) => <span key={condition.id} className={condition.status} title={`${condition.statusLabel}. ${condition.explanation}${condition.duration ? ` Длительность: ${condition.duration}` : ''}`}><i />{condition.label}<small>{condition.status === 'marker' ? 'маркер' : condition.status === 'partial' ? 'частично' : 'работает'}</small></span>) : <em>Нет состояний</em>}</div>
          <div className="combat-context-command"><Target size={14} /><span><small>ВЫБРАННАЯ КОМАНДА</small><strong>{selected ? selectedCommandName : 'Ожидание хода союзника'}</strong></span></div>
          {inspectedTarget && <div className={`combat-target-inspector ${inspectedTarget.allowed ? 'allowed' : 'blocked'}`}>
            {/* Дистанция и причина берутся из серверного прогноза, когда он
                есть: снимок `inspectedTarget` делается в момент наведения и
                после перемещения показывал прежние футы. */}
            <span><small>{inspectedTarget.team === 'enemy' ? 'ПРОТИВНИК' : 'СОЮЗНИК'} · {inspectedForecast?.distance_feet ?? inspectedTarget.distanceFeet} ФТ</small><strong>{inspectedTarget.name}</strong><em>{inspectedTarget.healthLabel ? `${inspectedTarget.healthLabel} · параметры скрыты` : `${inspectedTarget.hp}/${inspectedTarget.maxHp} ОЗ`}</em></span>
            {(!inspectedForecast || !inspectedForecast.in_range) && <p>{inspectedTarget.reason}</p>}
            {inspectedForecast && <div className={`attack-forecast ${inspectedForecast.advantage && !inspectedForecast.disadvantage ? 'advantage' : inspectedForecast.disadvantage && !inspectedForecast.advantage ? 'disadvantage' : ''}`}>
              <header>
                <b>{inspectedForecast.in_range ? `${inspectedForecast.hit_chance}%` : '—'}</b>
                <span>{inspectedForecast.in_range ? 'шанс попасть' : 'не достать'}<small>{inspectedForecast.label}{inspectedForecast.in_range ? ` · крит ${inspectedForecast.critical_chance}%` : ` · ${inspectedForecast.unreachable_reason}`}</small></span>
              </header>
              <dl>
                <div><dt>Бросок</dt><dd>d20 {inspectedForecast.attack_modifier >= 0 ? '+' : '−'} {Math.abs(inspectedForecast.attack_modifier)}{inspectedForecast.advantage && !inspectedForecast.disadvantage ? ' с преимуществом' : inspectedForecast.disadvantage && !inspectedForecast.advantage ? ' с помехой' : ''}</dd></div>
                <div><dt>Против</dt><dd>{inspectedForecast.armor_class == null ? 'КД неизвестен' : `КД ${inspectedForecast.armor_class}`}{inspectedForecast.cover_bonus > 0 ? ` · ${inspectedForecast.cover_label ?? 'укрытие'} +${inspectedForecast.cover_bonus}` : ''}</dd></div>
                <div><dt>Урон</dt><dd>≈ {inspectedForecast.average_damage}</dd></div>
              </dl>
              {(inspectedForecast.advantage_sources.length > 0 || inspectedForecast.disadvantage_sources.length > 0) && <ul>
                {inspectedForecast.advantage_sources.map((reason) => <li key={`plus-${reason}`} className="plus">+ {reason}</li>)}
                {inspectedForecast.disadvantage_sources.map((reason) => <li key={`minus-${reason}`} className="minus">− {reason}</li>)}
              </ul>}
              {inspectedForecast.advantage && inspectedForecast.disadvantage && <small className="forecast-note">Преимущество и помеха гасят друг друга — бросается одна кость.</small>}
            </div>}
          </div>}
          {pendingCommand && <div className="combat-command-confirmation">
            <header><Target size={14} /><span><small>ЦЕЛЬ ЗАФИКСИРОВАНА</small><strong>{pendingCommandLabel}</strong></span></header>
            <p>Команда ждёт в строке действия внизу: добавьте слова, если хотите, и нажмите «Отправить».</p>
            <div><button onClick={() => { setPendingCommand(null); setAimCell(null); setInspectedTarget(null) }}><X size={13} />Отменить</button></div>
          </div>}
          {previewRoute && <div className={`movement-preview ${pendingMoveKey ? 'selected' : ''}`}>
            <span><Footprints size={14} /><b>{previewRoute.costFeet} фт</b><small>{previewRoute.path.length} кл. · останется {Math.max(0, remainingFeet - previewRoute.costFeet)} фт</small></span>
            {pendingMoveKey && selected && <div><button disabled={tacticalBusy} onClick={() => { const [x, y] = pendingMoveKey.split(',').map(Number); onMove(selected, x, y); setPendingMoveKey(null) }}><Check size={13} />Подтвердить</button><button onClick={() => setPendingMoveKey(null)} aria-label="Отменить маршрут"><X size={13} /></button></div>}
          </div>}
          {latestBattleEvent && <BattleResultCard state={state} event={latestBattleEvent} />}
        </section>}
        {children}
      </aside>
      <section className="turn-rail">
        {/* Ручка высоты: тянется вверх и вниз, значение переживает перезагрузку. */}
        <div className="rail-resize" role="separator" aria-orientation="horizontal" aria-label="Высота нижней панели" onPointerDown={startRailResize} onDoubleClick={() => { setRailHeight(0); window.localStorage.removeItem(RAIL_HEIGHT_KEY) }} title="Потяните, чтобы изменить высоту. Двойной щелчок — вернуть обычную" />
      {/* Свободный ввод присутствует во ВСЕХ состояниях, включая бой. Продуктовые
          принципы 2 и 3 требуют, чтобы предложения интерфейса не были границами;
          раньше в бою на месте этого поля стоял только хотбар, и у принципа не было
          носителя в UI. Ход не расходуется до подтверждённого сервером броска. */}
      {/* Одна строка на всё: слева колоды, справа поле и «Отправить». Выбранное
          действие подтверждается той же кнопкой — отдельного «Подтвердить»
          больше нет, а слова игрока уезжают вместе с командой. */}
      <form
        className="rail-free-input"
        onSubmit={(event) => {
          event.preventDefault()
          if (narrating) return
          const text = freeText.trim()
          if (pendingCommand) { confirmPreparedCommand(text || undefined); setFreeText(''); return }
          if (selfCastReady) { confirmSelfCast(text || undefined); setFreeText(''); return }
          if (!text) return
          onFreeAction(text)
          setFreeText('')
        }}
      >
        <nav className="hotbar-decks" role="tablist" aria-label="Категории действий">
          {([
            ['common', 'Основные', <CombatIcon id="deck-common" kind="deck" hint="перемещение основные действия" size={21} compact />],
            ['weapon', 'Атаки', <CombatIcon id="deck-weapon" kind="deck" hint="оружие атака меч" size={21} compact />],
            ['magic', 'Заклинания', <CombatIcon id="deck-magic" kind="deck" hint="магия заклинания" size={21} compact />],
            ['class', 'Классовые', <CombatIcon id="deck-class" kind="deck" hint="классовые способности защита" size={21} compact />],
            ['items', 'Предметы', <CombatIcon id="deck-items" kind="deck" hint="предметы зелья" size={21} compact />],
          ] as Array<[CombatDeck, string, React.ReactNode]>).map(([deck, label, icon]) => <button type="button" key={deck} role="tab" aria-selected={activeDeck === deck} className={activeDeck === deck ? 'active' : ''} onClick={() => setActiveDeck(deck)} disabled={tacticalBusy || (deck === 'magic' && !spells.length)} title={label}>{icon}<span>{label}</span></button>)}
        </nav>
        <div className="rail-input-shell">
          {preparedLabel && <span className="prepared-chip"><CombatIcon id="prepared-command" kind="roll" hint="выбранное действие" size={15} compact /><b>{preparedLabel}</b><button type="button" onClick={clearPrepared} aria-label="Снять выбранное действие"><X size={12} /></button></span>}
          <input
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder={preparedLabel ? 'Добавьте слова к действию — или отправьте как есть' : `Опишите действие ${activeName} так, как сказали бы за столом — Арбитр найдёт правило`}
            aria-label="Действие своими словами"
            disabled={narrating}
          />
        </div>
        <button type="submit" disabled={narrating || (!preparedLabel && !freeText.trim())}><Send size={17} />Отправить</button>
      </form>
      {/* Панель одна на оба режима. Раньше вне боя вместо неё показывалась полоска
          «исследование», а колоды и плитки не рендерились вовсе: игрок не видел, чем
          вообще владеет герой, пока не бросит инициативу. Место под панель в сетке
          зарезервировано всегда, поэтому показывать арсенал ничего не стоит. */}
      <section className={`tactical-control combat-hotbar ${combatActive ? '' : 'out-of-combat'}`} aria-label={combatActive ? `Панель боевых действий: ${activeName}` : `Панель действий вне боя: ${activeName}`}>
        <div className="hotbar-controls-row">
          {/* Остаток хода читается словами и целиком: «хватит ли» больше не нужно
              собирать из буквы в кружке на плитке и отдельной плашки над хотбаром. */}
          {combatActive ? <div className="hotbar-economy" aria-label="Экономика текущего хода">
            <span className={remainingFeet > 0 && movementAvailable ? 'ready' : 'spent'}><small>Движение</small><b>{movementAvailable ? `${remainingFeet} из ${speedFeet} фт` : 'потрачено'}</b></span>
            <span className={actionReady || weaponAttackReady ? 'ready' : 'spent'}><small>Действие</small><b>{actionReady ? 'свободно' : weaponAttackReady ? `ещё ${weaponAttacksLeft} атака` : 'потрачено'}</b></span>
            <span className={bonusReady ? 'ready' : 'spent'}><small>Бонус</small><b>{bonusReady ? 'свободен' : 'потрачен'}</b></span>
            <span className={reactionReady ? 'ready' : 'spent'}><small>Реакция</small><b>{reactionReady ? 'свободна' : 'потрачена'}</b></span>
          </div> : showStartCombat ? <div className="hotbar-exploration-note">
            {/* Сам режим переехал на поле, по центру сверху: он относится к карте,
                а не к панели действий. Здесь остался только вход в бой, и пустой
                коробки без него не остаётся. */}
            <button className="exploration-start-combat" disabled={!canAct || tacticalBusy} onClick={onStartCombat}><CombatIcon id="start-combat" kind="start-combat" hint="инициатива начать бой" size={27} compact /><span><small>Бросить инициативу</small><strong>Начать бой</strong></span></button>
          </div> : null}
        </div>
        <div className="hotbar-main">
          <div className="hotbar-actions" role="tabpanel" aria-label="Доступные действия">
            {/* Ручка сидит на самой карточке действий: в промежутке между областями её
                не было видно — тёмная полоска на тёмном фоне без опоры. */}
            <div className="actions-resize" role="separator" aria-orientation="vertical" aria-label="Ширина области действий" onPointerDown={startDetailResize} onDoubleClick={() => { setDetailWidth(0); window.localStorage.removeItem(DETAIL_WIDTH_KEY) }} title="Потяните, чтобы изменить ширину. Двойной щелчок — вернуть обычную"><i /><i /><i /></div>
            {activeDeck === 'common' && <button className="action-tile movement-tile" disabled={!selected || !movementAvailable || remainingFeet <= 0 || actionsLocked} onClick={() => { setSelectedCombatActionId(''); setCombatMode('weapon') }} title="Перемещение — выберите подсвеченную клетку на карте"><CombatIcon id="movement" kind="movement" hint="перемещение" /><strong>Перемещение</strong><small>{remainingFeet} фт</small><i className="action-cost movement">движение</i></button>}
            {activeDeck === 'weapon' && <button className={`action-tile weapon ${combatMode === 'weapon' && weaponSelectionId === BASE_ATTACK_ID ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked} onClick={() => { setSelectedItemId(BASE_ATTACK_ID); setCombatMode('weapon') }} title={`Базовая атака · ${baseRangeFeet} фт`}><CombatIcon id={BASE_ATTACK_ID} kind="weapon" hint="базовая атака оружием" /><strong>Базовая атака</strong><small>{baseRangeFeet} фт</small><i className="action-cost action">действие</i></button>}
            {activeDeck === 'weapon' && combatItems.filter((item) => item.type === 'weapon').map((item) => <button key={item.id} className={`action-tile weapon ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={`${item.name}: ${item.description || item.properties}`}><CombatIcon id={item.id} kind="weapon" hint={`${item.name} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.combat?.damage ?? 'атака'} · {item.combat?.normalRange ?? 5} фт</small><i className="action-cost action">действие</i></button>)}
            {activeDeck === 'magic' && <button className="action-tile spellbook-tile" onClick={() => setSpellbookOpen(true)} disabled={!spells.length || tacticalBusy} title={`Открыть полный каталог: ${spells.length} заклинаний доступно герою`}><CombatIcon id="spellbook" kind="spellbook" hint="книга заклинаний" /><strong>Книга</strong><small>{spells.length} доступно</small></button>}
            {activeDeck === 'magic' && hotbarSpells.map((spell) => { const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote); const pools = !spell.slotResource ? [] : spell.slotResource === 'pact_slots' || spell.slotResource === 'mystic_arcanum_6' ? [activeResources[spell.slotResource]].filter(Boolean) : Array.from({ length: Math.max(0, 7 - spell.level) }, (_, index) => activeResources[`spell_slots_${spell.level + index}`]).filter(Boolean); const pool = pools.find((candidate) => Number(candidate.current ?? 0) > 0) ?? pools[0]; const ready = !spell.slotResource || pools.some((candidate) => Number(candidate.current ?? 0) > 0); const actionType = activeConditionIds.has('metamagic-quickened') && spellActionType(spell) === 'action' ? 'bonus_action' : spellActionType(spell); const economyReady = actionType !== 'long_cast' && (actionType === 'bonus_action' ? bonusReady : actionType === 'reaction' ? reactionReady : actionReady); return <button key={spell.id} className={`action-tile spell support-${support.status} ${combatMode === 'magic' && selectedSpell?.id === spell.id ? 'selected' : ''}`} disabled={support.blocked || !selected || !ready || !economyReady || (combatActive ? tacticalBusy : !castableOutOfCombat(spell))} onClick={() => selectSpell(spell)} title={`${spell.name} — ${support.blocked ? `${support.label}. ${support.explanation}` : `${spell.description ?? ''}${spell.concentration ? ' · Концентрация' : ''}`}`}><CombatIcon id={spell.id} kind="spell" hint={`${spell.kind} ${spell.damageType ?? ''} ${spell.name}`} /><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spellRange(spell)} фт</small>{pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}{support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}<i className={`action-cost ${actionType}`}>{actionType === 'bonus_action' ? 'бонус' : actionType === 'reaction' ? 'реакция' : actionType === 'long_cast' ? 'вне боя' : 'действие'}</i></button> })}
            {(activeDeck === 'common' || activeDeck === 'class') && combatActions.filter((action) => action.category === activeDeck && action.actionType !== 'reaction').map((action) => { const support = mechanicsSupportPresentation(action.mechanicsSupport, action.supportNote); const pool = action.resource ? activeResources[action.resource] : undefined; const ready = !action.resource || Number(pool?.current ?? 0) >= Number(action.cost ?? 1); const economyReady = action.actionType === 'free' || (action.actionType === 'bonus_action' ? bonusReady : actionReady); return <button key={action.id} className={`action-tile feature-action support-${support.status} ${combatMode === 'action' && selectedCombatAction?.id === action.id ? 'selected' : ''}`} disabled={support.blocked || !selected || !ready || !economyReady || actionsLocked} onClick={() => selectCombatAction(action)} title={`${action.name} — ${support.blocked ? `${support.label}. ${support.explanation}` : action.description}`}><CombatIcon id={action.id} kind="action" hint={`${action.name} ${action.category} ${action.target}`} /><strong>{action.name}</strong><small>{action.target === 'self' ? 'на себя' : action.target === 'ally' ? `${action.range} фт · союзник` : `${action.range} фт · враг`}</small>{pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}{support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}<i className={`action-cost ${action.actionType}`}>{action.actionType === 'bonus_action' ? 'бонус' : action.actionType === 'free' ? 'свободно' : 'действие'}</i></button> })}
            {activeDeck === 'items' && combatItems.filter((item) => item.type !== 'weapon').map((item) => <button key={item.id} className={`action-tile item ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !actionReady || actionsLocked} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={`${item.name} — ${item.description}`}><CombatIcon id={item.id} kind="item" hint={`${item.name} ${item.type} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.quantity} шт. · {item.combat?.radius ? `радиус ${item.combat.radius} фт` : 'предмет'}</small><i className="action-cost action">действие</i></button>)}
            {((activeDeck === 'magic' && !spells.length) || (activeDeck === 'class' && !combatActions.some((action) => action.category === 'class')) || (activeDeck === 'items' && !combatItems.some((item) => item.type !== 'weapon'))) && <div className="hotbar-empty"><LockKeyhole size={18} /><span>У героя нет доступных действий этой категории</span></div>}
          </div>
          <aside className="hotbar-detail" aria-live="polite">
            {!combatActive && !(combatMode === 'magic' && selectedSpell) ? <>
              <DetailHeader title="Вне боя" description="Лечение, усиление и утилита творятся прямо здесь. Всё, что бьёт, требует инициативы." />
              {/* Про футы сказано здесь, а не отдельной колонкой справа: ради
                  одной фразы держать 140px в строке было нечем оправдать. */}
              <span>Шаги не считаны · свободные действия — строкой «Своими словами» ниже</span>
            </> : combatMode === 'magic' && selectedSpell ? <>
              <DetailHeader title={selectedSpell.name} description={selectedSpell.description} />
              <i className={`mechanics-support-detail support-${selectedSpellSupport.status}`}>{selectedSpellSupport.label}</i>
              {/* Оговорка о полноте механики убрана из колонки: игроку она
                  ничего не даёт, а место занимала больше самого описания. Ярлык
                  статуса рядом остаётся, полный текст живёт в подсказке плитки. */}
              {selectedSpell.spellOptions?.length ? <div className="spell-option-picker" aria-label="Вариант заклинания">
                {selectedSpell.spellOptions.map((option) => <button key={option} className={selectedSpellOption === option ? 'selected' : ''} onClick={() => setSelectedSpellOption(option)}>{SPELL_OPTION_LABELS[option] ?? option}</button>)}
              </div> : null}
              {/* Раньше подпись всегда звала выбрать цель, даже когда она уже
                  была выбрана: клик по врагу выглядел как несработавший. */}
              <span>{pendingTargetName ? `Цель: ${pendingTargetName}` : selectedSpell.target === 'self' ? 'На себя — нажмите «Отправить»' : selectedSpell.target === 'point' ? 'Выберите клетку' : selectedSpell.target === 'ally' ? 'Выберите союзника' : selectedSpell.target === 'creature' ? 'Выберите существо' : 'Выберите врага'} · {selectedSpellRange} фт{selectedSpell.concentration ? ' · концентрация' : ''}</span>
            </> : combatMode === 'action' && selectedCombatAction ? <><DetailHeader title={selectedCombatAction.name} description={selectedCombatAction.description} /><i className={`mechanics-support-detail support-${selectedActionSupport.status}`}>{selectedActionSupport.label}</i><span>{selectedCombatAction.target === 'self' ? 'На себя — нажмите «Отправить»' : 'Выберите цель на карте, затем «Отправить»'}</span></> : <><DetailHeader title={selectedItem?.name ?? 'Базовая атака'} description={selectedItem?.description || (selectedItem?.combat?.kind === 'thrown-area' ? 'Выберите клетку для броска.' : 'Выберите противника на карте.')} /><span>{attackRangeFeet} фт{areaRadiusFeet ? ` · область ${areaRadiusFeet} фт` : ''}</span></>}
          </aside>
          {/* Колонка шага рисуется, только когда в ней что-то есть: вне боя это
              подтверждение выбранной цели, в бою — кнопки хода. Пустой колонки в
              140px, как раньше, в строке больше не остаётся. */}
          {(combatActive || pendingCommand) && <div className="hotbar-turn-controls">
            {combatActive && knockoutEligible && <button className={`knockout-turn-toggle ${knockOut ? 'active' : ''}`} disabled={tacticalBusy} aria-pressed={knockOut} onClick={() => setKnockOut((current) => !current)} title='При снижении до 0 ОЗ оставить цель с 1 ОЗ без сознания'><CombatIcon id='knockout-toggle' kind='action' hint='несмертельный нокаут пощадить цель' size={27} compact /><span>{knockOut ? 'Нокаут включён' : 'Нокаутировать'}</span></button>}
            {combatActive && selectedItem && needsWeaponChange && <button disabled={!canAct || tacticalBusy || !actionReady} onClick={() => selected && onChangeWeapon(selected, selectedItem.id)}><CombatIcon id={`swap-${selectedItem.id}`} kind="swap" hint={`сменить оружие ${selectedItem.name}`} size={27} compact /><span>Сменить оружие</span></button>}
            {combatActive && <button className="end-turn-hotbar" disabled={!canAct || tacticalBusy} onClick={onFinishTurn}><CombatIcon id="end-turn" kind="end-turn" hint="завершить ход" size={27} compact /><span>Завершить ход</span></button>}
          </div>}
        </div>
        {tacticalBusy && <p className="tactical-command-status"><RefreshCw className="spinning" size={12} />Действие идёт, мир отзывается на него…</p>}
        {tacticalError && <div className="tactical-command-error" role="alert"><span>{tacticalError}</span><button onClick={onClearTacticalError} aria-label="Закрыть ошибку"><X size={12} /></button></div>}
      </section>
      </section>
    </>
  )
}
function SceneHeader({ title, location, objective, turn, chapter, round, merchants, onOpenMerchant, onReset }: { title: string; location: string; objective: string; turn: number; chapter: number; round?: number; merchants: Merchant[]; onOpenMerchant: () => void; onReset: () => void }) {
  // Торговец в сцене виден прямо в заголовке, а не только пунктом бокового меню:
  // до него игрок доходит по карте, и предложение должно стоять там же, где он
  // смотрит.
  // Подписи у кнопки нет намеренно. Заголовок узкий: при 1280 px на всё про всё
  // 594 px, и подпись «Подойти к торговцу: Мартен Рыжий» съедала 280 из них —
  // название сцены обрезалось до «Точк…». Замерено в комнате: без подписи
  // название получает свои 188 px и читается целиком. Текст действия и имя
  // торговца живут в подсказке и в aria-label, а словесный пункт «Торговец»
  // остаётся в боковом меню.
  const merchantLabel = merchants.length === 1 ? `Подойти к торговцу: ${merchants[0].name}` : `Торговцев рядом: ${merchants.length}`
  return (
    <div className="scene-header">
      {/* `turn` — номер сцены, а не ход отряда: он растёт только при переходе
          Директора. Подпись «ХОД» читалась как замерший счётчик действий. */}
      <div className="scene-title"><span>ГЛАВА {chapter}{round != null ? ` · РАУНД ${round}` : ''} · СЦЕНА {turn}</span><h1>{title}</h1><p><Target size={13} />{location}</p></div>
      {/* Приглашение стоит до «текущей цели»: у неё `margin-left: auto`, и всё,
          что после, уезжает вправо под кнопку сброса с `position: absolute`. */}
      {merchants.length > 0 && <button className="scene-merchant" onClick={onOpenMerchant} aria-haspopup="dialog" aria-label={merchantLabel} title={merchantLabel}><Store size={16} /></button>}
      {/* Цель не помещается в строку заголовка и обрезается многоточием, а
          читать её игроку надо: замерено — из 571 px текста видно 311. Полная
          формулировка уходит в подсказку, иначе цель просто теряется. */}
      <div className="objective" title={objective}><small>ТЕКУЩАЯ ЦЕЛЬ</small><strong>{objective}</strong></div>
      <button className="icon-button reset-button" onClick={onReset} title="Снять бой и поднять павших героев"><RotateCcw size={17} /></button>
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
      <p>{resolving ? 'Рассказчик учитывает результат и продолжает сцену…' : 'Нажми на кость — что выпадет, то и будет.'}</p>
    </div>
  )
}

function AgentInteractionCard({ interaction, players, playerId, canContinue, onVote, onAbstain, onRoll, onContinue }: {
  interaction: AgentInteraction
  players: Player[]
  playerId: string
  canContinue: boolean
  onVote: (optionId: string) => void
  onAbstain: () => void
  onRoll: () => void
  onContinue: () => void
}) {
  const voterId = interaction.voterByActorId?.[playerId]
  const selected = Object.entries(interaction.votes).find(([actorId]) => (interaction.voterByActorId?.[actorId] ?? actorId) === (voterId ?? playerId))?.[1]
  const resolved = interaction.status === 'resolved'
  const winner = interaction.options.find((option) => option.id === interaction.resolvedOptionId)
  const quorum = interaction.requiredVotes ?? interaction.eligibleVoterIds?.length ?? interaction.eligibleActorIds?.length ?? players.filter((player) => player.online).length
  const activeVoters = interaction.activeVoterIds?.length ?? interaction.eligibleVoterIds?.length ?? interaction.eligibleActorIds?.length ?? players.filter((player) => player.online).length
  const ttlSeconds = Math.max(1, Math.round((interaction.policy?.decisionTtlMs ?? 120_000) / 1_000))
  return (
    <section className={['agent-interaction', 'agent-interaction--' + interaction.type, resolved ? 'resolved' : ''].join(' ')} aria-label="Групповое решение">
      <div className="agent-interaction__head">
        <span><BrainCircuit size={15} />Решение отряда</span>
        <strong>{interaction.title}</strong>
        <p>{interaction.description}</p>
        <small className="agent-interaction__policy">Один голос на аккаунт · активны {activeVoters} · отключение = воздержание · автоисход через {ttlSeconds} с</small>
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
              <span>{option.label}</span><small>{votes} / {quorum} голосов</small>
            </button>
          })}
        </div>
      )}
      {!resolved && interaction.type !== 'roll' && <button className="agent-abstain" onClick={onAbstain}>Воздержаться</button>}
      {resolved && <button className="agent-continue" onClick={onContinue} disabled={!canContinue}><Sparkles size={14} />Продолжить историю: {winner?.label}</button>}
    </section>
  )
}

function ChatPanel({ messages, isNarrating, pendingCheck, interaction, players, currentPlayerId, canAct, turnName, combatActive, onRoll, onCancelCheck, onVote, onAbstain, onRollInteraction, onContinueInteraction, onWhy, open, onToggle }: {
  messages: ReturnType<typeof useGameSession>['state']['messages']; isNarrating: boolean; pendingCheck: PendingCheck | null; interaction?: AgentInteraction | null; players: Player[]; currentPlayerId: string; canAct: boolean; turnName: string; combatActive: boolean; onRoll: () => void; onCancelCheck: () => void; onVote: (optionId: string) => void; onAbstain: () => void; onRollInteraction: () => void; onContinueInteraction: () => void; onWhy: () => void; open: boolean; onToggle: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isNarrating])

  if (!open) {
    return <button className="chat-closed" onClick={onToggle}><MessageSquare size={19} /><span>История</span><b>{messages.length}</b></button>
  }

  return (
    <section className="chat-panel" aria-label="Что происходит в сцене">
      <div className="chat-head">
        <div><span className="chat-head-eyebrow">ЧТО ПРОИСХОДИТ</span></div>
        <button className="icon-button" onClick={onToggle} aria-label="Свернуть историю"><ChevronDown size={20} /></button>
      </div>
      {/* Голосование и проверка живут здесь, среди подтверждённой правды, а не в
          композере: ключевое мультиплеерное событие не должно зависеть от геометрии
          панели, которую можно перетащить или свернуть. */}
      {interaction ? <AgentInteractionCard interaction={interaction} players={players} playerId={currentPlayerId} canContinue={canAct} onVote={onVote} onAbstain={onAbstain} onRoll={onRollInteraction} onContinue={onContinueInteraction} />
        : pendingCheck ? (canAct ? <DiceCheckCard check={pendingCheck} onRoll={onRoll} onCancel={onCancelCheck} />
          : <div className="turn-wait"><LockKeyhole size={18} /><span><b>Бросок выполняет владелец героя</b><small>Ожидаем игрока: {turnName}</small></span></div>)
        : null}
      <div className="messages">
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.speaker}`}>
            <div className="message-body">
              <div className="message-meta"><strong>{message.author}</strong><time>{message.timestamp}</time></div>
              <p>{message.text}</p>
              {/* Ставки: что проверялось, против какой СЛ и чем грозил провал.
                  Сервер считал их и раньше, но игрок их не видел. */}
              {message.stakes?.difficulty != null && (
                <div className="turn-stakes">
                  <Target size={13} />
                  <span>
                    <b>{stakesTitle(message.stakes)}</b>
                    {message.stakes.on_failure && <small>при провале: {message.stakes.on_failure}</small>}
                  </span>
                </div>
              )}
              {message.roll && (
                <div className={`roll-result ${message.roll.success ? 'success' : 'failure'}`}>
                  <Dices size={18} /><span><small>{message.roll.label}</small><b>d20: {message.roll.value} <i>+ {message.roll.modifier}</i></b></span><strong>{message.roll.total}</strong>
                  <em>{message.roll.success ? 'УСПЕХ' : 'ОСЛОЖНЕНИЕ'}</em>
                </div>
              )}
              {/* Вне боя очереди нет и «передавать» ход некому. */}
              {message.speaker === 'narrator' && message.turnConsumed != null && <small className={`turn-resolution ${message.turnConsumed ? 'spent' : 'kept'}`}>{message.turnConsumed ? (combatActive ? 'Ход передан следующему герою' : 'Действие засчитано') : 'Можно продолжить ход'}</small>}
              {/* Провенанс правила нажимается. Сырой rule_id в игровом интерфейсе не
                  показываем — сервер отвечает разбором по запросу. */}
              {message.roll && <button className="why-link" onClick={onWhy} disabled={isNarrating}><HelpCircle size={15} />Почему так?</button>}
            </div>
          </article>
        ))}
        {isNarrating && <div className="typing"><span /><span /><span /> Рассказчик меняет мир…</div>}
        <div ref={endRef} />
      </div>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const copy = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(code)}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await response.json().catch(() => null) as { token?: string; error?: string } | null
      if (!response.ok || !body?.token) throw new Error(body?.error || 'Не удалось создать приглашение')
      await navigator.clipboard?.writeText(`${location.origin}?room=${encodeURIComponent(code)}#invite=${encodeURIComponent(body.token)}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать приглашение')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть приглашение" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><Users size={23} /></div>
        <span className="eyebrow">ПРИГЛАШЕНИЕ В ОТРЯД</span>
        <h2 id="invite-modal-title">Соберите героев</h2>
        <p>Создайте одноразовую ссылку. Она закрепляет за новым игроком одного свободного героя и действует семь дней.</p>
        <div className="invite-code"><span>{code}</span><button onClick={copy} disabled={busy}><Copy size={16} />{busy ? 'Создаём…' : copied ? 'Скопировано' : 'Копировать'}</button></div>
        {error && <p className="error-text">{error}</p>}
        <small className="modal-note">Секрет приглашения передаётся во фрагменте ссылки и удаляется из адреса после входа.</small>
      </div>
    </div>
  )
}

function CampaignModal({ state, onSwitch, onAccountRefresh, onCreateHero, onClose }: { state: GameState; onSwitch: (code: string, room?: { version?: number; state?: GameState | null }) => Promise<void>; onAccountRefresh: () => Promise<Account | null>; onCreateHero: (heroId: string) => void; onClose: () => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [partyName, setPartyName] = useState('')
  const [code, setCode] = useState('')
  const [world, setWorld] = useState({ preset: '', era: '', genre: '', tone: '', premise: '', themes: '', boundaries: '', magicLevel: '', technologyLevel: '', startingLocation: '', openingSituation: '' })
  // Соло-кампания — полноценный режим. Мест ровно столько, сколько игроков
  // сядет за стол; лишние места иначе висят пустыми и блокируют ход.
  const [slotCount, setSlotCount] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setCampaignsLoading(true)
    setError('')
    try {
      const campaignsResponse = await fetchWithTimeout(
        '/api/campaigns',
        {},
        15_000,
        'Список кампаний не загрузился вовремя. Сохранённые кампании не удалены.',
      )
      const campaignsBody = await campaignsResponse.json() as { campaigns?: CampaignSummary[]; error?: string }
      if (!campaignsResponse.ok) throw new Error(campaignsBody.error || 'Не удалось загрузить кампании')
      setCampaigns(campaignsBody.campaigns ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка загрузки кампаний')
    } finally {
      setCampaignsLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const validateStep = () => {
    setError('')
    if (step === 1 && code && !/^[A-Z0-9-]{3,24}$/.test(code)) { setError('Код комнаты должен содержать 3–24 латинских буквы, цифры или дефисы — либо оставьте его пустым для автогенерации.'); return false }
    return true
  }

  const create = async () => {
    if (!validateStep()) return
    setBusy(true)
    setError('')
    try {
      const resolvedCode = code || `WORLD-${(globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)).replace(/-/g, '').slice(0, 8).toUpperCase()}`
      const response = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: resolvedCode, name: name.trim(), bootstrap: { partyName: partyName.trim(), world, slotCount } }) })
      const body = await response.json() as { version?: number; state?: GameState | null; error?: string }
      if (!response.ok) throw new Error(body.error || 'Не удалось создать кампанию')
      await onAccountRefresh()
      await onSwitch(resolvedCode, body)
      onClose()
      const ownerSlotId = body.state?.players.find((hero) => hero.characterSetupRequired)?.id
      if (ownerSlotId) onCreateHero(ownerSlotId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось создать кампанию') }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={'modal campaign-modal ' + (wizard ? 'campaign-wizard' : '')} role="dialog" aria-modal="true" aria-labelledby="campaign-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть выбор кампании" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><ScrollText size={23} /></div>
        <span className="eyebrow">КАМПАНИИ И ГРУППЫ</span>
        <h2 id="campaign-modal-title">{wizard ? 'Создание нового мира' : 'Выберите приключение'}</h2>
        {!wizard ? <>
          <div className="campaign-list">
            {campaignsLoading && <p className="campaign-empty campaign-loading" role="status"><RefreshCw className="spinning" size={14} />Загружаем кампании…</p>}
            {campaigns.map((campaign) => <button key={campaign.code} className={campaign.code === state.sessionCode ? 'active' : ''} onClick={async () => { setBusy(true); setError(''); try { await onSwitch(campaign.code); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка переключения') } finally { setBusy(false) } }} disabled={busy}>
              <span><b>{campaign.name}</b><small>{campaign.partyName} · {campaign.memberCount} участников{campaign.setting ? ' · ' + campaign.setting : ''}</small></span><em>{campaign.code}</em>
            </button>)}
            {!campaignsLoading && !campaigns.length && !error && <p className="campaign-empty">Доступных кампаний пока нет.</p>}
            {!campaignsLoading && !!error && <button type="button" className="campaign-retry" onClick={() => void load()} disabled={busy}><RefreshCw size={14} />Повторить загрузку кампаний</button>}
          </div>
          <button className="campaign-start-wizard" onClick={() => setWizard(true)}><Plus size={15} />Создать полностью новую кампанию</button>
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
          {step === 2 && <div className="hero-creator slot-creator">
            <div className="world-auto-note"><Users size={17} /><span><b>Сколько игроков сядет за стол?</b> Первое место всегда ваше, остальные заполнят приглашённые друзья при входе по ссылке. Пустых мест не останется.</span></div>
            <div className="slot-count-picker" role="group" aria-label="Число мест героев">
              {[1, 2, 3, 4].map((count) => <button key={count} type="button" className={count === slotCount ? 'selected' : ''} aria-pressed={count === slotCount} onClick={() => setSlotCount(count)}>
                <strong>{count}</strong><small>{count === 1 ? 'соло-кампания' : `${count} игрока`.replace('4 игрока', '4 игроков')}</small>
              </button>)}
            </div>
            <div className="hero-library">{Array.from({ length: slotCount }, (_, index) => index + 1).map((slot) => <div className="hero-slot-preview" key={slot}><span>{slot}</span><div><b>{slot === 1 ? 'Ваш герой' : `Герой друга ${slot - 1}`}</b><small>Класс, вид, характеристики и история ещё не выбраны</small></div><ShieldCheck size={16} /></div>)}</div>
          </div>}
          {step === 3 && <div className="campaign-review"><span><Sparkles size={22} /></span><h3>Рассказчик готов создать мир</h3><p>Сначала появятся мир, первая сцена и места героев. Затем каждый игрок создаст собственного героя через серверно проверяемый мастер.</p><dl><div><dt>Кампания</dt><dd>{name.trim() || 'Название придумает рассказчик'}{partyName.trim() ? ` · отряд «${partyName.trim()}»` : ''}</dd></div><div><dt>Мир</dt><dd>{[world.preset, world.era, world.genre].filter(Boolean).join(' · ') || 'Полная автоматическая генерация'}</dd></div>{world.premise.trim() && <div><dt>Основа</dt><dd>{world.premise.trim()}</dd></div>}<div><dt>Начало</dt><dd>{world.openingSituation || 'Придумает рассказчик'}</dd></div><div><dt>Герои</dt><dd>{slotCount === 1 ? 'одно место · соло-кампания' : `${slotCount} места · первый герой ваш`}</dd></div></dl><small>Ни один игрок не сможет сделать первый ход, пока не завершит создание закреплённого за ним героя.</small></div>}
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
  const enemyTarget = state.enemies?.find((enemy) => enemy.id === event.targetId)
  const enemyActor = state.enemies?.find((enemy) => enemy.id === event.actorId)
  const hideTargetFacts = Boolean(enemyTarget && enemyTarget.healthKnown !== 'exact')
  const hideActorFacts = Boolean(enemyActor && enemyActor.healthKnown !== 'exact')
  if (event.type === 'combat-start') {
    const participants = (event.participantIds ?? []).map(actorName).join(', ')
    return participants ? `Бой начался. Участники: ${participants}.` : 'Бой начался, порядок инициативы определён.'
  }
  if (event.type === 'combat-end') return `Бой завершён в раунде ${event.round ?? 1}${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'move') return `${actorName(event.actorId)} перемещается на ${event.distanceFeet ?? 0} фт.`
  if (event.type === 'turn-end') return `${actorName(event.actorId)} завершает ход.`
  if (event.type === 'spell') return `${actorName(event.actorId)} применяет «${event.spellName ?? event.spellId ?? 'заклинание'}»${event.targetId ? ` к ${actorName(event.targetId)}` : ''}.`
  if (event.type === 'spell-save') {
    const modifier = Number(event.roll?.modifier) || 0
    const formula = `${event.roll?.die ?? '?'} ${modifier >= 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    const outcome = event.result === 'success' ? 'успех' : 'провал'
    const damage = event.damage != null ? ` · ${event.damage} урона` : ''
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    const automatic = event.automaticSuccess ? ' · автоматический успех' : event.immunity ? ` · иммунитет: ${event.immunity}` : ''
    return hideTargetFacts
      ? `${actorName(event.targetId)} делает спасбросок от «${event.spellName ?? event.spellId ?? 'заклинания'}» — ${outcome}${automatic}${damage}.`
      : `${actorName(event.targetId)}: спасбросок ${event.ability?.toUpperCase() ?? ''} от «${event.spellName ?? event.spellId ?? 'заклинания'}» ${formula} против СЛ ${event.roll?.difficulty ?? '?'} — ${outcome}${automatic}${damage}${hp}.`
  }
  if (event.type === 'spell-damage') return `${actorName(event.actorId)} применяет «${event.spellName ?? event.spellId ?? 'заклинание'}» к ${actorName(event.targetId)}: ${event.damage ?? 0} урона${hideTargetFacts ? '' : ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter ?? '?'}`}.`
  if (event.type === 'healing') return `${actorName(event.actorId)} лечит ${actorName(event.targetId)}${event.spellId ? ` заклинанием «${event.spellName ?? event.spellId}»` : ''}: +${event.healing ?? 0} ОЗ${hideTargetFacts ? '' : ` · ${event.hpBefore ?? '?'} → ${event.hpAfter ?? '?'}`}.`
  if (event.type === 'area-attack') return `${actorName(event.actorId)} применяет «${event.itemName ?? 'областную атаку'}» в области радиусом ${event.area?.radiusFeet ?? '?'} фт.`
  if (event.type === 'equipment') return `${actorName(event.actorId)} экипирует «${event.itemName ?? 'оружие'}».`
  if (event.type === 'summon') return `${actorName(event.actorId)} призывает ${actorName(event.targetId)}.`
  if (event.type === 'summon-end') return `${actorName(event.actorId)}: призыв ${actorName(event.targetId)} завершён.`
  if (event.type === 'death-save') {
    const natural = event.roll?.die ?? event.roll?.total ?? '?'
    const modifier = Number(event.roll?.modifier) || 0
    const rollText = modifier === 0 ? natural : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    return `${actorName(event.actorId)}: спасбросок от смерти ${rollText} — ${event.result === 'revived' ? 'натуральная 20, 1 ОЗ' : event.result === 'stabilized' ? 'стабилизация' : event.result === 'died' ? 'смерть' : event.result === 'success' ? 'успех' : 'провал'} (${event.successes ?? 0} успехов / ${event.failures ?? 0} провалов).${event.auraBonus ? ` Аура защиты: +${event.auraBonus}.` : ''}${event.indomitableBonus ? ` Несгибаемый: +${event.indomitableBonus}, исходный итог ${event.indomitableOriginalTotal ?? '?'}.` : ''}`
  }
  if (event.type === 'death-save-damage') return `${actorName(event.actorId)} получает ${event.critical ? 'два провала' : 'провал'} спасброска от смерти из-за урона.`
  if (event.type === 'hero-stabilized') return `${actorName(event.actorId)} стабилизирован и больше не делает спасброски от смерти.`
  if (event.type === 'concentration-save') {
    const natural = event.roll?.die ?? '?'
    const modifier = Number(event.roll?.modifier) || 0
    const rollText = modifier === 0 ? natural : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    return `${actorName(event.actorId)}: концентрация ${rollText} против СЛ ${event.roll?.difficulty ?? 10} — ${event.result === 'success' ? 'сохранена' : 'провалена'}.${event.auraBonus ? ` Аура защиты: +${event.auraBonus}.` : ''}${event.indomitableBonus ? ` Несгибаемый: +${event.indomitableBonus}, исходный итог ${event.indomitableOriginalTotal ?? '?'}.` : ''}`
  }
  if (event.type === 'concentration-end') return `Концентрация ${actorName(event.actorId)} прекращена${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'max-hp-reduction') return hideTargetFacts ? `Жизненные силы ${actorName(event.targetId)} ослаблены.` : `${actorName(event.targetId)}: максимум ОЗ ${event.maximumHpBefore ?? '?'} → ${event.maximumHpAfter ?? '?'}.`
  if (event.type === 'max-hp-reduction-prevented') return `Аура жизни защищает максимум ОЗ ${actorName(event.targetId)}.`
  if (event.type === 'action') return event.indomitableBonus
    ? `${actorName(event.actorId)} использует «${event.actionName ?? 'Несгибаемый'}»: исходный итог ${event.indomitableOriginalTotal ?? '?'}, бонус переброска +${event.indomitableBonus}.`
    : `${actorName(event.actorId)} использует «${event.actionName ?? event.actionId ?? 'боевое действие'}».`
  if (event.type === 'attack') {
    const outcome = event.roll?.hit ? `попадание${event.damage != null ? `, ${event.damage} урона` : ''}` : 'промах'
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    return hideActorFacts
      ? `${actorName(event.actorId)} атакует ${actorName(event.targetId)} — ${outcome}${hp}.`
      : `${actorName(event.actorId)} атакует ${actorName(event.targetId)}: ${event.roll?.total ?? '?'}${hideTargetFacts ? '' : ` против КД ${event.roll?.difficulty ?? '?'}`} — ${outcome}${hp}.`
  }
  return event.type
}

function BattleResultCard({ state, event }: { state: GameState; event: NonNullable<GameState['battleLog']>[number] }) {
  const enemyTarget = state.enemies?.find((enemy) => enemy.id === event.targetId)
  const enemyActor = state.enemies?.find((enemy) => enemy.id === event.actorId)
  const hideTargetFacts = Boolean(enemyTarget && enemyTarget.healthKnown !== 'exact')
  const hideActorFacts = Boolean(enemyActor && enemyActor.healthKnown !== 'exact')
  const rawRoll = hideActorFacts ? null : battleRollPresentation(event)
  const roll = rawRoll && hideTargetFacts ? { ...rawRoll, difficulty: undefined } : rawRoll
  const tone = event.type === 'healing' ? 'healing'
    : event.type === 'attack' ? event.roll?.hit ? 'success' : 'miss'
      : event.type === 'spell-save' ? event.result === 'success' ? 'saved' : 'failed'
        : event.damage != null ? 'success' : 'neutral'
  const label = event.type === 'attack' ? 'БРОСОК АТАКИ'
    : event.type === 'spell-save' ? 'СПАСБРОСОК'
      : event.type === 'healing' ? 'ЛЕЧЕНИЕ'
        : event.type === 'spell-damage' ? 'УРОН ЗАКЛИНАНИЕМ' : 'ПОСЛЕДНИЙ РЕЗУЛЬТАТ'
  const outcome = event.type === 'attack' ? event.roll?.hit ? 'ПОПАДАНИЕ' : 'ПРОМАХ'
    : event.type === 'spell-save' ? event.result === 'success' ? 'УСПЕХ' : 'ПРОВАЛ'
      : event.type === 'healing' ? `+${event.healing ?? 0} ОЗ`
        : event.damage != null ? `${event.damage} УРОНА` : null
  return <div className={`combat-result-card ${tone}`} role="status">
    <div className="combat-result-icon"><Dices size={15} /></div>
    <div className="combat-result-body">
      <header><small>{label}</small>{outcome && <strong>{outcome}</strong>}</header>
      <p>{battleEventText(state, event)}</p>
      {roll && <div className={`combat-roll-equation ${roll.difficulty == null ? 'difficulty-hidden' : ''}`} aria-label={`Бросок d20: ${roll.natural} ${roll.modifierText}, итог ${roll.total}${roll.difficulty == null ? '' : `, ${roll.difficultyLabel} ${roll.difficulty}`}`}>
        <span><small>d20</small><b>{roll.natural}</b></span><i>+</i><span><small>мод.</small><b>{roll.modifierText}</b></span><i>=</i><span className="total"><small>итог</small><b>{roll.total}</b></span>{roll.difficulty != null && <><i>vs</i><span className="difficulty"><small>{roll.difficultyLabel}</small><b>{roll.difficulty}</b></span></>}
      </div>}
      {(event.damage != null || event.healing != null || event.hpAfter != null) && <footer>
        {event.damage != null && <span><Flame size={11} />{event.damage} урона{event.damageType ? ` · ${event.damageType}` : ''}</span>}
        {event.healing != null && <span><Heart size={11} />+{event.healing} ОЗ</span>}
        {!hideTargetFacts && event.hpAfter != null && <span><Heart size={11} />ОЗ {event.hpBefore ?? '?'} → {event.hpAfter}</span>}
      </footer>}
    </div>
  </div>
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
              <div><small>{event.type === 'attack' ? 'АТАКА' : event.type === 'move' ? 'ПЕРЕМЕЩЕНИЕ' : event.type === 'turn-end' ? 'ХОД' : event.type.startsWith('death-save') || event.type === 'hero-stabilized' ? 'СУДЬБА ГЕРОЯ' : event.type.startsWith('concentration-') ? 'КОНЦЕНТРАЦИЯ' : 'БОЙ'}</small><p>{battleEventText(state, event)}</p></div>
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

function SettingsView({ health, uiScale, autoAttackRoll, scenicBackdrop, onUiScaleChange, onAutoAttackRollChange, onScenicBackdropChange }: { health: AiHealth | null; uiScale: number; autoAttackRoll: boolean; scenicBackdrop: boolean; onUiScaleChange: (value: number) => void; onAutoAttackRollChange: (value: boolean) => void; onScenicBackdropChange: (value: boolean) => void }) {
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
          <div className="provider-info"><span>ПРОВАЙДЕР<strong>{health?.provider ?? 'RouterAI'}</strong></span><span>МОДЕЛЬ<strong>{health?.model ?? 'Проверка подключения…'}</strong></span><span>МЕХАНИКА<strong>Единый серверный движок</strong></span><span>RULESET<strong>{health?.rulesetId ?? 'не выбран'}</strong></span></div>
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
          <ToggleRow icon={<Globe2 size={17} />} title="Атмосферный фон локации" description="Включено — окружение соответствует месту; выключено — спокойный однотонный фон" value={scenicBackdrop} onChange={() => onScenicBackdropChange(!scenicBackdrop)} />
          <ToggleRow icon={<Dices size={17} />} title="Автобросок при атаке" description="Включено — цель сразу атакуется; выключено — появляется отдельная кнопка кубика" value={autoAttackRoll} onChange={() => onAutoAttackRollChange(!autoAttackRoll)} />
        </div>
      </div>
    </section>
  )
}

function AdminView({ account, state, onUpdateWorld, onAssembleEncounter, onAssembleMerchant, onMoveMerchant, onSetMerchantAvailability, onReset }: { account: Account; state: GameState; onUpdateWorld: (patch: { campaign?: string; partyName?: string; partyMemberIds?: string[]; scene?: Partial<GameState['scene']> }) => void; onAssembleEncounter: (options: EncounterAssemblyOptions) => Promise<EncounterProposal>; onAssembleMerchant: (options: ShopAssemblyOptions) => Promise<Merchant>; onMoveMerchant: (merchantId: string, location: string, locationId?: string) => Promise<void>; onSetMerchantAvailability: (merchantId: string, available: boolean) => Promise<void>; onReset: () => void }) {
  const [users, setUsers] = useState<Account[]>([])
  const [error, setError] = useState('')
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
    setPartyMemberIds(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
    setScene({ title: state.scene.title, location: state.scene.location, mood: state.scene.mood, objective: state.scene.objective })
    setEncounterProposal(null)
    setEncounterError('')
  }, [state.sessionCode])

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
          <div className="engine-mode-field"><span>Игровая механика</span><strong>Единый авторитетный движок</strong><small>Движение, атаки, кубики, урон, магия и обычная тактика врагов рассчитываются сервером без AI. Агент включается только при создании кампании и новой области, а также в переломных моментах боя: смерть, бегство или сдача.</small></div>
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
          {combatActive && <div className="encounter-admin-warning"><Swords size={15} />Завершите текущее столкновение, прежде чем собирать новое.</div>}
          {encounterError && <div className="admin-error">{encounterError}</div>}
          {encounterProposal && <div className="encounter-admin-success"><Check size={15} /><span><b>Столкновение собрано</b><small>{encounterProposal.enemies?.length ?? 0} противников{encounterProposal.xp_spent != null ? ` · ${encounterProposal.xp_spent}${encounterProposal.xp_budget != null ? ` / ${encounterProposal.xp_budget}` : ''} XP` : ''}</small></span></div>}
          <div className="encounter-assembler-controls">
            <label><span>Сложность для группы</span><select value={encounterDifficulty} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterDifficulty(event.target.value as EncounterAssemblyOptions['difficulty'])}><option value="easy">Лёгкая</option><option value="medium">Средняя</option><option value="hard">Тяжёлая</option></select></label>
            <label><span>Тема противников</span><select value={encounterTheme} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterTheme(event.target.value as EncounterAssemblyOptions['theme'])}><option value="generic">Любые подходящие</option><option value="undead">Нежить</option><option value="beasts">Звери</option><option value="goblinoids">Гоблиноиды</option><option value="raiders">Налётчики</option></select></label>
            <button onClick={() => { void assembleCurrentEncounter() }} disabled={encounterBusy || combatActive}>{encounterBusy ? <RefreshCw className="spinning" size={15} /> : <Swords size={15} />}{encounterBusy ? 'Собираем столкновение…' : 'Собрать столкновение'}</button>
          </div>
          {encounterProposal?.enemies?.length ? <div className="encounter-proposal-list">{encounterProposal.enemies.map((enemy) => <span key={enemy.id}><b>{enemy.name}</b><small>Параметры рассчитываются сервером и скрыты от игроков</small></span>)}</div> : null}
        </div>
        <div className="admin-card admin-merchants">
          <div className="admin-card-head"><span><Store size={18} /><b>Торговцы и ShopAssembler</b></span><em>{state.merchants?.length ?? 0} в кампании</em></div>
          <p>Сборщик выбирает только позиции серверного каталога. Цены, лимиты количества и политика магазина проверяются Rules Engine.</p>
          {shopError && <div className="admin-error">{shopError}</div>}
          {shopMessage && <div className="shop-admin-success"><Check size={14} />{shopMessage}</div>}
          <div className="shop-assembler-controls">
            <label><span>Тип поселения</span><select value={shopSettlement} disabled={shopBusy} onChange={(event) => setShopSettlement(event.target.value as ShopAssemblyOptions['settlementType'])}><option value="village">Деревня</option><option value="town">Городок</option><option value="city">Большой город</option><option value="outpost">Застава</option><option value="traveling">Странствующая лавка</option></select></label>
            <label><span>Профиль лавки</span><select value={shopTheme} disabled={shopBusy} onChange={(event) => setShopTheme(event.target.value as ShopAssemblyOptions['theme'])}><option value="general">Общие товары</option><option value="provisions">Припасы</option><option value="arms">Оружие и защита</option><option value="healing">Лечение</option></select></label>
            <label><span>Бюджет склада, зм</span><input type="number" min="1" max="10000" value={shopBudgetGold} disabled={shopBusy} onChange={(event) => setShopBudgetGold(Number(event.target.value) || 1)} /></label>
            <button onClick={() => { void assembleCurrentShop() }} disabled={shopBusy}>{shopBusy ? <RefreshCw className="spinning" size={15} /> : <Sparkles size={15} />}{shopBusy ? 'Собираем лавку…' : 'Собрать лавку для текущей сцены'}</button>
          </div>
          <div className="shop-admin-list">
            {(state.merchants ?? []).map((merchant) => <article key={merchant.id}>
              <div><strong>{merchant.name}</strong><span>{merchant.title || 'Торговец'} · {merchant.stock.length} позиций</span><small>{merchant.location || 'Локация не задана'}</small></div>
              <em className={merchant.available ? 'available' : ''}>{merchant.available ? 'ОТКРЫТ' : 'ЗАКРЫТ'}</em>
              <div className="shop-admin-actions">
                <button disabled={shopBusy || locationsMatch(merchant, state.scene)} onClick={() => { void runShopAction(() => onMoveMerchant(merchant.id, state.scene.location, state.scene.location_id), `${merchant.name} перемещён в «${state.scene.location}».`) }}>Переместить сюда</button>
                <button disabled={shopBusy} onClick={() => { void runShopAction(() => onSetMerchantAvailability(merchant.id, !merchant.available), merchant.available ? `${merchant.name} закрывает торговлю.` : `${merchant.name} снова доступен.`) }}>{merchant.available ? 'Закрыть' : 'Открыть'}</button>
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

function ReactionPrompt({ actorName, sourceName, window, busy, beneficiaries, onChoose, onDecline }: { actorName: string; sourceName: string; window: CombatReactionWindow; busy: boolean; beneficiaries: Array<{ id: string; name: string }>; onChoose: (actionId: string, beneficiaryId?: string) => void; onDecline: () => void }) {
  const hit = ['attack-hit', 'spell-attack-hit'].includes(window.trigger)
  const opportunity = window.trigger === 'enemy-left-reach'
  const spellCast = window.trigger === 'spell-cast'
  const failedSave = window.trigger === 'failed-saving-throw'
  const failedSaveText = failedSave
    ? `${actorName} проваливает спасбросок: d20 ${window.trigger_roll?.kept ?? '—'} ${(window.trigger_roll?.modifier ?? 0) >= 0 ? '+' : ''}${window.trigger_roll?.modifier ?? 0} = ${window.trigger_roll?.total ?? '—'} против СЛ ${window.trigger_roll?.difficulty ?? '—'}.`
    : ''
  const [beneficiaryId, setBeneficiaryId] = useState(beneficiaries[0]?.id ?? window.actor_id)
  const needsBeneficiary = window.action_options.some((option) => option.requires_beneficiary)
  return <div className="reaction-backdrop"><section className="reaction-prompt" role="dialog" aria-modal="true" aria-label="Выбор реакции">
    <header><div><RefreshCw size={21} /><span><small>{failedSave ? 'ПРОВАЛЕННЫЙ СПАСБРОСОК' : 'ПРЕРЫВАЮЩАЯ РЕАКЦИЯ'}</small><strong>{failedSave ? `${actorName}, использовать особенность?` : `${actorName}, реагировать?`}</strong></span></div><em>{failedSave ? 'СПАСБРОСОК' : spellCast ? 'ЗАКЛИНАНИЕ' : opportunity ? 'ДВИЖЕНИЕ' : hit ? 'ПОПАДАНИЕ' : 'ПРОМАХ'}</em></header>
    <p>{failedSave ? failedSaveText : spellCast ? `${sourceName} начинает накладывать «${window.pending_spell?.name ?? 'заклинание'}»${window.pending_spell?.slot_level ? ` ячейкой ${window.pending_spell.slot_level} уровня` : ''}.` : opportunity ? `${sourceName} покидает досягаемость героя.` : hit ? `${sourceName} попадает по герою${window.damage?.applied_amount ? ` и наносит ${window.damage.applied_amount} урона` : ''}.` : `${sourceName} промахивается в ближнем бою.`} {failedSave ? 'Выберите «Несгибаемый» или оставьте исходный провал.' : 'Выберите одну доступную реакцию или продолжите бой без неё.'}</p>
    {needsBeneficiary && <label className="reaction-beneficiary"><span>Преимущество получит</span><select value={beneficiaryId} disabled={busy} onChange={(event) => setBeneficiaryId(event.target.value)}>{beneficiaries.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.name}</option>)}</select></label>}
    <div className="reaction-options">{window.action_options.map((option) => <button key={option.id} disabled={busy || (option.requires_beneficiary && !beneficiaryId)} onClick={() => onChoose(option.id, option.requires_beneficiary ? beneficiaryId : undefined)}><i><CombatIcon id={option.id} kind={option.id.startsWith('cast:') ? 'spell' : 'reaction'} hint={`${option.name} ${option.description}`} size={35} /></i><span><strong>{option.name}</strong><small>{option.description}</small></span>{option.resource && <em>{option.cost ?? 1}</em>}</button>)}</div>
    <footer><button disabled={busy} onClick={onDecline}>{busy ? 'Применяем…' : failedSave ? 'Оставить провал' : 'Не реагировать'}</button><span>{failedSave ? 'Несгибаемый не расходует реакцию и восстанавливается после продолжительного отдыха.' : 'Реакция восстановится в начале следующего хода героя.'}</span></footer>
  </section></div>
}

function DeathScreen({ heroes, partyDefeated, busy, error, canResolve, onResolve, onChooseCampaign, onExit }: {
  heroes: Player[]
  partyDefeated: boolean
  busy: boolean
  error: string | null
  canResolve: (heroId: string) => boolean
  onResolve: (heroId: string, resolution: 'resurrect' | 'replace', replacementName?: string) => void
  onChooseCampaign: () => void
  onExit: () => void
}) {
  const [replacementNames, setReplacementNames] = useState<Record<string, string>>({})
  const [replacementOpen, setReplacementOpen] = useState<Record<string, boolean>>({})
  const [localError, setLocalError] = useState<string | null>(null)

  const replace = (hero: Player) => {
    const name = String(replacementNames[hero.id] ?? '').trim()
    if (name.length < 2) {
      setLocalError('Укажите имя нового героя.')
      return
    }
    setLocalError(null)
    onResolve(hero.id, 'replace', name)
  }

  return <div className={`death-screen-backdrop ${partyDefeated ? 'party-defeated' : ''}`}>
    <section className="death-screen" role="dialog" aria-modal="true" aria-label={partyDefeated ? 'История завершена' : 'Судьба погибшего героя'}>
      <div className="death-emblem"><Skull size={39} /></div>
      <span className="death-eyebrow">{partyDefeated ? 'КОНЕЦ ИСТОРИИ' : 'СУДЬБА ГЕРОЯ'}</span>
      <h1>{partyDefeated ? 'Отряд погиб' : heroes.length > 1 ? 'Герои пали' : `${heroes[0]?.character ?? 'Герой'} погиб`}</h1>
      <p>{partyDefeated
        ? 'В живых не осталось ни одного героя. Эта история завершена: действия, новые сцены и бои в этом мире больше недоступны.'
        : 'Погибший герой больше не может действовать. Чтобы продолжить историю, воскресите его или приведите в отряд нового героя.'}</p>

      {!partyDefeated && <div className="fallen-heroes">{heroes.map((hero) => {
        const controllable = canResolve(hero.id)
        const replacing = replacementOpen[hero.id] === true
        return <article key={hero.id} className="fallen-hero-card">
          <div className="fallen-hero-portrait" style={{ backgroundImage: `url(${hero.portrait})`, backgroundPosition: hero.portraitPosition }}><Skull size={22} /></div>
          <div className="fallen-hero-name"><small>ПОГИБШИЙ ГЕРОЙ</small><strong>{hero.character}</strong><span>{hero.role} · {hero.level} уровень</span></div>
          {controllable ? <div className="death-resolution-actions">
            <button className="resurrect-hero" disabled={busy} onClick={() => { setLocalError(null); onResolve(hero.id, 'resurrect') }}><Sparkles size={17} /><span><strong>Воскресить</strong><small>Вернётся с 1 ОЗ</small></span></button>
            {!replacing ? <button disabled={busy} onClick={() => setReplacementOpen((current) => ({ ...current, [hero.id]: true }))}><Users size={17} /><span><strong>Новый герой</strong><small>Заменит погибшего и откроет лист</small></span></button> : <div className="replacement-name-field">
              <input value={replacementNames[hero.id] ?? ''} maxLength={120} autoFocus placeholder="Имя нового героя" onChange={(event) => setReplacementNames((current) => ({ ...current, [hero.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') replace(hero) }} />
              <button disabled={busy} onClick={() => replace(hero)}><Check size={16} />Принять</button>
            </div>}
          </div> : <em className="death-waiting"><LockKeyhole size={15} /> Решение принимает владелец героя или администратор.</em>}
        </article>
      })}</div>}

      {(localError || error) && <div className="death-error">{localError || error}</div>}
      {partyDefeated && <footer><div><button onClick={onChooseCampaign}><BookOpen size={16} />Другие кампании</button><button onClick={onExit}><LogOut size={16} />Выйти</button></div><small>Эту историю продолжить нельзя. Выберите другой мир или создайте новую кампанию.</small></footer>}
    </section>
  </div>
}

function CampaignConclusionScreen({ status, epilogue, busy, canManage, onArchive, onChooseCampaign }: {
  status: 'completed' | 'archived'
  epilogue?: string | null
  busy: boolean
  canManage: boolean
  onArchive: () => void
  onChooseCampaign: () => void
}) {
  return <div className="death-screen-backdrop">
    <section className="death-screen" role="dialog" aria-modal="true" aria-label="Кампания завершена">
      <span className="death-eyebrow">{status === 'archived' ? 'АРХИВ КАМПАНИИ' : 'ЭПИЛОГ'}</span>
      <h1>История завершена</h1>
      <p>{epilogue || 'Приключение завершилось, а его события сохранены в летописи кампании.'}</p>
      <footer>
        <div>
          <button onClick={onChooseCampaign}><BookOpen size={16} />Другие кампании</button>
          {status === 'completed' && canManage && <button onClick={onArchive} disabled={busy}>Архивировать</button>}
        </div>
        <small>Состояние, карта и журнал доступны для чтения.</small>
      </footer>
    </section>
  </div>
}

function ConnectionIndicator({ status }: { status: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    connecting: 'Подключение…',
    connected: 'Синхронизация включена',
    reconnecting: 'Связь восстанавливается…',
    offline: 'Нет связи с сервером',
  }
  /* Исправная синхронизация — не новость: подпись «синхронизация включена»
     висела в строке постоянно и ничего не сообщала. Показываемся только когда
     связь потеряна или восстанавливается: об этом игрок узнать обязан, иначе
     замерший мир выглядит как поломка игры. */
  if (status === 'connected') return null
  const Icon = WifiOff
  return <div className={`connection-status ${status}`} role="status" aria-live="polite" title={labels[status]}>
    <Icon size={14} />
    <span>{labels[status]}</span>
    {status === 'reconnecting' && <RefreshCw className="spinning" size={12} />}
  </div>
}

function GameApp({ account, onAccountRefresh, onLogout }: { account: Account; onAccountRefresh: () => Promise<Account | null>; onLogout: () => void }) {
  const { state, connectionState, tacticalBusy, tacticalError, merchantBusy, merchantError, directorError, merchantView, merchantNarration, clearTacticalError, submitAction, rollPendingCheck, cancelPendingCheck, rollFreeDie, voteAgentInteraction, abstainAgentInteraction, rollAgentInteraction, continueAgentInteraction, startCombat, movePlayer, attackEnemy, throwAreaItem, castSpell, useCombatAction, changeWeapon, finishMapTurn, resolveHeroDeath, equipItem, useItem, transferItem, attuneItem, importCharacter, levelUpCharacter, switchCampaign, loadMerchant, bargainWithMerchant, buyFromMerchant, sellToMerchant, appraiseWithMerchant, purchaseMerchantService, assembleMerchant, assembleEncounter, moveMerchant, setMerchantAvailability, reset, updatePlayer, updateWorld } = useGameSession()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 920)
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth > 680)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [merchantOpen, setMerchantOpen] = useState(false)
  const [campaignsOpen, setCampaignsOpen] = useState(() => account.heroIds.length === 0 && !account.campaignMemberships?.length)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('agentLab') === '1' ? 'agent-lab' : 'room')
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [creatingPlayerId, setCreatingPlayerId] = useState<string | null>(null)
  // Закрытый мастер не должен открываться заново на том же экране: иначе
  // «Закрыть» ничего не значит, а Escape выглядит сломанным.
  const [heroWizardDismissed, setHeroWizardDismissed] = useState(false)
  const [replacementEditorId, setReplacementEditorId] = useState<string | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [uiScale, setUiScale] = useState(loadUiScale)
  const [autoAttackRoll, setAutoAttackRoll] = useState(() => window.localStorage.getItem('skazanie-auto-attack-roll') !== 'false')
  const [scenicBackdrop, setScenicBackdrop] = useState(loadScenicBackdrop)
  const combatWasActive = useRef(false)
  const merchantLocation = useRef(state.scene.location)
  const joinAttempted = useRef(false)
  const isAdmin = account.role === 'admin'
  const partyIdSet = new Set(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
  const partyPlayers = state.players.filter((player) => partyIdSet.has(player.id))
  const deathState = state.mechanics?.death
  const deadHeroIds = new Set(Object.entries(deathState?.heroes ?? {}).filter(([, fate]) => fate.status === 'dead').map(([id]) => id))
  const fallenHeroes = partyPlayers.filter((player) => deadHeroIds.has(player.id))
  const partyDefeated = deathState?.campaign_status === 'party_defeated'
  const currentMembership = account.campaignMemberships?.find((membership) => membership.campaignId === state.sessionCode)
  const lifecycle = state.mechanics?.campaign_lifecycle
  const lifecycleStatus = lifecycle?.status ?? (partyDefeated ? 'failed' : 'active')
  const pacing = state.autonomy?.pacing
  const pacingLabels = { breather: 'ПЕРЕДЫШКА', development: 'РАЗВИТИЕ', escalation: 'НАРАСТАНИЕ', climax: 'КУЛЬМИНАЦИЯ' } as const
  const lastTravel = state.autonomy?.travel_history?.at(-1)
  const canManageLifecycle = isAdmin || currentMembership?.role === 'owner'
  const accessibleHeroIds = isAdmin
    ? partyPlayers.map((player) => player.id)
    : (currentMembership?.heroIds ?? account.heroIds).filter((id) => partyIdSet.has(id))
  // Управлять админ может любым героем, но «своим» считается только
  // закреплённый за аккаунтом: на этом различии держится мастер создания.
  const ownedHeroIds = (currentMembership?.heroIds ?? account.heroIds ?? []).filter((id) => partyIdSet.has(id))
  const [selectedHeroId, setSelectedHeroId] = useState(accessibleHeroIds[0])

  const changeLifecycle = async (action: 'pause' | 'resume' | 'complete' | 'archive') => {
    setLifecycleBusy(true)
    setLifecycleError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, idempotency_key: `${action}:${crypto.randomUUID()}` }),
      })
      const body = await response.json().catch(() => null) as { error?: string; version?: number; state?: GameState } | null
      if (!response.ok || !body?.state) throw new Error(body?.error || 'Не удалось изменить состояние кампании')
      await switchCampaign(state.sessionCode, { version: body.version, state: body.state })
    } catch (reason) {
      setLifecycleError(reason instanceof Error ? reason.message : 'Не удалось изменить состояние кампании')
    } finally {
      setLifecycleBusy(false)
    }
  }

  useEffect(() => { getAiHealth().then(setAiHealth).catch(() => setAiHealth(null)) }, [])
  useEffect(() => {
    const requestedRoom = new URLSearchParams(window.location.search).get('room')?.toUpperCase()
    if (!requestedRoom || isAdmin || joinAttempted.current) return
    joinAttempted.current = true
    void (async () => {
      try {
        const inviteToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('invite')
        if (!inviteToken) throw new Error('Для входа нужна действующая ссылка-приглашение')
        const response = await fetch(`/api/campaigns/${encodeURIComponent(requestedRoom)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invite_token: inviteToken }),
        })
        const body = await response.json().catch(() => null) as { error?: string; hero_ids?: string[] } | null
        if (!response.ok) throw new Error(body?.error || 'Не удалось присоединиться к кампании')
        history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(requestedRoom)}`)
        await onAccountRefresh()
        await switchCampaign(requestedRoom)
        setCampaignsOpen(false)
        if (body?.hero_ids?.[0]) setCreatingPlayerId(body.hero_ids[0])
      } catch (error) {
        setJoinError(error instanceof Error ? error.message : 'Не удалось присоединиться к кампании')
      }
    })()
  }, [isAdmin, onAccountRefresh, switchCampaign])
  useEffect(() => {
    // Мастер открывается сам только для героя, закреплённого за этим аккаунтом.
    // У администратора accessibleHeroIds — весь отряд, и прежнее условие
    // затягивало его в бесконечную цепочку чужих мест без выхода.
    const pendingHero = partyPlayers.find((hero) => ownedHeroIds.includes(hero.id) && hero.characterSetupRequired)
    if (pendingHero && creatingPlayerId == null && !heroWizardDismissed) setCreatingPlayerId(pendingHero.id)
  }, [creatingPlayerId, heroWizardDismissed, ownedHeroIds, partyPlayers])
  useEffect(() => {
    window.localStorage.setItem(UI_SCALE_KEY, String(uiScale))
    /* Масштаб живёт на корне документа, а не на `.app`: шкала кегля объявлена
       в `:root`, и подстановка `calc(13px * var(--ui-readable-scale))` считается
       там же. Пока переменную ставили на `.app`, при вычислении шкалы её ещё не
       было, и настройка не действовала ни на что. Заодно её видят экраны вне
       `.app` — вход, гибель отряда, модальные окна. */
    document.documentElement.style.setProperty('--ui-readable-scale', String(uiScale / 100))
  }, [uiScale])
  useEffect(() => { window.localStorage.setItem('skazanie-auto-attack-roll', String(autoAttackRoll)) }, [autoAttackRoll])
  useEffect(() => { window.localStorage.setItem(SCENIC_BACKDROP_KEY, String(scenicBackdrop)) }, [scenicBackdrop])
  useEffect(() => {
    const combatActive = Boolean(state.mechanics?.combat?.active)
    // Начавшийся бой закрывает и историю, и лавку: торговля посреди инициативы —
    // это окно поверх боя, за которым не видно ни карты, ни своего хода.
    if (combatActive && !combatWasActive.current) {
      setChatOpen(false)
      setMerchantOpen(false)
    }
    combatWasActive.current = combatActive
  }, [state.mechanics?.combat?.active])
  useEffect(() => {
    // Отряд сменил локацию — открытая лавка закрывается сама: на экране иначе
    // остаётся торговец, которого рядом уже нет. Сторожим именно смену места, а
    // не отсутствие торговца: окно с объяснением «здесь торговцев нет» открывать
    // можно и нужно, и захлопываться сразу же оно не должно.
    const location = state.scene.location
    if (merchantLocation.current !== location) {
      merchantLocation.current = location
      setMerchantOpen(false)
    }
  }, [state.scene.location])
  useEffect(() => {
    if (!accessibleHeroIds.includes(selectedHeroId)) setSelectedHeroId(accessibleHeroIds[0])
  }, [state.sessionCode, state.partyMemberIds?.join(',')])
  useEffect(() => {
    if (!replacementEditorId || deadHeroIds.has(replacementEditorId)) return
    setEditingPlayerId(replacementEditorId)
    setReplacementEditorId(null)
  }, [replacementEditorId, state.state_version])

  const navigate = (next: View) => {
    setView(next)
    if (window.innerWidth <= 680) setSidebarCollapsed(true)
  }
  // Лавка не меняет раздел: она ложится поверх того, что игрок и так смотрит.
  // Узкое меню при этом сворачивается — иначе на телефоне оно перекроет окно.
  const openMerchant = () => {
    setMerchantOpen(true)
    if (window.innerWidth <= 680) setSidebarCollapsed(true)
  }
  const activePlayer = partyPlayers.find((player) => player.id === selectedHeroId && accessibleHeroIds.includes(player.id)) ?? partyPlayers.find((player) => accessibleHeroIds.includes(player.id)) ?? partyPlayers[0] ?? state.players[0]
  // Без выбранной кампании игровую комнату рисовать нечем: раньше её место
  // занимал демо-мир, и новый аккаунт попадал в чужую историю. Проверка стоит
  // после всех хуков и до первого обращения к activePlayer.
  if (!state.sessionCode || !activePlayer) {
    return (
      <div className="app no-campaign">
        <main className="game-main">
          <div className="campaign-empty-screen">
            <ScrollText size={40} />
            <h1>Кампания ещё не выбрана</h1>
            <p>Создайте новый мир — рассказчик придумает его и напишет пролог — либо откройте кампанию, в которую вас пригласили.</p>
            <button className="primary" onClick={() => setCampaignsOpen(true)}><Plus size={16} />Кампании и группы</button>
            <button onClick={onLogout}>Выйти из аккаунта</button>
          </div>
          {campaignsOpen && <CampaignModal state={state} onSwitch={switchCampaign} onAccountRefresh={onAccountRefresh} onCreateHero={setCreatingPlayerId} onClose={() => setCampaignsOpen(false)} />}
        </main>
      </div>
    )
  }

  const availableMerchants = (state.merchants ?? []).filter((merchant) => merchant.available && merchantIsAtLocation(merchant, state.scene))
  const combatActive = Boolean(state.mechanics?.combat?.active && state.mechanics.combat.initiative?.length)
  const turnActorId = currentTurnActorId(state)
  const turnPlayer = partyPlayers.find((player) => player.id === turnActorId)
  const turnEnemy = state.enemies?.find((enemy) => enemy.id === turnActorId)
  const turnSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const turnActorName = turnPlayer?.character ?? turnSummon?.name ?? turnEnemy?.name ?? 'участник боя'
  const mapActorId = combatActive ? turnActorId : activePlayer.id
  const mapHero = partyPlayers.find((player) => player.id === mapActorId)
  const mapSummon = state.actors?.find((actor) => actor.id === mapActorId && actor.alive)

  const canControlHero = Boolean(mapHero && partyIdSet.has(mapActorId) && (isAdmin || accessibleHeroIds.includes(mapActorId)))
  const summonControllerIds = mapSummon ? [mapSummon.ownerId, mapSummon.controllerId] : []
  const canControlSummon = Boolean(mapSummon && mapSummon.faction === 'party' && (isAdmin || summonControllerIds.some((id) => accessibleHeroIds.includes(id))))
  const canAct = !tacticalBusy && lifecycleStatus === 'active' && !partyDefeated && !deadHeroIds.has(mapActorId) && (canControlHero || canControlSummon)
  const canFinishTurn = canAct && combatActive
  const reactionWindow = state.mechanics?.combat?.reaction_window ?? null
  const reactionActor = reactionWindow ? [...state.players, ...(state.actors ?? [])].find((actor) => actor.id === reactionWindow.actor_id) : null
  const reactionSource = reactionWindow ? [...state.players, ...(state.actors ?? []), ...(state.enemies ?? [])].find((actor) => actor.id === reactionWindow.source_actor_id) : null
  const reactionBeneficiaries = [...state.players, ...(state.actors ?? []).filter((actor) => actor.faction === 'party')]
    .filter((actor) => ('alive' in actor ? actor.alive !== false : actor.hp > 0))
    .map((actor) => ({ id: actor.id, name: 'character' in actor ? actor.character : actor.name }))
  const reactionControllerId = reactionActor && 'ownerId' in reactionActor ? String(reactionActor.ownerId ?? reactionActor.controllerId ?? '') : ''
  const reactionActorName = reactionActor && 'character' in reactionActor ? reactionActor.character : reactionActor?.name ?? 'Герой'
  const reactionSourceName = reactionSource && 'character' in reactionSource ? reactionSource.character : reactionSource?.name ?? 'Противник'
  const canAnswerReaction = Boolean(reactionWindow && lifecycleStatus === 'active' && (isAdmin || accessibleHeroIds.includes(reactionWindow.actor_id) || accessibleHeroIds.includes(reactionControllerId)))

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`} style={{
      '--ui-sidebar-width': `${Math.round(276 + Math.max(0, uiScale - 100) * .4)}px`,
      '--ui-hud-width': `${Math.round(246 + Math.max(0, uiScale - 100) * .25)}px`,
    } as React.CSSProperties}>
      <Sidebar players={partyPlayers} selectedPlayerId={activePlayer.id} turnPlayerId={turnActorId} accessibleHeroIds={accessibleHeroIds} isAdmin={isAdmin} deathSavesByHero={state.mechanics?.death?.saving_throws} onSelect={setSelectedHeroId} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(value => !value)} view={view} onNavigate={navigate} aiConnected={Boolean(aiHealth?.configured)} />
      <main className="game-main">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? 'Открыть меню' : 'Закрыть меню'} aria-expanded={!sidebarCollapsed}><Menu size={20} /></button>
          <button className="campaign-title" onClick={() => setCampaignsOpen(true)} title="Переключить кампанию или группу"><span>КАМПАНИЯ · {state.partyName}</span><strong>{state.campaign}</strong><ChevronDown size={15} /></button>
          <div className="top-actions">
            {/* Подпись в отдельном span: на узкой верхней панели её прячут, а
                сам код обязан оставаться читаемым — по нему зовут в игру. */}
            <div className="session-code" title={`Код комнаты: ${state.sessionCode}`}><i /><span>КОМНАТА</span><b>{state.sessionCode}</b></div>
            <ConnectionIndicator status={connectionState} />
            {pacing && pacing.beat > 0 && <div className={`director-status ${pacing.phase}`} title={lastTravel ? `Последний путь: ${lastTravel.from} → ${lastTravel.to}, ${lastTravel.duration_minutes} мин., риск ${lastTravel.risk_score}` : 'Серверный темп автономной кампании'}><Sparkles size={13} /><span>{pacingLabels[pacing.phase]}</span><b>{pacing.tension}</b></div>}
            {canManageLifecycle && lifecycleStatus === 'active' && <button className="invite-button" onClick={() => { void changeLifecycle('pause') }} disabled={lifecycleBusy}>Пауза</button>}
            {canManageLifecycle && lifecycleStatus === 'paused' && <button className="invite-button" onClick={() => { void changeLifecycle('resume') }} disabled={lifecycleBusy}>Продолжить</button>}
            {canManageLifecycle && ['active', 'paused'].includes(lifecycleStatus) && <button className="invite-button" onClick={() => { if (window.confirm('Завершить кампанию и создать эпилог? Это действие необратимо.')) void changeLifecycle('complete') }} disabled={lifecycleBusy}>Завершить</button>}
            {canManageLifecycle && lifecycleStatus === 'active' && <button className="invite-button" onClick={() => setInviteOpen(true)}><Users size={17} />Пригласить</button>}
            <div className="account-chip"><span>{account.name}<small>{activePlayer.character}</small></span><button onClick={onLogout} title="Выйти"><LogOut size={15} /></button></div>
          </div>
        </header>
        {view === 'room' && <div className={`game-area ${combatActive ? 'combat-active' : 'exploration-active'}`}>
          {(directorError || joinError || lifecycleError) && <div className="admin-error director-error">{directorError || joinError || lifecycleError}</div>}
          <DungeonMap
            state={state}
            players={partyPlayers}
            turnActorId={mapActorId}
            canAct={canAct}
            tacticalBusy={tacticalBusy}
            tacticalError={tacticalError}
            autoAttackRoll={autoAttackRoll}
            scenicBackdrop={scenicBackdrop}
            onClearTacticalError={clearTacticalError}
            onStartCombat={() => startCombat(activePlayer.id)}
            onMove={movePlayer}
            onAttack={attackEnemy}
            onAreaAttack={throwAreaItem}
            onCastSpell={castSpell}
            onUseCombatAction={useCombatAction}
            onChangeWeapon={changeWeapon}
            onFinishTurn={finishMapTurn}
            onFreeAction={submitAction}
            narrating={state.isNarrating}
            statusContent={<SceneHeader {...state.scene} chapter={state.adventure?.chapter ?? 1} round={combatActive ? state.mechanics?.combat?.round ?? 1 : undefined} merchants={combatActive ? [] : availableMerchants} onOpenMerchant={openMerchant} onReset={reset} />}
          >
            <ChatPanel messages={state.messages} isNarrating={state.isNarrating} pendingCheck={state.pendingCheck} interaction={state.agentInteraction} players={partyPlayers} currentPlayerId={activePlayer.id} canAct={canAct} turnName={turnActorName} combatActive={combatActive} onRoll={rollPendingCheck} onCancelCheck={cancelPendingCheck} onVote={(optionId) => voteAgentInteraction(activePlayer.id, optionId)} onAbstain={() => { void abstainAgentInteraction(activePlayer.id) }} onRollInteraction={() => { void rollAgentInteraction(activePlayer.id) }} onContinueInteraction={continueAgentInteraction} onWhy={() => { void submitAction('/why') }} open={chatOpen} onToggle={() => setChatOpen(value => !value)} />
            <div className="player-hud-stack">
              <PlayerHud player={activePlayer} hazards={((state.mechanics as { hazards?: Record<string, Array<{ id: string; label?: string; severity?: string; description?: string }>> } | undefined)?.hazards?.[activePlayer.id] ?? [])} onCharacter={() => { setEditingPlayerId(activePlayer.id) }} onInventory={() => navigate('inventory')} />
              <DiceTray key={state.sessionCode} latestRoll={state.lastDiceRoll} onRoll={() => rollFreeDie(activePlayer.id)} />
            </div>
          </DungeonMap>
        </div>}
        {view === 'world-map' && <WorldMapView state={state} busy={state.isNarrating} onTravel={(action) => { void submitAction(action); navigate('room') }} />}
        {view === 'journal' && <JournalView state={state} />}
        {view === 'characters' && <CharactersView players={partyPlayers} selectedId={activePlayer.id} turnId={turnActorId} accessibleHeroIds={accessibleHeroIds} onSelect={setSelectedHeroId} onEdit={setEditingPlayerId} />}
        {view === 'inventory' && <InventoryView
          player={activePlayer}
          party={partyPlayers}
          busy={tacticalBusy}
          error={tacticalError}
          onEquip={(itemId, equipped) => equipItem(activePlayer.id, itemId, equipped)}
          onUse={(itemId, targetId) => useItem(activePlayer.id, itemId, targetId)}
          onTransfer={(itemId, recipientId, quantity) => transferItem(activePlayer.id, itemId, recipientId, quantity)}
          onAttune={(itemId, attuned) => attuneItem(activePlayer.id, itemId, attuned)}
        />}
        {view === 'settings' && <SettingsView health={aiHealth} uiScale={uiScale} autoAttackRoll={autoAttackRoll} scenicBackdrop={scenicBackdrop} onUiScaleChange={setUiScale} onAutoAttackRollChange={setAutoAttackRoll} onScenicBackdropChange={setScenicBackdrop} />}
        {view === 'admin' && isAdmin && <AdminView account={account} state={state} onUpdateWorld={updateWorld} onAssembleEncounter={assembleEncounter} onAssembleMerchant={assembleMerchant} onMoveMerchant={moveMerchant} onSetMerchantAvailability={setMerchantAvailability} onReset={reset} />}
        {view === 'agent-lab' && isAdmin && <AgentLabView state={state} />}
      </main>
      {merchantOpen && <MerchantScreen merchants={availableMerchants} player={activePlayer} sceneLocation={state.scene.location} stateVersion={state.state_version ?? 0} view={merchantView} narration={merchantNarration} busy={merchantBusy} error={merchantError} onLoad={loadMerchant} onBargain={bargainWithMerchant} onBuy={buyFromMerchant} onSell={sellToMerchant} onAppraise={appraiseWithMerchant} onService={purchaseMerchantService} onClose={() => setMerchantOpen(false)} />}
      {inviteOpen && <InviteModal code={state.sessionCode} onClose={() => setInviteOpen(false)} />}
      {campaignsOpen && <CampaignModal state={state} onSwitch={switchCampaign} onAccountRefresh={onAccountRefresh} onCreateHero={setCreatingPlayerId} onClose={() => setCampaignsOpen(false)} />}
      {creatingPlayerId && aiHealth?.characterCreation && <CharacterCreationWizard
        player={state.players.find((player) => player.id === creatingPlayerId) ?? activePlayer}
        accountName={account.name}
        catalog={aiHealth.characterCreation}
        required={Boolean(state.players.find((player) => player.id === creatingPlayerId)?.characterSetupRequired)}
        onClose={() => { setCreatingPlayerId(null); setHeroWizardDismissed(true) }}
        onImport={(source) => importCharacter(creatingPlayerId, source)}
      />}
      {editingPlayerId && <CharacterEditor
        player={state.players.find((player) => player.id === editingPlayerId) ?? activePlayer}
        onClose={() => setEditingPlayerId(null)}
        onSave={(patch) => updatePlayer(editingPlayerId, patch)}
        onImport={(source) => importCharacter(editingPlayerId, source)}
        onLevelUp={() => {
          const player = state.players.find((candidate) => candidate.id === editingPlayerId)
          if (player) levelUpCharacter(player.id, player.level)
        }}
      />}
      {reactionWindow && canAnswerReaction && <ReactionPrompt actorName={String(reactionActorName)} sourceName={String(reactionSourceName)} window={reactionWindow} busy={tacticalBusy} beneficiaries={reactionBeneficiaries} onChoose={(actionId, beneficiaryId) => useCombatAction(reactionWindow.actor_id, actionId, reactionWindow.source_actor_id, undefined, beneficiaryId)} onDecline={() => useCombatAction(reactionWindow.actor_id, 'decline-reaction')} />}
      {!campaignsOpen && (partyDefeated || fallenHeroes.length > 0) && <DeathScreen heroes={fallenHeroes} partyDefeated={partyDefeated} busy={tacticalBusy} error={tacticalError} canResolve={(heroId) => isAdmin || accessibleHeroIds.includes(heroId)} onResolve={(heroId, resolution, replacementName) => { if (resolution === 'replace') setReplacementEditorId(heroId); resolveHeroDeath(heroId, resolution, replacementName) }} onChooseCampaign={() => setCampaignsOpen(true)} onExit={onLogout} />}
      {!campaignsOpen && ['completed', 'archived'].includes(lifecycleStatus) && <CampaignConclusionScreen status={lifecycleStatus as 'completed' | 'archived'} epilogue={lifecycle?.epilogue} busy={lifecycleBusy} canManage={canManageLifecycle} onArchive={() => { void changeLifecycle('archive') }} onChooseCampaign={() => setCampaignsOpen(true)} />}
    </div>
  )
}

function App() {
  const auth = useAuth()
  if (!auth.user) return <AuthScreen loading={auth.loading} error={auth.error} setupRequired={auth.setupRequired} onLogin={auth.login} onRegister={auth.register} onSetupAdmin={auth.setupAdmin} />
  return <GameApp account={auth.user} onAccountRefresh={auth.refresh} onLogout={auth.logout} />
}

export default App
