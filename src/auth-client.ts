import { useCallback, useEffect, useState } from 'react'
import type { Account } from './types'

type AuthResponse = { user?: Account | null; setupRequired?: boolean; error?: string }

async function authRequest(path: string, options?: RequestInit): Promise<AuthResponse> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  const body = await response.json().catch(() => ({})) as AuthResponse
  if (!response.ok) throw new Error(body.error || 'Ошибка авторизации')
  return body
}

export function useAuth() {
  const [user, setUser] = useState<Account | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [setupRequired, setSetupRequired] = useState(false)

  const refresh = useCallback(async () => {
    const result = await authRequest('/api/auth/me')
    setUser(result.user ?? null)
    setSetupRequired(Boolean(result.setupRequired))
    return result.user ?? null
  }, [])

  useEffect(() => {
    refresh().catch(() => setUser(null)).finally(() => setLoading(false))
  }, [refresh])

  const login = useCallback(async (email: string, password: string) => {
    setError('')
    try {
      const result = await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      setUser(result.user ?? null)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Не удалось войти'
      setError(message)
      throw reason
    }
  }, [])

  const register = useCallback(async (name: string, email: string, password: string) => {
    setError('')
    try {
      const result = await authRequest('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) })
      setUser(result.user ?? null)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Не удалось создать аккаунт'
      setError(message)
      throw reason
    }
  }, [])

  const setupAdmin = useCallback(async (name: string, email: string, password: string, setupToken: string) => {
    setError('')
    try {
      const result = await authRequest('/api/auth/setup-admin', { method: 'POST', body: JSON.stringify({ name, email, password, setupToken }) })
      setUser(result.user ?? null)
      setSetupRequired(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать администратора')
      throw reason
    }
  }, [])

  const logout = useCallback(async () => {
    await authRequest('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => null)
    setUser(null)
  }, [])

  return { user, loading, error, setupRequired, login, register, setupAdmin, logout, refresh }
}
