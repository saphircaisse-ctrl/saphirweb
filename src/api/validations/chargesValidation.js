import { query } from "express-validator";

export const getChargesValidator = [
  query("dateFrom")
    .optional()
    .isISO8601()
    .withMessage("dateFrom doit être une date ISO valide"),
  query("dateTo")
    .optional()
    .isISO8601()
    .withMessage("dateTo doit être une date ISO valide"),
  query("userId")
    .optional()
    .isInt({ min: 1 })
    .withMessage("userId doit être un entier positif"),
  query("labelId")
    .optional()
    .isInt({ min: 1 })
    .withMessage("labelId doit être un entier positif"),
  query("unlabeled")
    .optional()
    .isIn(["true", "false", "1", "0"])
    .withMessage("unlabeled doit être true ou false"),
  query("search")
    .optional()
    .trim()
    .isLength({ max: 120 })
    .withMessage("La recherche ne peut pas dépasser 120 caractères"),
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page doit être un entier positif"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit doit être entre 1 et 100"),
];
