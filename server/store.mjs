import 'dotenv/config'
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'

const scrypt = promisify(scryptCallback)
export const storageDir = process.env.DND_STORAGE_DIR ? resolve(process.env.DND_STORAGE_DIR) : join(process.cwd(), 'storage')
const authFile = join(storageDir, 'auth.json')
const roomsDir = join(storageDir, 'rooms')
mkdirSync(roomsDir, { recursive: true })

const emptyAuth = { users: [], sessions: [], memberships: [], invites: [] }

export class StorageCorruptionError extends Error {
  constructor(file, cause) {
    super(`Хранилище повреждено и не будет перезаписано автоматически: ${file}`, { cause })
    this.name = 'StorageCorruptionError'
    this.file = file
  }
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return structuredClone(fallback)
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { throw new StorageCorruptionError(file, error) }
}

export function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

function readAuth() {
  const db = existsSync(authFile) ? readJson(authFile, emptyAuth) : structuredClone(emptyAuth)
  db.users = Array.isArray(db.users) ? db.users : []
  db.sessions = Array.isArray(db.sessions) ? db.sessions : []
  db.memberships = Array.isArray(db.memberships) ? db.memberships : []
  db.invites = Array.isArray(db.invites) ? db.invites : []
  db.sessions = db.sessions.filter((session) => session.expiresAt > Date.now())
  return db
}

