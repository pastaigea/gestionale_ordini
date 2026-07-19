import { CheckCircle2, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrandLogo } from '../components/BrandLogo'
import { Button, Field } from '../components/ui'
import { useApp } from '../context/AppContext'

export const PasswordSetupPage = () => {
  const { session, updateOwnPassword } = useApp()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (password.length < 12) {
      setError('Usa almeno 12 caratteri.')
      return
    }
    if (password !== confirmation) {
      setError('Le due password non coincidono.')
      return
    }
    setSaving(true)
    try {
      await updateOwnPassword(password)
      window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`)
      navigate(session?.role === 'admin' ? '/admin' : '/cliente', { replace: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Aggiornamento password non riuscito.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="password-page">
      <section className="password-card" aria-labelledby="password-title">
        <BrandLogo />
        <span className="password-card__icon"><KeyRound size={25} /></span>
        <p className="eyebrow">Account protetto</p>
        <h1 id="password-title">Imposta una nuova password</h1>
        <p className="password-card__intro">Scegli una password privata di almeno 12 caratteri. Non verrà salvata nel sito o nel repository.</p>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Nuova password" htmlFor="new-password" hint="Almeno 12 caratteri">
            <div className="password-input">
              <input
                id="new-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
          <Field label="Conferma password" htmlFor="confirm-password">
            <input
              id="confirm-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={12}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
          {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
          <Button type="submit" size="lg" icon={saving ? undefined : <CheckCircle2 size={18} />} disabled={saving}>
            {saving ? 'Salvataggio…' : 'Salva e accedi'}
          </Button>
        </form>
        <p className="password-card__security"><ShieldCheck size={15} /> La credenziale è gestita dal servizio di autenticazione.</p>
      </section>
    </main>
  )
}
