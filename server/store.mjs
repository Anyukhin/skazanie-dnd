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

const emptyAuth = { users: [], sessions: [] }

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
  db.sessions = db.sessions.filter((session) => session.expiresAt > Date.now())
  return db
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, heroIds: user.heroIds ?? [], role: user.role ?? 'player', engineMode: user.engineMode ?? null, createdAt: user.createdAt }
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
  return publicUser(user)
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
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? publicUser(user) : null
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
  return user ? publicUser(user) : null
}

export function deleteSession(token) {
  if (!token) return
  const db = readAuth()
  db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash(token))
  atomicWrite(authFile, db)
}

export function listUsers() {
  return readAuth().users.map(publicUser)
}

export function updateUserAccess(userId, patch) {
  const db = readAuth()
  const user = db.users.find((item) => item.id === userId)
  if (!user) throw new Error('Пользователь не найден')
  if (Array.isArray(patch.heroIds)) user.heroIds = [...new Set(patch.heroIds.map(String).filter((id) => /^[a-z0-9-]{1,40}$/i.test(id)))]
  if (typeof patch.name === 'string' && patch.name.trim()) user.name = patch.name.trim().slice(0, 60)
  if (patch.role === 'admin' || patch.role === 'player') user.role = patch.role
  if (patch.engineMode === null || ['legacy', 'shadow', 'enforce'].includes(patch.engineMode)) user.engineMode = patch.engineMode
  atomicWrite(authFile, db)
  return publicUser(user)
}

function roomFile(code) {
  const safeCode = String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
  if (!safeCode) throw new Error('Некорректный код комнаты')
  return join(roomsDir, `${safeCode}.json`)
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
