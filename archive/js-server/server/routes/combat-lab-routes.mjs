/**
 * Маршруты боевого стенда администратора: `/api/admin/combat-lab/*`.
 *
 * Первый модуль маршрутов, вынесенный из `server/index.mjs`. Обработчик
 * получает зависимости при создании, а не из глобальной области сервера, и
 * возвращает `true`, если запрос его и ответ уже отправлен; иначе `false`,
 * и сервер идёт к следующим маршрутам в прежнем порядке.
 */

/**
 * @param {{
 *   combatLabRuns: import('../combat-lab.mjs').CombatLabRuns,
 *   CombatLabError: typeof import('../combat-lab.mjs').CombatLabError,
 *   requireAdmin: (req: any, res: any) => any,
 *   readBody: (req: any) => Promise<any>,
 *   json: (res: any, status: number, body: unknown) => void,
 * }} deps
 */
export function createCombatLabRoutes({ combatLabRuns, CombatLabError, requireAdmin, readBody, json }) {
  const send = (res, status, body) => { json(res, status, body); return true }
  return async function handleCombatLabRoute(req, res, requestPath) {
    if (!requestPath.startsWith('/api/admin/combat-lab/')) return false
    if (requestPath === '/api/admin/combat-lab/scenarios' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return true
      return send(res, 200, { scenarios: combatLabRuns.scenarios() })
    }
    if (requestPath === '/api/admin/combat-lab/catalog' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return true
      try { return send(res, 200, await combatLabRuns.catalog()) }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : 'Не удалось загрузить каталог боевого стенда', code: error?.code }) }
    }
    if (['/api/admin/combat-lab/encounter/assess', '/api/admin/combat-lab/encounter/generate'].includes(requestPath) && req.method === 'POST') {
      const admin = requireAdmin(req, res); if (!admin) return true
      try {
        const body = await readBody(req)
        const result = requestPath.endsWith('/generate')
          ? await combatLabRuns.generateEncounter(body)
          : await combatLabRuns.assessEncounter(body)
        return send(res, 200, result)
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : 'Не удалось рассчитать стычку', code: error?.code })
      }
    }
    if (requestPath === '/api/admin/combat-lab/runs' && req.method === 'GET') {
      const admin = requireAdmin(req, res); if (!admin) return true
      return send(res, 200, { activeRun: combatLabRuns.active() })
    }
    if (requestPath === '/api/admin/combat-lab/runs' && req.method === 'POST') {
      const admin = requireAdmin(req, res); if (!admin) return true
      try {
        const body = await readBody(req)
        const run = await combatLabRuns.create({ scenario: body.scenario, seed: body.seed, config: body.config })
        return send(res, 202, { id: run.id })
      } catch (error) {
        const status = error instanceof CombatLabError ? error.status : 400
        return send(res, status, { error: error instanceof Error ? error.message : 'Не удалось запустить боевой стенд', code: error?.code })
      }
    }
    const combatLabRunMatch = requestPath.match(/^\/api\/admin\/combat-lab\/runs\/([^/]+)(\/report)?$/u)
    if (combatLabRunMatch && (req.method === 'GET' || req.method === 'DELETE')) {
      const admin = requireAdmin(req, res); if (!admin) return true
      const id = decodeURIComponent(combatLabRunMatch[1])
      if (combatLabRunMatch[2]) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Отчёт доступен только для чтения' })
        const report = combatLabRuns.report(id)
        if (!report) return send(res, 404, { error: 'Прогон боевого стенда не найден' })
        res.setHeader('Content-Disposition', `attachment; filename="combat-lab-report.json"`)
        return send(res, 200, report)
      }
      if (req.method === 'GET') {
        const rawAfter = new URL(req.url, 'http://skazanie.local').searchParams.get('after')
        const after = rawAfter == null ? -1 : Number(rawAfter)
        if (!Number.isSafeInteger(after) || after < -1 || after > 2000) return send(res, 400, { error: 'Некорректный номер последнего кадра' })
        const run = combatLabRuns.get(id, after)
        return run ? send(res, 200, run) : send(res, 404, { error: 'Прогон боевого стенда не найден', code: 'COMBAT_LAB_RUN_NOT_FOUND' })
      }
      try {
        const run = await combatLabRuns.cancel(id)
        return run ? send(res, 202, run) : send(res, 404, { error: 'Прогон боевого стенда не найден', code: 'COMBAT_LAB_RUN_NOT_FOUND' })
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : 'Не удалось отменить прогон', code: error?.code })
      }
    }
    return false
  }
}
