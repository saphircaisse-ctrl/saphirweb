import asyncHandler from "express-async-handler";
import * as chargesService from "../services/chargesService.js";

export const getCharges = asyncHandler(async (req, res) => {
  const result = await chargesService.getCharges(
    req.query,
    req.user,
    req.societeId,
  );

  res.status(200).json({
    status: "success",
    ...result,
  });
});
