type ClassGLogoProps = { className?: string; showWordmark?: boolean }

export function ClassGLogo({ className, showWordmark = true }: ClassGLogoProps) {
  return (
    <span className={className} aria-label="ClassG">
      <img src="/brand/classg-mark.svg" className="size-7" alt="" aria-hidden="true" />
      {showWordmark ? (
        <span className="classg-wordmark" aria-hidden="true">
          Class<span className="classg-wordmark__accent">G</span>
        </span>
      ) : null}
    </span>
  )
}
