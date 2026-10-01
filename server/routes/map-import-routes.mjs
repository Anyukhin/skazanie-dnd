// @ts-check
/**
 * Импорт карты из TaleSpire: `POST /api/campaigns/:id/map-import`.
 *
 * Два режима одного маршрута:
 * - `mode: 'preview'` — разбор слэба без записи: этажи, сводка и
 *   предупреждения. Ведущий смотрит карту до того, как её увидят игроки;
 * - `mode: 'apply'` — команда `ImportLocationMap` через общий исполнитель.
 *   Полномочие ведущего передаётся флагом контекста, который ставит только
 *   этот маршрут; Rules Engine без флага команду не исполняет.
 *
 * Предпросмотр и применение зовут один и тот же `importTaleSpireSlab`, поэтому
 * показанное и записанное совпадают для одного и того же слэба.
 */
import { createHash } from 'node:crypto'

import { sceneLocationId } from '../adventure-director.mjs'
import { campaignIsReadOnly } from '../campaign-lifecycle.mjs'
import { TaleSpireImportError, importTaleSpireSlab } from '../talespire-import.mjs'
import { SLAB_MAX_TEXT_LENGTH, TaleSpireSlabError } from '../talespire-slab.mjs'
import { worldLocationById } from '../world-map.mjs'

