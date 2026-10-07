import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({ message: "Not found" });
}
