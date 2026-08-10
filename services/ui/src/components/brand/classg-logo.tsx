type ClassGLogoProps = { className?: string; showWordmark?: boolean }

export function ClassGLogo({ className, showWordmark = true }: ClassGLogoProps) {
  return (
    <span className={className} aria-label="ClassG">
      <svg viewBox="0 0 48 48" className="size-7" aria-hidden="true">
        <path d="M24 8a16 16 0 1 0 15 21" fill="none" stroke="var(--primary)" strokeLinecap="round" strokeWidth="2.5" />
        <path d="M24 12.5a11.5 11.5 0 1 0 11 15.3" fill="none" stroke="var(--foreground)" strokeLinecap="round" strokeWidth="2.25" />
        <path d="M31.5 28.5H40l-.8 6.2" fill="none" stroke="var(--primary)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
        <g fill="var(--primary)" stroke="var(--primary)" strokeLinecap="round" strokeWidth="1.25"><path d="m33.5 16.8 5 5m0-5-5 5" fill="none"/><circle cx="33.5" cy="16.8" r=".8"/><circle cx="38.5" cy="16.8" r=".8"/><circle cx="33.5" cy="21.8" r=".8"/><circle cx="38.5" cy="21.8" r=".8"/></g>
      </svg>
      {showWordmark ? <span className="classg-wordmark">Class<span>G</span></span> : null}
    </span>
  )
}
