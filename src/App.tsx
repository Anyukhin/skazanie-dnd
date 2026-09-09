import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronRight, Copy, Crown, DoorOpen,
  Dices, Flame, Footprints, Gem, History, Menu, MessageSquare,
  PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, RotateCcw,
  ScrollText, Send, Settings, Shield, Sparkles, Swords, Target, Users, X,
  Check, Compass, SlidersHorizontal, Wifi, WifiOff,
  Heart, HeartCrack, HelpCircle,
  Lock, LockKeyhole, LockOpen, LogOut, ShieldCheck, RefreshCw,
  Bot, PawPrint, Skull, WandSparkles, Globe2, Volume2, VolumeX, Bell, BellOff, ShieldAlert,
  Sun, Cloudy, CloudRain, CloudFog, CloudLightning,
} from 'lucide-react'
import type { Account, AgentInteraction, AiHealth, BattleEvent, CampaignAiSettings, CampaignAiSettingsResponse, CampaignRecap, CampaignRecapResponse, CampaignSummary, CharacterCreationCatalog, CombatAction, CombatMechanics, CombatReactionWindow, CombatSpell, CombatVisualBatch, EncounterProposal, Enemy, GameState, MapCell, MapFeedback, Merchant, PendingCheck, Player, ReputationTier, SceneObjectIntent, SummonedCreature, TacticalProp, WeatherConditionId, WeatherProjection } from './types'
import { fetchWithTimeout, getAiHealth, getCharacterCreationCatalog } from './ai-client'
import {
  ABILITY_LABELS, DIFFICULTY_LABELS, ErrorToasts, HeroFaceInitials, PageHeader, SKILL_LABELS, UI_SCALE_MAX, UI_SCALE_MIN,
  REPUTATION_TIER_LABELS, UI_SCALE_PRESETS, battleEventText, canonicalLocationKey, clampUiScale,
  combatState, hasHeroPortrait, heroFaceMode, heroFaceStyle, locationsMatch, useDialogEscape,
} from './app-shared'
import type { BoardCombatant } from './app-shared'
import { AdminView, AgentInteractionCard, CampaignModal, ChatPanel, JournalView, SettingsView } from './AppViews'
import { DungeonMap, heroStatusFor, heroStatusSummary, type HeroStatus } from './DungeonMap'
import { useAuth } from './auth-client'
import { AuthScreen } from './AuthScreen'
import { CharacterEditor, InventoryView } from './InventoryViews'
import { CharacterCreationWizard } from './CharacterCreationWizard'
import { DiceTray } from './DiceTray'
import { DiceRollScene, type DiceRollResult } from './DiceRollScene'
import { useGameSession, type CommandOutcome, type ConnectionState, type EncounterAssemblyOptions, type ShopAssemblyOptions } from './useGameSession'
import { chronicleMatchesFilter, isChronicleNearBottom, type ChronicleFilter } from './chat-chronicle.mjs'
import { atmosphereScreenAttenuation, atmosphereScreenFor } from './atmosphere-screen.mjs'
import { createScreenMusic, type ScreenMusicPlayer } from './screen-music'
import { normalizeVoiceMode, pickNarrationVoice, shouldAutoSpeak, type NarrationVoiceMode } from './narration-tts.mjs'
import { cancelNarration, observeVoices, russianVoiceAvailable, speakNarration } from './narration-speech'
import { CELL_FEET, currentTacticalTurn, mapGridDimensions } from './tactical-engine'
import { battleRollContext, battleRollPresentation, boardPositionKey, buildMovementPaths, conditionPresentation, evaluateCombatTarget, mechanicsSupportPresentation, movementCellReason, movementCostLabel, turnClockPresentation, type MovementPath } from './tactical-ui'
import { fallbackCombatActions, fallbackCombatResources } from './combat-actions'
import { fallbackCombatSpells, fallbackSpellResources } from './combat-spells'
import { CombatLabView } from './CombatLabView'
import { MerchantScreen } from './MerchantView'
import { CombatIcon } from './CombatIcon'
import { TacticalBoard, type BoardAnimationActor, type BoardCellHint, type BoardCellNode } from './TacticalBoard'
import { drawLingeringSpellEffects, type BoardAreaEffect, type BoardEffectRenderer, type BoardOverlayCell } from './board-render'
import { areaCells } from './area-geometry'
import {
  createPersistentSpellEffectsRenderer,
  persistentSpellEffectsFromProjection,
  systemPrefersReducedMotion,
} from './spell-effects'
import { doorsReachableFrom, sceneTacticalMap } from './tactical-map-client'
import { WorldMapView } from './WorldMapView'
import { LeaveLocationPicker, SceneTransitionBanner, sceneTransitionNotice, type SceneTransitionNotice } from './SceneTransitionOverlay'
import { doorDirectionFromActor, doorOverlayCells, localizedQuestClockLabel, selectedAttackForecast, shouldAutoOpenCampaignModal } from './desktop-ui.mjs'
import { boardMapArtForTheme, resolveSceneTheme, sceneIllustrationForTheme, type SceneArt, type SceneVisualTheme } from './scene-art'
import {
  createAtmosphereAudio,
  loadAtmosphereSettings,
  normalizeAtmosphereMood,
  saveAtmosphereSettings,
  type AtmosphereAudio,
  type AtmosphereSettings,
} from './atmosphere-audio'
import {
  NEWBIE_GUIDE_DISMISSED_KEY,
  confirmedLevelUps,
  playerRoleLabel,
  merchantForSceneNpc,
  battleEventParticipantIds,
  factionDisplayName,
  latestNpcTurnEvents,
  levelUpSeenKey,
  recentDamageForTarget,
  reputationImpactForTier,
  sceneNpcsAt,
  visibleNpcStance,
  type ConfirmedLevelUp,
} from './player-experience'

// Торговли здесь нет намеренно: она открывается модальным окном поверх комнаты,
// а не отдельным разделом. Второго пути к ней быть не должно.
type View = 'room' | 'world-map' | 'journal' | 'characters' | 'inventory' | 'settings' | 'admin' | 'combat-lab'

/** Слава приходит с сервера ступенями, а не числом: показываем то же словом. */
const UI_SCALE_KEY = 'skazanie-ui-scale-v3'
const SCENIC_BACKDROP_KEY = 'skazanie-scenic-backdrop-v1'
// Свет и тени доски — настройка устройства, как и фон локации: за одним столом
// у кого-то экран поярче, у кого-то потемнее, и общий выбор навязывать нечем.
const BOARD_LIGHTING_KEY = 'skazanie-board-lighting-v1'
const COMBAT_ANIMATIONS_KEY = 'skazanie-combat-animations-v1'
// Озвучка — настройка устройства, а не кампании: за одним столом кто-то слушает,
// кто-то читает, и навязывать общий выбор нельзя.
const NARRATION_VOICE_KEY = 'skazanie-narration-voice-v1'
// Подсказки новичкам — тоже настройка устройства: опытный игрок выключает их
// себе, не забирая у соседа.
const ACTION_HINTS_KEY = 'skazanie-action-hints-v1'
const DEFAULT_DOCUMENT_TITLE = 'Сказание'
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

function currentTurnActorId(state: GameState) {
  const combat = combatState(state)
  if (!combat.active || !combat.initiative?.length) return state.activePlayerId
  return combat.initiative[Math.max(0, Number(combat.active_index) || 0)]?.actor_id ?? state.activePlayerId
}

function loadUiScale() {
  const saved = Number(window.localStorage.getItem(UI_SCALE_KEY))
  return Number.isFinite(saved) && saved >= UI_SCALE_MIN && saved <= UI_SCALE_MAX ? saved : 100
}


function loadScenicBackdrop() {
  return window.localStorage.getItem(SCENIC_BACKDROP_KEY) !== 'false'
}

/** Свет доски включён, пока его не выключили: умолчание — прежняя картинка. */
function loadBoardLighting() {
  return window.localStorage.getItem(BOARD_LIGHTING_KEY) !== 'false'
}

function Logo() {
  return <div className="logo"><div className="logo-mark"><Dices size={21} /></div><span>СКАЗАНИЕ</span></div>
}

// Ставки приходят серверными ключами: показывать игроку `athletics · medium`
// нельзя, а переводить их на сервере значит смешивать механику с подачей.
function PlayerCard({ player, selected, turn, accessible, typing, deathSaves, status, onClick }: { player: Player; selected: boolean; turn: boolean; accessible: boolean; typing: boolean; deathSaves?: { successes: number; failures: number; stable: boolean }; status?: HeroStatus; onClick: () => void }) {
  // Герой на 0 ОЗ выглядел точно как здоровый: движок помечал его `unconscious`
  // и вёл спасброски от смерти, а в списке отряда об этом не было ни слова.
  const downed = player.hp <= 0
  const dead = status?.conditions.some((condition) => condition.id === 'dead') ?? false
  const downedLabel = dead ? 'Погиб' : deathSaves?.stable ? 'Стабилизирован' : 'Без сознания'
  return (
    <button className={`player-card ${selected ? 'active' : ''} ${accessible ? '' : 'locked'} ${downed ? 'downed' : ''}`} onClick={onClick} disabled={!accessible} title={accessible ? `${player.character}: ${player.online ? 'в сети' : 'не в сети'}${typing ? ', формулирует намерение' : ''}` : `${player.character}: этот герой закреплён за другим игроком`}>
      <div className="avatar portrait-avatar" data-face={heroFaceMode(player)} style={heroFaceStyle(player, { '--avatar': player.color } as React.CSSProperties)}>
        {!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}
        <span className={`presence ${player.online ? 'online' : ''}`} aria-label={player.online ? 'В сети' : 'Не в сети'} />
      </div>
      <div className="player-meta">
        <div className="player-name-row"><strong>{player.character}</strong>{turn && <Crown size={12} />}{!accessible && <LockKeyhole size={11} />}</div>
        <span>{playerRoleLabel(player)}{typing ? ' · печатает…' : ''}</span>
        {/* Временные хиты — голубой хвост поверх полосы и «+N» в числе: они
            уходят первыми и не лечатся, поэтому цвет свой, а не продолжение
            красного. Точки под полосой — состояния и концентрация словами в
            подсказке: у соратника их достаточно заметить, решения по словам
            принимает только владелец героя в своей полоске жизни. */}
        <div className="hp-line"><i style={{ width: `${Math.max(0, player.hp) / Math.max(1, player.maxHp) * 100}%` }} />{status && status.temporaryHp > 0 && <i className="temp" style={{ left: `${Math.min(100, Math.max(0, player.hp) / Math.max(1, player.maxHp) * 100)}%`, width: `${Math.min(100, status.temporaryHp / Math.max(1, player.maxHp) * 100)}%` }} />}<small>{player.hp}/{player.maxHp}{status && status.temporaryHp > 0 && <em>+{status.temporaryHp}</em>} ОЗ</small></div>
        {status && (status.concentration || status.conditions.length > 0) && <div className="player-status-dots" title={heroStatusSummary(status)} aria-label={heroStatusSummary(status)}>
          {status.concentration && <i className="concentration" />}
          {status.conditions.map((condition) => <i key={condition.id} className={condition.status === 'marker' ? 'marker' : 'condition'} />)}
        </div>}
        {downed && <div className="downed-line" title={deathSaves ? `Спасброски от смерти: ${deathSaves.successes} успеха, ${deathSaves.failures} провала` : undefined}>
          <HeartCrack size={11} /><span>{downedLabel}</span>
          {deathSaves && !deathSaves.stable && !dead && <em>{deathSaves.successes}✓ · {deathSaves.failures}✕</em>}
        </div>}
      </div>
      {/* Щит и число — один блок. Раньше число висело абсолютом от края карточки,
          а щит стоял в колонке сетки: их центры совпадали только на одном
          сочетании шрифта и размера иконки и разъезжались при любом другом. */}
      <span className="armor-badge"><Shield className="armor-icon" size={15} /><b className="armor-value">{player.armor}</b></span>
    </button>
  )
}

type SidebarLifecycleAction = 'pause' | 'resume' | 'complete' | 'chain_arcs' | 'conclude_after_arc'
type SidebarPacing = { phase: string; label: string; tension: number; title: string }
type SidebarProgression = { milestonesSinceLevel: number; milestonesPerLevel: number; levelUpAvailable: boolean }
type SidebarReputation = { label: string; known: boolean }

