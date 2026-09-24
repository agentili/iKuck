import { z } from 'zod';

export const houseNameSchema = z.string().trim().min(1).max(80);
export const memberEmailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
export const houseRoleSchema = z.enum(['admin', 'member']);

export type HouseRole = z.infer<typeof houseRoleSchema>;
