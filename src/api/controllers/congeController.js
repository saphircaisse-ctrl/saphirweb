import asyncHandler from "express-async-handler";
import * as CongeService from "../services/congeService.js";

export const getEmployees = asyncHandler(async (req, res) => {
  const data = await CongeService.getEmployees(
    req.user,
    req.societeId || req.query.societeId,
  );
  res.status(200).json({ success: true, results: data.length, data });
});

export const getAll = asyncHandler(async (req, res) => {
  const result = await CongeService.getAll(
    { ...req.query, societeId: req.societeId || req.query.societeId },
    req.user,
  );
  res.status(200).json({
    success: true,
    results: result.data.length,
    pagination: result.pagination,
    year: result.year,
    yearDays: result.yearDays,
    yearTotals: result.yearTotals,
    data: result.data,
  });
});

export const create = asyncHandler(async (req, res) => {
  const data = await CongeService.create(
    { ...req.body, societeId: req.societeId || req.body.societeId },
    req.user,
  );
  res.status(201).json({
    success: true,
    message: "Congé enregistré",
    data,
  });
});

export const update = asyncHandler(async (req, res) => {
  const data = await CongeService.update(req.params.id, req.body, req.user);
  res.status(200).json({
    success: true,
    message: "Congé mis à jour",
    data,
  });
});

export const remove = asyncHandler(async (req, res) => {
  const data = await CongeService.remove(req.params.id, req.user);
  res.status(200).json({ success: true, ...data });
});