function Sidebar({
  players, selectedPlayerId, turnPlayerId, accessibleHeroIds, typingActorIds, isAdmin,
  deathSavesByHero, statusByHero, onSelect, collapsed, onToggle, view, onNavigate,
  campaignName, partyName, sessionCode, connectionState, pacing, progression, reputationStanding = [],
  canManageLifecycle, lifecycleStatus, lifecycleBusy, onChangeLifecycle, inviteEnabled, onInvite,
  masterMenuOpen, masterMenuRef, campaignControlBusy, arcChainEnabled, onToggleMasterMenu,
  onRunCampaignControl, onOpenNewbieGuide, newbieGuideOpen, accountName, activeHeroName, onLogout,
  onOpenCampaigns, onOpenLevelUp,
}: {
  players: Player[]; selectedPlayerId: string; turnPlayerId: string; accessibleHeroIds: string[]; typingActorIds: string[]; isAdmin: boolean
  deathSavesByHero?: Record<string, { successes: number; failures: number; stable: boolean }>
  statusByHero?: Record<string, HeroStatus>
  onSelect: (id: string) => void; collapsed: boolean; onToggle: () => void; view: View; onNavigate: (view: View) => void
  campaignName: string; partyName: string; sessionCode: string; connectionState: ConnectionState; pacing?: SidebarPacing | null
  progression?: SidebarProgression | null; reputationStanding: SidebarReputation[]
  canManageLifecycle: boolean; lifecycleStatus: string; lifecycleBusy: boolean; onChangeLifecycle: (action: SidebarLifecycleAction) => void
  inviteEnabled: boolean; onInvite: () => void; masterMenuOpen: boolean; masterMenuRef: React.RefObject<HTMLDivElement | null>
  campaignControlBusy: boolean; arcChainEnabled: boolean; onToggleMasterMenu: () => void
  onRunCampaignControl: (action: 'rewind_turn' | 'replay_scene') => void; onOpenNewbieGuide: () => void; newbieGuideOpen: boolean
  accountName: string; activeHeroName: string; onLogout: () => void; onOpenCampaigns: () => void; onOpenLevelUp: () => void
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
      <section className="sidebar-context" aria-label="Состояние кампании">
        <button className="campaign-title sidebar-campaign" data-tooltip="Переключить кампанию" onClick={onOpenCampaigns} title="Переключить кампанию или группу">
          <Dices className="sidebar-campaign-icon" size={18} />
          <span><small>КАМПАНИЯ · {partyName}</small><strong>{campaignName}</strong></span>
          <ChevronDown size={15} />
        </button>
        <div className="sidebar-context-row">
          <div className="session-code" title={`Код комнаты: ${sessionCode}`}><i /><span>КОМНАТА</span><b>{sessionCode}</b></div>
          <ConnectionIndicator status={connectionState} />
        </div>
        {(pacing || progression || reputationStanding.length > 0) && <div className="sidebar-statuses">
          {pacing && <div className={`director-status ${pacing.phase}`} data-tooltip={pacing.label} title={pacing.title}><Sparkles size={13} /><span>{pacing.label}</span><b>{pacing.tension}</b></div>}
          {progression && progression.milestonesSinceLevel > 0 && (progression.levelUpAvailable
            ? <button className="progression-status earned" data-tooltip="Уровень готов" onClick={onOpenLevelUp} title="Отряд заслужил уровень. Откройте лист героя, чтобы выбрать умения."><Sparkles size={13} /><span>Уровень готов</span></button>
            : <div className="progression-status" data-tooltip="Вехи" title={`Вех до нового уровня: ${progression.milestonesSinceLevel} из ${progression.milestonesPerLevel}`}><Sparkles size={13} /><span>Вехи</span><b>{progression.milestonesSinceLevel}/{progression.milestonesPerLevel}</b></div>)}
          {reputationStanding.length > 0 && <div className="reputation-status" data-tooltip="Слава" title={reputationStanding.map((entry) => entry.label).join('; ')}><Shield size={13} /><span>Слава</span><b>{reputationStanding.filter((entry) => entry.known).length || '—'}</b></div>}
        </div>}
        <div className="sidebar-context-actions">
          {canManageLifecycle && lifecycleStatus === 'active' && <button className="invite-button sidebar-context-action" data-tooltip="Пауза" onClick={() => onChangeLifecycle('pause')} disabled={lifecycleBusy} title="Поставить кампанию на паузу"><Pause size={15} /><span>Пауза</span></button>}
          {canManageLifecycle && lifecycleStatus === 'paused' && <button className="invite-button sidebar-context-action" data-tooltip="Продолжить" onClick={() => onChangeLifecycle('resume')} disabled={lifecycleBusy} title="Продолжить кампанию"><Play size={15} /><span>Продолжить</span></button>}
          {inviteEnabled && <button className="invite-button sidebar-context-action" data-tooltip="Пригласить" onClick={onInvite} title="Пригласить игрока в комнату"><Users size={17} /><span>Пригласить</span></button>}
          {canManageLifecycle && ['active', 'paused'].includes(lifecycleStatus) && <div className="master-menu sidebar-master-menu" ref={masterMenuRef}>
            <button type="button" className={`invite-button master-menu-button sidebar-context-action ${masterMenuOpen ? 'open' : ''}`} data-tooltip="Мастер" aria-haspopup="menu" aria-expanded={masterMenuOpen} onClick={onToggleMasterMenu} title="Инструменты мастера"><Crown size={15} /><span>Мастер</span><ChevronDown size={14} /></button>
            {masterMenuOpen && <div className="master-menu-list" role="menu" aria-label="Инструменты мастера">
              <small>Ход</small>
              {canManageLifecycle && ['active', 'paused'].includes(lifecycleStatus) && <button type="button" role="menuitem" onClick={() => { onToggleMasterMenu(); onRunCampaignControl('rewind_turn') }} disabled={campaignControlBusy || lifecycleBusy} title="Вернуть состояние к началу последней серверной команды"><RotateCcw size={15} />Откатить ход</button>}
              {canManageLifecycle && ['active', 'paused'].includes(lifecycleStatus) && <button type="button" role="menuitem" onClick={() => { onToggleMasterMenu(); onRunCampaignControl('replay_scene') }} disabled={campaignControlBusy || lifecycleBusy} title="Вернуть состояние к началу текущей сцены"><History size={15} />Переиграть сцену</button>}
              <small>Кампания</small>
              {arcChainEnabled
                ? <button type="button" role="menuitem" onClick={() => { onToggleMasterMenu(); onChangeLifecycle('conclude_after_arc') }} disabled={lifecycleBusy} title="Развязка текущей арки закончит кампанию эпилогом">Закончить на этой арке</button>
                : <button type="button" role="menuitem" onClick={() => { onToggleMasterMenu(); onChangeLifecycle('chain_arcs') }} disabled={lifecycleBusy} title="Развязка арки откроет следующую теми же героями: снаряжение, слава и незакрытые нити переезжают">Играть дальше арками</button>}
              <button type="button" role="menuitem" className="danger" onClick={() => { onToggleMasterMenu(); if (window.confirm('Завершить кампанию и создать эпилог? Это действие необратимо.')) onChangeLifecycle('complete') }} disabled={lifecycleBusy}>Завершить кампанию</button>
            </div>}
          </div>}
          <button className="newbie-guide-button sidebar-context-action" data-tooltip="Шпаргалка новичка" onClick={onOpenNewbieGuide} aria-label="Открыть шпаргалку новичка" aria-pressed={newbieGuideOpen} title="Шпаргалка новичка"><HelpCircle size={17} /></button>
          <div className="account-chip sidebar-account"><span>{accountName}<small>{activeHeroName}</small></span><button onClick={onLogout} title="Выйти" aria-label="Выйти из аккаунта"><LogOut size={15} /></button></div>
        </div>
      </section>
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
        {isAdmin && <button className={`nav-item ${view === 'combat-lab' ? 'active' : ''}`} data-tooltip="Боевой стенд" aria-label="Открыть боевой стенд" onClick={() => onNavigate('combat-lab')}><Swords size={18} /><span>Боевой стенд</span></button>}
      </nav>
      <div className="sidebar-section">
        <div className="section-label"><span>ОТРЯД · {players.filter(p => p.online).length} В СЕТИ{players.some((p) => p.hp <= 0) ? ` · ${players.filter((p) => p.hp <= 0).length} ПАЛИ` : ''}</span></div>
        <div className="players-list">
          {players.map((player) => <PlayerCard key={player.id} player={player} selected={player.id === selectedPlayerId} turn={player.id === turnPlayerId} accessible={accessibleHeroIds.includes(player.id)} typing={typingActorIds.includes(player.id)} deathSaves={deathSavesByHero?.[player.id]} status={statusByHero?.[player.id]} onClick={() => onSelect(player.id)} />)}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} data-tooltip="Настройки" aria-label="Настройки" onClick={() => onNavigate('settings')}><Settings size={18} /><span>Настройки</span></button>
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

const recapDismissedKey = (sessionCode: string) => `skazanie-recap-dismissed-v1:${sessionCode.toUpperCase()}`

function PreviouslyOnCard({ recap, onDismiss }: { recap: CampaignRecap; onDismiss: () => void }) {
  // Карточка не блокирующая и не модальная: доска под ней остаётся рабочей,
  // а прочитавший закрывает её крестиком.
  return <aside className="previously-on" role="note" aria-labelledby="previously-on-title">
    <header>
      <ScrollText size={19} />
      <span><small>ПОСЛЕ ПЕРЕРЫВА</small><strong id="previously-on-title">В прошлой серии…</strong></span>
      <button type="button" onClick={onDismiss} aria-label="Закрыть напоминание"><X size={16} /></button>
    </header>
    <p>{recap.text}</p>
  </aside>
}

function NewbieGuide({ onDismiss }: { onDismiss: () => void }) {
  // Панель висит поверх карты и перехватывает клики по клеткам под собой:
  // игрок целится в клетку, попадает в шпаргалку — и герой «не реагирует».
  // Поэтому любой клик по панели закрывает её: прочитал — кликнул — играешь.
  useDialogEscape(onDismiss)
  return <aside className="newbie-guide" role="dialog" aria-modal="false" aria-labelledby="newbie-guide-title" onClick={onDismiss}>
    <header>
      <HelpCircle size={21} />
      <span><small>ПЕРВЫЕ ШАГИ</small><strong id="newbie-guide-title">Можно говорить обычными фразами</strong></span>
      <button type="button" onClick={onDismiss} aria-label="Закрыть шпаргалку"><X size={16} /></button>
    </header>
    <ul>
      <li>«Осматриваю алтарь и ищу следы»</li>
      <li>«Спрашиваю стражника о закрытых воротах»</li>
      <li>«Передаю зелье раненому союзнику»</li>
      <li>«Прячусь за телегой и стреляю»</li>
    </ul>
    <p><Target size={15} /><span><b>Кликайте по клеткам, фишкам и предметам:</b> карта покажет доступное действие и цель до отправки.</span></p>
    <footer><button type="button" onClick={onDismiss}>Понятно</button></footer>
  </aside>
}

function CampaignPausedNotice({ canManage, busy, onResume }: { canManage: boolean; busy: boolean; onResume: () => void }) {
  return <section className="campaign-paused-notice" role="status" aria-live="polite">
    <LockKeyhole size={24} />
    <span>
      <small>КАМПАНИЯ НА ПАУЗЕ</small>
      <strong>Игровые действия временно остановлены</strong>
      <p>{canManage ? 'Вы можете продолжить кампанию тем же серверным управлением жизненным циклом.' : 'Продолжить игру может владелец кампании.'}</p>
    </span>
    {canManage && <button type="button" disabled={busy} onClick={onResume}><LockOpen size={15} />Продолжить</button>}
  </section>
}

function LevelUpScreen({ levelUp, canOpenSheet, onOpenSheet, onClose }: {
  levelUp: ConfirmedLevelUp
  canOpenSheet: boolean
  onOpenSheet: () => void
  onClose: () => void
}) {
  return <div className="level-up-backdrop" role="dialog" aria-modal="true" aria-labelledby="level-up-title">
    <section className="level-up-screen">
      <div className="level-up-rays" aria-hidden="true" />
      <Crown size={52} aria-hidden="true" />
      <small>Подтверждено сервером</small>
      <h1 id="level-up-title">Новый уровень!</h1>
      <p><strong>{levelUp.character}</strong> теперь {levelUp.level}-го уровня.</p>
      <div>
        {canOpenSheet && <button type="button" onClick={onOpenSheet}><Sparkles size={16} />Открыть лист героя</button>}
        <button type="button" className="quiet" onClick={onClose}>{canOpenSheet ? 'Позже' : 'Продолжить'}</button>
      </div>
    </section>
  </div>
}

/**
 * Иконка неба по погоде. Таблица здесь единственная и только про картинку:
 * подписи, строку индикатора и список помех считает сервер
 * (`server/weather.mjs`), клиент их не выводит.
 */
const WEATHER_ICONS: Record<WeatherConditionId, typeof Sun> = {
  clear: Sun,
  overcast: Cloudy,
  rain: CloudRain,
  fog: CloudFog,
  storm: CloudLightning,
}

function SceneWeather({ weather }: { weather?: WeatherProjection }) {
  if (!weather?.indicator) return null
  const Icon = WEATHER_ICONS[weather.weather] ?? Cloudy
  // Подсказка объясняет не «что на небе» — это и так написано, — а чем оно
  // сейчас мешает или помогает. Под крышей строка честно говорит, что не мешает
  // ничем: игрок не должен гадать, действует ли дождь в трактире.
  const lines = [
    `День ${weather.day}, ${weather.clock}`,
    weather.weather_summary,
    weather.indoors ? 'Герой под крышей: погода на броски не влияет.' : '',
    ...weather.effects,
  ].filter(Boolean)
  return (
    <div
      className={`scene-weather phase-${weather.phase} sky-${weather.weather}`}
      role="note"
      // Тот же текст, что в подсказке: помехи от неба игрок обязан узнать и
      // без мыши, а не только наведением.
      aria-label={[`Время и погода: ${weather.indicator}`, ...lines].join('. ')}
      title={lines.join('\n')}
    >
      <Icon size={13} />
      <span>{weather.indicator}</span>
      {weather.effects.length > 0 && <b aria-hidden="true">!</b>}
    </div>
  )
}

function SceneHeader({ title, location, objective, turn, chapter, illustration, illustrationKey, locationArtUrl, scenicBackdrop, wantedSigns, weather }: {
  title: string
  location: string
  objective: string
  turn: number
  chapter: number
  illustration: SceneArt
  illustrationKey: string
  /**
   * Иллюстрация текущей локации, подготовленная заранее. Пустая строка —
   * локации без id: спрашивать сервер не о чем.
   */
  locationArtUrl: string
  scenicBackdrop: boolean
  /**
   * Приметы розыска: что мир показывает отряду вместо цифры. Строки приходят
   * готовыми из проекции (`server/law-and-order.mjs`) и растут со ступенью —
   * своей таблицы у клиента нет, потому что самой ступени он не знает.
   */
  wantedSigns: string[]
  /**
   * Небо над отрядом. Строка «Вечер · Дождь», подписи помех и признак «под
   * крышей» приходят готовыми из проекции (`server/weather.mjs`).
   */
  weather?: WeatherProjection
}) {
  const [objectiveExpanded, setObjectiveExpanded] = useState(false)
  // Готовой картинки у локации может и не быть — это норма, а не ошибка.
  // Поэтому изображение грузится незаметно и проявляется только после
  // `onLoad`: пока его нет, шапка выглядит ровно как раньше.
  const [locationArtReady, setLocationArtReady] = useState(false)
  useEffect(() => { setLocationArtReady(false) }, [locationArtUrl])
  const objectiveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!objectiveExpanded) return
    const closeOutside = (event: PointerEvent) => {
      if (!objectiveRef.current?.contains(event.target as Node)) setObjectiveExpanded(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [objectiveExpanded])
  return (
    <div className={`scene-header ${scenicBackdrop ? 'has-illustration' : ''}`}>
      {scenicBackdrop && <span key={`${illustrationKey}:${illustration.id}`} className="scene-illustration" aria-hidden="true">
        <img src={illustration.url} alt="" decoding="async" />
        {/* Иллюстрация самого места ложится поверх библиотечной подложки в тот
            же кадр: рамка и затемнение у них общие — шапка остаётся одной
            карточкой, а не обрастает вторым блоком. */}
        {locationArtUrl && <img
          className={`scene-location-art ${locationArtReady ? 'ready' : ''}`}
          src={locationArtUrl}
          alt=""
          decoding="async"
          onLoad={() => setLocationArtReady(true)}
          onError={() => setLocationArtReady(false)}
        />}
      </span>}
      {/* Подписи у иллюстрации нет: она печатала ровно то же `location`, что
          строкой ниже стоит в `.scene-title`. Скринридер читал название места
          дважды подряд, а глазами оно и так видно рядом — вторая копия ничего
          не добавляла ни тем, ни другим. */}
      {/* `turn` — номер сцены, а не ход отряда: он растёт только при переходе
          Директора. Подпись «ХОД» читалась как замерший счётчик действий. */}
      <div className="scene-title"><span>Глава {chapter} · сцена {turn}</span><h1>{title}</h1><p><Target size={13} />{location}</p></div>
      {/* Время суток и погода стоят рядом с названием места: это часть ответа
          на вопрос «где мы», а не отдельная панель. */}
      <SceneWeather weather={weather} />
      {/* Цель не помещается в строку заголовка и обрезается многоточием, а
          читать её игроку надо: замерено — из 571 px текста видно 311. Полная
          формулировка уходит в подсказку, иначе цель просто теряется. */}
      <button ref={objectiveRef} type="button" className={`objective ${objectiveExpanded ? 'expanded' : ''}`} title={objective} aria-expanded={objectiveExpanded} onClick={() => setObjectiveExpanded((value) => !value)}><small>ТЕКУЩАЯ ЦЕЛЬ</small><strong>{objective}</strong></button>
      {/* Розыск игрок видит миром, а не индикатором: в шапке стоит одна примета,
          остальные — в подсказке. Цифры ступени в проекции нет, и выводить её
          из числа строк клиенту нечем и незачем. */}
      {wantedSigns.length > 0 && <div className="scene-wanted" role="note" aria-label="Приметы розыска" title={wantedSigns.join('\n')}><ShieldAlert size={13} /><span>{wantedSigns[0]}</span></div>}
    </div>
  )
}

function ProposalQuestion({ busy, answer, onAsk }: { busy: boolean; answer: string; onAsk: (text: string) => Promise<CommandOutcome> }) {
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  return <form className="proposal-dialogue" onSubmit={async (event) => {
    event.preventDefault()
    if (busy || !question.trim()) return
    setError('')
    const outcome = await onAsk(question.trim())
    if (outcome.ok) setQuestion('')
    else setError(outcome.error)
  }}>
    <label>Уточнить перед действием<input value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy} placeholder="Например: что произойдёт при неудаче?" /></label>
    <button type="submit" disabled={busy || !question.trim()}>Спросить ведущего</button>
    {(error || answer) && <p role="status">{error || answer}</p>}
  </form>
}

