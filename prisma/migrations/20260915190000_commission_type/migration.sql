-- AlterTable
ALTER TABLE `articles`
  ADD COLUMN `commission_type` ENUM('VALUE', 'PERCENTAGE') NOT NULL DEFAULT 'VALUE';

-- AlterTable
ALTER TABLE `packs`
  ADD COLUMN `commission_type` ENUM('VALUE', 'PERCENTAGE') NOT NULL DEFAULT 'VALUE';
