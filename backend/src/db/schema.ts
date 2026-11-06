import { sql } from 'drizzle-orm';
import type { PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import type { PlanCommand, PlanResult, PlanState } from '@ikuck/shared/contracts';
import type { RecentlySnapshotItem } from '../bring/recently.js';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const chefChatControl = pgTable('chef_chat_control', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
}, (table) => ({ singleton: check('chef_chat_control_singleton', sql`${table.id} = 1`) }));

export const chefChatOperations = pgTable('chef_chat_operations', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  token: uuid('token').notNull(),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => ({
  userTime: index('chef_chat_operations_user_time_idx').on(table.userId, table.createdAt),
  stateUser: index('chef_chat_operations_state_user_idx').on(table.state, table.userId),
  stateCheck: check('chef_chat_operations_state_check', sql`${table.state} in ('reserved', 'dispatched', 'settled', 'cancelled', 'quarantined')`),
}));

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

export const bringConnections = pgTable('bring_connections', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull(),
  encryptedSession: text('encrypted_session').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
  recentlyWatermarkAt: timestamp('recently_watermark_at', { withTimezone: true }),
  recentlySnapshot: jsonb('recently_snapshot').$type<RecentlySnapshotItem[]>(),
});

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const houses = pgTable('houses', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  timeZone: text('time_zone'),
  timeZoneRevision: uuid('time_zone_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  timeZoneRevisionPair: check('houses_time_zone_revision_pair_check', sql`(${table.timeZone} IS NULL AND ${table.timeZoneRevision} IS NULL) OR ${table.timeZoneRevision} IS NOT NULL`),
}));

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

export const houseMigrationPending = pgTable('house_migration_pending', {
  id: uuid('id').defaultRandom().primaryKey(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userUnique: uniqueIndex('house_migration_pending_user_id_unique').on(table.userId),
}));

