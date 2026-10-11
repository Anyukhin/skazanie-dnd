import { createHash } from 'node:crypto'

import { buildNarrationBrief } from './security.mjs'
import { campaignConceptForAgent, fieldSummaryFor, heroCardForAgent } from './agent-context.mjs'

/**
 * Потолок ожидания для необязательного текста критического момента.
 *
 * Был 4 000 мс. Живой замер 2026-07-28: первичная модель отвечает за
 * 2,7–4,0 с, то есть падение героя — самый заметный момент партии — срывалось
 * в сухой запасной текст примерно в половине случаев, и роль Творческого
 * режиссёра не работала ровно там, ради чего заведена. Потолок поднят до 8 с:
 * он остаётся ниже общего таймаута модели (9 с), поэтому цепочка фолбэков не
 * успевает начаться, а ход по-прежнему не может зависнуть — по истечении
 * срока рассказчик отдаёт детерминированный текст.
 */
export const CRITICAL_NARRATION_TIMEOUT_MS = 8_000

const CRITICAL_CONDITIONS = new Map([
  ['fled', 'enemy_fled'],
  ['surrendered', 'enemy_surrendered'],
])

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function actorName(state, id) {
  const expected = String(id ?? '')
  const actor = [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => actorId(candidate) === expected)
  return String(actor?.character ?? actor?.name ?? (expected || 'участник'))
}

