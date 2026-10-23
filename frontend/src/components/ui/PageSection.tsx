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
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">
              {eyebrow}
            </p>
          )}
          {title && (
            <TitleElement id={titleId} className="mt-1 text-2xl font-black text-gray-950">
              {title}
            </TitleElement>
          )}
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-gray-700">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
