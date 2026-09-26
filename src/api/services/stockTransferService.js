import prisma from "../../loaders/prisma.js";
import ApiError from "../utils/apiError.js";
import ApiFeatures from "../utils/apiFeatures.js";

// Import Domain Services
import stockValidation from "./domain/stockValidationService.js";
import stockManagement from "./domain/stockManagementService.js";
import productVisibility from "../utils/productVisibilityUtility.js";
import timeRange from "../utils/timeRangeUtility.js";
import { createNotifications } from "./notificationService.js";

/* ============================================================
   STOCK TRANSFER SERVICE - INTEGRATED WITH BUSINESS RULES
============================================================ */

const SUPER_ADMIN_ROLE_NAMES = ["Super_Admin", "SUPERADMIN"];
const SOCIETE_ADMIN_ROLE_NAME = "Societe_Admin";

const getRoleName = (user) =>
  String(
    user?.roleName ||
      (typeof user?.role === "string" ? user.role : user?.role?.name) ||
      "",
  ).trim();

const isSuperAdminUser = (user) =>
  !!user?.isSuperAdmin ||
  SUPER_ADMIN_ROLE_NAMES.includes(getRoleName(user)) ||
  getRoleName(user).toLowerCase().replace(/[\s_-]+/g, "") === "superadmin";

const isSocieteAdminUser = (user) =>
  getRoleName(user) === SOCIETE_ADMIN_ROLE_NAME;

const RECEIVER_USER_SELECT = {
  id: true,
  name: true,
  email: true,
};

