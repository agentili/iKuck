import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const serviceMetadata = pgTable('service_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  emailUnique: uniqueIndex('users_email_unique').on(table.email),
}));

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const houses = pgTable('houses', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const houseMemberships = pgTable('house_memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userUnique: uniqueIndex('house_memberships_user_unique').on(table.userId),
  houseUserUnique: uniqueIndex('house_memberships_house_user_unique').on(table.houseId, table.userId),
  houseIndex: index('house_memberships_house_index').on(table.houseId),
  roleCheck: check('house_memberships_role_check', sql`${table.role} in ('admin', 'member')`),
}));

export const accountIdentities = pgTable('account_identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerSubject: text('provider_subject').notNull(),
  providerEmail: text('provider_email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerSubjectUnique: uniqueIndex('account_identities_provider_subject_unique').on(table.provider, table.providerSubject),
  userProviderUnique: uniqueIndex('account_identities_user_provider_unique').on(table.userId, table.provider),
  userIndex: index('account_identities_user_id_index').on(table.userId),
}));

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  csrfTokenHash: text('csrf_token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenUnique: uniqueIndex('auth_sessions_token_hash_unique').on(table.tokenHash),
  userIndex: index('auth_sessions_user_id_index').on(table.userId),
  expiryIndex: index('auth_sessions_expires_at_index').on(table.expiresAt),
}));

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenUnique: uniqueIndex('email_verification_token_hash_unique').on(table.tokenHash),
  userIndex: index('email_verification_tokens_user_id_index').on(table.userId),
}));

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenUnique: uniqueIndex('password_reset_token_hash_unique').on(table.tokenHash),
  userIndex: index('password_reset_tokens_user_id_index').on(table.userId),
}));

export const syncItems = pgTable('sync_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull().default('user'),
  scopeId: text('scope_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  deviceId: text('device_id').notNull(),
  payload: jsonb('payload'),
  deleted: boolean('deleted').notNull().default(false),
  clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
  mutationId: text('mutation_id').notNull(),
  serverSequence: bigint('server_sequence', { mode: 'number' })
    .notNull()
    .default(sql`nextval('sync_server_sequence')`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  entityUnique: uniqueIndex('sync_items_scope_entity_unique').on(table.scopeType, table.scopeId, table.entityType, table.entityId),
  scopeSequenceIndex: index('sync_items_scope_sequence_index').on(table.scopeType, table.scopeId, table.serverSequence),
  scopeTypeCheck: check('sync_items_scope_type_check', sql`${table.scopeType} in ('user', 'house')`),
}));

export const processedSyncMutations = pgTable('processed_sync_mutations', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull().default('user'),
  scopeId: text('scope_id').notNull(),
  mutationId: text('mutation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  mutationUnique: uniqueIndex('processed_sync_mutations_scope_unique').on(table.scopeType, table.scopeId, table.mutationId),
  scopeTypeCheck: check('processed_sync_mutations_scope_type_check', sql`${table.scopeType} in ('user', 'house')`),
}));
