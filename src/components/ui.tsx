import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import { isSupabaseMode } from '../lib/supabase'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
}

export const Button = ({
  variant = 'primary',
  size = 'md',
  icon,
  className = '',
  children,
  ...props
}: ButtonProps) => (
  <button className={`button button--${variant} button--${size} ${className}`} {...props}>
    {icon && <span className="button__icon" aria-hidden="true">{icon}</span>}
    {children}
  </button>
)

interface CardProps extends PropsWithChildren {
  className?: string
}

export const Card = ({ children, className = '' }: CardProps) => (
  <section className={`card ${className}`}>{children}</section>
)

interface PageHeaderProps {
  eyebrow?: string
  title: string
  description?: string
  action?: ReactNode
}

export const PageHeader = ({ eyebrow, title, description, action }: PageHeaderProps) => (
  <header className="page-header">
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="page-header__description">{description}</p>}
    </div>
    {action && <div className="page-header__action">{action}</div>}
  </header>
)

interface ModalProps extends PropsWithChildren {
  title: string
  description?: string
  onClose: () => void
  size?: 'sm' | 'md' | 'lg'
}

export const Modal = ({ title, description, onClose, size = 'md', children }: ModalProps) => {
  const modalRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={modalRef} className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Chiudi finestra">
            <X size={20} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  )
}

interface FieldProps extends PropsWithChildren {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  className?: string
}

export const Field = ({ label, htmlFor, hint, error, className = '', children }: FieldProps) => (
  <label className={`field ${className}`} htmlFor={htmlFor}>
    <span className="field__label">{label}</span>
    {children}
    {hint && !error && <span className="field__hint">{hint}</span>}
    {error && <span className="field__error" role="alert">{error}</span>}
  </label>
)

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}

export const EmptyState = ({ icon, title, description, action }: EmptyStateProps) => (
  <div className="empty-state">
    <span className="empty-state__icon" aria-hidden="true">{icon}</span>
    <h3>{title}</h3>
    <p>{description}</p>
    {action}
  </div>
)

export const DemoNotice = ({ children }: PropsWithChildren) => {
  if (isSupabaseMode) return null
  return (
    <div className="demo-notice" role="note">
      <span className="demo-notice__dot" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}
