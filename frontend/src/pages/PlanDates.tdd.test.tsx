import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanPage from './PlanPage';

const italianMonthNames = [
  'gennaio|gen',
  'febbraio|feb',
  'marzo|mar',
  'aprile|apr',
  'maggio|mag',
  'giugno|giu',
  'luglio|lug',
  'agosto|ago',
  'settembre|set',
  'ottobre|ott',
  'novembre|nov',
  'dicembre|dic',
];

const dateText = (isoDate: string): RegExp => {
  const [year, month, day] = isoDate.split('-');
  const numericMonth = String(Number(month));
  const numericDay = String(Number(day));
  const monthName = italianMonthNames[Number(month) - 1];

  return new RegExp(
    `(?:${year}-${month}-${day}|${numericDay}[./-]0?${numericMonth}(?:[./-]${year})?|${numericDay}\\s+(?:${monthName})(?:\\s+${year})?)`,
    'i',
  );
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type DateWindowCase = {
  description: string;
  instant: string;
  timeZone: string;
  today: string;
  nextFourDays: [string, string, string, string];
  fifthDay: string;
};

const dateWindowCases: DateWindowCase[] = [
  {
    description: 'starts after the Rome civil date at the spring DST boundary',
    instant: '2026-03-28T23:30:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-03-29',
    nextFourDays: ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02'],
    fifthDay: '2026-04-03',
  },
  {
    description: 'uses the New York civil date for the same instant near UTC midnight',
    instant: '2026-03-28T23:30:00Z',
    timeZone: 'America/New_York',
    today: '2026-03-28',
    nextFourDays: ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01'],
    fifthDay: '2026-04-02',
  },
  {
    description: 'keeps four consecutive civil dates across the spring clock change',
    instant: '2026-03-28T12:00:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-03-28',
    nextFourDays: ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01'],
    fifthDay: '2026-04-02',
  },
  {
    description: 'keeps four consecutive civil dates across the autumn clock change',
    instant: '2026-10-24T12:00:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-10-24',
    nextFourDays: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'],
    fifthDay: '2026-10-29',
  },
  {
    description: 'continues from the end of a month into the following month',
    instant: '2026-01-30T12:00:00Z',
    timeZone: 'UTC',
    today: '2026-01-30',
    nextFourDays: ['2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03'],
    fifthDay: '2026-02-04',
  },
  {
    description: 'includes leap day when it falls in the next four civil dates',
    instant: '2024-02-28T12:00:00Z',
    timeZone: 'UTC',
    today: '2024-02-28',
    nextFourDays: ['2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03'],
    fifthDay: '2024-03-04',
  },
  {
    description: 'continues across the end of the year without shifting stored civil dates',
    instant: '2026-12-30T12:00:00Z',
    timeZone: 'UTC',
    today: '2026-12-30',
    nextFourDays: ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'],
    fifthDay: '2027-01-04',
  },
];

describe('guest plan date window', () => {
  it.each(dateWindowCases)('$description', async ({ instant, timeZone, today, nextFourDays, fifthDay }) => {
    vi.stubEnv('TZ', timeZone);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);

    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    await expect(screen.queryByText(dateText(today))).not.toBeInTheDocument();
    for (const date of nextFourDays) {
      expect(await screen.findByText(dateText(date))).toBeVisible();
    }
    expect(screen.queryByText(dateText(fifthDay))).not.toBeInTheDocument();
  });
});
