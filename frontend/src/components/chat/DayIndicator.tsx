import { memo } from 'react';
import { useChatStore } from './chatStore';

interface DayIndicatorProps {
  onDayChange?: (day: 'today' | 'yesterday' | 'dayBefore') => void;
}

export const DayIndicator = memo(({ onDayChange }: DayIndicatorProps) => {
  const selectedDay = useChatStore((state) => state.selectedDay);
  const selectDay = useChatStore((state) => state.selectDay);

  const days = [
    { key: 'today', label: 'Oggi', shortLabel: 'OGG' },
    { key: 'yesterday', label: 'Ieri', shortLabel: 'IER' },
    { key: 'dayBefore', label: "L'altro ieri", shortLabel: 'ALT' },
  ] as const;

  const handleClick = (day: 'today' | 'yesterday' | 'dayBefore') => {
    if (onDayChange) {
      onDayChange(day);
    } else {
      selectDay(day);
    }
  };

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-2" role="tablist" aria-label="Giorni ricetta">
      {days.map((day) => (
        <button
          key={day.key}
          role="tab"
          aria-selected={selectedDay === day.key}
          onClick={() => handleClick(day.key)}
          className={`chat-day-indicator flex items-center gap-2 transition-all ${
            selectedDay === day.key
              ? 'shadow-md'
              : ''
          }`}
          style={{
            backgroundColor: 'var(--sc-peach-soft)',
            color: 'var(--sc-terracotta)',
            borderRadius: 'var(--sc-radius-pill)',
            padding: '10px 18px',
            fontSize: '14px',
            fontWeight: 600,
            fontFamily: 'DM Sans, system-ui, sans-serif',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <span
            className="chat-day-dot"
            style={{
              width: selectedDay === day.key ? '10px' : '8px',
              height: selectedDay === day.key ? '10px' : '8px',
              borderRadius: '50%',
              backgroundColor: selectedDay === day.key ? 'var(--sc-terracotta)' : 'var(--sc-ink-faint)',
              transition: 'all 0.2s',
            }}
          />
          <span className="hidden sm:inline">{day.label}</span>
          <span className="sm:hidden">{day.shortLabel}</span>
        </button>
      ))}
    </div>
  );
});

DayIndicator.displayName = 'DayIndicator';