const CONFLICT_CODES = new Set(['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'MAP_IMPORT_DURING_COMBAT'])

/**
 * @param {{
 *   requireUser: (req: any, res: any) => any,
 *   getRoom: (campaignId: string) => any,
 *   campaignMembershipFor: (userId: string, campaignId: string) => any,
 *   readBody: (req: any) => Promise<any>,
 *   json: (res: any, status: number, body: unknown) => void,
 *   eventStore: { getByIdempotencyKey: (campaignId: string, key: string) => Promise<any> },
 *   authoritativeExecutor: { executeCommands: (input: any) => Promise<any> },
 *   persistAuthoritativeProjection: (campaignId: string, state: any, events: any[], journal?: any, options?: any) => any,
 *   campaignHeroIds: (user: any, campaignId: string) => string[],
 *   viewerStateFor: (state: any, user: any, actorId: string) => any,
 * }} deps
 */
export function createMapImportRoutes(deps) {
  const { requireUser, getRoom, campaignMembershipFor, readBody, json, eventStore, authoritativeExecutor,
    persistAuthoritativeProjection, campaignHeroIds, viewerStateFor } = deps
  /** @param {any} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => { json(res, status, body); return true }

  /**
   * @param {any} req
   * @param {any} res
   * @param {string} requestPath
   * @returns {Promise<boolean>}
   */
  return async function handleMapImportRoute(req, res, requestPath) {
    const match = requestPath.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/map-import$/u)
    if (!match) return false
    if (req.method !== 'POST') return send(res, 405, { error: 'Метод не поддерживается' })
    const user = requireUser(req, res); if (!user) return true
    const campaignId = match[1].toUpperCase()
    try {
      const room = getRoom(campaignId)
      if (!room?.state) return send(res, 404, { error: 'Кампания не найдена' })
      const membership = campaignMembershipFor(user.id, campaignId)
      if (user.role !== 'admin' && membership?.role !== 'owner') {
        return send(res, 403, { error: 'Загружать карту может только ведущий кампании', code: 'MAP_IMPORT_FORBIDDEN' })
      }
      const body = await readBody(req)
      const slab = typeof body.slab === 'string' ? body.slab : ''
      if (!slab.trim()) return send(res, 400, { error: 'Вставьте строку слэба TaleSpire', code: 'SLAB_EMPTY' })
      if (slab.length > SLAB_MAX_TEXT_LENGTH) return send(res, 400, { error: 'Слэб длиннее, чем допускает TaleSpire', code: 'SLAB_TOO_LARGE' })
      const state = room.state
      const currentLocationId = sceneLocationId(state)
      const locationId = String(body.location_id ?? '').trim().slice(0, 120) || currentLocationId
      const location = worldLocationById(state.worldMap, locationId)
      const current = locationId === currentLocationId
      if (!locationId || (!current && !location)) {
        return send(res, 400, { error: 'Такой локации нет на карте мира кампании', code: 'MAP_IMPORT_LOCATION_UNKNOWN' })
      }
      const locationInfo = {
        id: locationId,
        name: String(location?.name ?? (current ? state.scene?.location : '') ?? locationId).slice(0, 120) || locationId,
        current,
      }

      if (body.mode !== 'apply') {
        const preview = importTaleSpireSlab(slab, { locationId, theme: current ? String(state.scene?.theme ?? '').slice(0, 60) : '' })
        return send(res, 200, { mode: 'preview', location: locationInfo, ...preview })
      }

      // Пауза не мешает: ведущему как раз удобно готовить карты, пока кампания
      // стоит. Завершённая и архивная кампании доступны только для чтения.
      if (campaignIsReadOnly(state)) {
        return send(res, 409, { error: 'Завершённая или архивная кампания доступна только для чтения', code: 'CAMPAIGN_READ_ONLY' })
      }
      const idempotencyKey = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim().slice(0, 200)
      if (!idempotencyKey) return send(res, 400, { error: 'Нужен idempotency_key', code: 'IDEMPOTENCY_KEY_REQUIRED' })
      // Повтор того же ключа с другим слэбом — не повтор, а ошибка клиента.
      const slabHash = createHash('sha256').update(slab).digest('hex')
      const previous = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      if (previous) {
        const recorded = previous.events?.find((/** @type {any} */ event) => event?.event_type === 'LocationMapImported')
        if (!recorded || recorded.payload?.source?.sha256 !== slabHash || recorded.payload?.location_id !== locationId) {
          return send(res, 409, { error: 'Этот idempotency_key уже использован для другого импорта', code: 'IDEMPOTENCY_CONFLICT' })
        }
      }
      const committed = await authoritativeExecutor.executeCommands({
        campaignId,
        idempotencyKey,
        commands: [{
          command_type: 'ImportLocationMap',
          command_id: `map-import:${createHash('sha256').update(`${campaignId}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`,
          location_id: locationId,
          slab,
        }],
        context: { mapImportAuthorized: true },
      })
      const duplicate = Boolean(committed.replayed || committed.duplicate)
      // Повтор ключа ничего не пишет: и журнал, и проекция комнаты остаются
      // теми, что сохранил первый запрос, — отдаётся текущее состояние комнаты.
      const projected = duplicate
        ? { state: getRoom(campaignId)?.state ?? committed.state, version: getRoom(campaignId)?.version }
        : persistAuthoritativeProjection(campaignId, committed.state, committed.events ?? [], null, { forceProjectorRefresh: true })
      const responseState = projected?.state ?? committed.state
      const actorId = campaignHeroIds(user, campaignId)
        .find((id) => responseState.players?.some((/** @type {any} */ player) => String(player.id) === String(id))) ?? ''
      const event = (committed.events ?? []).find((/** @type {any} */ candidate) => candidate?.event_type === 'LocationMapImported')
      return send(res, 200, {
        mode: 'apply',
        location: locationInfo,
        duplicate,
        applied_to_scene: event?.payload?.applied_to_scene === true,
        levels: (event?.payload?.levels ?? []).map((/** @type {any} */ level) => ({ index: level.index, label: level.label })),
        warnings: event?.payload?.warnings ?? [],
        version: projected?.version ?? room.version,
        state: viewerStateFor(responseState, user, actorId),
      })
    } catch (error) {
      const code = /** @type {any} */ (error)?.code
      const known = error instanceof TaleSpireSlabError || error instanceof TaleSpireImportError || typeof code === 'string'
      if (!known) throw error
      return send(res, CONFLICT_CODES.has(code) ? 409 : 400, {
        error: error instanceof Error ? error.message : 'Не удалось загрузить карту',
        code,
      })
    }
  }
}
