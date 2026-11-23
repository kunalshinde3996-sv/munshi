CREATE TABLE `provenance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text,
	`value` text NOT NULL,
	`kind` text NOT NULL,
	`trusted` integer NOT NULL,
	`email_id` text,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
