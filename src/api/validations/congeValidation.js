import { body, param, query } from "express-validator";
import validatorMiddleware from "../middlewares/validatorMiddleware.js";

export const listValidator = [
  query("userId")
    .optional()
    .isInt({ min: 1 })
    .withMessage("userId must be a positive integer")
    .toInt(),
  query("year")
    .optional()
    .isInt({ min: 2000, max: 2100 })
    .withMessage("year must be a valid year")
    .toInt(),
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer")
    .toInt(),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be between 1 and 100")
    .toInt(),
  query("search")
    .optional()
    .isString()
    .isLength({ max: 120 })
    .withMessage("search cannot exceed 120 characters"),
  validatorMiddleware,
];

export const createValidator = [
  body("userId")
    .isInt({ min: 1 })
    .withMessage("userId is required")
    .toInt(),
  body("startDate")
    .isISO8601()
    .withMessage("startDate must be a valid date"),
  body("endDate")
    .isISO8601()
    .withMessage("endDate must be a valid date"),
  body("note")
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .isLength({ max: 500 })
    .withMessage("note cannot exceed 500 characters"),
  validatorMiddleware,
];

export const updateValidator = [
  param("id")
    .isInt({ min: 1 })
    .withMessage("id must be a positive integer")
    .toInt(),
  body("userId")
    .optional()
    .isInt({ min: 1 })
    .withMessage("userId must be a positive integer")
    .toInt(),
  body("startDate")
    .optional()
    .isISO8601()
    .withMessage("startDate must be a valid date"),
  body("endDate")
    .optional()
    .isISO8601()
    .withMessage("endDate must be a valid date"),
  body("note")
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .isLength({ max: 500 })
    .withMessage("note cannot exceed 500 characters"),
  validatorMiddleware,
];

export const idValidator = [
  param("id")
    .isInt({ min: 1 })
    .withMessage("id must be a positive integer")
    .toInt(),
  validatorMiddleware,
];
