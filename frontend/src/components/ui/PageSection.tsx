import type { ReactNode } from 'react';

interface PageSectionProps {
  eyebrow?: string;
  title: string;
  titleId?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export default function PageSection({
  eyebrow,
  title,
  titleId,
  description,
  action,
  className,
  children,
}: PageSectionProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`space-y-4 rounded-3xl border-2 p-4 sm:p-5 mb-6${className ? ` ${className}` : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">
              {eyebrow}
            </p>
          )}
          <h2 id={titleId} className="mt-1 text-2xl font-black text-gray-950">
            {title}
          </h2>
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
