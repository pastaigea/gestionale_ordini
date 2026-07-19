import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  LockKeyhole,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrandLogo } from '../components/BrandLogo'
import { Button, Field } from '../components/ui'
import { useApp } from '../context/AppContext'
import { DEMO_ADMIN, DEMO_CUSTOMER } from '../data/demo'
import { configurationError, isSupabaseMode } from '../lib/supabase'

export const LoginPage = () => {
  const { login, isSupabaseConfigured, dataError } = useApp()
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const fillDemo = (role: 'admin' | 'client') => {
    const credentials = role === 'admin' ? DEMO_ADMIN : DEMO_CUSTOMER
    setIdentifier(credentials.email)
    setPassword(credentials.password)
    setError('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const authenticated = await login(identifier, password)
      navigate(authenticated.role === 'admin' ? '/admin' : '/cliente', { replace: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Accesso non riuscito.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="Gestionale ordini Pasta Igea">
        <div className="login-story__glow login-story__glow--one" />
        <div className="login-story__glow login-story__glow--two" />
        <BrandLogo inverse />
        <div className="login-story__content">
          <span className="login-story__kicker"><Sparkles size={15} /> Il lavoro scorre, dall’ordine alla consegna</span>
          <h1>La pasta giusta.<br />Al momento giusto.</h1>
          <p>Un unico spazio riservato per ordini, consegne e documenti di trasporto.</p>
          <ul>
            <li><PackageCheck /><span><strong>Ordini semplici</strong>Catalogo e prezzi sempre a portata di mano</span></li>
            <li><CheckCircle2 /><span><strong>Stato in tempo reale</strong>Segui ogni passaggio fino alla consegna</span></li>
            <li><FileText /><span><strong>DDT ordinati</strong>Consulta ed esporta i tuoi documenti</span></li>
          </ul>
        </div>
        <p className="login-story__footer">Pasta fresca artigianale per la ristorazione</p>
      </section>

      <section className="login-panel">
        <div className="login-panel__mobile-logo"><BrandLogo /></div>
        <div className="login-card">
          <div className="login-card__heading">
            <span className="login-card__icon"><LockKeyhole size={22} /></span>
            <div>
              <p className="eyebrow">Area riservata</p>
              <h2>Bentornato</h2>
            </div>
          </div>
          <p className="login-card__intro">Inserisci le tue credenziali per accedere al gestionale.</p>

          {(configurationError || dataError) && (
            <div className="form-alert form-alert--error" role="alert">
              <ShieldCheck size={18} />
              <span>{configurationError || dataError}</span>
            </div>
          )}

          {!isSupabaseMode && (
            <div className="demo-credentials" aria-label="Account dimostrativi">
              <div className="demo-credentials__header">
                <span><span className="demo-notice__dot" /> Modalità demo locale</span>
                <small>Dati e credenziali sono fittizi</small>
              </div>
              <div className="demo-credentials__buttons">
                <button type="button" onClick={() => fillDemo('client')}>
                  <UserRound size={16} /> Usa accesso cliente
                </button>
                <button type="button" onClick={() => fillDemo('admin')}>
                  <ShieldCheck size={16} /> Usa accesso admin
                </button>
              </div>
            </div>
          )}

          <form onSubmit={(event) => void submit(event)} className="login-form">
            <Field label={isSupabaseMode ? 'Email' : 'Email o nome utente'} htmlFor="login-identifier">
              <div className="input-with-icon">
                <UserRound size={18} />
                <input
                  id="login-identifier"
                  name="identifier"
                  type={isSupabaseMode ? 'email' : 'text'}
                  autoComplete="username"
                  required
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="nome@azienda.it"
                />
              </div>
            </Field>
            <Field label="Password" htmlFor="login-password">
              <div className="input-with-icon">
                <LockKeyhole size={18} />
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Inserisci la password"
                />
                <button
                  className="input-with-icon__action"
                  type="button"
                  onClick={() => setShowPassword((show) => !show)}
                  aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>
            {error && <div className="form-alert form-alert--error" role="alert">{error}</div>}
            <Button type="submit" size="lg" disabled={loading || Boolean(configurationError)}>
              {loading ? 'Accesso in corso…' : <>Accedi <ArrowRight size={18} /></>}
            </Button>
          </form>
          <div className="login-card__security">
            <ShieldCheck size={17} />
            <span>{isSupabaseConfigured ? 'Autenticazione Supabase configurata' : 'I dati demo restano solo in questo browser'}</span>
          </div>
        </div>
        <footer className="login-panel__footer">© {new Date().getFullYear()} Pasta Igea · Gestionale ordini</footer>
      </section>
    </main>
  )
}
