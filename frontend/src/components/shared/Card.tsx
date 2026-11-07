import { type HTMLAttributes, forwardRef } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'feature' | 'quiet';
  hoverable?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ variant = 'default', hoverable = false, padding = 'md', className = '', children, ...props }, ref) => {
    const variantStyles = {
      default: 'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-panel)] shadow-[var(--shadow-card)]',
      feature: 'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-feature)] shadow-[var(--shadow-surface)]',
      quiet: 'bg-[var(--color-surface)] border-none rounded-[var(--radius-panel)] shadow-none',
    };

    const paddingStyles = {
      none: '',
      sm: 'p-3',
      md: 'p-4 sm:p-5',
      lg: 'p-6 sm:p-8',
    };

    const hoverStyles = hoverable
      ? 'transition-all duration-150 hover:shadow-[var(--shadow-lift)] hover:-translate-y-0.5 active:translate-y-0'
      : '';

    return (
      <div
        ref={ref}
        className={`${variantStyles[variant]} ${paddingStyles[padding]} ${hoverStyles} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';