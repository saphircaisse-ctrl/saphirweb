import * as StockTransferService from "../services/stockTransferService.js";
import asyncHandler from "express-async-handler";

/* ============================================================
   CREATE STOCK TRANSFER (ATOMIC)
============================================================ */
export const createTransfer = asyncHandler(async (req, res) => {
  const transfer = await StockTransferService.create(req.body, req.user);

  res.status(201).json({
    success: true,
    message:
      `Transfer ${transfer.transferNumber} created successfully. ` +
      `Status: ${transfer.status}. ` +
      `${transfer.summary.stockMovementApplied ? "Stock movement applied." : "Hold applied (PENDING) — awaiting receiver acceptance."}`,
    data: transfer,
  });
});

/* ============================================================
   GET RECEIVERS
============================================================ */
export const getReceivers = asyncHandler(async (req, res) => {
  const receivers = await StockTransferService.getReceivers(req.user, req.query);

  res.status(200).json({
    success: true,
    results: receivers.length,
    data: receivers,
  });
});

/* ============================================================
   GET ALL TRANSFERS
============================================================ */
export const getAllTransfers = asyncHandler(async (req, res) => {
  const result = await StockTransferService.getAll(req.query, req.user);

  res.status(200).json({
    success: true,
    results: result.results,
    pagination: result.pagination,
    data: result.data,
  });
});

/* ============================================================
   GET TRANSFER BY ID
============================================================ */
export const getTransferById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const transfer = await StockTransferService.getById(Number(id), req.user);

  res.status(200).json({
    success: true,
    message: "Transfer retrieved successfully",
    data: transfer,
  });
});

/* ============================================================
   GET TRANSFERS BY DEPOT
============================================================ */
export const getTransfersByDepot = asyncHandler(async (req, res) => {
  const { depotId } = req.params;
  const result = await StockTransferService.getByDepot(
    Number(depotId),
    req.user,
    req.query,
  );

  res.status(200).json({
    success: true,
    depot: result.depot,
    results: result.results,
    data: result.data,
  });
});

/* ============================================================
   DELETE TRANSFER (ATOMIC ROLLBACK)
============================================================ */
export const deleteTransfer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await StockTransferService.remove(Number(id), req.user);

  res.status(200).json({
    success: true,
    message: result.message,
  });
});

/* ============================================================
   APPEND TRANSFER LINES (ATOMIC)
============================================================ */
export const appendTransferLines = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await StockTransferService.appendLines(
    Number(id),
    req.body,
    req.user,
  );

  res.status(200).json({
    success: true,
    message:
      `Successfully appended ${result.appendInfo.linesAdded} line(s) to transfer ${result.transferNumber}. ` +
      `Status: ${result.status}. ` +
      `${result.summary.stockMovementApplied ? `${result.appendInfo.transactionsCreated} transaction(s) created and stock updated.` : "Hold applied (PENDING)."}`,
    data: result,
  });
});

/* ============================================================
   VALIDATE / ACCEPT TRANSFER (ATOMIC)
============================================================ */
export const validateTransfer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await StockTransferService.validateTransfer(
    Number(id),
    req.user,
    { receiverGate: false },
  );

  res.status(200).json({
    success: true,
    message:
      `Transfer ${result.transferNumber} completed successfully. ` +
      `${result.summary.totalLines} line(s) processed. ` +
      `${result.summary.transactionsCreated} transaction(s) created. ` +
      `Stock updated in both depots.`,
    data: result,
  });
});

/** Receiver-facing accept — same as validate but gated to receiver/admin */
export const acceptTransfer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await StockTransferService.validateTransfer(
    Number(id),
    req.user,
    { receiverGate: true },
  );

  res.status(200).json({
    success: true,
    message:
      `Transfer ${result.transferNumber} completed successfully. ` +
      `${result.summary.totalLines} line(s) processed. ` +
      `${result.summary.transactionsCreated} transaction(s) created. ` +
      `Stock updated in both depots.`,
    data: result,
  });
});

/* ============================================================
   DECLINE TRANSFER (ATOMIC)
============================================================ */
export const declineTransfer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await StockTransferService.declineTransfer(
    Number(id),
    req.user,
  );

  res.status(200).json({
    success: true,
    message: `Transfer ${result.transferNumber} declined. Stock hold released.`,
    data: result,
  });
});
