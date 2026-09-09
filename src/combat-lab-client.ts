export class LabRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function labRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  const body = await response.json()
  if (!response.ok) throw new LabRequestError(body.error || 'Не удалось связаться с боевым стендом', response.status)
  return body as T
}
