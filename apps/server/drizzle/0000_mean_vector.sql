CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`obligation_id` text,
	`tool` text NOT NULL,
	`args_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`risk_tier` text NOT NULL,
	`tainted` integer DEFAULT false NOT NULL,
	`decision` text NOT NULL,
	`decision_reason` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`hold_until` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`trace_json` text DEFAULT '[]' NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`run_id` text,
	`action_id` text,
	`event` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_user_email` ON `contacts` (`user_id`,`email`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`from_addr` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`extraction_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'google' NOT NULL,
	`encrypted` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`due_date` text,
	`amount` real,
	`currency` text,
	`counterparty` text,
	`confidence` real NOT NULL,
	`evidence_quote` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rule_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`mode` text DEFAULT 'sandbox' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