function DiceCheckCard({ check, onRoll, onCancel, busy = false, children }: { check: PendingCheck; onRoll: () => void; onCancel: () => void; busy?: boolean; children?: React.ReactNode }) {
  const rolling = check.status === 'rolling'
  const resolving = check.status === 'resolving'
  // До ответа сервера карточка не показывает выдуманное число: результат
  // принадлежит только `check.result`, а промежуточное вращение живёт в сцене.
  const shownValue = check.result?.value ?? '?'
  const swing = check.advantage && !check.disadvantage ? 'преимущество' : check.disadvantage && !check.advantage ? 'помеха' : null
  return (
    <div className={`dice-check ${check.proposal ? 'has-proposal' : ''} ${rolling ? 'rolling' : ''} ${resolving ? 'resolving' : ''}`}>
      <div className="dice-copy">
        <span>{check.proposal ? 'Предложение ведущего · временное правило' : 'Требуется проверка'}</span>
        <strong>{check.label}</strong>
        <small>Сложность {check.difficulty} · модификатор {check.modifier >= 0 ? '+' : ''}{check.modifier}{swing ? ` · ${swing}` : ''}</small>
      </div>
      {check.proposal && <div className="improvisation-proposal">
        <strong>{check.proposal.summary}</strong>
        {check.proposal.approach !== check.proposal.summary && <p>{check.proposal.approach}</p>}
        <dl><div><dt>Цена</dt><dd>{check.proposal.cost}</dd></div>
          <div><dt>Успех</dt><dd>{check.proposal.on_success}</dd></div>
          <div><dt>Провал</dt><dd>{check.proposal.on_failure}</dd></div></dl>
      </div>}
      <button className="d20-button" onClick={onRoll} disabled={busy || check.status !== 'ready'} aria-label={`${check.result ? 'Повторить отправку результата' : check.proposal ? 'Подтвердить и бросить d20' : 'Бросить d20'}: ${check.label}`}>
        <i><b>{shownValue}</b><small>d20</small></i>
        <span>{rolling ? 'Кость катится…' : resolving ? `${check.result?.value} ${check.modifier >= 0 ? '+' : '−'} ${Math.abs(check.modifier)} = ${check.result?.total}` : check.result ? 'Повторить отправку результата' : check.proposal ? 'Подтвердить и бросить' : 'Бросить кубик'}</span>
      </button>
      <p>{resolving ? 'Рассказчик учитывает результат и продолжает сцену…' : check.proposal ? 'До подтверждения ход и ресурсы не расходуются. Можно отказаться и описать другой способ.' : 'Нажми на кость — что выпадет, то и будет.'}</p>
      <div className="dice-check__footer">
        {children}
        <button className="cancel-check cancel-check--dismiss" onClick={onCancel} disabled={busy || check.status === 'rolling' || (Boolean(check.proposal) && check.status === 'resolving')}>{check.result ? 'Закрыть проверку' : 'Отказаться от действия'}</button>
      </div>
    </div>
  )
}

/**
 * Полоска героя у нижней панели действий: портрет, ОЗ, КД, скорость и две
 * кнопки-иконки. Счётчики действия, бонусного действия, реакции и ячеек
 * заклинаний живут рядом в `DungeonMap` и читают ту же серверную проекцию.
 */
function PlayerHud({ player, hazards = [], combatActive = false, status, onCharacter, onInventory }: { player: Player; hazards?: Array<{ id: string; label?: string; severity?: string; description?: string }>; combatActive?: boolean; status?: HeroStatus; onCharacter: () => void; onInventory: () => void }) {
  const hazardLabel = hazards.map((hazard) => hazard.label || hazard.id).join(', ')
  const hp = Math.max(0, Number(player.hp) || 0)
  const maxHp = Math.max(1, Number(player.maxHp) || 1)
  const hpRatio = Math.max(0, Math.min(1, hp / maxHp))
  return (
    <aside className="player-hud" aria-label={`${player.character}: здоровье ${hp} из ${maxHp}, класс доспеха ${player.armor}, скорость ${player.speed} футов`}>
      <div className="hud-identity">
        <span className="hud-portrait" data-face={heroFaceMode(player)} style={heroFaceStyle(player)}>{!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}</span>
        <span><strong>{player.character}</strong><small>{playerRoleLabel(player)}</small></span>
      </div>
      <div className="hud-health" title={`Здоровье: ${hp} из ${maxHp}${status && status.temporaryHp > 0 ? ` · временные хиты ${status.temporaryHp}` : ''}`}>
        <div className="hud-health-label"><Heart size={14} /><b>{hp}/{maxHp}</b>{status && status.temporaryHp > 0 && <em className="hud-temp">+{status.temporaryHp}</em>}</div>
        <span className="hud-health-bar" aria-hidden="true"><i style={{ width: `${Math.round(hpRatio * 100)}%` }} /></span>
      </div>
      <div className="hud-vitals">
        <span title="Класс доспеха (КД)" aria-label={`Класс доспеха ${player.armor}`}><Shield size={14} /><b>{player.armor}</b></span>
        {!combatActive && <span title="Скорость" aria-label={`Скорость ${player.speed} футов`}><Footprints size={14} /><b>{player.speed}</b><small>фт</small></span>}
        {hazards.length > 0 && <em className="hud-hazard" title={`Активная опасность: ${hazardLabel}`}><Flame size={13} />{hazardLabel}</em>}
      </div>
      <div className="hud-actions">
        <button onClick={onCharacter} title="Лист героя" aria-label="Лист героя"><BookOpen size={15} /></button>
        <button onClick={onInventory} title={`Инвентарь · ${player.inventory.length}`} aria-label={`Инвентарь, предметов: ${player.inventory.length}`}><BackpackIcon /><b>{player.inventory.length}</b></button>
      </div>
      {/* Вторая строка — словами, потому что по ним принимают решения: держать
          ли концентрацию под ударом, чем лечить отравление. Рисуется только
          когда есть что сказать; пустой строки у здорового героя нет. */}
      {status && (status.concentration || status.conditions.length > 0) && <div className="hud-status" role="group" aria-label="Состояния героя">
        {status.concentration && <span className="hud-chip concentration" title={`Концентрация: ${status.concentration}. Урон требует спасброска Телосложения, иначе заклинание спадёт`}><b>К</b>{status.concentration}</span>}
        {status.conditions.map((condition) => <span key={condition.id} className={`hud-chip ${condition.status}`} title={`${condition.statusLabel}. ${condition.explanation}${condition.duration ? ` Длительность: ${condition.duration}` : ''}`}>{condition.label}{condition.duration && <small>· {condition.duration}</small>}</span>)}
      </div>}
    </aside>
  )
}

