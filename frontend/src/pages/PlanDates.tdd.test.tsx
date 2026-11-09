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
  nextSevenDays: [string, string, string, string, string, string, string];
  eighthDay: string;
};

const dateWindowCases: DateWindowCase[] = [
  {
    description: 'starts after the Rome civil date at the spring DST boundary',
    instant: '2026-03-28T23:30:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-03-29',
    nextSevenDays: ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05'],
    eighthDay: '2026-04-06',
  },
  {
    description: 'uses the New York civil date for the same instant near UTC midnight',
    instant: '2026-03-28T23:30:00Z',
    timeZone: 'America/New_York',
    today: '2026-03-28',
    nextSevenDays: ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04'],
    eighthDay: '2026-04-05',
  },
  {
    description: 'keeps seven consecutive civil dates across the spring clock change',
    instant: '2026-03-28T12:00:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-03-28',
    nextSevenDays: ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04'],
    eighthDay: '2026-04-05',
  },
  {
    description: 'keeps seven consecutive civil dates across the autumn clock change',
    instant: '2026-10-24T12:00:00Z',
    timeZone: 'Europe/Rome',
    today: '2026-10-24',
    nextSevenDays: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'],
    eighthDay: '2026-11-01',
  },
  {
    description: 'continues from the end of a month into the following month',
    instant: '2026-01-30T12:00:00Z',
    timeZone: 'UTC',
    today: '2026-01-30',
    nextSevenDays: ['2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06'],
    eighthDay: '2026-02-07',
  },
  {
    description: 'includes leap day when it falls in the next four civil dates',
    instant: '2024-02-28T12:00:00Z',
    timeZone: 'UTC',
    today: '2024-02-28',
    nextSevenDays: ['2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04', '2024-03-05', '2024-03-06'],
    eighthDay: '2024-03-07',
  },
  {
    description: 'continues across the end of the year without shifting stored civil dates',
    instant: '2026-12-30T12:00:00Z',
    timeZone: 'UTC',
    today: '2026-12-30',
    nextSevenDays: ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05', '2027-01-06'],
    eighthDay: '2027-01-07',
  },
];

describe('guest plan date window', () => {
  it.each(dateWindowCases)('$description', async ({ instant, timeZone, today, nextSevenDays, eighthDay }) => {
    vi.stubEnv('TZ', timeZone);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);

    render(<MemoryRouter><PlanPage /></MemoryRouter>);

    await expect(screen.queryByText(dateText(today))).not.toBeInTheDocument();
    for (const date of nextSevenDays) {
      expect(await screen.findByText(dateText(date))).toBeVisible();
    }
    expect(screen.queryByText(dateText(eighthDay))).not.toBeInTheDocument();
  });
});
