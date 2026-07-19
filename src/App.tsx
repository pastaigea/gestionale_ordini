import { LoaderCircle } from 'lucide-react'
import { Navigate, Route, Routes } from 'react-router-dom'
import type { PropsWithChildren } from 'react'
import { BrandLogo } from './components/BrandLogo'
import { useApp } from './context/AppContext'
import { AdminPortal } from './pages/AdminPortal'
import { CustomerPortal } from './pages/CustomerPortal'
import { LoginPage } from './pages/LoginPage'
import { PasswordSetupPage } from './pages/PasswordSetupPage'
import type { UserRole } from './types'

const Protected = ({ role, children }: PropsWithChildren<{ role: UserRole }>) => {
  const { session, authLoading, passwordSetup } = useApp()
  if (authLoading) return <LoadingScreen />
  if (!session) return <Navigate to="/login" replace />
  if (passwordSetup) return <Navigate to="/imposta-password" replace />
  if (session.role !== role) return <Navigate to={session.role === 'admin' ? '/admin' : '/cliente'} replace />
  return children
}

const HomeRedirect = () => {
  const { session, authLoading, passwordSetup } = useApp()
  if (authLoading) return <LoadingScreen />
  if (!session) return <Navigate to="/login" replace />
  if (passwordSetup) return <Navigate to="/imposta-password" replace />
  return <Navigate to={session.role === 'admin' ? '/admin' : '/cliente'} replace />
}

const PasswordSetupGate = () => {
  const { session, authLoading } = useApp()
  if (authLoading) return <LoadingScreen />
  if (!session) return <Navigate to="/login" replace />
  return <PasswordSetupPage />
}

const LoadingScreen = () => (
  <main className="loading-screen">
    <BrandLogo />
    <LoaderCircle className="spin" size={25} />
    <p>Prepariamo il gestionale…</p>
  </main>
)

export default function App() {
  const { session, passwordSetup } = useApp()
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={session ? <Navigate to={passwordSetup ? '/imposta-password' : session.role === 'admin' ? '/admin' : '/cliente'} replace /> : <LoginPage />} />
      <Route path="/imposta-password" element={<PasswordSetupGate />} />
      <Route path="/cliente/*" element={<Protected role="client"><CustomerPortal /></Protected>} />
      <Route path="/admin/*" element={<Protected role="admin"><AdminPortal /></Protected>} />
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  )
}
