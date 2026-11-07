import type { ReactNode } from 'react';

interface PageSectionProps {
  eyebrow?: string;
  title?: string;
  titleId?: string;
  titleLevel?: 'h1' | 'h2';
  description?: string;
  action?: ReactNode;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
  featured?: boolean;
}

export default function PageSection({
  eyebrow,
  title,
  titleId,
  titleLevel = 'h2',
  description,
  action,
  className,
  ariaLabel,
  children,
  featured = false,
}: PageSectionProps) {
  const TitleElement = titleLevel === 'h1' ? 'h1' : 'h2';
  const baseClass = featured
    ? 'space-y-4 rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6 mb-6'
    : 'space-y-4 rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4 sm:p-5 mb-6';
  return (
    <section
      role="region"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      className={`${baseClass}${className ? ` ${className}` : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--color-primary)]">
              {eyebrow}
            </p>
          )}
          {title && (
            <TitleElement id={titleId} className="mt-1 text-2xl font-black text-[var(--color-text)]">
              {title}
            </TitleElement>
          )}
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
