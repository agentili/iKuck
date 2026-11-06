interface ErrorBannerProps {
  message: string;
}

export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div role="alert" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-sm font-semibold text-[var(--ik-tomato)]">
      {message}
    </div>
  );
}
