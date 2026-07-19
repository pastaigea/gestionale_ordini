import { createClient } from '@supabase/supabase-js'

const initialLocation = typeof window === 'undefined' ? '' : window.location.href
export const hasPasswordSetupToken = /(?:[?#&]type=(?:recovery|invite)(?:[&#]|$)|#\/(?:imposta|reimposta)-password)/i.test(initialLocation)

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
)?.trim()

export const supabase = url && key
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Gli inviti creati dalla Admin API Supabase usano il flusso implicit.
        // La posizione iniziale viene catturata sopra prima che Auth ripulisca il callback.
        flowType: 'implicit',
      },
    })
  : null

export const isSupabaseConfigured = Boolean(supabase)
export const appMode = import.meta.env.VITE_APP_MODE === 'supabase' ? 'supabase' : 'demo'
export const isSupabaseMode = appMode === 'supabase'
export const configurationError = isSupabaseMode && !supabase
  ? 'Modalità Supabase richiesta, ma VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY non sono configurate.'
  : null
