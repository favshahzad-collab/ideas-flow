import { useId } from 'react'

/**
 * The statement a signer agrees to, word for word as the server records it.
 *
 * MIRRORS `SIGNING_CONSENT_STATEMENT` in `backend/src/lib/signingAttestation.ts`.
 * The server stores its own copy with every signature - this one is only what
 * the person reads - so a drift between the two would show somebody one
 * sentence and file another. `SigningConsent.test.tsx` pins this text.
 */
export const SIGNING_CONSENT_STATEMENT =
  'I confirm this is my signature, and that signing here has the same effect as signing this memo on paper.'

/** What the dialogs say when somebody presses sign without ticking the box. */
export const CONSENT_MISSING = 'Tick the box to confirm this is your signature.'

/**
 * The tick box every signing dialog asks for before the signature goes on.
 *
 * A signature image alone is a picture on a page. Agreeing in words, at the
 * moment of signing, is what makes it the signer's act - and the server
 * refuses a signature that arrives without it.
 */
export default function SigningConsent({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2.5 rounded-control border border-line bg-sunken p-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-accent"
      />
      <label htmlFor={id} className="text-meta leading-snug text-content">
        {SIGNING_CONSENT_STATEMENT}
      </label>
    </div>
  )
}
