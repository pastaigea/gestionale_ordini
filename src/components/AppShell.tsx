import {
  ChevronDown,
  LogOut,
  Menu,
  RefreshCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ComponentType, PropsWithChildren } from 'react'
import { NavLink } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { isSupabaseMode } from '../lib/supabase'
import { BrandLogo } from './BrandLogo'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ size?: number; strokeWidth?: number }>
  end?: boolean
}

interface AppShellProps extends PropsWithChildren {
  navItems: NavItem[]
  areaLabel: string
}

export const AppShell = ({ navItems, areaLabel, children }: AppShellProps) => {
  const { session, logout, resetDemo, isSupabaseConfigured, db, dataError, dataRefreshing, refreshData } = useApp()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [compactViewport, setCompactViewport] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 960px)').matches,
  )
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 960px)')
    const update = () => setCompactViewport(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const initials = session?.name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Vai al contenuto</a>
      {mobileOpen && <button className="sidebar-scrim" aria-label="Chiudi menu" onClick={() => setMobileOpen(false)} />}
      <aside
        className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}
        aria-hidden={compactViewport && !mobileOpen}
        inert={compactViewport && !mobileOpen}
      >
        <div className="sidebar__top">
          <BrandLogo inverse />
          <button className="sidebar__close" onClick={() => setMobileOpen(false)} aria-label="Chiudi menu">
            <X size={21} />
          </button>
        </div>
        <div className="sidebar__area">
          <ShieldCheck size={14} />
          {areaLabel}
        </div>
        <nav className="sidebar__nav" aria-label="Navigazione principale">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              to={to}
              end={end}
              key={to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
            >
              <Icon size={19} strokeWidth={1.9} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <footer className="sidebar__footer">
          <div className="sidebar__support">
            <span>Serve aiuto?</span>
            {db.supplier.email ? <a href={`mailto:${db.supplier.email}`}>Contatta l’amministrazione</a> : <small>Contatto da configurare</small>}
          </div>
          <small>{isSupabaseMode ? 'Portale riservato · v0.1' : 'Ambiente dimostrativo · v0.1'}</small>
        </footer>
      </aside>

      <div className="app-shell__body">
        <header className="topbar">
          <div className="topbar__left">
            <button className="topbar__menu" onClick={() => setMobileOpen(true)} aria-label="Apri menu">
              <Menu size={22} />
            </button>
            <span className={`connection-pill ${isSupabaseConfigured && !dataError ? 'connection-pill--online' : ''}`}>
              <span />
              {isSupabaseMode
                ? dataRefreshing ? 'Aggiornamento…' : dataError ? 'Connessione da verificare' : 'Servizi connessi'
                : 'Demo locale'}
            </span>
          </div>
          <div className="profile-menu" ref={profileRef}>
            <button
              className="profile-menu__trigger"
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
            >
              <span className="profile-menu__avatar">{initials}</span>
              <span className="profile-menu__copy">
                <strong>{session?.name}</strong>
                <small>{session?.role === 'admin' ? 'Amministratore' : 'Cliente'}</small>
              </span>
              <ChevronDown size={16} />
            </button>
            {profileOpen && (
              <div className="profile-menu__dropdown" role="menu">
                {!isSupabaseMode && (
                  <button type="button" role="menuitem" onClick={() => {
                    resetDemo()
                    setProfileOpen(false)
                  }}>
                    <RefreshCcw size={16} /> Ripristina dati demo
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => void logout()}>
                  <LogOut size={16} /> Esci
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="main-content" id="main-content">
          {dataError && (
            <div className="app-data-error" role="alert">
              <span><strong>Dati non aggiornati.</strong> {dataError}</span>
              <button type="button" disabled={dataRefreshing} onClick={() => void refreshData().catch(() => undefined)}>
                <RefreshCcw className={dataRefreshing ? 'spin' : ''} size={15} /> Riprova
              </button>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}
