import { z } from "zod";

export const SynchronizationStatusSchema = z.enum([
  "local",
  "pending",
  "confirmed",
  "recoverable_failure",
  "conflict",
]);

export type SynchronizationStatus = z.infer<typeof SynchronizationStatusSchema>;

export const OfflineOperationSchema = z.object({
  operationId: z.string().uuid(),
  aggregateId: z.string().uuid(),
  deviceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  dependencies: z.array(z.string().uuid()).default([]),
  reversesOperationId: z.string().uuid().optional(),
});

export type OfflineOperation = z.infer<typeof OfflineOperationSchema>;