export function criticalMomentFor(events = [], state = {}) {
  const enemyIds = new Set((state.enemies ?? []).map(actorId))
  const playerIds = new Set((state.players ?? []).map(actorId))
  for (const event of events) {
    if (event.event_type !== 'HeroDied') continue
    const targetId = String(event.target_ids?.[0] ?? event.payload?.target_id ?? '')
    if (playerIds.has(targetId)) return { kind: 'hero_died', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  for (const event of events) {
    if (event.event_type !== 'HitPointsReducedToZero') continue
    const targetId = String(event.target_ids?.[0] ?? event.payload?.target_id ?? '')
    if (enemyIds.has(targetId)) return { kind: 'enemy_defeated', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
    if (playerIds.has(targetId)) return { kind: 'hero_fallen', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  for (const event of events) {
    if (event.event_type !== 'ConditionAdded') continue
    const kind = CRITICAL_CONDITIONS.get(String(event.payload?.condition ?? ''))
    if (!kind) continue
    const targetId = String(event.target_ids?.[0] ?? event.actor_id ?? '')
    return { kind, actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  return null
}

/**
 * Реплика ведущего о самом моменте, когда живой текст модели не пришёл.
 * Прежде запасной рассказчик пересказывал строку боя — «Борин поражает
 * Гоблина. Гоблин получает урон», — и хроника читалась дважды (плейтест
 * 2026-10-10). Формы — настоящее время без рода; смерть называет только
 * подтверждённое событие гибели героя. Вариант — по хешу события: повтор и
 * replay дают ту же строку.
 */
const CRITICAL_MOMENT_LINES = Object.freeze({
  enemy_defeated: ['{name} валится с ног — этот противник своё отвоевал.', '{name} оседает наземь и больше не встаёт в строй.', 'Ещё один враг повержен: {name} затихает.'],
  hero_fallen: ['{name} оседает на землю без сознания — жизнь ещё теплится.', '{name} падает без чувств; товарищам стоит поспешить.', '{name} рушится на землю и не шевелится — но ещё дышит.'],
  hero_died: ['{name} больше не поднимется. Бой идёт дальше — уже без героя.'],
  enemy_fled: ['{name} бросает бой и пускается наутёк.', '{name} не выдерживает и бежит.'],
  enemy_surrendered: ['{name} бросает оружие и просит пощады.', '{name} опускает оружие: с него хватит.'],
})

export function criticalMomentLine(trigger, events = []) {
  const lines = CRITICAL_MOMENT_LINES[String(trigger?.kind ?? '')]
  const name = String(trigger?.target_name ?? '').trim()
  if (!lines?.length || !name) return ''
  const seed = `${trigger.kind}\u0000${trigger.target_id}\u0000${(events ?? []).map((event) => event?.event_id ?? '').join('|')}`
  const index = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % lines.length
  return lines[index].replace('{name}', name)
}

/** Поступки героя, к которым игрок может приложить слова: удар, выстрел, заклинание, манёвр. */
const HERO_DEED_EVENTS = new Set(['AttackResolved', 'SpellCast', 'SpellSavingThrowResolved', 'DamageApplied', 'CombatActionUsed', 'ShoveResolved', 'GrappleResolved'])

/**
 * Слова игрока к своему ходу в бою («Борин рычит «За Илу!» и рубит с плеча»)
 * — повод для одной-двух фраз ведущего о самом поступке. Без слов бой идёт
 * прежним темпом, строкой боя: модель не встаёт в каждый ход (AGENTS.md §6).
 */
export function heroFlourishFor(events = [], state = {}, { playerNote = '', actorId = '' } = {}) {
  const note = String(playerNote ?? '').trim()
  const hero = String(actorId ?? '')
  if (!note || !hero || !state?.mechanics?.combat?.active) return null
  if (!(events ?? []).some((event) => String(event?.actor_id ?? '') === hero && HERO_DEED_EVENTS.has(String(event?.event_type ?? '')))) return null
  return { kind: 'hero_flourish', actor_id: hero, target_id: hero, target_name: actorName(state, hero), note: note.slice(0, 400) }
}

/**
 * События самого момента падения героя: удар, урон, спасброски, гибель. Смена
 * хода и шаги других в тот же ответ не входят — рассказчик писал «Мирель
 * погибает, и её ход заканчивается; ход переходит к Борину» (замер 9,
 * 2026-10-10), и гибель героя звучала как строка очереди.
 */
const HERO_MOMENT_EVENTS = new Set(['AttackResolved', 'SpellCast', 'SpellSavingThrowResolved', 'DamageApplied', 'HitPointsReducedToZero', 'DeathSavingThrowResolved', 'HeroDied', 'ConditionAdded'])

function heroMomentEvents(events, trigger) {
  const hero = String(trigger?.target_id ?? '')
  return (events ?? []).filter((event) => HERO_MOMENT_EVENTS.has(String(event?.event_type ?? ''))
    && (String(event?.actor_id ?? '') === hero || (event?.target_ids ?? []).map(String).includes(hero)))
}

/**
 * Павшие герои отряда: погибшие и лежащие без сознания, с карточкой — их
 * узы и предыстория, ради чего они пришли.
 *
 * @param {Record<string, any>} state
 */
function fallenHeroesFor(state) {
  const death = state.mechanics?.death?.heroes ?? {}
  return (state.players ?? [])
    .map((actor) => ({ actor, id: actorId(actor) }))
    .filter(({ actor, id }) => death[id]?.status === 'dead' || Number(actor?.hp) <= 0)
    .slice(0, 4)
    .map(({ id }) => ({
      ...heroCardForAgent(state, id),
      condition: death[id]?.status === 'dead' ? 'погиб' : 'без сознания',
    }))
}

function publicEnvironment(state, trigger) {
  const scene = state.scene ?? {}
  // Карточка павшего героя: его предыстория и узы — то, о чём эта смерть или
  // это падение (сестра, долг, клятва), а не просто «герой выбыл».
  const fallenCard = ['hero_fallen', 'hero_died'].includes(String(trigger?.kind ?? ''))
    ? heroCardForAgent(state, trigger.target_id)
    : null
  // После схватки — кто из героев пал: погиб или лежит без сознания. Прежде
  // сцена «после боя» звучала так, будто ничего не случилось, хотя Мирель
  // только что погибла (замер 27, 2026-10-11).
  const fallenHeroes = trigger?.kind === 'encounter_aftermath' ? fallenHeroesFor(state) : []
  const field = fieldSummaryFor(state)
  return {
    // Кто где стоит и в каком состоянии: рассказ момента держится поля,
    // а не журнала (замеры 27–31).
    ...(field ? { field } : {}),
    ...(fallenCard ? { fallen_hero: fallenCard } : {}),
    ...(fallenHeroes.length ? { fallen_heroes: fallenHeroes } : {}),
    campaign_premise: campaignConceptForAgent(state),
    scene: {
      title: String(scene.title ?? ''),
      location: String(scene.location ?? ''),
      mood: String(scene.mood ?? ''),
      objective: String(scene.objective ?? ''),
    },
    critical_moment: trigger,
    participants: {
      heroes: (state.players ?? []).map((actor) => ({ id: actorId(actor), name: actorName(state, actorId(actor)) })),
      enemies: (state.enemies ?? []).map((actor) => ({ id: actorId(actor), name: actorName(state, actorId(actor)) })),
    },
  }
}

/**
 * The creative director is deliberately absent from ordinary mechanics. It is
 * called only after the rules engine has committed a bounded critical event;
 * narration can decorate that fact but cannot alter HP, rolls or positions.
 */
export class CriticalNarrationCoordinator {
  constructor({ narrator } = {}) {
    if (!narrator) throw new TypeError('CriticalNarrationCoordinator requires narrator')
    this.narrator = narrator
  }

  /**
   * `recentNarrations` — последние реплики рассказчика в этой кампании. Без них
   * проверка повторов у рассказчика не видела ничего, и одна и та же
   * фраза-заполнитель звучала дважды за бой (плейтест 2026-10-10).
   */
  /**
   * Сцена после победы: «продолжим» закрывал встречу одной строкой дележа
   * добычи, и судья читал это как «сухую сводку вместо продолжения сцены»
   * (замеры 2026-10-10). Две-три фразы — тишина после схватки, что видно у тел
   * и вокруг, куда зовёт цель сцены. Исход, добыча и награда — только из
   * событий; без живого текста модели — ничего, строка дележа говорит сама.
   */
  async renderAftermath({ events = [], state = {}, viewer = {}, recentNarrations = [] } = {}) {
    const outcome = (events ?? []).find((event) => event?.event_type === 'EncounterOutcomeRecorded')?.payload?.outcome
    if (!['enemies_defeated', 'fled'].includes(String(outcome ?? ''))) return null
    const trigger = { kind: 'encounter_aftermath', actor_id: '', target_id: '', target_name: '' }
    const visible = (events ?? []).filter((event) => ['EncounterOutcomeRecorded', 'EncounterRewardsDistributed', 'LootContainerCreated', 'WorldFactRecorded'].includes(String(event?.event_type ?? '')))
      .map((event) => event.event_type === 'EncounterOutcomeRecorded' ? { ...event, payload: { outcome: event.payload?.outcome } } : event)
    const brief = buildNarrationBrief({
      visible_events: visible,
      visible_state_changes: [],
      known_environment: publicEnvironment(state, trigger),
      permitted_npc_reactions: [],
      viewer,
    })
    const narration = await this.narrator.render(brief, {
      knownRuleIds: [],
      timeoutMs: CRITICAL_NARRATION_TIMEOUT_MS,
      recentNarrations: (Array.isArray(recentNarrations) ? recentNarrations : []).map((text) => String(text ?? '')).filter(Boolean),
      style: 'Две-три фразы после схватки: тишина, дыхание, что видно вокруг, и куда тянет цель сцены. Если в fallen_heroes кто-то пал — начни с него: где он лежит и как замирает отряд (погибшего не воскрешай; за живых героев не говори и не решай; без сознания — жив). Добычу, монеты и награды не пересказывай — их показывает стол. Без чисел; не добавляй находок, бросков и решений правил.',
    })
    if (/^deterministic/u.test(String(narration?.provider ?? '')) || !String(narration?.narration ?? '').trim()) return null
    return { ...narration, trigger }
  }

  /**
   * Начало схватки — абзац ведущего: кто выходит, откуда и как выглядит. Прежде
   * игрок читал «Из укрытий выскакивают Волк 1 и Разбойник 1. Бой начинается»,
   * и судья называл это «стат-блоком» и «служебным объявлением» (замер 10,
   * 2026-10-10). Один вызов модели на встречу, как у перелома боя; без живого
   * текста остаётся прежняя строка.
   */
  async renderEncounterOpening({ events = [], state = {}, viewer = {}, recentNarrations = [] } = {}) {
    const created = (events ?? []).find((event) => event?.event_type === 'EncounterCreated')
    const encounter = created?.payload?.encounter
    if (!encounter) return null
    const trigger = { kind: 'encounter_opening', actor_id: '', target_id: '', target_name: '' }
    const enemies = (Array.isArray(encounter.enemies) ? encounter.enemies : [])
      .map((enemy) => String(enemy?.name ?? '').replace(/\s+\d+$/u, '').trim()).filter(Boolean).slice(0, 12)
    const brief = buildNarrationBrief({
      visible_events: [{ ...created, payload: { encounter: { theme: String(encounter.theme ?? ''), enemies: enemies.map((name) => ({ name })) } } }],
      visible_state_changes: [],
      known_environment: { ...publicEnvironment(state, trigger), encounter_foes: enemies },
      permitted_npc_reactions: [],
      viewer,
    })
    const narration = await this.narrator.render(brief, {
      knownRuleIds: [],
      timeoutMs: CRITICAL_NARRATION_TIMEOUT_MS,
      recentNarrations: (Array.isArray(recentNarrations) ? recentNarrations : []).map((text) => String(text ?? '')).filter(Boolean),
      // Цель сцены и зацепки — не тема вводки: «их появление обрывает поиски
      // другого пути к разгадке; баркас остаётся зацепкой» (замер 19).
      style: 'Два-три предложения о начале схватки: кто выходит из укрытия и откуда, как выглядят и что делали здесь до появления героев — по сцене и составу из encounter_foes; имена без номеров («двое разбойников и волк»). Не пересказывай цель сцены, задания и зацепки. Без чисел, ходов, очереди и правил; не добавляй бросков, урона, находок и решений правил.',
    })
    if (/^deterministic/u.test(String(narration?.provider ?? '')) || !String(narration?.narration ?? '').trim()) return null
    return { ...narration, trigger }
  }

  async renderCriticalMoment({ events: allEvents = [], state = {}, viewer = {}, recentNarrations = [], playerNote = '', actorId = '' } = {}) {
    const trigger = criticalMomentFor(allEvents, state) ?? heroFlourishFor(allEvents, state, { playerNote, actorId })
    if (!trigger) return null
    const heroMoment = ['hero_fallen', 'hero_died'].includes(trigger.kind)
    const focused = heroMoment ? heroMomentEvents(allEvents, trigger) : []
    const events = focused.length ? focused : allEvents
    const brief = buildNarrationBrief({
      visible_events: events,
      visible_state_changes: events.map((event) => ({
        event_type: event.event_type,
        actor_id: event.actor_id ?? null,
        target_ids: event.target_ids ?? [],
        payload: event.payload ?? {},
        source_rule_ids: event.source_rule_ids ?? [],
        visibility: event.visibility ?? 'public',
      })),
      known_environment: {
        ...publicEnvironment(state, trigger),
        // Слова игрока — его заявка к этому ходу: рассказчик вплетает их, а не
        // повторяет; эхо срезается так же, как у свободного действия.
        ...(trigger.note ? { player_intent: { action: trigger.note } } : {}),
      },
      permitted_npc_reactions: trigger.kind === 'enemy_fled' || trigger.kind === 'enemy_surrendered'
        ? [{ actor_id: trigger.target_id, reaction: trigger.kind }]
        : [],
      viewer,
    })
    const knownRuleIds = [...new Set(events.flatMap((event) => event.source_rule_ids ?? []))]
    const narration = await this.narrator.render(brief, {
      knownRuleIds,
      timeoutMs: CRITICAL_NARRATION_TIMEOUT_MS,
      recentNarrations: (Array.isArray(recentNarrations) ? recentNarrations : []).map((text) => String(text ?? '')).filter(Boolean),
      style: trigger.kind === 'hero_fallen'
        // Замер 27: «падает без сознания, и у скал видна пена» — строка, а
        // не момент; и никто не позвал товарища на помощь.
        ? 'Три-четыре фразы о падении героя без сознания: удар, как он падает, что видно вокруг, — и ясно, что жизнь ещё теплится. Закончи зовом к тому, кто из героев (participants.heroes) может успеть, по имени: «Борин, она в трёх шагах — успеешь?». Герой ещё не объявлен мёртвым: не описывай смерть, предсмертные слова, похороны или окончательный исход. За живых героев не решай. Не пиши о ходах, очереди и правилах. Не добавляй новых бросков, урона, наград или решений правил.'
        : trigger.kind === 'hero_died'
          ? 'Один выразительный абзац об окончательной смерти героя — главный момент вечера. Покажи последний миг: взгляд, движение, то, что осталось несказанным, по fallen_hero (его узы и предыстория — то, ради чего он пришёл), и как замирает поле боя. Не пиши о ходах, очереди и правилах, не говори за живых героев. Не воскрешай героя и не продолжай историю за него. Не добавляй новых бросков, урона, наград или решений правил.'
          : trigger.kind === 'hero_flourish'
            // Замер 9: «Борин прикрывает Мирель щитом, но удар проходит мимо» —
            // пересказ заявки игрока, которая уже стоит в летописи.
            // Игрок описал поступок словами — ответ сценой, а не сухим
            // «снаряд проходит мимо» (владелец, 2026-10-12; замеры 19–31).
            ? 'Две-три фразы о поступке героя — сцена, а не строка журнала. Заявка игрока уже в летописи: не пересказывай её, а покажи, как это выглядело — движение, звук, лицо врага, — как ответил противник и что изменилось на поле по field (кто где, кто ранен, кто рядом). Боевой клич можно коротко подхватить цитатой. Исход — попадание, промах, урон — только из событий, словами, без чисел; не добавляй бросков, урона, наград и решений правил.'
            : 'Один выразительный абзац о переломном моменте. Не добавляй новых бросков, урона, наград или решений правил.',
    })
    // Живой текст не пришёл — короткая реплика о моменте, а не повтор строки боя.
    // У слов героя запасной реплики нет: строка боя и его собственная реплика
    // уже в летописи.
    const deterministic = /^deterministic/u.test(String(narration?.provider ?? ''))
    if (deterministic && trigger.kind === 'hero_flourish') return { ...narration, narration: '', trigger }
    const fallback = deterministic ? criticalMomentLine(trigger, allEvents) : ''
    return { ...narration, ...(fallback ? { narration: fallback } : {}), trigger }
  }
}
