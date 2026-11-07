import { type InputHTMLAttributes, forwardRef } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, leadingIcon, trailingIcon, className = '', id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
    const errorId = error ? `${inputId}-error` : undefined;
    const helperId = helperText ? `${inputId}-helper` : undefined;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {leadingIcon && (
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-[var(--color-text-muted)]">
              {leadingIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={`${errorId ?? ''} ${helperId ?? ''}`.trim() || undefined}
            className={`
              w-full bg-[var(--color-surface)] border rounded-[var(--radius-control)]
              text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
              transition-colors duration-150
              focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)] focus:border-transparent
              disabled:bg-[var(--color-border)] disabled:cursor-not-allowed
              min-h-[44px]
              ${leadingIcon ? 'pl-10' : 'pl-4'}
              ${trailingIcon ? 'pr-10' : 'pr-4'}
              py-2.5
              ${error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]'}
              ${className}
            `}
            {...props}
          />
          {trailingIcon && (
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-[var(--color-text-muted)]">
              {trailingIcon}
            </div>
          )}
        </div>
        {error && (
          <p id={errorId} className="mt-1.5 text-sm text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={helperId} className="mt-1.5 text-sm text-[var(--color-text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';