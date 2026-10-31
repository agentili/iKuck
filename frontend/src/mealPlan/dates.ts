const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertCivilDate(value: string): void {
  const match = calendarDatePattern.exec(value);
  if (match === null || Number(match[1]) < 1) throw new RangeError('A valid Gregorian civil date is required');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError('A valid Gregorian civil date is required');
  }
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export function getDeviceTimeZone(): string | null {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidIanaTimeZone(timeZone) ? timeZone : null;
  } catch {
    return null;
  }
}

export function getCivilDate(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.getTime())) throw new RangeError('A valid instant is required');
  if (!isValidIanaTimeZone(timeZone)) throw new RangeError('A supported IANA timezone is required');
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: 'year' | 'month' | 'day'): string => {
    const value = parts.find((entry) => entry.type === type)?.value;
    if (value === undefined) throw new RangeError('The civil date could not be resolved');
    return value;
  };
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function addCivilDays(date: string, days: number): string {
  assertCivilDate(date);
  if (!Number.isInteger(days)) throw new RangeError('A whole number of civil days is required');
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  if (!Number.isFinite(value.getTime())) throw new RangeError('Civil date is outside the supported range');
  const result = value.toISOString().slice(0, 10);
  assertCivilDate(result);
  return result;
}

export function getNextFourCivilDates(instant: Date, timeZone: string): [string, string, string, string] {
  const today = getCivilDate(instant, timeZone);
  return [1, 2, 3, 4].map((offset) => addCivilDays(today, offset)) as [string, string, string, string];
}

export function formatCivilDate(date: string): string {
  assertCivilDate(date);
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function formatCivilDateLong(date: string): string {
  assertCivilDate(date);
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00.000Z`));
}
