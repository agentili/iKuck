import { type InputHTMLAttributes, forwardRef } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  description?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, className = '', id, ...props }, ref) => {
    const checkboxId = id || label.toLowerCase().replace(/\s+/g, '-');
    const descId = description ? `${checkboxId}-desc` : undefined;

    return (
      <label className={`flex items-start gap-3 cursor-pointer ${className}`} htmlFor={checkboxId}>
        <input
          ref={ref}
          type="checkbox"
          id={checkboxId}
          aria-describedby={descId}
          className={`
            mt-0.5 h-5 w-5 shrink-0 rounded-[var(--radius-control)]
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

Checkbox.displayName = 'Checkbox';