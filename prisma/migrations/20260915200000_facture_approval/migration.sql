-- AlterEnum: notifications.type
ALTER TABLE `notifications` MODIFY COLUMN `type` ENUM(
  'WALLET_TRANSFER_REQUEST',
  'WALLET_TRANSFER_ACCEPTED',
  'WALLET_TRANSFER_DECLINED',
  'ORDER_CANCELLED',
  'FACTURE_APPROVAL_REQUEST',
  'FACTURE_APPROVAL_ACCEPTED',
  'FACTURE_APPROVAL_DECLINED',
  'FACTURE_PREPARE'
) NOT NULL;

-- AlterTable: bon_livraisons facture approval columns
ALTER TABLE `bon_livraisons`
  ADD COLUMN `facture_approver_id` INTEGER NULL,
  ADD COLUMN `facture_approval_status` ENUM('NONE', 'PENDING', 'ACCEPTED', 'DECLINED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `facture_approved_at` DATETIME(3) NULL,
  ADD COLUMN `facture_approved_by_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `bon_livraisons_facture_approver_id_idx` ON `bon_livraisons`(`facture_approver_id`);
CREATE INDEX `bon_livraisons_facture_approval_status_idx` ON `bon_livraisons`(`facture_approval_status`);

-- AddForeignKey
ALTER TABLE `bon_livraisons`
  ADD CONSTRAINT `bon_livraisons_facture_approver_id_fkey`
  FOREIGN KEY (`facture_approver_id`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `bon_livraisons`
  ADD CONSTRAINT `bon_livraisons_facture_approved_by_id_fkey`
  FOREIGN KEY (`facture_approved_by_id`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
