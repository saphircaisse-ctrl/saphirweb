-- AlterTable
ALTER TABLE `users` ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `users_hidden_idx` ON `users`(`hidden`);
