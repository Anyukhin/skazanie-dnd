import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

const root = mkdtempSync(join(tmpdir(), 'skazanie-membership-lifecycle-'))
const storage = join(root, 'storage')
const emptyEnv = join(root, 'empty.env')
writeFileSync(emptyEnv, '', 'utf8')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился с кодом ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Сервер не стал доступен')
}

async function stopServer(processToStop) {
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return
  await new Promise((resolve) => {
    processToStop.once('exit', resolve)
    processToStop.kill()
  })
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnv, ROUTERAI_API_KEY: '', COOKIE_SECURE: 'false',
      ADMIN_SETUP_TOKEN: 'round11-probe-setup-token', GAME_ENGINE_MODE: 'enforce',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.resume()
  try { await waitForHealth(`http://127.0.0.1:${port}`, child) } catch (error) {
    await stopServer(child)
    throw error
  }
  return child
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* для диагностики сохраняем text */ }
  return { status: response.status, body: parsed, text, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

function state() {
  return {
    sessionCode: 'STALE-SEAT', campaign: 'Stale seat probe', activePlayerId: 'hero-1',
    isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    players: [{ id: 'hero-1', character: 'Existing hero', characterSetupRequired: false, hp: 10, maxHp: 10, inventory: [] }],
    partyMemberIds: ['hero-1'],
    scene: { title: 'Room', location: 'Room', mood: '', objective: '', turn: 0, cells: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce', state_version: 0,
  }
}

let child = null
try {
  process.env.DND_STORAGE_DIR = storage
  process.env.DOTENV_CONFIG_PATH = emptyEnv
  const store = await import(`../../../../server/store.mjs?round11=${Date.now()}`)
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = await startServer(port)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Probe admin', email: 'round11-admin@example.test', password: 'round11-admin-password', setupToken: 'round11-probe-setup-token',
  } })
  assert.equal(admin.status, 201, admin.text)
  const adminCookie = admin.cookie
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Probe guest', email: 'round11-guest@example.test', password: 'round11-guest-password',
  } })
  assert.equal(guest.status, 201, guest.text)
  const guestCookie = guest.cookie

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'STALE-SEAT', name: 'Stale seat probe', state: state() } })
  assert.equal(created.status, 201, created.text)

  // HTTP-маршрут обычно фильтрует hero_ids по комнате. Здесь store-level
  // выдача лишь моделирует уже выданную ссылку после будущего удаления места;
  // штатного HTTP удаления slot в текущем runtime нет.
  const issued = store.createCampaignInvite({ campaignId: 'STALE-SEAT', createdBy: admin.body.user.id, heroIds: ['missing-hero'], multiUse: true })
  const joined = await request(baseUrl, '/api/campaigns/STALE-SEAT/join', { method: 'POST', cookie: guestCookie, body: { invite_token: issued.token } })
  assert.equal(joined.status, 409)

  const auth = JSON.parse(readFileSync(join(storage, 'auth.json'), 'utf8'))
  const guestMembership = auth.memberships.find((membership) => membership.userId === guest.body.user.id)
  const invite = auth.invites.find((candidate) => candidate.id === issued.invite.id)
  assert.deepEqual(guestMembership?.heroIds, ['missing-hero'])
  assert.equal(invite?.redemptions?.length, 1)

  const positiveState = { ...state(), sessionCode: 'POS-SEAT', campaign: 'Positive seat probe', players: [
    { id: 'hero-1', character: 'Open hero 1', characterSetupRequired: true, hp: 10, maxHp: 10, inventory: [] },
    { id: 'hero-2', character: 'Open hero 2', characterSetupRequired: true, hp: 10, maxHp: 10, inventory: [] },
  ], partyMemberIds: ['hero-1', 'hero-2'], activePlayerId: 'hero-1' }
  const positiveCreated = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'POS-SEAT', name: 'Positive seat probe', state: positiveState } })
  assert.equal(positiveCreated.status, 201, positiveCreated.text)
  const positiveInvite = await request(baseUrl, '/api/campaigns/POS-SEAT/invites', { method: 'POST', cookie: adminCookie, body: {} })
  assert.equal(positiveInvite.status, 201, positiveInvite.text)
  const firstJoin = await request(baseUrl, '/api/campaigns/POS-SEAT/join', { method: 'POST', cookie: guestCookie, body: { invite_token: positiveInvite.body.token } })
  assert.equal(firstJoin.status, 200, firstJoin.text)
  assert.deepEqual(firstJoin.body.hero_ids, ['hero-1'])
  const sameAccountRetry = await request(baseUrl, '/api/campaigns/POS-SEAT/join', { method: 'POST', cookie: guestCookie, body: { invite_token: positiveInvite.body.token } })
  assert.equal(sameAccountRetry.status, 200, sameAccountRetry.text)
  assert.equal(sameAccountRetry.body.duplicate, true)
  const secondGuest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Probe second guest', email: 'round11-second@example.test', password: 'round11-second-password',
  } })
  assert.equal(secondGuest.status, 201, secondGuest.text)
  const secondJoin = await request(baseUrl, '/api/campaigns/POS-SEAT/join', { method: 'POST', cookie: secondGuest.cookie, body: { invite_token: positiveInvite.body.token } })
  assert.equal(secondJoin.status, 200, secondJoin.text)
  assert.deepEqual(secondJoin.body.hero_ids, ['hero-2'])

  await stopServer(child)
  child = await startServer(port)
  const campaignsAfterRestart = await request(baseUrl, '/api/campaigns', { cookie: guestCookie })
  assert.equal(campaignsAfterRestart.status, 200, campaignsAfterRestart.text)
  assert.ok(campaignsAfterRestart.body.campaigns.some((campaign) => campaign.code === 'STALE-SEAT'))
  assert.ok(campaignsAfterRestart.body.campaigns.some((campaign) => campaign.code === 'POS-SEAT'))
  const positiveRoomAfterRestart = await request(baseUrl, '/api/rooms/POS-SEAT', { cookie: guestCookie })
  assert.equal(positiveRoomAfterRestart.status, 200, positiveRoomAfterRestart.text)
  assert.ok(positiveRoomAfterRestart.body.state.players.some((player) => player.id === 'hero-1'))
  const accountAfterRestart = await request(baseUrl, '/api/auth/me', { cookie: guestCookie })
  assert.equal(accountAfterRestart.status, 200)
  const positiveMembership = accountAfterRestart.body.user.campaignMemberships.find((entry) => entry.campaignId === 'POS-SEAT')
  assert.deepEqual(positiveMembership?.heroIds, ['hero-1'])
  const staleRoomAfterRestart = await request(baseUrl, '/api/rooms/STALE-SEAT', { cookie: guestCookie })
  assert.equal(staleRoomAfterRestart.status, 200)

  console.log(JSON.stringify({
    join_status: joined.status,
    join_error: joined.body?.error,
    persisted_orphan_hero_id: guestMembership?.heroIds?.[0],
    persisted_orphan_status: guestMembership?.status,
    persisted_redemption_count: invite?.redemptions?.length ?? 0,
    campaigns_after_restart_status: campaignsAfterRestart.status,
    stale_room_after_restart_status: staleRoomAfterRestart.status,
    positive_room_after_restart: { status: positiveRoomAfterRestart.status, assigned_hero_ids: positiveMembership.heroIds },
    positive_first_join: { status: firstJoin.status, hero_ids: firstJoin.body?.hero_ids },
    positive_same_account_retry: { status: sameAccountRetry.status, duplicate: sameAccountRetry.body?.duplicate },
    positive_second_account: { status: secondJoin.status, hero_ids: secondJoin.body?.hero_ids },
  }, null, 2))
} finally {
  await stopServer(child)
  rmSync(root, { recursive: true, force: true })
}