const TRANSFER_INCLUDE = {
  sourceDepot: {
    select: {
      id: true,
      code: true,
      name: true,
      societe: { select: { id: true, raisonSocial: true } },
    },
  },
  destinationDepot: {
    select: {
      id: true,
      code: true,
      name: true,
      societe: { select: { id: true, raisonSocial: true } },
    },
  },
  lines: {
    include: {
      article: {
        select: {
          id: true,
          barcode: true,
          name: true,
          gereEnStock: true,
          unitePrincipale: {
            select: { id: true, name: true, symbol: true },
          },
        },
      },
      variant: {
        select: {
          id: true,
          barcode: true,
          name: true,
          article: {
            select: { id: true, name: true, gereEnStock: true },
          },
        },
      },
    },
    orderBy: { lineNumber: "asc" },
  },
  transactions: {
    include: {
      depot: { select: { id: true, code: true, name: true } },
      article: { select: { id: true, name: true } },
      variant: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  createdByUser: { select: RECEIVER_USER_SELECT },
  receiverUser: { select: RECEIVER_USER_SELECT },
  validatedByUser: { select: RECEIVER_USER_SELECT },
};

/* ============================================================
   HELPER: Generate Transfer Number
============================================================ */
const generateTransferNumber = async (societeId) => {
  const year = new Date().getFullYear();
  const prefix = `TRF-${year}`;

  const lastTransfer = await prisma.stockTransfer.findFirst({
    where: {
      societeId,
      transferNumber: { startsWith: prefix },
    },
    orderBy: { transferNumber: "desc" },
    select: { transferNumber: true },
  });

  let nextNumber = 1;
  if (lastTransfer) {
    const lastNum = parseInt(lastTransfer.transferNumber.split("-")[2]);
    nextNumber = lastNum + 1;
  }

  return `${prefix}-${String(nextNumber).padStart(4, "0")}`;
};

/* ============================================================
   HELPER: Validate Depot Pair
============================================================ */
const validateDepotPair = async (sourceDepotId, destinationDepotId, user) => {
  if (sourceDepotId === destinationDepotId) {
    throw new ApiError("Source and destination depots cannot be the same", 400);
  }

  const [sourceDepot, destinationDepot] = await Promise.all([
    prisma.depot.findUnique({
      where: { id: sourceDepotId },
      select: {
        id: true,
        societeId: true,
        active: true,
        name: true,
        code: true,
      },
    }),
    prisma.depot.findUnique({
      where: { id: destinationDepotId },
      select: {
        id: true,
        societeId: true,
        active: true,
        name: true,
        code: true,
      },
    }),
  ]);

  if (!sourceDepot) throw new ApiError("Source depot not found", 404);
  if (!destinationDepot) throw new ApiError("Destination depot not found", 404);
  if (!sourceDepot.active)
    throw new ApiError(`Source depot "${sourceDepot.name}" is inactive`, 400);
  if (!destinationDepot.active)
    throw new ApiError(
      `Destination depot "${destinationDepot.name}" is inactive`,
      400,
    );

  if (!isSuperAdminUser(user)) {
    if (sourceDepot.societeId !== user.societeId) {
      throw new ApiError(
        "Access denied. Source depot belongs to another société.",
        403,
      );
    }
    if (destinationDepot.societeId !== user.societeId) {
      throw new ApiError(
        "Access denied. Destination depot belongs to another société.",
        403,
      );
    }
    if (sourceDepot.societeId !== destinationDepot.societeId) {
      throw new ApiError(
        "Regular users can only transfer between depots of the same société",
        403,
      );
    }
  }

  return { sourceDepot, destinationDepot };
};

/* ============================================================
   HELPER: Assert receiver user (active, visible, société match)
   Super Admins may receive for any société.
============================================================ */
export const assertReceiverUser = async (receiverUserId, societeId) => {
  const id = parseInt(receiverUserId, 10);
  if (!id) {
    throw new ApiError("receiverUserId is required", 400);
  }

  const receiver = await prisma.user.findFirst({
    where: { id, active: true, hidden: false },
    select: {
      id: true,
      name: true,
      email: true,
      isSuperAdmin: true,
      societeId: true,
      role: { select: { name: true } },
    },
  });

  if (!receiver) {
    throw new ApiError("Receiver user not found or inactive", 404);
  }

  const roleName = receiver.role?.name;
  const isSA =
    receiver.isSuperAdmin || SUPER_ADMIN_ROLE_NAMES.includes(roleName);

  if (!isSA && societeId != null && receiver.societeId !== societeId) {
    throw new ApiError(
      "Receiver must belong to the same société as the transfer depots",
      400,
    );
  }

  return receiver;
};

/* ============================================================
   HELPER: True hold — available -= qty, reserved += qty
============================================================ */
const applyPendingHold = async (
  tx,
  { depotId, articleId, variantId, quantity },
) => {
  const qty = parseFloat(quantity);
  const where = articleId ? { depotId, articleId } : { depotId, variantId };

  const stock = await tx.stockByDepot.findFirst({ where });
  if (!stock) {
    throw new ApiError("Insufficient stock to hold for pending transfer", 400);
  }

  const available = parseFloat(stock.quantityAvailable);
  if (available < qty) {
    throw new ApiError(
      `Insufficient available stock to hold. Available: ${available}, Requested: ${qty}`,
      400,
    );
  }

  await tx.stockByDepot.update({
    where: { id: stock.id },
    data: {
      quantityAvailable: available - qty,
      quantityReserved: parseFloat(stock.quantityReserved) + qty,
    },
  });
};

/* ============================================================
   HELPER: Release hold — restore available from reserved,
   clear reserved; also decrement inTransit for legacy rows.
   Only restores available for the reserved portion so legacy
   inTransit-only holds stay correct before TRANSFER_OUT.
============================================================ */
const releasePendingHold = async (
  tx,
  { depotId, articleId, variantId, quantity },
) => {
  const qty = parseFloat(quantity);
  const where = articleId ? { depotId, articleId } : { depotId, variantId };

  const stock = await tx.stockByDepot.findFirst({ where });
  if (!stock) return;

  const reserved = parseFloat(stock.quantityReserved || 0);
  const inTransit = parseFloat(stock.quantityInTransit || 0);
  const available = parseFloat(stock.quantityAvailable || 0);
  const restoreAvailable = Math.min(reserved, qty);

  await tx.stockByDepot.update({
    where: { id: stock.id },
    data: {
      quantityAvailable: available + restoreAvailable,
      quantityReserved: Math.max(0, reserved - qty),
      quantityInTransit: Math.max(0, inTransit - qty),
    },
  });
};

/* ============================================================
   HELPER: Can accept / decline a pending transfer
============================================================ */
const assertSocieteAccessToTransfer = (transfer, user) => {
  if (!transfer) throw new ApiError("Transfer not found", 404);

  if (
    !isSuperAdminUser(user) &&
    transfer.sourceDepot?.societeId != null &&
    transfer.sourceDepot.societeId !== user.societeId
  ) {
    throw new ApiError(
      "Access denied. This transfer belongs to another société.",
      403,
    );
  }
};

/** Receiver or Super/Societe admin — used by /accept and /decline. */
const assertCanRespondTransfer = (transfer, user) => {
  assertSocieteAccessToTransfer(transfer, user);

  const isReceiver = user.id === transfer.receiverUserId;
  if (isReceiver || isSuperAdminUser(user) || isSocieteAdminUser(user)) {
    return;
  }

  throw new ApiError(
    "Access denied. Only the designated receiver or an admin can respond.",
    403,
  );
};

/* ============================================================
   HELPER: Validate Transfer Lines
============================================================ */
const validateTransferLines = async (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ApiError("At least one transfer line is required", 400);
  }

  const seenArticles = new Set();
  const seenVariants = new Set();

  lines.forEach((line, index) => {
    if (!line.articleId && !line.variantId) {
      throw new ApiError(
        `Line ${index + 1}: Either articleId or variantId is required`,
        400,
      );
    }
    if (line.articleId && line.variantId) {
      throw new ApiError(
        `Line ${index + 1}: Provide either articleId OR variantId, not both`,
        400,
      );
    }

    if (line.articleId) {
      if (seenArticles.has(line.articleId)) {
        throw new ApiError(
          `Line ${index + 1}: Duplicate articleId ${line.articleId}.`,
          400,
        );
      }
      seenArticles.add(line.articleId);
    }

    if (line.variantId) {
      if (seenVariants.has(line.variantId)) {
        throw new ApiError(
          `Line ${index + 1}: Duplicate variantId ${line.variantId}.`,
          400,
        );
      }
      seenVariants.add(line.variantId);
    }

    if (line.quantityReceived === undefined || line.quantityReceived === null) {
      throw new ApiError(
        `Line ${index + 1}: quantityReceived is required`,
        400,
      );
    }

    const quantity = parseFloat(line.quantityReceived);
    if (isNaN(quantity) || quantity <= 0) {
      throw new ApiError(
        `Line ${index + 1}: quantityReceived must be greater than 0`,
        400,
      );
    }
  });

  await productVisibility.validateBatchProductVisibility(
    lines.map((line) => ({
      articleId: line.articleId,
      variantId: line.variantId,
    })),
    "stock transfer",
  );
};

/* ============================================================
   HELPER: Categorize Lines by Stock Management
============================================================ */
const categorizeByStockManagement = async (lines) => {
  const stockManaged = [];
  const nonStockManaged = [];

  for (const line of lines) {
    const isManaged = await stockManagement.isProductStockManaged(
      line.articleId,
      line.variantId,
    );
    if (isManaged) {
      stockManaged.push(line);
    } else {
      nonStockManaged.push(line);
    }
  }

  return { stockManaged, nonStockManaged };
};

/* ============================================================
   CREATE STOCK TRANSFER
============================================================ */
export const create = async (data, user) => {
  const {
    sourceDepotId,
    destinationDepotId,
    status = "PENDING",
    transferDate,
    notes,
    lines,
    receiverUserId: rawReceiverUserId,
  } = data;

  await timeRange.validateSystemHours(new Date(), "stock transfer");

  if (!["PENDING", "COMPLETED"].includes(status)) {
    throw new ApiError(
      'Invalid status. Must be either "PENDING" or "COMPLETED"',
      400,
    );
  }

  const { sourceDepot, destinationDepot } = await validateDepotPair(
    sourceDepotId,
    destinationDepotId,
    user,
  );

  await validateTransferLines(lines);

  let receiverUserId = null;
  if (status === "PENDING") {
    if (!rawReceiverUserId) {
      throw new ApiError(
        "receiverUserId is required for PENDING transfers",
        400,
      );
    }
    const receiver = await assertReceiverUser(
      rawReceiverUserId,
      sourceDepot.societeId,
    );
    receiverUserId = receiver.id;
  }

  const { stockManaged, nonStockManaged } =
    await categorizeByStockManagement(lines);

  if (stockManaged.length > 0) {
    await stockValidation.validateBatchStockAvailability(
      stockManaged.map((line) => ({
        depotId: sourceDepotId,
        articleId: line.articleId,
        variantId: line.variantId,
        quantity: parseFloat(line.quantityReceived),
      })),
      "stock transfer",
    );
  }

  const transferNumber = await generateTransferNumber(sourceDepot.societeId);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const transfer = await tx.stockTransfer.create({
          data: {
            societeId: sourceDepot.societeId,
            transferNumber,
            sourceDepotId,
            destinationDepotId,
            transferDate: transferDate ? new Date(transferDate) : new Date(),
            status,
            notes,
            createdBy: user.id,
            receiverUserId,
            ...(status === "COMPLETED" && {
              validatedBy: user.id,
              validatedAt: new Date(),
            }),
          },
        });

        const linesData = lines.map((line, index) => ({
          transferId: transfer.id,
          articleId: line.articleId || null,
          variantId: line.variantId || null,
          lineNumber: index + 1,
          quantityReceived: parseFloat(line.quantityReceived),
        }));

        await tx.stockTransferLine.createMany({ data: linesData });

        const transactionsCreated = [];

        if (stockManaged.length > 0) {
          const stockManagedData = linesData.filter((lineData) =>
            stockManaged.some(
              (sm) =>
                (sm.articleId && sm.articleId === lineData.articleId) ||
                (sm.variantId && sm.variantId === lineData.variantId),
            ),
          );

          if (status === "PENDING") {
            for (const lineData of stockManagedData) {
              await applyPendingHold(tx, {
                depotId: sourceDepotId,
                articleId: lineData.articleId,
                variantId: lineData.variantId,
                quantity: lineData.quantityReceived,
              });
            }
          } else {
            for (const lineData of stockManagedData) {
              const quantity = lineData.quantityReceived;

              const transactionResults =
                await stockManagement.batchStockOperationsWithTx(tx, [
                  {
                    depotId: sourceDepotId,
                    articleId: lineData.articleId,
                    variantId: lineData.variantId,
                    quantityChange: -quantity,
                    transactionType: "TRANSFER_OUT",
                    referenceId: transferNumber,
                    reason: `Transfer to ${destinationDepot.name} (${destinationDepot.code})`,
                    userId: user.id,
                    transferId: transfer.id,
                  },
                  {
                    depotId: destinationDepotId,
                    articleId: lineData.articleId,
                    variantId: lineData.variantId,
                    quantityChange: quantity,
                    transactionType: "TRANSFER_IN",
                    referenceId: transferNumber,
                    reason: `Transfer from ${sourceDepot.name} (${sourceDepot.code})`,
                    userId: user.id,
                    transferId: transfer.id,
                  },
                ]);

              transactionsCreated.push(
                ...transactionResults.filter((r) => r.stockUpdated),
              );
            }
          }
        }

        return tx.stockTransfer.findUnique({
          where: { id: transfer.id },
          include: TRANSFER_INCLUDE,
        });
      },
      { timeout: 30000 },
    );

    if (status === "PENDING" && receiverUserId) {
      try {
        await prisma.$transaction(async (tx) => {
          await createNotifications(tx, {
            userIds: [receiverUserId],
            type: "STOCK_TRANSFER_REQUEST",
            payload: {
              transferId: result.id,
              transferNumber: result.transferNumber,
              sourceDepotName: sourceDepot.name,
              destinationDepotName: destinationDepot.name,
              requestedByName: user.name || user.email || null,
              linesCount: result.lines.length,
              totalQuantity: result.lines.reduce(
                (sum, l) => sum + parseFloat(l.quantityReceived),
                0,
              ),
            },
          });
        });
      } catch (notifyError) {
        console.error(
          "[stockTransfer.create] STOCK_TRANSFER_REQUEST notify failed:",
          notifyError?.message || notifyError,
        );
      }
    }

    return {
      ...result,
      summary: {
        totalLines: result.lines.length,
        stockManagedLines: stockManaged.length,
        nonStockManagedLines: nonStockManaged.length,
        totalQuantity: result.lines.reduce(
          (sum, l) => sum + parseFloat(l.quantityReceived),
          0,
        ),
        transactionsCreated: result.transactions.length,
        stockMovementApplied: status === "COMPLETED" && stockManaged.length > 0,
      },
    };
  } catch (error) {
    console.error("Stock transfer creation failed:", error);
    if (error.code === "P2002")
      throw new ApiError("Duplicate transfer number.", 409);
    if (error.code === "P2003")
      throw new ApiError(
        "Invalid reference: Article, Variant, or Depot not found.",
        400,
      );
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Transfer creation failed: ${error.message}`, 500);
  }
};

/* ============================================================
   GET RECEIVERS (active, non-hidden users for société)
============================================================ */
export const getReceivers = async (user, { societeId, search } = {}) => {
  const scopedSocieteId = isSuperAdminUser(user)
    ? societeId
      ? parseInt(societeId, 10)
      : null
    : user.societeId;

  if (!scopedSocieteId && !isSuperAdminUser(user)) {
    throw new ApiError("societeId is required", 400);
  }

  const where = {
    active: true,
    hidden: false,
    AND: [
      ...(scopedSocieteId
        ? [
            {
              OR: [{ societeId: scopedSocieteId }, { isSuperAdmin: true }],
            },
          ]
        : []),
      ...(search
        ? [
            {
              OR: [
                { name: { contains: search } },
                { email: { contains: search } },
              ],
            },
          ]
        : []),
    ],
  };

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      role: { select: { name: true } },
    },
    orderBy: { name: "asc" },
    take: 100,
  });

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role?.name || null,
  }));
};

/* ============================================================
   GET ALL TRANSFERS
============================================================ */
export const getAll = async (query, user) => {
  const where = {};

  if (isSuperAdminUser(user)) {
    if (query.societeId) {
      where.societeId = parseInt(query.societeId);
      delete query.societeId;
    }
  } else {
    where.societeId = user.societeId;
    delete query.societeId;
  }

  if (query.sourceDepotId) {
    where.sourceDepotId = parseInt(query.sourceDepotId);
    delete query.sourceDepotId;
  }
  if (query.destinationDepotId) {
    where.destinationDepotId = parseInt(query.destinationDepotId);
    delete query.destinationDepotId;
  }
  if (query.status) {
    where.status = query.status;
    delete query.status;
  }
  if (query.startDate) {
    where.transferDate = {
      ...where.transferDate,
      gte: new Date(query.startDate),
    };
    delete query.startDate;
  }
  if (query.endDate) {
    where.transferDate = {
      ...where.transferDate,
      lte: new Date(query.endDate),
    };
    delete query.endDate;
  }

  const count = await prisma.stockTransfer.count({ where });
  const apiFeatures = new ApiFeatures(query).sort().paginate(count);
  const { orderBy, skip, take } = apiFeatures.build();

  const transfers = await prisma.stockTransfer.findMany({
    where,
    orderBy: orderBy || { transferDate: "desc" },
    skip,
    take,
    include: {
      sourceDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      destinationDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      createdByUser: { select: { id: true, name: true } },
      receiverUser: { select: { id: true, name: true } },
      validatedByUser: { select: { id: true, name: true } },
      _count: { select: { lines: true, transactions: true } },
    },
  });

  return {
    results: transfers.length,
    pagination: apiFeatures.paginationResult,
    data: transfers,
  };
};

/* ============================================================
   GET TRANSFER BY ID
============================================================ */
export const getById = async (id, user) => {
  const transfer = await prisma.stockTransfer.findUnique({
    where: { id },
    include: {
      sourceDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societeId: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      destinationDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      lines: {
        include: {
          article: {
            select: {
              id: true,
              barcode: true,
              prixAchat: true,
              name: true,
              visible: true,
              gereEnStock: true,
              unitePrincipale: {
                select: { id: true, name: true, symbol: true },
              },
            },
          },
          variant: {
            select: {
              id: true,
              barcode: true,
              name: true,
              article: {
                select: {
                  id: true,
                  name: true,
                  prixAchat: true,
                  visible: true,
                  gereEnStock: true,
                },
              },
            },
          },
        },
        orderBy: { lineNumber: "asc" },
      },
      transactions: {
        include: {
          depot: { select: { id: true, code: true, name: true } },
          article: { select: { id: true, name: true } },
          variant: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      createdByUser: { select: RECEIVER_USER_SELECT },
      receiverUser: { select: RECEIVER_USER_SELECT },
      validatedByUser: { select: RECEIVER_USER_SELECT },
    },
  });

  if (!transfer) throw new ApiError("Transfer not found", 404);

  if (
    !isSuperAdminUser(user) &&
    transfer.sourceDepot.societeId !== user.societeId
  ) {
    throw new ApiError(
      "Access denied. This transfer belongs to another société.",
      403,
    );
  }

  return {
    ...transfer,
    summary: {
      totalLines: transfer.lines.length,
      totalQuantity: transfer.lines.reduce(
        (sum, l) => sum + parseFloat(l.quantityReceived),
        0,
      ),
      transactionsCreated: transfer.transactions.length,
      stockMovementApplied: transfer.status === "COMPLETED",
    },
  };
};

/* ============================================================
   GET TRANSFERS BY DEPOT
============================================================ */
export const getByDepot = async (depotId, user, query = {}) => {
  const depot = await prisma.depot.findUnique({
    where: { id: depotId },
    select: { id: true, code: true, name: true, societeId: true },
  });

  if (!depot) throw new ApiError("Depot not found", 404);

  if (!isSuperAdminUser(user) && depot.societeId !== user.societeId) {
    throw new ApiError(
      "Access denied. This depot belongs to another société.",
      403,
    );
  }

  const where = {
    OR: [{ sourceDepotId: depotId }, { destinationDepotId: depotId }],
  };

  if (query.status) where.status = query.status;
  if (query.startDate)
    where.transferDate = {
      ...where.transferDate,
      gte: new Date(query.startDate),
    };
  if (query.endDate)
    where.transferDate = {
      ...where.transferDate,
      lte: new Date(query.endDate),
    };

  const transfers = await prisma.stockTransfer.findMany({
    where,
    orderBy: { transferDate: "desc" },
    include: {
      sourceDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      destinationDepot: {
        select: {
          id: true,
          code: true,
          name: true,
          societe: { select: { id: true, raisonSocial: true } },
        },
      },
      createdByUser: { select: { id: true, name: true } },
      receiverUser: { select: { id: true, name: true } },
      validatedByUser: { select: { id: true, name: true } },
      _count: { select: { lines: true, transactions: true } },
    },
  });

  return {
    depot: { id: depot.id, code: depot.code, name: depot.name },
    results: transfers.length,
    data: transfers,
  };
};

/* ============================================================
   APPEND TRANSFER LINES
============================================================ */
export const appendLines = async (transferId, data, user) => {
  const { lines } = data;

  await timeRange.validateSystemHours(new Date(), "append transfer lines");
  await validateTransferLines(lines);

  const transfer = await prisma.stockTransfer.findUnique({
    where: { id: transferId },
    include: {
      sourceDepot: {
        select: {
          id: true,
          societeId: true,
          name: true,
          code: true,
          active: true,
        },
      },
      destinationDepot: {
        select: { id: true, name: true, code: true, active: true },
      },
      lines: {
        select: {
          id: true,
          articleId: true,
          variantId: true,
          lineNumber: true,
          quantityReceived: true,
        },
      },
    },
  });

  if (!transfer) throw new ApiError("Transfer not found", 404);

  if (
    !isSuperAdminUser(user) &&
    transfer.sourceDepot.societeId !== user.societeId
  ) {
    throw new ApiError(
      "Access denied. This transfer belongs to another société.",
      403,
    );
  }
  if (transfer.status === "DECLINED") {
    throw new ApiError("Cannot append lines to a declined transfer", 400);
  }
  if (!transfer.sourceDepot.active) {
    throw new ApiError(
      `Source depot "${transfer.sourceDepot.name}" is inactive.`,
      400,
    );
  }
  if (!transfer.destinationDepot.active) {
    throw new ApiError(
      `Destination depot "${transfer.destinationDepot.name}" is inactive.`,
      400,
    );
  }

  const existingProducts = new Set();
  transfer.lines.forEach((line) => {
    if (line.articleId) existingProducts.add(`article_${line.articleId}`);
    if (line.variantId) existingProducts.add(`variant_${line.variantId}`);
  });

  lines.forEach((line, index) => {
    const key = line.articleId
      ? `article_${line.articleId}`
      : `variant_${line.variantId}`;
    if (existingProducts.has(key)) {
      throw new ApiError(
        `Line ${index + 1}: Product already exists in this transfer.`,
        400,
      );
    }
  });

  const { stockManaged, nonStockManaged } =
    await categorizeByStockManagement(lines);

  if (stockManaged.length > 0) {
    await stockValidation.validateBatchStockAvailability(
      stockManaged.map((line) => ({
        depotId: transfer.sourceDepot.id,
        articleId: line.articleId,
        variantId: line.variantId,
        quantity: parseFloat(line.quantityReceived),
      })),
      "append transfer lines",
    );
  }

  const maxLineNumber =
    transfer.lines.length > 0
      ? Math.max(...transfer.lines.map((l) => l.lineNumber))
      : 0;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const newLinesData = lines.map((line, index) => ({
          transferId,
          articleId: line.articleId || null,
          variantId: line.variantId || null,
          lineNumber: maxLineNumber + index + 1,
          quantityReceived: parseFloat(line.quantityReceived),
        }));

        await tx.stockTransferLine.createMany({ data: newLinesData });

        const transactionsCreated = [];

        if (stockManaged.length > 0) {
          const stockManagedData = newLinesData.filter((lineData) =>
            stockManaged.some(
              (sm) =>
                (sm.articleId && sm.articleId === lineData.articleId) ||
                (sm.variantId && sm.variantId === lineData.variantId),
            ),
          );

          if (transfer.status === "PENDING") {
            for (const lineData of stockManagedData) {
              await applyPendingHold(tx, {
                depotId: transfer.sourceDepot.id,
                articleId: lineData.articleId,
                variantId: lineData.variantId,
                quantity: lineData.quantityReceived,
              });
            }
          } else {
            for (const lineData of stockManagedData) {
              const quantity = lineData.quantityReceived;

              const transactionResults =
                await stockManagement.batchStockOperationsWithTx(tx, [
                  {
                    depotId: transfer.sourceDepot.id,
                    articleId: lineData.articleId,
                    variantId: lineData.variantId,
                    quantityChange: -quantity,
                    transactionType: "TRANSFER_OUT",
                    referenceId: transfer.transferNumber,
                    reason: `Transfer to ${transfer.destinationDepot.name} (${transfer.destinationDepot.code}) - Appended`,
                    userId: user.id,
                    transferId: transferId,
                  },
                  {
                    depotId: transfer.destinationDepotId,
                    articleId: lineData.articleId,
                    variantId: lineData.variantId,
                    quantityChange: quantity,
                    transactionType: "TRANSFER_IN",
                    referenceId: transfer.transferNumber,
                    reason: `Transfer from ${transfer.sourceDepot.name} (${transfer.sourceDepot.code}) - Appended`,
                    userId: user.id,
                    transferId: transferId,
                  },
                ]);

              transactionsCreated.push(
                ...transactionResults.filter((r) => r.stockUpdated),
              );
            }
          }
        }

        await tx.stockTransfer.update({
          where: { id: transferId },
          data: { updatedAt: new Date() },
        });

        const updatedTransfer = await tx.stockTransfer.findUnique({
          where: { id: transferId },
          include: TRANSFER_INCLUDE,
        });

        return {
          transfer: updatedTransfer,
          linesAdded: newLinesData.length,
          transactionsCreated: transactionsCreated.length,
        };
      },
      { timeout: 30000 },
    );

    return {
      ...result.transfer,
      summary: {
        totalLines: result.transfer.lines.length,
        stockManagedLines: stockManaged.length,
        nonStockManagedLines: nonStockManaged.length,
        totalQuantity: result.transfer.lines.reduce(
          (sum, l) => sum + parseFloat(l.quantityReceived),
          0,
        ),
        transactionsCreated: result.transfer.transactions.length,
        stockMovementApplied:
          transfer.status === "COMPLETED" && stockManaged.length > 0,
      },
      appendInfo: {
        linesAdded: result.linesAdded,
        transactionsCreated: result.transactionsCreated,
      },
    };
  } catch (error) {
    console.error("Append transfer lines failed:", error);
    if (error.code === "P2002")
      throw new ApiError("Duplicate constraint violation.", 409);
    if (error.code === "P2003") throw new ApiError("Invalid reference.", 400);
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      `Failed to append transfer lines: ${error.message}`,
      500,
    );
  }
};

/* ============================================================
   VALIDATE / ACCEPT TRANSFER (PENDING → COMPLETED)
============================================================ */
/**
 * Complete a PENDING transfer (move stock).
 * @param {{ receiverGate?: boolean }} options
 *   - receiverGate true (default): only designated receiver / SA / Societe_Admin
 *   - receiverGate false: any caller that already passed validate_transfer middleware
 */
export const validateTransfer = async (
  transferId,
  user,
  options = { receiverGate: true },
) => {
  await timeRange.validateSystemHours(new Date(), "validate transfer");

  const transfer = await prisma.stockTransfer.findUnique({
    where: { id: transferId },
    include: {
      sourceDepot: {
        select: {
          id: true,
          societeId: true,
          name: true,
          code: true,
          active: true,
        },
      },
      destinationDepot: {
        select: { id: true, name: true, code: true, active: true },
      },
      lines: {
        select: {
          id: true,
          articleId: true,
          variantId: true,
          lineNumber: true,
          quantityReceived: true,
        },
        orderBy: { lineNumber: "asc" },
      },
    },
  });

  if (!transfer) throw new ApiError("Transfer not found", 404);

  if (options.receiverGate !== false) {
    assertCanRespondTransfer(transfer, user);
  } else {
    assertSocieteAccessToTransfer(transfer, user);
  }

  if (transfer.status === "COMPLETED") {
    throw new ApiError(
      "Transfer is already completed and cannot be modified",
      400,
    );
  }
  if (transfer.status === "DECLINED") {
    throw new ApiError("Transfer was declined and cannot be validated", 400);
  }
  if (!transfer.lines || transfer.lines.length === 0) {
    throw new ApiError("Cannot complete transfer with no lines.", 400);
  }
  if (!transfer.sourceDepot.active) {
    throw new ApiError(
      `Source depot "${transfer.sourceDepot.name}" is inactive.`,
      400,
    );
  }
  if (!transfer.destinationDepot.active) {
    throw new ApiError(
      `Destination depot "${transfer.destinationDepot.name}" is inactive.`,
      400,
    );
  }

  const { stockManaged, nonStockManaged } = await categorizeByStockManagement(
    transfer.lines,
  );

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.stockTransfer.updateMany({
          where: { id: transferId, status: "PENDING" },
          data: {
            status: "COMPLETED",
            validatedBy: user.id,
            validatedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          throw new ApiError(
            "Transfer is no longer pending (already processed)",
            409,
          );
        }

        const transactionsCreated = [];

        if (stockManaged.length > 0) {
          for (const line of stockManaged) {
            const quantity = parseFloat(line.quantityReceived);

            await releasePendingHold(tx, {
              depotId: transfer.sourceDepot.id,
              articleId: line.articleId,
              variantId: line.variantId,
              quantity,
            });

            const transactionResults =
              await stockManagement.batchStockOperationsWithTx(tx, [
                {
                  depotId: transfer.sourceDepot.id,
                  articleId: line.articleId,
                  variantId: line.variantId,
                  quantityChange: -quantity,
                  transactionType: "TRANSFER_OUT",
                  referenceId: transfer.transferNumber,
                  reason: `Transfer to ${transfer.destinationDepot.name} (${transfer.destinationDepot.code})`,
                  userId: user.id,
                  transferId: transferId,
                },
                {
                  depotId: transfer.destinationDepotId,
                  articleId: line.articleId,
                  variantId: line.variantId,
                  quantityChange: quantity,
                  transactionType: "TRANSFER_IN",
                  referenceId: transfer.transferNumber,
                  reason: `Transfer from ${transfer.sourceDepot.name} (${transfer.sourceDepot.code})`,
                  userId: user.id,
                  transferId: transferId,
                },
              ]);

            transactionsCreated.push(
              ...transactionResults.filter((r) => r.stockUpdated),
            );
          }
        }

        if (transfer.createdBy && transfer.createdBy !== user.id) {
          await createNotifications(tx, {
            userIds: [transfer.createdBy],
            type: "STOCK_TRANSFER_ACCEPTED",
            payload: {
              transferId,
              transferNumber: transfer.transferNumber,
              sourceDepotName: transfer.sourceDepot.name,
              destinationDepotName: transfer.destinationDepot.name,
              acceptedByName: user.name || user.email || null,
            },
          });
        }

        const completedTransfer = await tx.stockTransfer.findUnique({
          where: { id: transferId },
          include: TRANSFER_INCLUDE,
        });

        return {
          transfer: completedTransfer,
          transactionsCreated: transactionsCreated.length,
        };
      },
      { timeout: 30000 },
    );

    return {
      ...result.transfer,
      summary: {
        totalLines: result.transfer.lines.length,
        stockManagedLines: stockManaged.length,
        nonStockManagedLines: nonStockManaged.length,
        totalQuantity: result.transfer.lines.reduce(
          (sum, l) => sum + parseFloat(l.quantityReceived),
          0,
        ),
        transactionsCreated: result.transfer.transactions.length,
        stockMovementApplied: true,
      },
    };
  } catch (error) {
    console.error("Transfer validation failed:", error);
    if (error instanceof ApiError) throw error;
    if (error.code === "P2002")
      throw new ApiError("Duplicate constraint violation.", 409);
    if (error.code === "P2003") throw new ApiError("Invalid reference.", 400);
    throw new ApiError(`Failed to validate transfer: ${error.message}`, 500);
  }
};

/* ============================================================
   DECLINE TRANSFER (PENDING → DECLINED, release hold)
============================================================ */
export const declineTransfer = async (transferId, user) => {
  await timeRange.validateSystemHours(new Date(), "decline transfer");

  const transfer = await prisma.stockTransfer.findUnique({
    where: { id: transferId },
    include: {
      sourceDepot: {
        select: {
          id: true,
          societeId: true,
          name: true,
          code: true,
        },
      },
      destinationDepot: {
        select: { id: true, name: true, code: true },
      },
      lines: {
        select: {
          id: true,
          articleId: true,
          variantId: true,
          quantityReceived: true,
        },
      },
    },
  });

  if (!transfer) throw new ApiError("Transfer not found", 404);
  assertCanRespondTransfer(transfer, user);

  if (transfer.status !== "PENDING") {
    throw new ApiError("Only PENDING transfers can be declined", 400);
  }

  const { stockManaged } = await categorizeByStockManagement(transfer.lines);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.stockTransfer.updateMany({
          where: { id: transferId, status: "PENDING" },
          data: {
            status: "DECLINED",
            validatedBy: user.id,
            validatedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          throw new ApiError(
            "Transfer is no longer pending (already processed)",
            409,
          );
        }

        for (const line of stockManaged) {
          await releasePendingHold(tx, {
            depotId: transfer.sourceDepot.id,
            articleId: line.articleId,
            variantId: line.variantId,
            quantity: parseFloat(line.quantityReceived),
          });
        }

        if (transfer.createdBy && transfer.createdBy !== user.id) {
          await createNotifications(tx, {
            userIds: [transfer.createdBy],
            type: "STOCK_TRANSFER_DECLINED",
            payload: {
              transferId,
              transferNumber: transfer.transferNumber,
              sourceDepotName: transfer.sourceDepot.name,
              destinationDepotName: transfer.destinationDepot.name,
              declinedByName: user.name || user.email || null,
            },
          });
        }

        return tx.stockTransfer.findUnique({
          where: { id: transferId },
          include: TRANSFER_INCLUDE,
        });
      },
      { timeout: 30000 },
    );

    return result;
  } catch (error) {
    console.error("Transfer decline failed:", error);
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Failed to decline transfer: ${error.message}`, 500);
  }
};

