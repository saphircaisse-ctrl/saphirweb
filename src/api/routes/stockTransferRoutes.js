import { Router } from "express";
import * as StockTransferController from "../controllers/stockTransferController.js";

import { auth } from "../middlewares/authMiddleware.js";
import {
  hasPermission,
  hasAnyPermission,
} from "../middlewares/rbacMiddleware.js";

import {
  createTransferValidator,
  transferIdValidator,
  depotIdParamValidator,
  getTransfersQueryValidator,
  appendTransferLinesValidator,
  getReceiversQueryValidator,
} from "../validations/stockTransferValidation.js";

const router = Router();

router.use(auth);

/**
 * GET /api/transfers
 */
router.get(
  "/",
  getTransfersQueryValidator,
  StockTransferController.getAllTransfers,
);

/**
 * GET /api/transfers/receivers
 * Must be registered BEFORE /:id
 */
router.get(
  "/receivers",
  hasAnyPermission(["create_transfer", "validate_transfer"]),
  getReceiversQueryValidator,
  StockTransferController.getReceivers,
);

/**
 * GET /api/transfers/by-depot/:depotId
 * Must be registered BEFORE /:id
 */
router.get(
  "/by-depot/:depotId",
  depotIdParamValidator,
  StockTransferController.getTransfersByDepot,
);

/**
 * GET /api/transfers/:id
 */
router.get(
  "/:id",
  transferIdValidator,
  StockTransferController.getTransferById,
);

/**
 * POST /api/transfers/:id/append-lines
 */
router.post(
  "/:id/append-lines",
  hasPermission("create_transfer"),
  transferIdValidator,
  appendTransferLinesValidator,
  StockTransferController.appendTransferLines,
);

/**
 * POST /api/transfers/:id/accept
 * Auth only — receiver can accept without validate_transfer
 */
router.post(
  "/:id/accept",
  transferIdValidator,
  StockTransferController.acceptTransfer,
);

/**
 * POST /api/transfers/:id/decline
 * Auth only — receiver can decline without validate_transfer
 */
router.post(
  "/:id/decline",
  transferIdValidator,
  StockTransferController.declineTransfer,
);

/**
 * POST /api/transfers/:id/validate
 * Admin path — requires validate_transfer
 */
router.post(
  "/:id/validate",
  hasPermission("validate_transfer"),
  transferIdValidator,
  StockTransferController.validateTransfer,
);

/**
 * POST /api/transfers
 */
router.post(
  "/",
  hasPermission("create_transfer"),
  createTransferValidator,
  StockTransferController.createTransfer,
);

/**
 * DELETE /api/transfers/:id
 */
router.delete(
  "/:id",
  hasPermission("delete_transfer"),
  transferIdValidator,
  StockTransferController.deleteTransfer,
);

export default router;
