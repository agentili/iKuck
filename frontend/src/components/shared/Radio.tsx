import { type InputHTMLAttributes, forwardRef } from 'react';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  description?: string;
  name: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, description, name, className = '', id, ...props }, ref) => {
    const radioId = id || label.toLowerCase().replace(/\s+/g, '-');
    const descId = description ? `${radioId}-desc` : undefined;

    return (
      <label className={`flex items-start gap-3 cursor-pointer ${className}`} htmlFor={radioId}>
        <input
          ref={ref}
          type="radio"
          name={name}
          id={radioId}
          aria-describedby={descId}
          className={`
            mt-0.5 h-5 w-5 shrink-0 rounded-full
            border-[var(--color-border)] bg-[var(--color-surface)]
            text-[var(--color-primary-action)]
            focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]
            transition-colors duration-150
            hover:border-[var(--color-primary)]
            disabled:opacity-50 disabled:cursor-not-allowed
          `}
          {...props}
        />
        <div className="min-w-0">
          <span className="block text-[var(--color-text)] font-medium">{label}</span>
          {description && (
            <p id={descId} className="mt-0.5 text-sm text-[var(--color-text-muted)]">
              {description}
            </p>
          )}
        </div>
      </label>
    );
  }
);

Radio.displayName = 'Radio';