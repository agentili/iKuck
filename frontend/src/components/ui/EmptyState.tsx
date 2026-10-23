import { Link } from 'react-router-dom';

interface EmptyStateAction {
  label: string;
  href: string;
  ariaLabel: string;
}

interface EmptyStateProps {
  title?: string;
  text: string;
  action?: EmptyStateAction;
}

export default function EmptyState({ title, text, action }: EmptyStateProps) {
  return (
    <div className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-gray-50 p-4">
      {title && <h3 className="text-sm font-bold text-gray-700">{title}</h3>}
      <p className="mt-1 text-sm leading-relaxed text-gray-700">{text}</p>
      {action && (
        <Link
          to={action.href}
          aria-label={action.ariaLabel}
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
