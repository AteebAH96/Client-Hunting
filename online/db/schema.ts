import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const csvState = sqliteTable('csv_state', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  csv: text('csv').notNull(),
});
export const csvBackups = sqliteTable('csv_backups', {
  revision: integer('revision').primaryKey(),
  csv: text('csv').notNull(),
  createdAt: text('created_at').notNull(),
});
export const searchJobs = sqliteTable('search_jobs', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  activeSlot: integer('active_slot'),
  leaseUntil: integer('lease_until').notNull().default(0),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('one_active_search').on(table.activeSlot)]);
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
