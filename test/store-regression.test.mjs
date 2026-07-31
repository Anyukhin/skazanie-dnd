import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function fixture() {
  return {
    sessionCode: 'CAMP-1', campaign: 'Регрессионная кампания', activePlayerId: 'hero', isNarrating: false,
    messages: [{ id: 'm1', speaker: 'player', author: 'Ада', text: 'Осматриваю дверь', timestamp: '12:00' }],
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Комната', objective: 'Найти выход', turn: 1, cells: [] },
  }
}

test('legacy-кампания, персонаж и история сохраняются и восстанавливаются после reload модуля', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-store-'))
  process.env.DND_STORAGE_DIR = root
  const first = await import(`../server/store.mjs?first=${Date.now()}`)
  const created = first.saveRoom('CAMP-1', fixture(), 0)
  assert.equal(created.conflict, false)
  assert.equal(first.getRoom('CAMP-1').state.messages[0].text, 'Осматриваю дверь')
  assert.equal(first.getRoom('CAMP-1').state.players[0].character, 'Ада')

  const second = await import(`../server/store.mjs?second=${Date.now()}`)
  const restored = second.getRoom('CAMP-1')
  assert.equal(restored.version, 1)
  assert.equal(restored.state.campaign, 'Регрессионная кампания')
  assert.equal(restored.state.players[0].hp, 10)
  assert.deepEqual(second.listRoomCodes(), ['CAMP-1'])
})

test('optimistic locking не позволяет затереть более новую комнату', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-lock-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?lock=${Date.now()}`)
  assert.equal(store.saveRoom('LOCK-1', fixture(), 0).conflict, false)
  const conflict = store.saveRoom('LOCK-1', { ...fixture(), campaign: 'Устаревшая запись' }, 0)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.room.state.campaign, 'Регрессионная кампания')
})

test('повреждённый JSON не заменяется пустым состоянием', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-corrupt-'))
  mkdirSync(join(root, 'rooms'), { recursive: true })
  writeFileSync(join(root, 'rooms', 'BROKEN.json'), '{not json', 'utf8')
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?corrupt=${Date.now()}`)
  assert.throws(() => store.getRoom('BROKEN'), (error) => error instanceof store.StorageCorruptionError)
})

test('transient narration progress is never persisted as campaign state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-transient-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?transient=${Date.now()}`)
  const saved = store.saveRoom('LOADING-1', { ...fixture(), isNarrating: true }, 0)
  assert.equal(saved.conflict, false)
  assert.equal(saved.room.state.isNarrating, false)
  assert.equal(store.getRoom('LOADING-1').state.isNarrating, false)
})

test('два параллельных createSession не теряют сессии в auth.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-auth-race-'))
  writeFileSync(join(root, 'auth.json'), JSON.stringify({
    users: [{ id: 'user-1', email: 'race@example.test', name: 'Race', role: 'player', heroIds: [] }],
    sessions: [], memberships: [], invites: [],
  }), 'utf8')
  const childCode = "const { createSession } = await import('./server/store.mjs'); createSession('user-1')"
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, DND_STORAGE_DIR: root },
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)))
  })
  await Promise.all([runChild(), runChild()])
  const auth = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'))
  assert.equal(auth.sessions.length, 2)
})

test('legacy campaign invites remain scoped, single-use and idempotent for the same account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-membership-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?membership=${Date.now()}`)
  const owner = await store.registerUser({ name: 'Owner', email: 'owner@membership.test', password: 'secure-owner-password' })
  const guest = await store.registerUser({ name: 'Guest', email: 'guest@membership.test', password: 'secure-guest-password' })
  const intruder = await store.registerUser({ name: 'Intruder', email: 'intruder@membership.test', password: 'secure-intruder-password' })

  store.upsertCampaignMembership({ campaignId: 'CAMP-A', userId: owner.id, role: 'owner', heroIds: ['hero'] })
  store.upsertCampaignMembership({ campaignId: 'CAMP-B', userId: intruder.id, role: 'owner', heroIds: ['hero'] })
  const issued = store.createCampaignInvite({ campaignId: 'CAMP-A', createdBy: owner.id, heroIds: ['guest-hero'] })
  const redeemed = store.redeemCampaignInvite({ campaignId: 'CAMP-A', token: issued.token, userId: guest.id })
  assert.deepEqual(redeemed.membership.heroIds, ['guest-hero'])
  assert.equal(store.redeemCampaignInvite({ campaignId: 'CAMP-A', token: issued.token, userId: guest.id }).duplicate, true)
  assert.throws(
    () => store.redeemCampaignInvite({ campaignId: 'CAMP-A', token: issued.token, userId: intruder.id }),
    /уже использовано/u,
  )
  assert.deepEqual(store.campaignMembershipFor(owner.id, 'CAMP-A').heroIds, ['hero'])
  assert.deepEqual(store.campaignMembershipFor(intruder.id, 'CAMP-B').heroIds, ['hero'])
})

test('one table invite atomically assigns one free hero to each account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-table-invite-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?table-invite=${Date.now()}`)
  const owner = await store.registerUser({ name: 'Owner', email: 'owner@table-invite.test', password: 'secure-owner-password' })
  const firstGuest = await store.registerUser({ name: 'First', email: 'first@table-invite.test', password: 'secure-first-password' })
  const secondGuest = await store.registerUser({ name: 'Second', email: 'second@table-invite.test', password: 'secure-second-password' })
  const extraGuest = await store.registerUser({ name: 'Extra', email: 'extra@table-invite.test', password: 'secure-extra-password' })

  store.upsertCampaignMembership({ campaignId: 'TABLE-A', userId: owner.id, role: 'owner', heroIds: ['hero-1'] })
  const issued = store.createCampaignInvite({
    campaignId: 'TABLE-A',
    createdBy: owner.id,
    heroIds: ['hero-2', 'hero-3'],
    multiUse: true,
  })

  assert.deepEqual(
    store.redeemCampaignInvite({ campaignId: 'TABLE-A', token: issued.token, userId: firstGuest.id }).membership.heroIds,
    ['hero-2'],
  )
  assert.equal(
    store.redeemCampaignInvite({ campaignId: 'TABLE-A', token: issued.token, userId: firstGuest.id }).duplicate,
    true,
  )
  assert.deepEqual(
    store.redeemCampaignInvite({ campaignId: 'TABLE-A', token: issued.token, userId: secondGuest.id }).membership.heroIds,
    ['hero-3'],
  )
  assert.throws(
    () => store.redeemCampaignInvite({ campaignId: 'TABLE-A', token: issued.token, userId: extraGuest.id }),
    /не осталось свободных героев/u,
  )
})