function publicUser(user, db = null) {
  const memberships = (db?.memberships ?? [])
    .filter((membership) => membership.userId === user.id && membership.status !== 'revoked')
    .map(({ campaignId, role, heroIds, joinedAt }) => ({ campaignId, role, heroIds: heroIds ?? [], joinedAt }))
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    heroIds: user.heroIds ?? [],
    campaignMemberships: memberships,
    role: user.role ?? 'player',
    engineMode: user.engineMode === 'enforce' ? 'enforce' : null,
    createdAt: user.createdAt,
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function buildUser({ email, password, name, role = 'player', heroIds = [] }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error('Укажите корректную почту')
  if (String(password || '').length < 10) throw new Error('Пароль должен содержать не менее 10 символов')
  const salt = randomBytes(16).toString('hex')
  const hash = await scrypt(String(password), salt, 64)
  const db = readAuth()
  if (db.users.some((user) => user.email === normalizedEmail)) throw new Error('Аккаунт с такой почтой уже существует')
  const user = {
    id: randomUUID(), email: normalizedEmail, name: String(name || '').trim().slice(0, 60) || normalizedEmail.split('@')[0],
    passwordSalt: salt, passwordHash: Buffer.from(hash).toString('hex'), heroIds, role, createdAt: Date.now(),
  }
  db.users.push(user)
  atomicWrite(authFile, db)
  return publicUser(user, db)
}

export async function registerUser(input) {
  return buildUser({ ...input, role: 'player', heroIds: [] })
}

export function hasAdmin() {
  return readAuth().users.some((user) => user.role === 'admin')
}

export async function createAdmin(input, setupToken) {
  const expected = String(process.env.ADMIN_SETUP_TOKEN || '')
  if (!expected || String(setupToken || '') !== expected) throw new Error('Неверный код первоначальной настройки')
  if (hasAdmin()) throw new Error('Учётная запись администратора уже создана')
  return buildUser({ ...input, role: 'admin', heroIds: [] })
}

export async function verifyUser(email, password) {
  const db = readAuth()
  const user = db.users.find((item) => item.email === String(email || '').trim().toLowerCase())
  if (!user) return null
  const actual = Buffer.from(await scrypt(String(password || ''), user.passwordSalt, 64))
  const expected = Buffer.from(user.passwordHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? publicUser(user, db) : null
}

export function createSession(userId) {
  const db = readAuth()
  const token = randomBytes(32).toString('base64url')
  db.sessions.push({ tokenHash: tokenHash(token), userId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 })
  atomicWrite(authFile, db)
  return token
}

export function userForToken(token) {
  if (!token) return null
  const db = readAuth()
  const session = db.sessions.find((item) => item.tokenHash === tokenHash(token))
  const user = session && db.users.find((item) => item.id === session.userId)
  return user ? publicUser(user, db) : null
}

export function deleteSession(token) {
  if (!token) return
  const db = readAuth()
  db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash(token))
  atomicWrite(authFile, db)
}

export function listUsers() {
  const db = readAuth()
  return db.users.map((user) => publicUser(user, db))
}

export function updateUserAccess(userId, patch) {
  const db = readAuth()
  const user = db.users.find((item) => item.id === userId)
  if (!user) throw new Error('Пользователь не найден')
  if (Array.isArray(patch.heroIds)) user.heroIds = [...new Set(patch.heroIds.map(String).filter((id) => /^[a-z0-9-]{1,40}$/i.test(id)))]
  if (typeof patch.name === 'string' && patch.name.trim()) user.name = patch.name.trim().slice(0, 60)
  if (patch.role === 'admin' || patch.role === 'player') user.role = patch.role
  if (patch.engineMode === null || patch.engineMode === 'enforce') user.engineMode = patch.engineMode
  atomicWrite(authFile, db)
  return publicUser(user, db)
}

function normalizeCampaignId(campaignId) {
  const normalized = String(campaignId || '').toUpperCase()
  if (!/^[A-Z0-9-]{3,24}$/.test(normalized)) throw new Error('Некорректный код кампании')
  return normalized
}

function normalizeHeroIds(heroIds) {
  return [...new Set((Array.isArray(heroIds) ? heroIds : []).map(String).filter((id) => /^[a-z0-9-]{1,40}$/i.test(id)))]
}

export function campaignMembershipFor(userId, campaignId) {
  const normalized = normalizeCampaignId(campaignId)
  const db = readAuth()
  const membership = db.memberships.find((item) => item.userId === userId && item.campaignId === normalized && item.status !== 'revoked')
  return membership ? structuredClone(membership) : null
}

export function campaignHasMemberships(campaignId) {
  const normalized = normalizeCampaignId(campaignId)
  return readAuth().memberships.some((item) => item.campaignId === normalized && item.status !== 'revoked')
}

export function listCampaignMemberships(campaignId) {
  const normalized = normalizeCampaignId(campaignId)
  return readAuth().memberships
    .filter((item) => item.campaignId === normalized && item.status !== 'revoked')
    .map((item) => structuredClone(item))
}

export function upsertCampaignMembership({ campaignId, userId, role = 'player', heroIds = [] }) {
  const normalized = normalizeCampaignId(campaignId)
  const db = readAuth()
  if (!db.users.some((user) => user.id === userId)) throw new Error('Пользователь не найден')
  const cleanHeroIds = normalizeHeroIds(heroIds)
  const existing = db.memberships.find((item) => item.campaignId === normalized && item.userId === userId)
  if (existing) {
    existing.role = role === 'owner' ? 'owner' : 'player'
    existing.heroIds = cleanHeroIds
    existing.status = 'active'
  } else {
    db.memberships.push({
      campaignId: normalized,
      userId,
      role: role === 'owner' ? 'owner' : 'player',
      heroIds: cleanHeroIds,
      status: 'active',
      joinedAt: Date.now(),
    })
  }
  atomicWrite(authFile, db)
  return structuredClone(db.memberships.find((item) => item.campaignId === normalized && item.userId === userId))
}

export function createCampaignInvite({ campaignId, createdBy, heroIds = [], expiresInMs = 7 * 24 * 60 * 60 * 1000 }) {
  const normalized = normalizeCampaignId(campaignId)
  const db = readAuth()
  const creator = db.memberships.find((item) => item.campaignId === normalized && item.userId === createdBy && item.status !== 'revoked')
  const account = db.users.find((user) => user.id === createdBy)
  if (account?.role !== 'admin' && creator?.role !== 'owner') throw new Error('Создавать приглашения может только владелец кампании')
  const token = randomBytes(32).toString('base64url')
  const invite = {
    id: randomUUID(),
    campaignId: normalized,
    tokenHash: tokenHash(token),
    role: 'player',
    heroIds: normalizeHeroIds(heroIds),
    createdBy,
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(60_000, Math.min(Number(expiresInMs) || 0, 30 * 24 * 60 * 60 * 1000)),
    usedAt: null,
    usedBy: null,
    revokedAt: null,
  }
  db.invites.push(invite)
  atomicWrite(authFile, db)
  return { token, invite: structuredClone(invite) }
}

export function redeemCampaignInvite({ campaignId, token, userId }) {
  const normalized = normalizeCampaignId(campaignId)
  const db = readAuth()
  const invite = db.invites.find((item) => item.campaignId === normalized && item.tokenHash === tokenHash(String(token || '')))
  if (!invite || invite.revokedAt) throw new Error('Приглашение недействительно')
  if (invite.expiresAt <= Date.now()) throw new Error('Срок действия приглашения истёк')
  if (invite.usedAt && invite.usedBy !== userId) throw new Error('Приглашение уже использовано')
  const existing = db.memberships.find((item) => item.campaignId === normalized && item.userId === userId)
  if (invite.usedAt && invite.usedBy === userId && existing) return { membership: structuredClone(existing), duplicate: true }
  if (existing) throw new Error('Вы уже состоите в этой кампании')
  const assignedElsewhere = new Set(db.memberships
    .filter((item) => item.campaignId === normalized && item.status !== 'revoked')
    .flatMap((item) => item.heroIds ?? []))
  if (invite.heroIds.some((heroId) => assignedElsewhere.has(heroId))) throw new Error('Герой из приглашения уже назначен другому игроку')
  const membership = {
    campaignId: normalized,
    userId,
    role: invite.role,
    heroIds: normalizeHeroIds(invite.heroIds),
    status: 'active',
    joinedAt: Date.now(),
  }
  db.memberships.push(membership)
  invite.usedAt = Date.now()
  invite.usedBy = userId
  atomicWrite(authFile, db)
  return { membership: structuredClone(membership), duplicate: false }
}

function roomFile(code) {
  const safeCode = String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
  if (!safeCode) throw new Error('Некорректный код комнаты')
  return join(roomsDir, `${safeCode}.json`)
}

const roomSaveListeners = new Set()

export function onRoomSaved(listener) {
  if (typeof listener !== 'function') throw new TypeError('Room save listener must be a function')
  roomSaveListeners.add(listener)
  return () => roomSaveListeners.delete(listener)
}

export function getRoom(code) {
  const room = readJson(roomFile(code), { version: 0, state: null, updatedAt: null })
  if (!room || typeof room !== 'object' || !Number.isSafeInteger(Number(room.version)) || Number(room.version) < 0) {
    throw new StorageCorruptionError(roomFile(code), new Error('Некорректная структура комнаты'))
  }
  return { version: Number(room.version), state: room.state ?? null, updatedAt: room.updatedAt ?? null }
}

export function saveRoom(code, state, baseVersion) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Состояние комнаты должно быть объектом')
  const file = roomFile(code)
  const current = getRoom(code)
  if (Number(baseVersion) !== current.version) return { conflict: true, room: current }
  // Loading progress belongs to an in-flight browser request, not to the
  // campaign. Persisting it makes a closed tab look busy forever.
  const persistentState = { ...state, isNarrating: false }
  const room = { version: current.version + 1, state: structuredClone(persistentState), updatedAt: new Date().toISOString() }
  atomicWrite(file, room)
  for (const listener of roomSaveListeners) {
    try { listener(String(code || '').toUpperCase(), structuredClone(room)) }
    catch { /* realtime delivery is best effort; persisted room remains valid */ }
  }
  return { conflict: false, room }
}

export function listRoomCodes() {
  return readdirSync(roomsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[A-Z0-9-]+\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -5))
}

export function storagePaths() {
  return { storageDir, authFile, roomsDir }
}
