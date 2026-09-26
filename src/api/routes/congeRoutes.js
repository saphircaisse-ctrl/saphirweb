import { Router } from "express";
import * as CongeController from "../controllers/congeController.js";
import { auth } from "../middlewares/authMiddleware.js";
import { societyFilter } from "../middlewares/societyFilterMiddleware.js";
import { attendanceAdminOnly } from "../middlewares/attendanceAdminMiddleware.js";
import {
  listValidator,
  createValidator,
  updateValidator,
  idValidator,
} from "../validations/congeValidation.js";

const router = Router();

router.use(auth);
router.use(attendanceAdminOnly);
router.use(societyFilter);

router.get("/employees", CongeController.getEmployees);
router.get("/", listValidator, CongeController.getAll);
router.post("/", createValidator, CongeController.create);
router.put("/:id", updateValidator, CongeController.update);
router.delete("/:id", idValidator, CongeController.remove);

export default router;
