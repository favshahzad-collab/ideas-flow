import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from '../../hooks/useTheme'

const OPTIONS: {
  value: ThemePreference
  label: string
  icon: typeof Sun
}[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Three explicit choices rather than a button that cycles: "System" is a real
 * preference, not the absence of one, and a cycling control gives no way to
 * tell which of the three you are currently on.
 */
export default function ThemeToggle({
  className = '',
  inMenu = false,
}: {
  className?: string
  /**
   * Drawn inside the account menu (on a phone, where the header has no room
   * for it): the three become menu radio items, which is what a screen reader
   * expects to find inside a menu.
   */
  inMenu?: boolean
}) {
  const { preference, setPreference } = useTheme()

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={`inline-flex items-center gap-0.5 rounded-pill border border-line bg-surface p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = preference === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => setPreference(value)}
            {...(inMenu
              ? { role: 'menuitemradio', 'aria-checked': active }
              : { 'aria-pressed': active })}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            className={`flex h-7 w-7 items-center justify-center rounded-pill transition-colors ${
              active
                ? 'bg-accent text-on-accent'
                : 'text-content-subtle hover:bg-sunken hover:text-content'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