export const pantryCandidates = pgTable('pantry_candidates', {
  id: uuid('id').defaultRandom().primaryKey(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  rawLabel: text('raw_label').notNull(),
  label: text('label').notNull(),
  normalizedLabel: text('normalized_label').notNull(),
  specification: text('specification').notNull(),
  listName: text('list_name').notNull(),
  checkedOffAt: timestamp('checked_off_at', { withTimezone: true }),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('pending'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => ({
  houseLabelUnique: uniqueIndex('pantry_candidates_house_normalized_label_unique').on(table.houseId, table.normalizedLabel),
  houseStatusExpiryIndex: index('pantry_candidates_house_status_expiry_idx').on(table.houseId, table.status, table.expiresAt),
  statusCheck: check('pantry_candidates_status_check', sql`${table.status} in ('pending', 'accepted', 'ignored')`),
}));

export const s2sServiceGrants = pgTable('s2s_service_grants', {
  id: uuid('id').defaultRandom().primaryKey(),
  serviceId: text('service_id').notNull(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  sponsorUserId: uuid('sponsor_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sponsorMembershipId: uuid('sponsor_membership_id').notNull().references(() => houseMemberships.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  houseIndex: index('s2s_service_grants_house_idx').on(table.houseId),
  sponsorIndex: index('s2s_service_grants_sponsor_idx').on(table.sponsorUserId),
  serviceIdCheck: check('s2s_service_grants_service_id_check', sql`${table.serviceId} = 'hermes-family-pantry-reader'`),
  scopeCheck: check('s2s_service_grants_scope_check', sql`${table.scope} = 'dinner-context:read'`),
  expiresAtCheck: check('s2s_service_grants_expires_at_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

export const s2sServiceCredentials = pgTable('s2s_service_credentials', {
  keyId: text('key_id').primaryKey(),
  grantId: uuid('grant_id').notNull().references(() => s2sServiceGrants.id, { onDelete: 'cascade' }),
  secretDigest: text('secret_digest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  grantIndex: index('s2s_service_credentials_grant_idx').on(table.grantId),
  keyIdCheck: check('s2s_service_credentials_key_id_check', sql`${table.keyId} ~ '^[A-Za-z0-9_-]{16,64}$'`),
  secretDigestCheck: check('s2s_service_credentials_secret_digest_check', sql`${table.secretDigest} ~ '^[0-9a-f]{64}$'`),
  expiresAtCheck: check('s2s_service_credentials_expires_at_check', sql`${table.expiresAt} > ${table.createdAt}`),
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
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
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

export const mealPlanStates = pgTable('meal_plan_states', {
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  userScopeId: uuid('user_scope_id').references(() => users.id, { onDelete: 'cascade' }),
  houseScopeId: uuid('house_scope_id').references(() => houses.id, { onDelete: 'cascade' }),
  planDate: date('plan_date', { mode: 'string' }).notNull(),
  revision: uuid('revision').notNull(),
  kind: text('kind').notNull(),
  recipeId: text('recipe_id'),
  manualClientAt: timestamp('manual_client_at', { withTimezone: true }),
  manualServerAt: timestamp('manual_server_at', { withTimezone: true }),
  manualDeviceId: text('manual_device_id'),
  manualOperationId: text('manual_operation_id'),
}, (table) => ({
  primary: primaryKey({ name: 'meal_plan_states_pk', columns: [table.scopeType, table.scopeId, table.planDate] }),
  scopeCheck: check('meal_plan_states_scope_check', sql`(${table.scopeType} = 'user' AND ${table.userScopeId} IS NOT NULL AND ${table.houseScopeId} IS NULL AND ${table.scopeId} = ${table.userScopeId}::text) OR (${table.scopeType} = 'house' AND ${table.userScopeId} IS NULL AND ${table.houseScopeId} IS NOT NULL AND ${table.scopeId} = ${table.houseScopeId}::text)`),
  kindCheck: check('meal_plan_states_kind_check', sql`${table.kind} IN ('automatic', 'manual', 'deleted')`),
  recipeCheck: check('meal_plan_states_recipe_check', sql`(${table.kind} = 'deleted' AND ${table.recipeId} IS NULL) OR (${table.kind} IN ('automatic', 'manual') AND ${table.recipeId} IS NOT NULL)`),
  manualTupleCheck: check('meal_plan_states_manual_tuple_check', sql`(${table.manualClientAt} IS NULL AND ${table.manualServerAt} IS NULL AND ${table.manualDeviceId} IS NULL AND ${table.manualOperationId} IS NULL) OR (${table.manualClientAt} IS NOT NULL AND ${table.manualServerAt} IS NOT NULL AND ${table.manualDeviceId} IS NOT NULL AND ${table.manualOperationId} IS NOT NULL)`),
}));

export const mealPlanReceipts = pgTable('meal_plan_receipts', {
  id: uuid('id').defaultRandom().primaryKey(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  userScopeId: uuid('user_scope_id').references(() => users.id, { onDelete: 'cascade' }),
  houseScopeId: uuid('house_scope_id').references(() => houses.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  operationId: text('operation_id').notNull(),
  requestHash: text('request_hash').notNull(),
  importSource: text('import_source'),
  importSourceId: text('import_source_id'),
  importLocalRevision: text('import_local_revision'),
  commandHash: text('command_hash'),
  commandJson: jsonb('command_json').$type<import('@ikuck/shared/contracts').PlanCommand>(),
  resultJson: jsonb('result_json').$type<import('@ikuck/shared/contracts').PlanResult>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  operationUnique: uniqueIndex('meal_plan_receipts_scope_actor_operation_unique').on(table.scopeType, table.scopeId, table.actorId, table.operationId),
  importSourceUnique: uniqueIndex('meal_plan_receipts_import_source_unique')
    .on(table.scopeType, table.scopeId, table.actorId, table.importSource, table.importSourceId, table.importLocalRevision)
    .where(sql`${table.importSource} IS NOT NULL`),
  scopeIndex: index('meal_plan_receipts_scope_index').on(table.scopeType, table.scopeId),
  scopeCheck: check('meal_plan_receipts_scope_check', sql`(${table.scopeType} = 'user' AND ${table.userScopeId} IS NOT NULL AND ${table.houseScopeId} IS NULL AND ${table.scopeId} = ${table.userScopeId}::text) OR (${table.scopeType} = 'house' AND ${table.userScopeId} IS NULL AND ${table.houseScopeId} IS NOT NULL AND ${table.scopeId} = ${table.houseScopeId}::text)`),
  operationIdCheck: check('meal_plan_receipts_operation_id_check', sql`length(${table.operationId}) BETWEEN 1 AND 128`),
  requestHashCheck: check('meal_plan_receipts_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  importProvenanceCheck: check('meal_plan_receipts_import_provenance_check', sql`(${table.importSource} IS NULL AND ${table.importSourceId} IS NULL AND ${table.importLocalRevision} IS NULL AND ${table.commandHash} IS NULL) OR (${table.importSource} IS NOT NULL AND ${table.importSource} IN ('guest', 'account') AND ${table.importSourceId} IS NOT NULL AND length(${table.importSourceId}) BETWEEN 1 AND 128 AND ${table.importLocalRevision} IS NOT NULL AND length(${table.importLocalRevision}) BETWEEN 1 AND 128 AND ${table.commandHash} IS NOT NULL AND ${table.commandHash} ~ '^[0-9a-f]{64}$')`),
}));

export const mealPlanMigrationConflicts = pgTable('meal_plan_migration_conflicts', {
  id: uuid('id').defaultRandom().primaryKey(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  sourceAccountId: uuid('source_account_id').notNull(),
  planDate: date('plan_date', { mode: 'string' }).notNull(),
  sourceRevision: uuid('source_revision').notNull(),
  sourceProjectionMutationId: text('source_projection_mutation_id').notNull(),
  sourceDeviceId: text('source_device_id').notNull(),
  sourceClientUpdatedAt: timestamp('source_client_updated_at', { withTimezone: true }).notNull(),
  sourceServerUpdatedAt: timestamp('source_server_updated_at', { withTimezone: true }).notNull(),
  sourceState: jsonb('source_state').$type<PlanState>(),
  sourceProjection: jsonb('source_projection').$type<Record<string, unknown>>(),
  targetRevision: uuid('target_revision').notNull(),
  targetState: jsonb('target_state').$type<PlanState>().notNull(),
  originalCommand: jsonb('original_command').$type<PlanCommand>().notNull(),
  status: text('status').notNull().default('pending'),
  resolutionDigest: text('resolution_digest'),
  resolutionCommand: jsonb('resolution_command').$type<PlanCommand>(),
  resolutionResult: jsonb('resolution_result').$type<PlanResult>(),
  resolvedByUserId: uuid('resolved_by_user_id'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueSourceRevision: uniqueIndex('meal_plan_migration_conflicts_source_unique')
    .on(table.houseId, table.sourceAccountId, table.planDate, table.sourceRevision),
  houseStatusCreated: index('meal_plan_migration_conflicts_house_status_created_idx')
    .on(table.houseId, table.status, table.createdAt),
  statusCheck: check('meal_plan_migration_conflicts_status_check', sql`${table.status} IN ('pending', 'resolved')`),
  resolutionCheck: check('meal_plan_migration_conflicts_resolution_check', sql`
    (${table.status} = 'pending' AND ${table.resolutionDigest} IS NULL AND ${table.resolutionCommand} IS NULL
      AND ${table.resolutionResult} IS NULL AND ${table.resolvedByUserId} IS NULL AND ${table.resolvedAt} IS NULL)
    OR (${table.status} = 'resolved' AND ${table.resolutionDigest} ~ '^[0-9a-f]{64}$'
      AND ${table.resolutionCommand} IS NOT NULL AND ${table.resolutionResult} IS NOT NULL
      AND ${table.resolvedByUserId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)
  `),
}));

export const mealPlanMigrationQuarantines = pgTable('meal_plan_migration_quarantines', {
  id: uuid('id').defaultRandom().primaryKey(),
  houseId: uuid('house_id').notNull().references(() => houses.id, { onDelete: 'cascade' }),
  sourceAccountId: uuid('source_account_id').notNull(),
  planDate: date('plan_date', { mode: 'string' }).notNull(),
  reasonCode: text('reason_code').notNull(),
  fingerprint: text('fingerprint').notNull(),
  rawSourceState: jsonb('raw_source_state'),
  rawSourceProjection: jsonb('raw_source_projection'),
  rawTargetState: jsonb('raw_target_state'),
  rawTargetProjection: jsonb('raw_target_projection'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueEvidence: uniqueIndex('meal_plan_migration_quarantines_source_fingerprint_unique')
    .on(table.houseId, table.sourceAccountId, table.planDate, table.fingerprint),
  houseDate: index('meal_plan_migration_quarantines_house_date_idx').on(table.houseId, table.planDate),
  fingerprintCheck: check('meal_plan_migration_quarantines_fingerprint_check', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
  reasonCheck: check('meal_plan_migration_quarantines_reason_check', sql`length(${table.reasonCode}) BETWEEN 1 AND 80`),
}));

export const processedSyncMutations = pgTable('processed_sync_mutations', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  scopeType: text('scope_type').notNull().default('user'),
  scopeId: text('scope_id').notNull(),
  mutationId: text('mutation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  mutationUnique: uniqueIndex('processed_sync_mutations_scope_unique').on(table.scopeType, table.scopeId, table.mutationId),
  scopeTypeCheck: check('processed_sync_mutations_scope_type_check', sql`${table.scopeType} in ('user', 'house')`),
}));

export const dinnerConsumptionReceipts = pgTable('dinner_consumption_receipts', {
  operationId: text('operation_id').primaryKey(),
  entryId: text('entry_id').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  requestDigest: text('request_digest').notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  plan: jsonb('plan').$type<PantryConsumptionPlan>().notNull(),
}, (table) => ({
  entryUnique: uniqueIndex('dinner_consumption_receipts_scope_entry_unique').on(table.scopeType, table.scopeId, table.entryId),
  scopeIndex: index('dinner_consumption_receipts_scope_index').on(table.scopeType, table.scopeId),
  operationIdCheck: check('dinner_consumption_operation_id_check', sql`length(${table.operationId}) between 1 and 128`),
  entryIdCheck: check('dinner_consumption_entry_id_check', sql`length(${table.entryId}) between 1 and 128`),
  scopeTypeCheck: check('dinner_consumption_scope_type_check', sql`${table.scopeType} in ('user', 'house')`),
  requestDigestCheck: check('dinner_consumption_request_digest_check', sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
}));
