CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`telegram_sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_kind_ref` ON `notifications` (`kind`,`ref_id`);