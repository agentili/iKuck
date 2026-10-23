interface ErrorBannerProps {
  message: string;
}

export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div role="alert" className="rounded-[var(--ik-radius-control)] border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900">
      {message}
    </div>
  );
}
