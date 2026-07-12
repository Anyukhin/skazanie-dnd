import { useEffect, useState } from 'react'
import { ArrowRight, Dices, KeyRound, Mail, ShieldCheck, Sparkles, UserRound } from 'lucide-react'

export function AuthScreen({ loading, error, setupRequired, onLogin, onRegister, onSetupAdmin }: {
  loading: boolean
  error: string
  setupRequired: boolean
  onLogin: (email: string, password: string) => Promise<void>
  onRegister: (name: string, email: string, password: string) => Promise<void>
  onSetupAdmin: (name: string, email: string, password: string, setupToken: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'setup'>(setupRequired ? 'setup' : 'login')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState(() => new URLSearchParams(location.search).get('setup') ?? '')

  useEffect(() => { if (setupRequired) setMode('setup') }, [setupRequired])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      if (mode === 'login') await onLogin(email, password)
      else if (mode === 'register') await onRegister(name, email, password)
      else await onSetupAdmin(name, email, password, setupToken)
    } catch { /* Ошибка уже показана над формой. */ }
    finally { setBusy(false) }
  }

  return (
    <main className="auth-screen">
      <div className="auth-ambient auth-ambient-one" /><div className="auth-ambient auth-ambient-two" />
      <section className="auth-story">
        <div className="auth-logo"><i><Dices size={25} /></i><span>СКАЗАНИЕ</span></div>
        <div><span className="auth-eyebrow"><Sparkles size={13} />СОВМЕСТНОЕ ПРИКЛЮЧЕНИЕ</span><h1>У каждого героя<br />есть свой игрок.</h1><p>Войдите в аккаунт, чтобы продолжить историю именно своим персонажем — с его листом, инвентарём и решениями.</p></div>
        <small><ShieldCheck size={14} />Пароль хранится только в виде защищённого хеша. Игровая сессия привязана к вашему браузеру.</small>
      </section>
      <section className="auth-card">
        {mode !== 'setup' && <div className="auth-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Войти</button><button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Создать аккаунт</button></div>}
        <form onSubmit={submit}>
          <span className="auth-form-eyebrow">{mode === 'login' ? 'ВОЗВРАЩЕНИЕ В КАМПАНИЮ' : mode === 'register' ? 'НОВЫЙ УЧАСТНИК' : 'ПЕРВОНАЧАЛЬНАЯ НАСТРОЙКА'}</span>
          <h2>{mode === 'login' ? 'С возвращением' : mode === 'register' ? 'Присоединиться к отряду' : 'Создать администратора'}</h2>
          <p>{mode === 'login' ? 'Ваши герои уже ждут продолжения.' : mode === 'register' ? 'После регистрации администратор назначит вам доступных героев.' : 'Это единственная учётная запись с полным доступом к миру, героям и игрокам.'}</p>
          {mode !== 'login' && <label><span>Имя</span><div><UserRound size={16} /><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Как к вам обращаться" /></div></label>}
          <label><span>Электронная почта</span><div><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="player@example.com" autoComplete="email" /></div></label>
          <label><span>Пароль</span><div><KeyRound size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} placeholder="Минимум 10 символов" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div></label>
          {mode === 'setup' && <label><span>Код первоначальной настройки</span><div><ShieldCheck size={16} /><input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required placeholder="Код автоматически добавлен лаунчером" autoComplete="off" /></div><small>Код находится в `ADMIN_SETUP_TOKEN` файла `.env` и нужен только один раз.</small></label>}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={busy || loading}>{busy || loading ? 'Подождите…' : mode === 'login' ? 'Войти в игру' : mode === 'register' ? 'Создать аккаунт' : 'Создать администратора'}<ArrowRight size={17} /></button>
        </form>
      </section>
    </main>
  )
}
