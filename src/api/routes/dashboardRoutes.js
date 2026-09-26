import { Router } from "express";
import { auth } from "../middlewares/authMiddleware.js";
import { societyFilter } from "../middlewares/societyFilterMiddleware.js";
import { adminOnly } from "../middlewares/superAdminMiddleware.js";
import * as DashboardController from "../controllers/dashboardController.js";
import { overviewValidator } from "../validations/dashboardValidation.js";

const router = Router();

router.use(auth);

router.get("/overview", societyFilter, overviewValidator, DashboardController.getOverview);

router.get("/wallets", adminOnly, societyFilter, DashboardController.getWalletsOverview);

export default router;
