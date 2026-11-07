import { type HTMLAttributes } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  tabs: TabItem[];
  activeTab: string;
  onChange: (tabId: string) => void;
  variant?: 'default' | 'pills' | 'underline';
  fullWidth?: boolean;
}

export function Tabs({ tabs, activeTab, onChange, variant = 'default', fullWidth = false, className = '', ...props }: TabsProps) {
  const variantStyles = {
    default: 'bg-[var(--color-surface)] border-b border-[var(--color-border)]',
    pills: 'bg-transparent',
    underline: 'bg-transparent border-b border-[var(--color-border)]',
  };

  const tabStyles = {
    default: (isActive: boolean) => `
      px-4 py-3 text-sm font-semibold border-b-2 -mb-px
      transition-colors duration-150
      ${isActive
        ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
        : 'text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text)] hover:border-[var(--color-border)]'}
    `,
    pills: (isActive: boolean) => `
      px-4 py-2 text-sm font-semibold rounded-[var(--radius-control)]
      transition-colors duration-150
      ${isActive
        ? 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]'
        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'}
    `,
    underline: (isActive: boolean) => `
      px-4 py-3 text-sm font-semibold border-b-2 -mb-px
      transition-colors duration-150
      ${isActive
        ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
        : 'text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text)]'}
    `,
  };

  const widthStyles = fullWidth ? 'flex-1 text-center' : '';

  return (
    <div className={`${variantStyles[variant]} ${className}`} {...props} role="tablist">
      <nav className={`flex ${fullWidth ? 'w-full' : ''} gap-1 overflow-x-auto pb-px`} aria-label="Tab navigation">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${tab.id}-panel`}
            id={`${tab.id}-tab`}
            onClick={() => !tab.disabled && onChange(tab.id)}
            disabled={tab.disabled}
            className={`
              flex items-center gap-1.5 whitespace-nowrap
              focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]
              disabled:opacity-50 disabled:cursor-not-allowed
              min-h-[44px]
              ${tabStyles[variant](activeTab === tab.id)} ${widthStyles}
            `}
          >
            {tab.icon && <span className="flex-shrink-0" aria-hidden="true">{tab.icon}</span>}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`
                min-w-[1.25rem] h-5 rounded-full text-xs font-bold flex items-center justify-center
                ${activeTab === tab.id
                  ? 'bg-[var(--color-on-primary-action)] text-[var(--color-primary)]'
                  : 'bg-[var(--color-border)] text-[var(--color-text-muted)]'}
              `}>
                {tab.count > 99 ? '99+' : tab.count}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}