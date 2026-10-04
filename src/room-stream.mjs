/*
 * Живой поток комнаты на клиенте: чей это снимок и что делать с кадром отзыва.
 *
 * Очередь снимков (аудит PR #131, REC-04). Пока клиент ждёт ответа своей
 * команды, снимки комнаты из SSE и опроса откладываются и потом применяется
 * самый свежий. Раньше в очереди лежали только номер версии и состояние: игрок
 * переключался с A на B, пока ждал ответа в A, и отложенный снимок A (версия 7)
 * побеждал загруженную B (версия 1) просто большим номером — в адресе B, на
 * экране A. Номера версий разных кампаний принадлежат разным журналам и между
 * собой не сравниваются, поэтому кампания проверяется раньше версии: в каждой
 * записи очереди лежит кампания, из потока которой снимок пришёл, а снимок
 * применяется, только если и источник, и сам снимок — текущая кампания.
 */

const MAX_QUEUED_ROOMS = 50
const MAX_CAMPAIGN_ID_LENGTH = 120
const MAX_REASON_LENGTH = 80

/** Код кампании в том виде, в котором его сравнивают: без пробелов, в верхнем регистре. */
export function campaignKey(value) {
  return String(value ?? '').trim().slice(0, MAX_CAMPAIGN_ID_LENGTH).toUpperCase()
}

/** Одна ли это кампания. Пустой код не совпадает ни с чем, даже с пустым. */
export function sameCampaign(left, right) {
  const key = campaignKey(left)
  return Boolean(key) && key === campaignKey(right)
}

/**
 * Можно ли показать снимок: поток или запрос, из которого он пришёл, и сам
 * снимок относятся к текущей кампании. Проверяется до сравнения версий.
 */
export function roomSnapshotAcceptable(currentCampaignId, sourceCampaignId, state) {
  return sameCampaign(currentCampaignId, sourceCampaignId)
    && sameCampaign(currentCampaignId, state?.sessionCode)
}

/** Откладывает снимок с меткой кампании-источника. Чужой или битый снимок не встаёт в очередь. */
export function enqueueRoomSnapshot(queue, sourceCampaignId, room) {
  const list = Array.isArray(queue) ? queue : []
  const campaignId = campaignKey(sourceCampaignId)
  const version = Number(room?.version)
  if (!room?.state || !Number.isSafeInteger(version) || version < 0) return list
  if (!sameCampaign(campaignId, room.state.sessionCode)) return list
  const next = [...list, { campaignId, version, state: room.state }]
  return next.length > MAX_QUEUED_ROOMS ? next.slice(next.length - MAX_QUEUED_ROOMS) : next
}

/**
 * Самый свежий отложенный снимок текущей кампании новее уже применённой
 * версии. Записи других кампаний не участвуют в сравнении номеров вовсе.
 */
export function takeQueuedRoom(queue, currentCampaignId, appliedVersion) {
  const applied = Number(appliedVersion)
  let latest = null
  for (const candidate of Array.isArray(queue) ? queue : []) {
    if (!roomSnapshotAcceptable(currentCampaignId, candidate?.campaignId, candidate?.state)) continue
    if (!(candidate.version > (Number.isFinite(applied) ? applied : 0))) continue
    if (!latest || candidate.version >= latest.version) latest = candidate
  }
  return latest
}

/** При смене кампании в очереди остаются только снимки той, куда переходят. */
export function queuedRoomsForCampaign(queue, campaignId) {
  return (Array.isArray(queue) ? queue : []).filter((candidate) => sameCampaign(candidate?.campaignId, campaignId))
}

/*
 * Кадр `access` (аудит PR #131, LIVE-01/02). Сервер закрывает поток, у
 * которого больше нет права читать кампанию: после logout, истечения сессии
 * или отзыва доступа приходит `{ status: 'revoked', reason }`, затем конец
 * ответа. Переподключение того же клиента упрётся в 401/403, поэтому для
 * этого потока кадр окончателен: клиент не переподключается вслепую, а один
 * раз сверяет аккаунт и доступ к комнате.
 */

/** Причина отзыва из кадра `access` или `null`, если кадр не про отзыв. */
export function streamAccessRevocation(data) {
  let payload = data
  if (typeof data === 'string') {
    if (data.length > 4_096) return null
    try { payload = JSON.parse(data) } catch { return null }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.status !== 'revoked') return null
  const reason = String(payload.reason ?? '').trim().slice(0, MAX_REASON_LENGTH)
  return { reason: /^[a-z0-9_]+$/u.test(reason) ? reason : 'access_lost' }
}
