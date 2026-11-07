import { type HTMLAttributes } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'warning' | 'danger' | 'accent' | 'success' | 'neutral';
  size?: 'sm' | 'md';
  dot?: boolean;
}

export function Badge({
  variant = 'default',
  size = 'md',
  dot = false,
  className = '',
  children,
  ...props
}: BadgeProps) {
  const variantStyles = {
    default: 'bg-[var(--color-border)] text-[var(--color-text-muted)]',
    primary: 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]',
    warning: 'bg-[var(--color-warning)] text-[var(--color-on-primary-action)]',
    danger: 'bg-[var(--color-danger)] text-[var(--color-on-primary-action)]',
    accent: 'bg-[var(--color-accent)] text-[var(--color-on-primary-action)]',
    success: 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]',
    neutral: 'bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)]',
  };

  const sizeStyles = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };

  const dotColors = {
    default: 'bg-[var(--color-text-muted)]',
    primary: 'bg-[var(--color-primary)]',
    warning: 'bg-[var(--color-warning)]',
    danger: 'bg-[var(--color-danger)]',
    accent: 'bg-[var(--color-accent)]',
    success: 'bg-[var(--color-primary)]',
    neutral: 'bg-[var(--color-text-muted)]',
  };

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 font-semibold rounded-[var(--radius-pill)]
        ${variantStyles[variant]} ${sizeStyles[size]} ${className}
      `}
      {...props}
    >
      {dot && <span className={`w-2 h-2 rounded-full ${dotColors[variant]}`} aria-hidden="true" />}
      {children}
    </span>
  );
}