/* ============================================================
   DELETE TRANSFER
============================================================ */
export const remove = async (id, user) => {
  await timeRange.validateSystemHours(new Date(), "delete transfer");

  const transfer = await prisma.stockTransfer.findUnique({
    where: { id },
    include: {
      sourceDepot: { select: { id: true, societeId: true, name: true } },
      lines: true,
      transactions: true,
    },
  });

  if (!transfer) throw new ApiError("Transfer not found", 404);

  if (
    !isSuperAdminUser(user) &&
    transfer.sourceDepot.societeId !== user.societeId
  ) {
    throw new ApiError(
      "Access denied. This transfer belongs to another société.",
      403,
    );
  }

  const { stockManaged } = await categorizeByStockManagement(transfer.lines);

  try {
    await prisma.$transaction(
      async (tx) => {
        if (transfer.status === "COMPLETED" && stockManaged.length > 0) {
          for (const line of stockManaged) {
            const quantity = parseFloat(line.quantityReceived);

            const sourceWhere = line.articleId
              ? { depotId: transfer.sourceDepotId, articleId: line.articleId }
              : { depotId: transfer.sourceDepotId, variantId: line.variantId };

            const sourceStock = await tx.stockByDepot.findFirst({
              where: sourceWhere,
            });
            if (sourceStock) {
              await tx.stockByDepot.update({
                where: { id: sourceStock.id },
                data: {
                  quantityAvailable:
                    parseFloat(sourceStock.quantityAvailable) + quantity,
                },
              });
            }

            const destWhere = line.articleId
              ? {
                  depotId: transfer.destinationDepotId,
                  articleId: line.articleId,
                }
              : {
                  depotId: transfer.destinationDepotId,
                  variantId: line.variantId,
                };

            const destStock = await tx.stockByDepot.findFirst({
              where: destWhere,
            });
            if (destStock) {
              await tx.stockByDepot.update({
                where: { id: destStock.id },
                data: {
                  quantityAvailable:
                    parseFloat(destStock.quantityAvailable) - quantity,
                },
              });
            }
          }
        } else if (transfer.status === "PENDING" && stockManaged.length > 0) {
          for (const line of stockManaged) {
            await releasePendingHold(tx, {
              depotId: transfer.sourceDepotId,
              articleId: line.articleId,
              variantId: line.variantId,
              quantity: parseFloat(line.quantityReceived),
            });
          }
        }
        // DECLINED: hold already released — no stock change

        await tx.stockTransaction.deleteMany({ where: { transferId: id } });
        await tx.stockTransfer.delete({ where: { id } });
      },
      { timeout: 30000 },
    );

    return {
      message:
        transfer.status === "COMPLETED"
          ? `Transfer deleted and stock reverted successfully (${stockManaged.length} stock-managed items)`
          : transfer.status === "PENDING"
            ? `Transfer deleted and hold released successfully (${stockManaged.length} stock-managed items)`
            : `Transfer deleted successfully`,
    };
  } catch (error) {
    console.error("Transfer deletion failed:", error);
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Failed to delete transfer: ${error.message}`, 500);
  }
};

export default {
  create,
  getAll,
  getById,
  getByDepot,
  getReceivers,
  appendLines,
  validateTransfer,
  declineTransfer,
  remove,
  assertReceiverUser,
};
