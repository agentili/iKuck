import type { ReactNode } from 'react';

interface PageSectionProps {
  eyebrow?: string;
  title?: string;
  titleId?: string;
  titleLevel?: 'h1' | 'h2';
  description?: string;
  action?: ReactNode;
  actionClassName?: string;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}

export default function PageSection({
  eyebrow,
  title,
  titleId,
  titleLevel = 'h2',
  description,
  action,
  actionClassName,
  className,
  ariaLabel,
  children,
}: PageSectionProps) {
  const TitleElement = titleLevel === 'h1' ? 'h1' : 'h2';
  return (
    <section
      role="region"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      className={`space-y-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] p-4 sm:p-5 mb-6${className ? ` ${className}` : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <p className="ik-eyebrow text-sm font-bold">
              {eyebrow}
            </p>
          )}
          {title && (
            <TitleElement id={titleId} className="mt-1 text-2xl font-black text-[var(--ik-ink)]">
              {title}
            </TitleElement>
          )}
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">{description}</p>
          )}
        </div>
        {action && <div className={actionClassName ?? 'shrink-0'}>{action}</div>}
      </div>
      {children}
    </section>
  );
}
