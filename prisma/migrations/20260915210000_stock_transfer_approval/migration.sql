-- AlterEnum: notifications.type
ALTER TABLE `notifications` MODIFY COLUMN `type` ENUM(
  'WALLET_TRANSFER_REQUEST',
  'WALLET_TRANSFER_ACCEPTED',
  'WALLET_TRANSFER_DECLINED',
  'ORDER_CANCELLED',
  'FACTURE_APPROVAL_REQUEST',
  'FACTURE_APPROVAL_ACCEPTED',
  'FACTURE_APPROVAL_DECLINED',
  'FACTURE_PREPARE',
  'STOCK_TRANSFER_REQUEST',
  'STOCK_TRANSFER_ACCEPTED',
  'STOCK_TRANSFER_DECLINED'
) NOT NULL;

-- AlterEnum: stock_transfers.status
ALTER TABLE `stock_transfers` MODIFY COLUMN `status` ENUM(
  'PENDING',
  'COMPLETED',
  'DECLINED'
) NOT NULL DEFAULT 'PENDING';

-- AlterTable: stock_transfers.receiver_user_id
ALTER TABLE `stock_transfers`
  ADD COLUMN `receiver_user_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `stock_transfers_receiver_user_id_idx` ON `stock_transfers`(`receiver_user_id`);

-- AddForeignKey
ALTER TABLE `stock_transfers`
  ADD CONSTRAINT `stock_transfers_receiver_user_id_fkey`
  FOREIGN KEY (`receiver_user_id`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
