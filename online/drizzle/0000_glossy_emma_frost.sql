CREATE TABLE `csv_backups` (
	`revision` integer PRIMARY KEY NOT NULL,
	`csv` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `csv_state` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`csv` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`active_slot` integer,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_search` ON `search_jobs` (`active_slot`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