function InviteModal({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useDialogEscape(onClose)
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

function CharactersView({ players, selectedId, turnId, combatActive, accessibleHeroIds, onSelect, onEdit }: { players: Player[]; selectedId: string; turnId: string; combatActive: boolean; accessibleHeroIds: string[]; onSelect: (id: string) => void; onEdit: (id: string) => void }) {
  const active = players.find((player) => player.id === selectedId) ?? players[0]
  const canEdit = accessibleHeroIds.includes(active.id)
  return (
    <section className="section-page characters-page">
      <PageHeader eyebrow="ВАШ ОТРЯД" title="Персонажи" description="Герои кампании, их состояние и положение в текущей сцене." />
      <div className="character-actions-bar"><span>Выбран: <b>{active.character}</b></span><button disabled={!canEdit} onClick={() => onEdit(active.id)}>{canEdit ? <PencilIcon /> : <LockKeyhole size={14} />}{canEdit ? active.characterSetupRequired ? 'Продолжить создание героя' : 'Открыть и редактировать лист' : 'Нет доступа к герою'}</button></div>
      <div className={`character-grid ${players.length === 1 ? 'single-hero' : ''}`}>
        {players.map((player) => (
          <button key={player.id} disabled={!accessibleHeroIds.includes(player.id)} className={`character-sheet ${selectedId === player.id ? 'active' : ''} ${accessibleHeroIds.includes(player.id) ? '' : 'locked'}`} onClick={() => onSelect(player.id)}>
            <div className="character-art" data-face={heroFaceMode(player)} style={heroFaceStyle(player)}>{!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}<div className="character-statuses"><span className={player.online ? 'online' : ''}>{player.online ? 'В сети' : 'Не в сети'}</span>{combatActive && turnId === player.id && <em><Crown size={13} />Сейчас ходит</em>}</div></div>
            <div className="character-info"><small>{player.name} играет за</small><h2>{player.character}</h2><p>{playerRoleLabel(player)}</p>
              <div className="character-stats"><span><b>{player.hp}</b> / {player.maxHp}<small>Здоровье</small></span><span><b>{player.armor}</b><small>Класс доспеха</small></span><span><b>{player.speed} фт</b><small>Скорость</small></span></div>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function PencilIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="m15 5 4 4L8 20H4v-4L15 5Z"/><path d="m13 7 4 4"/></svg> }

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
    <header><div><RefreshCw size={21} /><span><small>{failedSave ? 'ПРОВАЛЕННЫЙ СПАСБРОСОК' : 'ПРЕРЫВАЮЩАЯ РЕАКЦИЯ'}</small><strong>{failedSave ? `${actorName}, использовать особенность?` : `${actorName}, реагировать?`}</strong></span></div><em>{failedSave ? 'Спасбросок' : spellCast ? 'Заклинание' : opportunity ? 'Движение' : hit ? 'Попадание' : 'Промах'}</em></header>
    <p>{failedSave ? failedSaveText : spellCast ? `${sourceName} начинает накладывать «${window.pending_spell?.name ?? 'заклинание'}»${window.pending_spell?.slot_level ? ` ячейкой ${window.pending_spell.slot_level} уровня` : ''}.` : opportunity ? `${sourceName} покидает досягаемость героя.` : hit ? `${sourceName} попадает по герою${window.damage?.applied_amount ? ` и наносит ${window.damage.applied_amount} урона` : ''}.` : `${sourceName} промахивается в ближнем бою.`} {failedSave ? 'Выберите «Несгибаемый» или оставьте исходный провал.' : 'Выберите одну доступную реакцию или продолжите бой без неё.'}</p>
    {needsBeneficiary && <label className="reaction-beneficiary"><span>Преимущество получит</span><select value={beneficiaryId} disabled={busy} onChange={(event) => setBeneficiaryId(event.target.value)}>{beneficiaries.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.name}</option>)}</select></label>}
    <div className="reaction-options">{window.action_options.map((option) => <button key={option.id} disabled={busy || (option.requires_beneficiary && !beneficiaryId)} onClick={() => onChoose(option.id, option.requires_beneficiary ? beneficiaryId : undefined)}><i><CombatIcon id={option.id} kind={option.id.startsWith('cast:') ? 'spell' : 'reaction'} hint={`${option.name} ${option.description}`} size={35} /></i><span><strong>{option.name}</strong><small>{option.description}</small></span>{option.resource && <em>{option.cost ?? 1}</em>}</button>)}</div>
    <footer><button disabled={busy} onClick={onDecline}>{busy ? 'Применяем…' : failedSave ? 'Оставить провал' : 'Не реагировать'}</button><span>{failedSave ? 'Несгибаемый не расходует реакцию и восстанавливается после продолжительного отдыха.' : 'Реакция восстановится в начале следующего хода героя.'}</span></footer>
  </section></div>
}

function DeathScreen({ heroes, partyDefeated, busy, error, canResolve, onResolve, onContinueToEpilogue }: {
  heroes: Player[]
  partyDefeated: boolean
  busy: boolean
  error: string | null
  canResolve: (heroId: string) => boolean
  onResolve: (heroId: string, resolution: 'resurrect' | 'replace', replacementName?: string) => void
  onContinueToEpilogue: () => void
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
          <div className="fallen-hero-portrait" data-face={heroFaceMode(hero)} style={heroFaceStyle(hero)}>{!hasHeroPortrait(hero) && <HeroFaceInitials hero={hero} />}<Skull size={22} /></div>
          <div className="fallen-hero-name"><small>ПОГИБШИЙ ГЕРОЙ</small><strong>{hero.character}</strong><span>{playerRoleLabel(hero)}</span></div>
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
      {partyDefeated && <footer><div><button onClick={onContinueToEpilogue}><BookOpen size={16} />К эпилогу</button></div><small>Сначала зафиксирована судьба героев; дальше — итог всей истории.</small></footer>}
    </section>
  </div>
}

function CampaignConclusionScreen({ status, epilogue, busy, canManage, onArchive, onChooseCampaign }: {
  status: 'completed' | 'failed' | 'archived'
  epilogue?: string | null
  busy: boolean
  canManage: boolean
  onArchive: () => void
  onChooseCampaign: () => void
}) {
  const failed = status === 'failed'
  return <div className="death-screen-backdrop">
    <section className="death-screen" role="dialog" aria-modal="true" aria-label="Кампания завершена">
      <span className="death-eyebrow">{status === 'archived' ? 'АРХИВ КАМПАНИИ' : failed ? 'ПОРАЖЕНИЕ' : 'ЭПИЛОГ'}</span>
      <h1>{failed ? 'История завершилась поражением' : 'История завершена'}</h1>
      <p>{epilogue || (failed
        ? 'Отряд пал, но его решения и последствия сохранены в летописи кампании.'
        : 'Приключение завершилось, а его события сохранены в летописи кампании.')}</p>
      <footer>
        <div>
          <button onClick={onChooseCampaign}><BookOpen size={16} />Другие кампании</button>
          {status !== 'archived' && canManage && <button onClick={onArchive} disabled={busy}>Архивировать</button>}
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

type PendingCheckDiceScene = {
  key: string
  label: string
  rolling: boolean
  value: number
  actualResult: DiceRollResult | null
}

function pendingCheckKey(check: Pick<PendingCheck, 'check_id' | 'playerId' | 'action'>) {
  return check.check_id ?? `${check.playerId}:${check.action}`
}

function GameApp({ account, onAccountRefresh, onLogout }: { account: Account; onAccountRefresh: () => Promise<Account | null>; onLogout: () => void }) {
  const gameSession = useGameSession()
  const { confirmPendingAction, cancelPendingAction } = gameSession
  const { state, combatVisualBatch, connectionState, tacticalBusy, tacticalError, merchantBusy, merchantError, directorError, merchantView, merchantNarration, clearTacticalError, submitAction, rollPendingCheck, cancelPendingCheck, rollFreeDie, voteAgentInteraction, abstainAgentInteraction, rollAgentInteraction, continueAgentInteraction, startCombat, attackNpc, startRest, spendHitPointDie, completeRest, movePlayer, attackEnemy, throwAreaItem, castSpell, useCombatAction, changeWeapon, operateDoor, operateSceneObject, captiveAction, lootContainer, beastAction, resolveGuardEncounter, proposeParley, settleParley, openTavernDiceRound, answerTavernDiceRound, leaveTavernDiceRound, orderTavernDrink, sendLetter, receiveNpcBlessing, useLevelTransition, finishMapTurn, resolveHeroDeath, equipItem, useItem, transferItem, attuneItem, activateItem, importCharacter, levelUpCharacter, switchCampaign, loadMerchant, bargainWithMerchant, buyFromMerchant, sellToMerchant, appraiseWithMerchant, purchaseMerchantService, assembleMerchant, assembleEncounter, moveMerchant, setMerchantAvailability, updatePlayer, updateWorld } = gameSession
  const [checkDiceScene, setCheckDiceScene] = useState<PendingCheckDiceScene | null>(null)
  const checkDiceSceneRef = useRef<PendingCheckDiceScene | null>(null)
  const checkDiceTimerRef = useRef<number | null>(null)
  const checkRollInFlightRef = useRef<string | null>(null)
  const [checkRollBusy, setCheckRollBusy] = useState(false)
  const reducedMotion = systemPrefersReducedMotion()
  const clearCheckDiceTimer = useCallback(() => {
    if (checkDiceTimerRef.current !== null) window.clearTimeout(checkDiceTimerRef.current)
    checkDiceTimerRef.current = null
  }, [])
  useEffect(() => () => clearCheckDiceTimer(), [clearCheckDiceTimer])
  const closeCheckDiceScene = useCallback(() => {
    clearCheckDiceTimer()
    checkDiceSceneRef.current = null
    setCheckDiceScene(null)
  }, [clearCheckDiceTimer])
  const startPendingCheckRoll = useCallback((check: PendingCheck) => {
    if (check.status !== 'ready') return
    const key = pendingCheckKey(check)
    if (checkRollInFlightRef.current) return
    clearCheckDiceTimer()
    const actualResult = check.result
      ? { value: check.result.value, modifier: check.result.modifier, total: check.result.total }
      : null
    const scene: PendingCheckDiceScene = {
      key,
      label: check.label,
      rolling: !actualResult,
      value: actualResult?.value ?? check.sides,
      actualResult,
    }
    checkRollInFlightRef.current = key
    checkDiceSceneRef.current = scene
    setCheckDiceScene(scene)
    setCheckRollBusy(true)
    void rollPendingCheck().catch(() => undefined).finally(() => {
      if (checkRollInFlightRef.current !== key) return
      checkRollInFlightRef.current = null
      setCheckRollBusy(false)
    })
  }, [clearCheckDiceTimer, rollPendingCheck])
  useEffect(() => {
    const scene = checkDiceSceneRef.current
    if (!scene) return
    const pending = state.pendingCheck
    if (pending && pendingCheckKey(pending) === scene.key) {
      if (pending.result) {
        const actualResult: DiceRollResult = {
          value: pending.result.value,
          modifier: pending.result.modifier,
          total: pending.result.total,
        }
        if (scene.rolling || scene.actualResult?.value !== actualResult.value || scene.actualResult.total !== actualResult.total) {
          const next = { ...scene, rolling: false, value: actualResult.value, actualResult }
          checkDiceSceneRef.current = next
          setCheckDiceScene(next)
        }
      } else if (pending.status === 'ready' && !checkRollInFlightRef.current && !checkRollBusy) {
        closeCheckDiceScene()
      }
      return
    }
    if (pending) {
      closeCheckDiceScene()
      return
    }
    if (!scene.actualResult) {
      closeCheckDiceScene()
      return
    }
    if (checkDiceTimerRef.current === null) {
      checkDiceTimerRef.current = window.setTimeout(closeCheckDiceScene, 3_200)
    }
  }, [checkRollBusy, closeCheckDiceScene, state.pendingCheck])
  useEffect(() => {
    const pending = state.pendingCheck
    if (!checkRollBusy && checkDiceSceneRef.current?.rolling && (!pending || (pending.status === 'ready' && !pending.result))) closeCheckDiceScene()
  }, [checkRollBusy, closeCheckDiceScene, state.pendingCheck])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 920)
  const [inviteOpen, setInviteOpen] = useState(false)
  // Меню «Мастер» в шапке: закрывается Escape, кликом мимо и после любого выбора.
  const [masterMenuOpen, setMasterMenuOpen] = useState(false)
  const masterMenuRef = useRef<HTMLDivElement>(null)
  useDialogEscape(() => setMasterMenuOpen(false), masterMenuOpen)
  useEffect(() => {
    if (!masterMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (masterMenuRef.current && event.target instanceof Node && !masterMenuRef.current.contains(event.target)) setMasterMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [masterMenuOpen])
  const [merchantSelection, setMerchantSelection] = useState<{ id: string; context: string } | null>(null)
  const requestedRoomAtEntry = useRef(new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '')
  const [campaignsOpen, setCampaignsOpen] = useState(() => new URLSearchParams(window.location.search).get('combatLab') !== '1' && shouldAutoOpenCampaignModal({
    heroCount: account.heroIds.length,
    membershipCount: account.campaignMemberships?.length ?? 0,
    requestedRoom: requestedRoomAtEntry.current,
  }))
  const [joinError, setJoinError] = useState<string | null>(null)
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('combatLab') === '1' ? 'combat-lab' : 'room')
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  const [characterCreationCatalog, setCharacterCreationCatalog] = useState<CharacterCreationCatalog | null>(null)
  const [characterCreationError, setCharacterCreationError] = useState('')
  const [campaignAi, setCampaignAi] = useState<CampaignAiSettingsResponse | null>(null)
  const [campaignAiBusy, setCampaignAiBusy] = useState(false)
  const [campaignAiError, setCampaignAiError] = useState('')
  const [campaignRecap, setCampaignRecap] = useState<CampaignRecap | null>(null)
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [editorInitialTab, setEditorInitialTab] = useState<'sheet' | 'story' | 'advancement'>('sheet')
  const [editorRequestLevelUp, setEditorRequestLevelUp] = useState(false)
  const [creatingPlayerId, setCreatingPlayerId] = useState<string | null>(null)
  // Закрытый мастер не должен открываться заново на том же экране: иначе
  // «Закрыть» ничего не значит, а Escape выглядит сломанным.
  const [heroWizardDismissed, setHeroWizardDismissed] = useState(false)
  const [replacementEditorId, setReplacementEditorId] = useState<string | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [campaignControlBusy, setCampaignControlBusy] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [reviewedPartyDefeat, setReviewedPartyDefeat] = useState<string | null>(null)
  const [newbieGuideOpen, setNewbieGuideOpen] = useState(() => (
    window.localStorage.getItem(NEWBIE_GUIDE_DISMISSED_KEY) !== 'true'
  ))
  const [levelUpCelebration, setLevelUpCelebration] = useState<ConfirmedLevelUp | null>(null)
  // Смена сцены объявляется плашкой: сервер менял карту молча, и игрок, нажав
  // «покинуть локацию», не понимал, что уже стоит в другом месте.
  const [sceneNotice, setSceneNotice] = useState<SceneTransitionNotice | null>(null)
  const previousSceneState = useRef<GameState | null>(null)
  const [leavePickerOpen, setLeavePickerOpen] = useState(false)
  const levelUpCursor = useRef({
    sessionCode: state.sessionCode,
    ready: state.campaign !== 'Загрузка кампании…',
    levels: Object.fromEntries(state.players.map((player) => [player.id, player.level])),
  })
  const [uiScale, setUiScale] = useState(loadUiScale)
  // По умолчанию кубик бросает игрок: автоматика включается осознанно.
  const [autoAttackRoll, setAutoAttackRoll] = useState(() => window.localStorage.getItem('skazanie-auto-attack-roll') === 'true')
  const [scenicBackdrop, setScenicBackdrop] = useState(loadScenicBackdrop)
  const [boardLighting, setBoardLighting] = useState(loadBoardLighting)
  const [combatAnimations, setCombatAnimations] = useState(() => window.localStorage.getItem(COMBAT_ANIMATIONS_KEY) !== 'false')
  const [atmosphereSettings, setAtmosphereSettings] = useState(loadAtmosphereSettings)
  const [voiceMode, setVoiceMode] = useState<NarrationVoiceMode>(() => normalizeVoiceMode(window.localStorage.getItem(NARRATION_VOICE_KEY)))
  // Подсказки по умолчанию включены: их и просили ради новичков за столом.
  // Выключенные не доезжают до панели вовсе, а не прячутся стилем.
  const [actionHintsEnabled, setActionHintsEnabled] = useState(() => window.localStorage.getItem(ACTION_HINTS_KEY) !== 'false')
  const [narrationVoices, setNarrationVoices] = useState<SpeechSynthesisVoice[]>([])
  // Мастер создания мира живёт внутри модального окна кампаний, но звук о нём
  // знать обязан: тема мастерской включается именно там.
  const [worldWizardOpen, setWorldWizardOpen] = useState(false)
  // Русского голоса нет — озвучки нет вовсе: читать русский текст английским
  // голосом хуже, чем молчать. Настройка и кнопка в таком случае не рисуются.
  const narrationVoice = useMemo(() => pickNarrationVoice(narrationVoices), [narrationVoices])
  const voiceSupported = russianVoiceAvailable(narrationVoices)
  // Подсказки считает сервер и кладёт в проекцию комнаты; клиент только решает,
  // показывать ли их этому игроку.
  const actionHints = actionHintsEnabled ? (state.suggested_actions ?? []) : []
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => (
    'Notification' in window ? Notification.permission : 'unsupported'
  ))
  const atmosphereAudioRef = useRef<AtmosphereAudio | null>(null)
  const screenMusicRef = useRef<ScreenMusicPlayer | null>(null)
  const normalDocumentTitle = useRef(document.title || DEFAULT_DOCUMENT_TITLE)
  const latestNarratorMessage = [...state.messages].reverse().find((message) => message.speaker === 'narrator')
  const sceneTheme = useMemo(() => resolveSceneTheme(state), [state.scene])
  const sceneLocationKey = state.scene.location_id ?? state.scene.location
  const sceneIllustration = useMemo(
    () => sceneIllustrationForTheme(sceneTheme, sceneLocationKey),
    [sceneLocationKey, sceneTheme],
  )
  // Иллюстрация локации отдаётся **только из кеша кампании**: во время игры
  // картинки не генерируются, их готовит ведущий заранее. Нет в кеше — сервер
  // честно отвечает 404, и шапка остаётся с библиотечной подложкой.
  //
  // Старые сцены могут не иметь канонического location_id. Для них запасной
  // источник иллюстрации — текущая точка карты мира.
  const locationArtId = state.scene.location_id ?? state.worldMap?.currentLocationId ?? ''
  const locationArtUrl = locationArtId
    ? `/api/campaigns/${state.sessionCode}/locations/${encodeURIComponent(locationArtId)}/illustration`
    : ''
  const joinAttempted = useRef(false)
  const isAdmin = account.role === 'admin'
  const partyIdSet = new Set(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
  const partyPlayers = state.players.filter((player) => partyIdSet.has(player.id))
  // Состояния, концентрация и временные хиты каждого героя — один расчёт на
  // снимок, им пользуются и список отряда, и полоска жизни.
  const heroStatusByHero = useMemo(
    () => Object.fromEntries(partyPlayers.map((player) => [player.id, heroStatusFor(state, player.id)])) as Record<string, HeroStatus>,
    [partyPlayers, state.mechanics?.conditions, state.mechanics?.concentration, state.mechanics?.active_effects, state.mechanics?.temporary_hp],
  )
  const deathState = state.mechanics?.death
  const deadHeroIds = new Set(Object.entries(deathState?.heroes ?? {}).filter(([, fate]) => fate.status === 'dead').map(([id]) => id))
  const fallenHeroes = partyPlayers.filter((player) => deadHeroIds.has(player.id))
  const partyDefeated = deathState?.campaign_status === 'party_defeated'
  const currentMembership = account.campaignMemberships?.find((membership) => membership.campaignId === state.sessionCode)
  const lifecycle = state.mechanics?.campaign_lifecycle
  const lifecycleStatus = lifecycle?.status ?? (partyDefeated ? 'failed' : 'active')
  const partyDefeatReviewed = reviewedPartyDefeat === state.sessionCode
  const showDeathScreen = fallenHeroes.length > 0 && (!partyDefeated || !partyDefeatReviewed)
  const showConclusion = ['completed', 'failed', 'archived'].includes(lifecycleStatus)
    && (fallenHeroes.length === 0 || (partyDefeated && partyDefeatReviewed))
  const pacing = state.autonomy?.pacing
  const pacingLabels = { breather: 'Передышка', development: 'Развитие', escalation: 'Нарастание', climax: 'Кульминация' } as const
  const lastTravel = state.autonomy?.travel_history?.at(-1)
  // Сервер считает заслуженный уровень, но не выдаёт его сам: выбор подкласса
  // и умений остаётся за игроком. Прогресс виден всегда — принцип 3 запрещает
  // молчаливо неактивные кнопки, поэтому «ещё не набрано» показывается прямо.
  const progression = state.mechanics?.progression
  const reputationStanding = state.autonomy?.reputation_standing ?? []
  const canManageLifecycle = isAdmin || currentMembership?.role === 'owner'
  const arcChainEnabled = state.campaignConcept?.arc_chain === true
  const accessibleHeroIds = isAdmin
    ? partyPlayers.map((player) => player.id)
    : (currentMembership?.heroIds ?? account.heroIds).filter((id) => partyIdSet.has(id))
  // Управлять админ может любым героем, но «своим» считается только
  // закреплённый за аккаунтом: на этом различии держится мастер создания.
  const ownedHeroIds = (currentMembership?.heroIds ?? account.heroIds ?? []).filter((id) => partyIdSet.has(id))
  const [selectedHeroId, setSelectedHeroId] = useState(accessibleHeroIds[0])
  const activePlayer = partyPlayers.find((player) => player.id === selectedHeroId && accessibleHeroIds.includes(player.id)) ?? partyPlayers.find((player) => accessibleHeroIds.includes(player.id)) ?? partyPlayers[0] ?? state.players[0]
  const merchantContext = JSON.stringify([state.sessionCode, state.scene.location_id, state.scene.location, state.scene.level?.index, activePlayer?.id, view])
  const selectedMerchant = merchantSelection?.context === merchantContext
    && activePlayer && accessibleHeroIds.includes(activePlayer.id)
    && !activePlayer.characterSetupRequired && activePlayer.hp > 0 && lifecycleStatus === 'active'
    ? merchantForSceneNpc(state, merchantSelection.id)
    : null
  useEffect(() => {
    if (merchantSelection && !selectedMerchant) setMerchantSelection(null)
  }, [merchantSelection, selectedMerchant])
  const alertTurnActorId = currentTurnActorId(state)
  const alertCombatActive = Boolean(state.mechanics?.combat?.active && state.mechanics.combat.initiative?.length)
  const alertActorName = partyPlayers.find((player) => player.id === alertTurnActorId)?.character ?? 'герой'
  const turnAlertCursor = useRef({ sessionCode: state.sessionCode, actorId: alertTurnActorId })

  const changeLifecycle = async (action: 'pause' | 'resume' | 'complete' | 'archive' | 'chain_arcs' | 'conclude_after_arc') => {
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

  const runCampaignControl = async (action: 'rewind_turn' | 'replay_scene') => {
    const question = action === 'rewind_turn'
      ? 'Откатить последний ход целиком? Журнал останется неизменным, но состояние вернётся к началу хода.'
      : 'Переиграть текущую сцену с самого начала? Все ходы, находки и последствия внутри неё будут отменены новым событием.'
    if (!window.confirm(question)) return
    setCampaignControlBusy(true)
    setLifecycleError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, idempotency_key: `${action}:${crypto.randomUUID()}` }),
      })
      const body = await response.json().catch(() => null) as { error?: string; version?: number; state?: GameState } | null
      if (!response.ok || !body?.state) throw new Error(body?.error || 'Не удалось применить инструмент ведущего')
      await switchCampaign(state.sessionCode, { version: body.version, state: body.state })
    } catch (reason) {
      setLifecycleError(reason instanceof Error ? reason.message : 'Не удалось применить инструмент ведущего')
    } finally {
      setCampaignControlBusy(false)
    }
  }

  const updateCampaignAi = useCallback(async (patch: Partial<CampaignAiSettings>) => {
    if (!campaignAi?.canManage || campaignAiBusy) return
    setCampaignAiBusy(true)
    setCampaignAiError('')
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...campaignAi.settings, ...patch }),
      })
      const body = await response.json().catch(() => null) as CampaignAiSettingsResponse | null
      if (!response.ok || !body?.settings) throw new Error(body?.error || 'Не удалось сохранить настройки ИИ кампании')
      setCampaignAi(body)
    } catch (error) {
      setCampaignAiError(error instanceof Error ? error.message : 'Не удалось сохранить настройки ИИ кампании')
    } finally {
      setCampaignAiBusy(false)
    }
  }, [campaignAi, campaignAiBusy, state.sessionCode])

  const updateCampaignRuleset = useCallback(async (rulesetId: 'dnd_5e_2014' | 'srd_5_2_1') => {
    if (!campaignAi?.ruleset.canChange || campaignAiBusy) return
    setCampaignAiBusy(true)
    setCampaignAiError('')
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...campaignAi.settings,
          rulesetId,
          idempotency_key: globalThis.crypto?.randomUUID?.() ?? `ruleset-${Date.now()}`,
        }),
      })
      const body = await response.json().catch(() => null) as CampaignAiSettingsResponse | null
      if (!response.ok || !body?.ruleset) throw new Error(body?.error || 'Не удалось изменить правила кампании')
      setCampaignAi(body)
    } catch (error) {
      setCampaignAiError(error instanceof Error ? error.message : 'Не удалось изменить правила кампании')
    } finally {
      setCampaignAiBusy(false)
    }
  }, [campaignAi, campaignAiBusy, state.sessionCode])

  useEffect(() => { getAiHealth().then(setAiHealth).catch(() => setAiHealth(null)) }, [])
  useEffect(() => {
    let active = true
    setCharacterCreationCatalog(null)
    setCharacterCreationError('')
    if (!state.sessionCode) return () => { active = false }
    const rulesetId = state.ruleset_id === 'dnd_5e_2014' ? 'dnd_5e_2014' : 'srd_5_2_1'
    void getCharacterCreationCatalog(rulesetId)
      .then((catalog) => { if (active) setCharacterCreationCatalog(catalog) })
      .catch((error) => {
        if (active) setCharacterCreationError(error instanceof Error ? error.message : 'Каталог создания героя недоступен')
      })
    return () => { active = false }
  }, [state.sessionCode, state.ruleset_id])
  useEffect(() => {
    const controller = new AbortController()
    setCampaignAi(null)
    setCampaignAiError('')
    // До выбора кампании кода сессии ещё нет, и запрос уходил на
    // `/api/campaigns//settings` — 404 в консоли на каждой загрузке страницы.
    // Пустой код — это не «кампания без настроек», а «кампании ещё нет»:
    // спрашивать сервер не о чем, и карточка настроек в этот момент не
    // показывается вовсе. Возврат стоит **после** сброса состояния: иначе на
    // выходе из кампании в интерфейсе осталась бы карточка прежней.
    if (view !== 'settings') return () => controller.abort()
    if (!state.sessionCode) return () => controller.abort()
    void fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/settings`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as CampaignAiSettingsResponse | null
        if (!response.ok || !body?.settings) throw new Error(body?.error || 'Не удалось загрузить настройки ИИ кампании')
        setCampaignAi(body)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setCampaignAiError(error instanceof Error ? error.message : 'Не удалось загрузить настройки ИИ кампании')
      })
    return () => controller.abort()
  }, [state.sessionCode, state.state_version, view])
  // Рекап «в прошлой серии». Сервер сам решает, был ли перерыв, и отдаёт
  // recap: null, если карточку показывать не нужно. Закрытая версия помнится
  // локально на игрока, чтобы один и тот же текст не встречал его дважды.
  useEffect(() => {
    const controller = new AbortController()
    setCampaignRecap(null)
    void fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/recap`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const body = await response.json().catch(() => null) as CampaignRecapResponse | null
        if (!body?.recap?.text) return
        if (window.localStorage.getItem(recapDismissedKey(state.sessionCode)) === String(body.recap.version)) return
        setCampaignRecap(body.recap)
      })
      .catch(() => { /* рекап не обязателен: комната открывается без него */ })
    return () => controller.abort()
  }, [state.sessionCode])
  useEffect(() => {
    const requestedRoom = requestedRoomAtEntry.current
    const roomLoaded = requestedRoom
      && state.sessionCode.toUpperCase() === requestedRoom
      && state.campaign !== 'Загрузка кампании…'
    if (roomLoaded) setCampaignsOpen(false)
  }, [state.campaign, state.sessionCode])
  useEffect(() => {
    const requestedRoom = new URLSearchParams(window.location.search).get('room')?.toUpperCase()
    if (!requestedRoom || isAdmin || joinAttempted.current) return
    joinAttempted.current = true
    const existingMembership = account.campaignMemberships?.some((membership) => membership.campaignId === requestedRoom)
    if (existingMembership) {
      history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(requestedRoom)}`)
      void switchCampaign(requestedRoom)
        .then(() => setCampaignsOpen(false))
        .catch((error) => setJoinError(error instanceof Error ? error.message : 'Не удалось открыть кампанию'))
      return
    }
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
  }, [account.campaignMemberships, isAdmin, onAccountRefresh, switchCampaign])
  useEffect(() => {
    // Мастер открывается сам только для героя, закреплённого за этим аккаунтом.
    // У администратора accessibleHeroIds — весь отряд, и прежнее условие
    // затягивало его в бесконечную цепочку чужих мест без выхода.
    const pendingHero = partyPlayers.find((hero) => ownedHeroIds.includes(hero.id) && hero.characterSetupRequired)
    if (pendingHero && creatingPlayerId == null && editingPlayerId == null && !heroWizardDismissed) {
      if (pendingHero.characterSetupStage === 'leveling') {
        setEditorInitialTab('advancement')
        setEditorRequestLevelUp(false)
        setEditingPlayerId(pendingHero.id)
      }
      else setCreatingPlayerId(pendingHero.id)
    }
  }, [creatingPlayerId, editingPlayerId, heroWizardDismissed, ownedHeroIds, partyPlayers])
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
  useEffect(() => { window.localStorage.setItem(BOARD_LIGHTING_KEY, String(boardLighting)) }, [boardLighting])
  useEffect(() => { window.localStorage.setItem(COMBAT_ANIMATIONS_KEY, String(combatAnimations)) }, [combatAnimations])
  useEffect(() => { window.localStorage.setItem(NARRATION_VOICE_KEY, voiceMode) }, [voiceMode])
  useEffect(() => { window.localStorage.setItem(ACTION_HINTS_KEY, String(actionHintsEnabled)) }, [actionHintsEnabled])
  // Список голосов в Chrome приезжает событием, а не первым вызовом. Подписка
  // снимается вместе с компонентом — вместе с ней смолкает и сама озвучка.
  useEffect(() => {
    const stop = observeVoices(setNarrationVoices)
    return () => {
      stop()
      cancelNarration()
    }
  }, [])
  // Автоозвучка читает только завершённый нарратив. Стриминговые куски сюда не
  // попадают: сообщение появляется в ленте уже целым, и голос не заикается.
  const spokenMessageId = useRef<string | null>(null)
  useEffect(() => {
    if (!latestNarratorMessage) return
    if (spokenMessageId.current === latestNarratorMessage.id) return
    spokenMessageId.current = latestNarratorMessage.id
    if (!shouldAutoSpeak(latestNarratorMessage, voiceMode)) return
    speakNarration(latestNarratorMessage.text, narrationVoice)
  }, [latestNarratorMessage, voiceMode, narrationVoice])
  useEffect(() => {
    const restoreTitle = () => {
      if (!document.hidden) document.title = normalDocumentTitle.current
    }
    document.addEventListener('visibilitychange', restoreTitle)
    return () => {
      document.removeEventListener('visibilitychange', restoreTitle)
      document.title = normalDocumentTitle.current
    }
  }, [])
  useEffect(() => {
    const audio = createAtmosphereAudio({ settings: atmosphereSettings })
    atmosphereAudioRef.current = audio
    const removeUnlockListeners = () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    const unlock = () => {
      void audio.unlock().then((unlocked) => {
        if (unlocked) removeUnlockListeners()
      })
    }
    // Браузер разрешает Web Audio только после жеста. Никакого модального
    // приглашения: первое обычное действие за столом мягко включает атмосферу.
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      removeUnlockListeners()
      if (atmosphereAudioRef.current === audio) atmosphereAudioRef.current = null
      void audio.dispose()
    }
  }, [])
  useEffect(() => {
    const cursor = turnAlertCursor.current
    if (cursor.sessionCode !== state.sessionCode) {
      cursor.sessionCode = state.sessionCode
      cursor.actorId = alertTurnActorId
      document.title = normalDocumentTitle.current
      return
    }
    if (cursor.actorId === alertTurnActorId) return
    cursor.actorId = alertTurnActorId
    if (!alertCombatActive || !accessibleHeroIds.includes(alertTurnActorId)) {
      if (document.hidden) document.title = normalDocumentTitle.current
      return
    }
    if (!document.hidden) return

    document.title = `⚔ Твой ход — ${alertActorName}`
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    try {
      const notification = new Notification('Твой ход в «Сказании»', {
        body: `${alertActorName} может действовать.`,
        tag: `skazanie-turn:${state.sessionCode}`,
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
      window.setTimeout(() => notification.close(), 12_000)
    } catch {
      // Заголовок и звук остаются корректным fallback даже при сбое API ОС.
    }
  }, [accessibleHeroIds, alertActorName, alertCombatActive, alertTurnActorId, state.sessionCode])
  useEffect(() => {
    atmosphereAudioRef.current?.setMood(normalizeAtmosphereMood(sceneTheme), 1.8)
  }, [sceneTheme])
  // Громкость фона до стола. Тема остаётся прежней — своей музыки у этих
  // экранов пока нет, — но играть её в полный голос, пока игрок выбирает
  // кампанию или лепит героя, неуместно.
  useEffect(() => {
    const screen = atmosphereScreenFor({
      authenticated: true,
      campaignListOpen: campaignsOpen,
      worldWizardOpen,
      heroWizardOpen: Boolean(creatingPlayerId),
    })
    atmosphereAudioRef.current?.setScreenAttenuation(atmosphereScreenAttenuation(screen))
    // Музыка мастеров: файл начинает качаться только сейчас, при заходе, и
    // останавливается при уходе с экрана.
    screenMusicRef.current?.setScreen(screen)
  }, [campaignsOpen, worldWizardOpen, creatingPlayerId])
  useEffect(() => {
    const music = createScreenMusic({ ambientVolume: atmosphereSettings.ambientVolume, muted: atmosphereSettings.muted })
    screenMusicRef.current = music
    return () => {
      if (screenMusicRef.current === music) screenMusicRef.current = null
      music.dispose()
    }
  }, [])
  useEffect(() => {
    screenMusicRef.current?.setSettings({ ambientVolume: atmosphereSettings.ambientVolume, muted: atmosphereSettings.muted })
  }, [atmosphereSettings.ambientVolume, atmosphereSettings.muted])
  useEffect(() => {
    atmosphereAudioRef.current?.setWaiting(state.isNarrating)
  }, [state.isNarrating])
  useEffect(() => {
    // Плашка смены сцены сравнивает два снимка: первая загрузка кампании и
    // смена комнаты — не переход, объявлять там нечего.
    const notice = sceneTransitionNotice(previousSceneState.current, state)
    previousSceneState.current = state
    if (notice) {
      setSceneNotice((current) => current?.key === notice.key ? current : notice)
      setLeavePickerOpen(false)
    }
  }, [state.sessionCode, state.scene.location_id, state.scene.location])
  const combatUnderway = Boolean(state.mechanics?.combat?.active)
  const travelBlocked = state.isNarrating
    || Boolean(activePlayer?.characterSetupRequired)
    || tacticalBusy
    || Boolean(state.pendingCheck || state.pendingAction)
    || combatUnderway
    || Boolean(state.law?.encounter)
    || lifecycleStatus !== 'active'
    || partyDefeated
  useEffect(() => {
    // Выбор пути закрывается, когда сервер уже ждёт другое решение или команда
    // ещё выполняется: скрытая отправка второго действия дала бы тихий отказ.
    if (travelBlocked) setLeavePickerOpen(false)
  }, [travelBlocked])
  const closeSceneNotice = useCallback(() => setSceneNotice(null), [])
  useEffect(() => {
    if (!accessibleHeroIds.includes(selectedHeroId)) setSelectedHeroId(accessibleHeroIds[0])
  }, [state.sessionCode, state.partyMemberIds?.join(',')])
  useEffect(() => {
    if (!replacementEditorId || deadHeroIds.has(replacementEditorId)) return
    setEditingPlayerId(replacementEditorId)
    setReplacementEditorId(null)
  }, [replacementEditorId, state.state_version])
  useEffect(() => {
    const ready = Boolean(state.sessionCode && state.campaign !== 'Загрузка кампании…')
    const levels = Object.fromEntries(state.players.map((player) => [player.id, player.level]))
    const cursor = levelUpCursor.current
    if (cursor.sessionCode !== state.sessionCode || !ready || !cursor.ready) {
      levelUpCursor.current = { sessionCode: state.sessionCode, ready, levels }
      if (cursor.sessionCode !== state.sessionCode) setLevelUpCelebration(null)
      return
    }

    const visibleEvents = (combatVisualBatch?.events ?? []).filter((event) => (
      event.visibility !== 'gm_only' && event.visibility !== 'npc_private'
    ))
    const confirmed = confirmedLevelUps(cursor.levels, state.players, visibleEvents)
    levelUpCursor.current = { sessionCode: state.sessionCode, ready, levels }
    const unseen = confirmed.find((entry) => (
      window.localStorage.getItem(levelUpSeenKey(state.sessionCode, entry.playerId, entry.level)) !== 'true'
    ))
    if (!unseen) return
    // Запоминаем показ при открытии: повторный SSE snapshot и reload не должны
    // превращать одно серверное повышение в несколько празднований.
    window.localStorage.setItem(levelUpSeenKey(state.sessionCode, unseen.playerId, unseen.level), 'true')
    setLevelUpCelebration(unseen)
  }, [combatVisualBatch?.id, state.campaign, state.players, state.sessionCode])

  const navigate = (next: View) => {
    setLeavePickerOpen(false)
    const url = new URL(window.location.href)
    if (next === 'combat-lab') url.searchParams.set('combatLab', '1')
    else url.searchParams.delete('combatLab')
    window.history.replaceState(null, '', url)
    setView(next)
    if (window.innerWidth <= 680) setSidebarCollapsed(true)
  }
  // Лавка не меняет раздел: она ложится поверх того, что игрок и так смотрит.
  // Узкое меню при этом сворачивается — иначе на телефоне оно перекроет окно.
  const openMerchant = (merchantId: string) => {
    if (!merchantForSceneNpc(state, merchantId) || tacticalBusy || merchantBusy || state.isNarrating
      || !activePlayer || activePlayer.characterSetupRequired || activePlayer.hp <= 0
      || !accessibleHeroIds.includes(activePlayer.id) || lifecycleStatus !== 'active') return
    setMerchantSelection({ id: merchantId, context: merchantContext })
    if (window.innerWidth <= 680) setSidebarCollapsed(true)
  }
  const changeAmbientVolume = (value: number) => {
    const next = atmosphereAudioRef.current?.setAmbientVolume(value)
      ?? saveAtmosphereSettings({ ...atmosphereSettings, ambientVolume: value })
    setAtmosphereSettings(next)
  }
  const changeAtmosphereMuted = (muted: boolean) => {
    const next = atmosphereAudioRef.current?.setMuted(muted)
      ?? saveAtmosphereSettings({ ...atmosphereSettings, muted })
    setAtmosphereSettings(next)
  }
  const requestTurnNotifications = async () => {
    if (!('Notification' in window)) {
      setNotificationPermission('unsupported')
      return
    }
    if (Notification.permission !== 'default') {
      setNotificationPermission(Notification.permission)
      return
    }
    try {
      setNotificationPermission(await Notification.requestPermission())
    } catch {
      setNotificationPermission(Notification.permission)
    }
  }
  const updateTypingPresence = useCallback((actorId: string, typing: boolean) => {
    if (!state.sessionCode || !actorId) return
    void fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/presence/typing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_id: actorId, typing }),
    }).catch(() => undefined)
  }, [state.sessionCode])
  // Без выбранной кампании игровую комнату рисовать нечем: раньше её место
  // занимал демо-мир, и новый аккаунт попадал в чужую историю. Проверка стоит
  // после всех хуков и до первого обращения к activePlayer.
  if (!state.sessionCode || !activePlayer) {
    if (isAdmin && view === 'combat-lab') return <div className="app no-campaign"><main className="game-main"><button className="combat-lab-back" onClick={() => navigate('room')}>Вернуться к кампаниям</button><CombatLabView /></main></div>
    return (
      <div className="app no-campaign">
        <main className="game-main">
          <div className="campaign-empty-screen">
            <ScrollText size={40} />
            <h1>{joinError ? 'Не удалось занять место героя' : 'Кампания ещё не выбрана'}</h1>
            <p>{joinError || 'Создайте новый мир — рассказчик придумает его и напишет пролог — либо откройте кампанию, в которую вас пригласили.'}</p>
            {joinError && <small className="campaign-join-explanation">Если все герои уже разобраны, попросите владельца создать кампанию с дополнительным местом. Роль наблюдателя не выдаёт скрытых данных и пока не входит в MVP.</small>}
            <button className="primary" onClick={() => setCampaignsOpen(true)}><Plus size={16} />Кампании и группы</button>
            {isAdmin && <button onClick={() => { setCampaignsOpen(false); navigate('combat-lab') }}><Swords size={16} />Боевой стенд</button>}
            <button onClick={onLogout}>Выйти из аккаунта</button>
          </div>
          {campaignsOpen && <CampaignModal state={state} rulesets={aiHealth?.installedRulesets} onSwitch={switchCampaign} onAccountRefresh={onAccountRefresh} onCreateHero={setCreatingPlayerId} onWizardChange={setWorldWizardOpen} onClose={() => setCampaignsOpen(false)} />}
        </main>
      </div>
    )
  }
  if (!isAdmin && currentMembership && accessibleHeroIds.length === 0) {
    return (
      <div className="app no-campaign">
        <main className="game-main">
          <div className="campaign-empty-screen">
            <Users size={40} />
            <h1>Все герои разобраны</h1>
            <p>Вы вошли в кампанию «{state.campaign}», но за вашим аккаунтом не закреплён герой. Игровые действия и скрытые сведения недоступны.</p>
            <button className="primary" onClick={() => setCampaignsOpen(true)}><ScrollText size={16} />Кампании и группы</button>
            <button onClick={onLogout}>Выйти из аккаунта</button>
          </div>
          {campaignsOpen && <CampaignModal state={state} rulesets={aiHealth?.installedRulesets} onSwitch={switchCampaign} onAccountRefresh={onAccountRefresh} onCreateHero={setCreatingPlayerId} onWizardChange={setWorldWizardOpen} onClose={() => setCampaignsOpen(false)} />}
        </main>
      </div>
    )
  }

  const combatActive = Boolean(state.mechanics?.combat?.active && state.mechanics.combat.initiative?.length)
  const turnActorId = currentTurnActorId(state)
  const turnPlayer = partyPlayers.find((player) => player.id === turnActorId)
  const turnEnemy = state.enemies?.find((enemy) => enemy.id === turnActorId)
  const turnSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const turnActorName = turnPlayer?.character ?? turnSummon?.name ?? turnEnemy?.name ?? 'участник боя'
  const mapActorId = combatActive ? turnActorId : activePlayer.id
  // Формулировка не случайная: её разбирает тот же словарь ухода
  // (`server/party-exit-intent.mjs`), которым сервер решает, открывать ли
  // голосование. Кнопка отправляет ровно то намерение, которое игрок мог бы
  // написать словами, — своего скрытого канала у неё нет, и переход всё равно
  // исполняет сервер по результату голосования.
  const leaveWithoutDestination = () => {
    if (travelBlocked) return
    void submitAction(`Предлагаю покинуть локацию «${state.scene.location || state.scene.title}»`, activePlayer.id)
      .then((outcome) => { if (outcome.ok) setLeavePickerOpen(false) })
  }
  // Сначала — куда. Кнопка открывает выбор пункта назначения по карте мира;
  // уйти «куда глаза глядят» по-прежнему можно, но как осознанный выбор, а не
  // как единственный.
  const proposeLeaveLocation = () => {
    if (travelBlocked) return
    setLeavePickerOpen((current) => !current)
  }
  const proposeTravelFromBoard = (action: string) => {
    if (travelBlocked) return
    void submitAction(action, activePlayer.id)
      .then((outcome) => { if (outcome.ok) setLeavePickerOpen(false) })
  }
  const mapHero = partyPlayers.find((player) => player.id === mapActorId)
  const mapSummon = state.actors?.find((actor) => actor.id === mapActorId && actor.alive)

  const canControlHero = Boolean(mapHero && partyIdSet.has(mapActorId) && (isAdmin || accessibleHeroIds.includes(mapActorId)))
  const summonControllerIds = mapSummon ? [mapSummon.ownerId, mapSummon.controllerId] : []
  const canControlSummon = Boolean(mapSummon && mapSummon.faction === 'party' && (isAdmin || summonControllerIds.some((id) => accessibleHeroIds.includes(id))))
  const canAct = !tacticalBusy && !mapHero?.characterSetupRequired && lifecycleStatus === 'active' && !partyDefeated && !deadHeroIds.has(mapActorId) && (canControlHero || canControlSummon)
  const needsHeroSetup = Boolean(activePlayer.characterSetupRequired)
  const openHeroEditor = (heroId: string, intent: 'sheet' | 'development' | 'levelup' = 'sheet') => {
    if (!accessibleHeroIds.includes(heroId)) return
    const hero = state.players.find((player) => player.id === heroId)
    setHeroWizardDismissed(false)
    if (hero?.characterSetupRequired && hero.characterSetupStage !== 'leveling') setCreatingPlayerId(heroId)
    else {
      const stagedSetup = hero?.characterSetupStage === 'leveling'
      setEditorInitialTab(stagedSetup || intent !== 'sheet' ? 'advancement' : 'sheet')
      setEditorRequestLevelUp(!stagedSetup && intent === 'levelup')
      setEditingPlayerId(heroId)
    }
  }
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
  const visibleTypingActorIds = (state.presence?.typing_actor_ids ?? []).filter((actorId) => actorId !== activePlayer.id)

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`} style={{
      '--ui-sidebar-width': `${Math.round(256 + Math.max(0, uiScale - 100) * .4)}px`,
      '--ui-hud-width': `${Math.round(246 + Math.max(0, uiScale - 100) * .25)}px`,
    } as React.CSSProperties}>
      <Sidebar
        players={partyPlayers}
        selectedPlayerId={activePlayer.id}
        turnPlayerId={turnActorId}
        accessibleHeroIds={accessibleHeroIds}
        typingActorIds={visibleTypingActorIds}
        isAdmin={isAdmin}
        deathSavesByHero={state.mechanics?.death?.saving_throws}
        statusByHero={heroStatusByHero}
        onSelect={setSelectedHeroId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(value => !value)}
        view={view}
        onNavigate={navigate}
        campaignName={state.campaign}
        partyName={state.partyName ?? ''}
        sessionCode={state.sessionCode ?? ''}
        connectionState={connectionState}
        pacing={pacing && pacing.beat > 0 ? {
          phase: pacing.phase,
          label: pacingLabels[pacing.phase],
          tension: pacing.tension,
          title: lastTravel ? `Последний путь: ${lastTravel.from} → ${lastTravel.to}, ${lastTravel.duration_minutes} мин., риск ${lastTravel.risk_score}` : 'Серверный темп автономной кампании',
        } : null}
        progression={progression ? {
          milestonesSinceLevel: progression.milestones_since_level,
          milestonesPerLevel: progression.milestones_per_level,
          levelUpAvailable: progression.level_up_available,
        } : null}
        reputationStanding={reputationStanding.map((entry) => ({
          label: `${entry.faction_id} — ${REPUTATION_TIER_LABELS[entry.tier]}`,
          known: entry.tier !== 'unknown',
        }))}
        canManageLifecycle={canManageLifecycle}
        lifecycleStatus={lifecycleStatus}
        lifecycleBusy={lifecycleBusy}
        onChangeLifecycle={(action) => { void changeLifecycle(action) }}
        inviteEnabled={canManageLifecycle && lifecycleStatus === 'active'}
        onInvite={() => setInviteOpen(true)}
        masterMenuOpen={masterMenuOpen}
        masterMenuRef={masterMenuRef}
        campaignControlBusy={campaignControlBusy}
        arcChainEnabled={arcChainEnabled}
        onToggleMasterMenu={() => setMasterMenuOpen((value) => !value)}
        onRunCampaignControl={(action) => { void runCampaignControl(action) }}
        onOpenNewbieGuide={() => setNewbieGuideOpen(true)}
        newbieGuideOpen={newbieGuideOpen}
        accountName={account.name}
        activeHeroName={activePlayer.character}
        onLogout={onLogout}
        onOpenCampaigns={() => setCampaignsOpen(true)}
        onOpenLevelUp={() => openHeroEditor(ownedHeroIds[0] ?? accessibleHeroIds[0] ?? activePlayer.id, 'levelup')}
      />
      <main className="game-main">
        <button className="mobile-menu icon-button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? 'Открыть меню' : 'Закрыть меню'} aria-expanded={!sidebarCollapsed}><Menu size={20} /></button>
        {view === 'room' && <div className={`game-area ${combatActive ? 'combat-active' : 'exploration-active'} ${state.isNarrating ? 'is-narrating' : ''} ${needsHeroSetup ? 'needs-hero-setup' : ''}`}>
          {needsHeroSetup && <section className="hero-setup-notice" aria-label="Подготовка героя">
            <div><strong>{activePlayer.characterSetupStage === 'leveling' ? `Подготовьте героя к ${(state.character_start_level ?? 1)}-му уровню` : 'Создайте героя, чтобы начать приключение'}</strong>
              <p>{activePlayer.characterSetupStage === 'leveling' ? `Сейчас уровень ${activePlayer.level}. Сохранённые выборы останутся при возвращении.` : 'Выберите класс, расу и историю. После подготовки станут доступны игровые действия.'}</p></div>
            <button disabled={!accessibleHeroIds.includes(activePlayer.id)} onClick={() => openHeroEditor(activePlayer.id)}>{accessibleHeroIds.includes(activePlayer.id) ? activePlayer.characterSetupStage === 'leveling' ? 'Продолжить подготовку' : 'Создать героя' : 'Ожидаем владельца героя'}</button>
          </section>}
          {lifecycleStatus === 'paused' && <CampaignPausedNotice
            canManage={canManageLifecycle}
            busy={lifecycleBusy}
            onResume={() => { void changeLifecycle('resume') }}
          />}
          {campaignRecap && <PreviouslyOnCard recap={campaignRecap} onDismiss={() => {
            window.localStorage.setItem(recapDismissedKey(state.sessionCode), String(campaignRecap.version))
            setCampaignRecap(null)
          }} />}
          {newbieGuideOpen && <NewbieGuide onDismiss={() => {
            window.localStorage.setItem(NEWBIE_GUIDE_DISMISSED_KEY, 'true')
            setNewbieGuideOpen(false)
          }} />}
          {/* Свободный бросок переехал из правой колонки в угол карты: он нужен
              в любой момент, а карточка с подписями занимала место рядом с
              состоянием героя. */}
          <DiceTray key={state.sessionCode} compact latestRoll={state.lastDiceRoll} onRoll={(sides) => rollFreeDie(activePlayer.id, sides)} />
          <DungeonMap
            state={state}
            players={partyPlayers}
            turnActorId={mapActorId}
            typingActorId={activePlayer.id}
            canConverse={accessibleHeroIds.includes(activePlayer.id)}
            dialogueBusy={tacticalBusy || merchantBusy}
            dialogueDraft={gameSession.dialogueDraft?.actorId === activePlayer.id && gameSession.dialogueDraft.campaignId === state.sessionCode ? gameSession.dialogueDraft : null}
            canAct={canAct && !state.pendingCheck && !state.pendingAction}
            tacticalBusy={tacticalBusy || Boolean(state.pendingCheck || state.pendingAction)}
            tacticalError={tacticalError}
            autoAttackRoll={autoAttackRoll}
            scenicBackdrop={scenicBackdrop}
            boardLighting={boardLighting}
            combatAnimations={combatAnimations}
            visualBatch={combatVisualBatch}
            onStartCombat={() => startCombat(activePlayer.id)}
            onNpcAttack={(npcId) => attackNpc(activePlayer.id, npcId)}
            onMove={movePlayer}
            onAttack={attackEnemy}
            onAreaAttack={throwAreaItem}
            onCastSpell={castSpell}
            onUseCombatAction={useCombatAction}
            onChangeWeapon={changeWeapon}
            onOperateDoor={operateDoor}
            onOperateSceneObject={operateSceneObject}
            onUseLevelTransition={useLevelTransition}
            onLeaveLocation={proposeLeaveLocation}
            leaveLocationDisabled={travelBlocked}
            onOpenMerchant={openMerchant}
            onFinishTurn={finishMapTurn}
            onFreeAction={(text, kind) => submitAction(text, activePlayer.id, undefined, kind)}
            onNpcAction={(text, npcId) => submitAction(text, activePlayer.id, npcId)}
            onCaptiveAction={(captiveId, action, skill) => captiveAction(activePlayer.id, captiveId, action, skill)}
            onLootContainer={(containerId, lines, recipientId) => lootContainer(activePlayer.id, containerId, lines, recipientId)}
            onBeastAction={(beastId, action) => beastAction(activePlayer.id, beastId, action)}
            onResolveGuardEncounter={(resolution, skill) => resolveGuardEncounter(activePlayer.id, resolution, skill)}
            onProposeParley={(skill) => proposeParley(activePlayer.id, skill)}
            onSettleParley={(outcome) => settleParley(activePlayer.id, outcome)}
            onOpenTavernDiceRound={(npcId, stakeCp) => openTavernDiceRound(activePlayer.id, npcId, stakeCp)}
            onAnswerTavernDiceRound={(approach) => answerTavernDiceRound(activePlayer.id, approach)}
            onLeaveTavernDiceRound={() => leaveTavernDiceRound(activePlayer.id)}
            onOrderTavernDrink={() => orderTavernDrink(activePlayer.id)}
            onSendLetter={(kind, addresseeId, body) => sendLetter(activePlayer.id, kind, addresseeId, body)}
            onReceiveNpcBlessing={(npcId) => receiveNpcBlessing(activePlayer.id, npcId)}
            onTransferItem={(itemId, npcId, quantity) => transferItem(activePlayer.id, itemId, npcId, quantity)}
            onStartRest={(kind) => startRest(activePlayer.id, kind)}
            onSpendHitPointDie={() => spendHitPointDie(activePlayer.id)}
            onCompleteRest={() => completeRest(activePlayer.id)}
            onTypingChange={updateTypingPresence}
            narrating={state.isNarrating}
            playerHud={<PlayerHud player={mapHero ?? activePlayer} combatActive={combatActive} status={heroStatusByHero[(mapHero ?? activePlayer).id]} hazards={((state.mechanics as { hazards?: Record<string, Array<{ id: string; label?: string; severity?: string; description?: string }>> } | undefined)?.hazards?.[(mapHero ?? activePlayer).id] ?? [])} onCharacter={() => openHeroEditor((mapHero ?? activePlayer).id)} onInventory={() => navigate('inventory')} />}
            statusContent={<SceneHeader {...state.scene} chapter={state.adventure?.chapter ?? 1} illustration={sceneIllustration} illustrationKey={sceneLocationKey} locationArtUrl={locationArtUrl} scenicBackdrop={scenicBackdrop} wantedSigns={state.law?.signs ?? []} weather={state.weather_by_actor?.[activePlayer.id] ?? state.weather} />}
          >
            <ChatPanel messages={state.messages} isNarrating={state.isNarrating} interaction={state.agentInteraction} players={partyPlayers} typingActorIds={visibleTypingActorIds} currentPlayerId={activePlayer.id} canAct={canAct} combatActive={combatActive} suggestedActions={actionHints} sceneKey={`${state.scene.location}|${state.scene.title}`} onVote={(optionId) => voteAgentInteraction(activePlayer.id, optionId)} onAbstain={() => { void abstainAgentInteraction(activePlayer.id) }} onRollInteraction={() => { void rollAgentInteraction(activePlayer.id) }} onContinueInteraction={() => continueAgentInteraction(activePlayer.id)} onWhy={() => { void submitAction('/why', activePlayer.id) }} onSpeak={voiceSupported && voiceMode !== 'off' ? (text) => speakNarration(text, narrationVoice) : null} />
          </DungeonMap>
        </div>}
        {view === 'world-map' && <WorldMapView state={state} busy={travelBlocked} onTravel={(action) => {
          void submitAction(action, activePlayer.id).then((outcome) => { if (outcome.ok) navigate('room') })
        }} />}
        {view === 'journal' && <JournalView state={state} />}
        {view === 'characters' && <CharactersView players={partyPlayers} selectedId={activePlayer.id} turnId={turnActorId} combatActive={combatActive} accessibleHeroIds={accessibleHeroIds} onSelect={setSelectedHeroId} onEdit={openHeroEditor} />}
        {view === 'inventory' && <InventoryView
          onCreateHero={accessibleHeroIds.includes(activePlayer.id) ? () => openHeroEditor(activePlayer.id) : undefined}
          player={activePlayer}
          party={partyPlayers}
          enemyTargets={(state.enemies ?? []).filter((candidate) => candidate.alive && (candidate.hp == null || candidate.hp > 0)).map((candidate) => ({ id: candidate.id, label: candidate.name }))}
          combatActive={combatActive}
          combatItemTurnAvailable={canAct && turnActorId === activePlayer.id}
          combatBonusActionAvailable={state.mechanics?.combat?.action_economy?.[activePlayer.id]?.bonus_action !== false}
          busy={tacticalBusy}
          error={tacticalError}
          onEquip={(itemId, equipped) => equipItem(activePlayer.id, itemId, equipped)}
          onUse={(itemId, options) => useItem(activePlayer.id, itemId, options)}
          onTransfer={(itemId, recipientId, quantity) => transferItem(activePlayer.id, itemId, recipientId, quantity)}
          onAttune={(itemId, attuned) => attuneItem(activePlayer.id, itemId, attuned)}
          onActivate={(itemId, activated) => activateItem(activePlayer.id, itemId, activated)}
        />}
        {view === 'settings' && <SettingsView health={aiHealth} campaignAi={campaignAi} campaignAiBusy={campaignAiBusy} campaignAiError={campaignAiError} uiScale={uiScale} autoAttackRoll={autoAttackRoll} scenicBackdrop={scenicBackdrop} boardLighting={boardLighting} combatAnimations={combatAnimations} atmosphereSettings={atmosphereSettings} notificationPermission={notificationPermission} voiceMode={voiceMode} voiceSupported={voiceSupported} onVoiceModeChange={setVoiceMode} actionHintsEnabled={actionHintsEnabled} onActionHintsEnabledChange={setActionHintsEnabled} onCampaignAiChange={(patch) => { void updateCampaignAi(patch) }} onCampaignRulesetChange={(rulesetId) => { void updateCampaignRuleset(rulesetId) }} onUiScaleChange={setUiScale} onAutoAttackRollChange={setAutoAttackRoll} onScenicBackdropChange={setScenicBackdrop} onBoardLightingChange={setBoardLighting} onCombatAnimationsChange={setCombatAnimations} onAmbientVolumeChange={changeAmbientVolume} onAtmosphereMutedChange={changeAtmosphereMuted} onRequestNotifications={() => { void requestTurnNotifications() }} />}
        {view === 'admin' && isAdmin && <AdminView account={account} state={state} onUpdateWorld={updateWorld} onAssembleEncounter={assembleEncounter} onAssembleMerchant={assembleMerchant} onMoveMerchant={moveMerchant} onSetMerchantAvailability={setMerchantAvailability} />}
        {view === 'combat-lab' && isAdmin && <CombatLabView />}
      </main>
      {/* Рассказчик и требование броска стоят поверх ЛЮБОГО раздела, а не
          только комнаты: игрок, ушедший в инвентарь или журнал, до этого не
          видел ни стрима, ни карточки «Ожидающая проверка» — и узнавал о своём
          броске, только вернувшись на карту. Слой прижат к рабочей области
          (боковое меню слева, в комнате — правая колонка справа), поэтому
          прежние отступы карточек внутри него не изменились. */}
      {checkDiceScene && <DiceRollScene
        key={checkDiceScene.key}
        sides={20}
        value={checkDiceScene.value}
        actualResult={checkDiceScene.actualResult}
        rolling={checkDiceScene.rolling}
        reducedMotion={reducedMotion}
        title="Проверка"
        playerName={checkDiceScene.label}
        onClose={closeCheckDiceScene}
      />}
      <div className={`scene-overlay-layer ${view === 'room' ? 'beside-server-column' : ''}`}>
        {sceneNotice && <SceneTransitionBanner key={sceneNotice.key} notice={sceneNotice} onClose={closeSceneNotice} />}
        {leavePickerOpen && view === 'room' && !combatActive && <LeaveLocationPicker
          state={state}
          busy={travelBlocked}
          onTravel={proposeTravelFromBoard}
          onNarratorDecides={leaveWithoutDestination}
          onOpenWorldMap={() => { setLeavePickerOpen(false); navigate('world-map') }}
          onClose={() => setLeavePickerOpen(false)}
        />}
        {state.pendingAction && <details className="pending-check-overlay" aria-label="План боевого манёвра" aria-live="polite" open>
          <summary><Footprints size={15} /><span>План манёвра · {state.pendingAction.proposal.movement_feet} фт</span><ChevronDown size={16} /></summary>
          {canAct && state.pendingAction.playerId === activePlayer.id ? <div className="dice-check has-proposal">
            <div className="dice-copy"><span>План манёвра</span><strong>{state.pendingAction.proposal.title}</strong></div>
            <div className="improvisation-proposal">
              <dl><div><dt>Цена</dt><dd>{state.pendingAction.proposal.cost}</dd></div>
                <div><dt>Маршрут</dt><dd>{state.pendingAction.proposal.path.length ? 'Отмечен цифрами на карте' : 'Герой уже в пределах досягаемости'}</dd></div></dl>
              <p>{state.pendingAction.proposal.consequence}</p>
            </div>
            <button className="d20-button" onClick={() => { void confirmPendingAction() }} disabled={state.isNarrating || state.pendingAction.status !== 'ready'}>
              <span>{state.pendingAction.status === 'submitting' ? 'Манёвр выполняется…' : 'Подтвердить манёвр'}</span>
            </button>
            <button className="cancel-check" onClick={cancelPendingAction} disabled={state.isNarrating || state.pendingAction.status !== 'ready'}>Отказаться</button>
            {state.pendingAction.status === 'ready' && <button className="cancel-check" disabled={state.isNarrating} onClick={gameSession.editPendingProposal}>Изменить способ</button>}
            {state.pendingAction.status === 'ready' && <ProposalQuestion busy={state.isNarrating} answer={gameSession.lastDialogueAnswer} onAsk={(text) => submitAction(text, state.pendingAction!.playerId, undefined, 'question')} />}
          </div> : <div className="turn-wait"><LockKeyhole size={18} /><span>Выберите героя, которому принадлежит это предложение. Подтверждение доступно в его ход.</span></div>}
        </details>}
        {state.pendingCheck && (
          <details key={state.pendingCheck.check_id ?? state.pendingCheck.action} className="pending-check-overlay" open aria-live="polite">
            <summary><Dices size={15} /><span>Ожидающая проверка</span><ChevronDown size={16} /></summary>
            {canAct && state.pendingCheck.playerId === activePlayer.id
              ? <DiceCheckCard check={state.pendingCheck} onRoll={() => startPendingCheckRoll(state.pendingCheck!)} onCancel={cancelPendingCheck} busy={state.isNarrating || checkRollBusy}>
                {state.pendingCheck.status === 'ready' && !state.pendingCheck.result && !state.pendingCheck.command && <button className="cancel-check" disabled={state.isNarrating} onClick={gameSession.editPendingProposal}>Изменить способ</button>}
                {state.pendingCheck.status === 'ready' && !state.pendingCheck.result && <ProposalQuestion busy={state.isNarrating} answer={gameSession.lastDialogueAnswer} onAsk={(text) => submitAction(text, state.pendingCheck!.playerId, undefined, 'question')} />}
              </DiceCheckCard>
              : <div className="turn-wait"><LockKeyhole size={18} /><span><b>Бросок выполняет владелец героя</b><small>Ожидаем игрока: {turnActorName}</small></span></div>}
          </details>
        )}
      </div>
      {/* Одна лента на все отказы: раньше их было три в трёх углах, и вторая
          ошибка затирала первую. Тексты не переписываются — очередь только
          показывает их по порядку. */}
      <ErrorToasts sources={[
        { text: directorError },
        { text: characterCreationError },
        { text: joinError },
        { text: lifecycleError },
        { text: tacticalError, onDismiss: clearTacticalError },
      ]} />
      {selectedMerchant && <MerchantScreen key={merchantContext + selectedMerchant.id} merchant={selectedMerchant} player={activePlayer} sceneLocation={state.scene.location} stateVersion={state.state_version ?? 0} view={merchantView} narration={merchantNarration} busy={merchantBusy} error={merchantError} onLoad={loadMerchant} onBargain={bargainWithMerchant} onBuy={buyFromMerchant} onSell={sellToMerchant} onAppraise={appraiseWithMerchant} onService={purchaseMerchantService} onClose={() => setMerchantSelection(null)} />}
      {inviteOpen && <InviteModal code={state.sessionCode} onClose={() => setInviteOpen(false)} />}
      {campaignsOpen && <CampaignModal state={state} rulesets={aiHealth?.installedRulesets} onSwitch={switchCampaign} onAccountRefresh={onAccountRefresh} onCreateHero={setCreatingPlayerId} onWizardChange={setWorldWizardOpen} onClose={() => setCampaignsOpen(false)} />}
      {creatingPlayerId && (characterCreationCatalog ?? (state.ruleset_id !== 'dnd_5e_2014' ? aiHealth?.characterCreation : null)) && <CharacterCreationWizard
        key={`${creatingPlayerId}:${state.ruleset_id ?? 'srd_5_2_1'}`}
        player={state.players.find((player) => player.id === creatingPlayerId) ?? activePlayer}
        accountName={account.name}
        catalog={characterCreationCatalog ?? aiHealth!.characterCreation!}
        rulesetId={state.ruleset_id}
        required={Boolean(state.players.find((player) => player.id === creatingPlayerId)?.characterSetupRequired)}
        onClose={() => { setCreatingPlayerId(null); setHeroWizardDismissed(true) }}
        onImport={async (source) => {
          await importCharacter(creatingPlayerId, source)
          // При повышенном старте импорт фиксирует только первый уровень;
          // дальше тот же игрок продолжает подготовку в мастере развития.
          if ((state.character_start_level ?? 1) > 1) {
            setEditorInitialTab('advancement')
            setEditorRequestLevelUp(false)
            setEditingPlayerId(creatingPlayerId)
          }
        }}
        onRollAbilities={(rollIndex) => gameSession.rollCharacterAbilities(creatingPlayerId, rollIndex)}
        onRollWealth={(classId) => gameSession.rollCharacterWealth(creatingPlayerId, classId)}
      />}
      {editingPlayerId && <CharacterEditor
        key={`${editingPlayerId}:${editorInitialTab}:${editorRequestLevelUp ? 'levelup' : 'browse'}`}
        player={state.players.find((player) => player.id === editingPlayerId) ?? activePlayer}
        rulesetId={state.ruleset_id}
        targetLevel={state.character_start_level}
        initialTab={editorInitialTab}
        phbCatalog={characterCreationCatalog?.phb}
        requestLevelUp={editorRequestLevelUp}
        onClose={() => { setEditingPlayerId(null); setEditorInitialTab('sheet'); setEditorRequestLevelUp(false); setHeroWizardDismissed(true) }}
        onSave={(patch) => updatePlayer(editingPlayerId, patch)}
        onImport={(source) => importCharacter(editingPlayerId, source)}
        onLevelUp={() => {
          const player = state.players.find((candidate) => candidate.id === editingPlayerId)
          return player ? levelUpCharacter(player.id, player.level) : Promise.resolve({ ok: false, error: 'Герой не найден' })
        }}
      />}
      {reactionWindow && canAnswerReaction && <ReactionPrompt actorName={String(reactionActorName)} sourceName={String(reactionSourceName)} window={reactionWindow} busy={tacticalBusy} beneficiaries={reactionBeneficiaries} onChoose={(actionId, beneficiaryId) => useCombatAction(reactionWindow.actor_id, actionId, reactionWindow.source_actor_id, undefined, beneficiaryId)} onDecline={() => useCombatAction(reactionWindow.actor_id, 'decline-reaction')} />}
      {!campaignsOpen && showDeathScreen && <DeathScreen heroes={fallenHeroes} partyDefeated={partyDefeated} busy={tacticalBusy} error={tacticalError} canResolve={(heroId) => isAdmin || accessibleHeroIds.includes(heroId)} onResolve={(heroId, resolution, replacementName) => { if (resolution === 'replace') setReplacementEditorId(heroId); resolveHeroDeath(heroId, resolution, replacementName) }} onContinueToEpilogue={() => setReviewedPartyDefeat(state.sessionCode)} />}
      {!campaignsOpen && showConclusion && <CampaignConclusionScreen status={lifecycleStatus as 'completed' | 'failed' | 'archived'} epilogue={lifecycle?.epilogue} busy={lifecycleBusy} canManage={canManageLifecycle} onArchive={() => { void changeLifecycle('archive') }} onChooseCampaign={() => setCampaignsOpen(true)} />}
      {!campaignsOpen && !showDeathScreen && !showConclusion && levelUpCelebration && !(editingPlayerId === levelUpCelebration.playerId) && <LevelUpScreen
        levelUp={levelUpCelebration}
        canOpenSheet={isAdmin || accessibleHeroIds.includes(levelUpCelebration.playerId)}
        onOpenSheet={() => {
          openHeroEditor(levelUpCelebration.playerId, 'development')
          setLevelUpCelebration(null)
        }}
        onClose={() => setLevelUpCelebration(null)}
      />}
    </div>
  )
}

function App() {
  const auth = useAuth()
  if (!auth.user) return <AuthScreen loading={auth.loading} error={auth.error} setupRequired={auth.setupRequired} onLogin={auth.login} onRegister={auth.register} onSetupAdmin={auth.setupAdmin} />
  return <GameApp account={auth.user} onAccountRefresh={auth.refresh} onLogout={auth.logout} />
}

export default App
