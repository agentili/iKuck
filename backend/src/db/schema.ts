import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const serviceMetadata = pgTable('service_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
