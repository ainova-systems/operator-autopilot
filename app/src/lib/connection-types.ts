import { z } from "zod";

/**
 * A saved connection to an Operator instance.
 *
 * MVP has a single backend (local SQLite), so there is no `backend`
 * discriminator. When a second adapter lands (e.g. `kvstore-cloud`),
 * that PR refactors this type into a discriminated union AND extends the
 * factory in lockstep — see architecture-v5.md §15a.1.
 */
export interface Connection {
  readonly id: string;
  readonly name: string;
  readonly dbPath: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export const connectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dbPath: z.string().min(1),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
}) satisfies z.ZodType<Connection>;

export const connectionInputSchema = z.object({
  name: z.string().min(1).max(200),
  dbPath: z.string().min(1),
});

export type ConnectionInput = z.infer<typeof connectionInputSchema>;

export const connectionPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  dbPath: z.string().min(1).optional(),
});

export type ConnectionPatch = z.infer<typeof connectionPatchSchema>;

export interface ActiveConnectionState {
  readonly id: string;
  readonly at: string;
}

export const activeConnectionStateSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
}) satisfies z.ZodType<ActiveConnectionState>;
