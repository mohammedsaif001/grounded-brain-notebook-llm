import type { NextFunction, Request, Response } from "express";
import { flattenError, ZodError } from "zod";
import { AppError } from "../types/app-error.js";

export function errorHandler(error:unknown,_req:Request,res:Response,_next:NextFunction) {
    if (error instanceof AppError) {
        return res.status(error.statuscode).json({
            error:error.message,
            details:error.details
        })
    }

     if (error instanceof ZodError) {
        res.status(400).json({
            error: "Validation failed",
            details: flattenError(error).fieldErrors,
        });
        return;
    }

    console.error(error);
    res.status(500).json({ error: "Internal server error" });
}