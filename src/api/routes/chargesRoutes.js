import { Router } from "express";
import { auth } from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/superAdminMiddleware.js";
import { societyFilter } from "../middlewares/societyFilterMiddleware.js";
import validatorMiddleware from "../middlewares/validatorMiddleware.js";
import { getChargesValidator } from "../validations/chargesValidation.js";
import * as chargesController from "../controllers/chargesController.js";

const router = Router();

router.use(auth);
router.use(adminOnly);
router.use(societyFilter);

router.get("/", getChargesValidator, validatorMiddleware, chargesController.getCharges);

export default router;
