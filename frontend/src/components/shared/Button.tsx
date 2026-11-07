import { type ButtonHTMLAttributes, forwardRef } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', fullWidth = false, loading = false, disabled, children, className = '', ...props }, ref) => {
    const baseStyles = `
      inline-flex items-center justify-center gap-2 font-bold rounded-[var(--radius-control)]
      transition-colors duration-150
      focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]
      disabled:opacity-50 disabled:cursor-not-allowed
      touch-action-manipulation
    `;

    const variantStyles = {
      primary: 'bg-[var(--color-primary-action)] text-[var(--color-on-primary-action)] border-none hover:bg-[var(--color-primary)]',
      secondary: 'bg-transparent text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-primary)]',
      ghost: 'bg-transparent text-[var(--color-text)] border-none hover:bg-[var(--color-surface)]',
    };

    const sizeStyles = {
      sm: 'min-h-[36px] px-3 text-sm',
      md: 'min-h-[44px] px-4 text-base',
      lg: 'min-h-[52px] px-6 text-lg',
    };

    const widthStyles = fullWidth ? 'w-full' : '';

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${widthStyles} ${className}`}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';