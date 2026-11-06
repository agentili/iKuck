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
        >
          <span className={`chat-day-dot${selectedDay === day.key ? ' is-active' : ''}`} />
          <span className="hidden sm:inline">{day.label}</span>
          <span className="sm:hidden">{day.shortLabel}</span>
        </button>
      ))}
    </div>
  );
});

DayIndicator.displayName = 'DayIndicator';