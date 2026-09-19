import { z } from 'zod';

// Zod schemas and inferred types shared by apps/api and apps/web live here.

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
