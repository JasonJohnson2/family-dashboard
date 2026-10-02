import { z } from 'zod';
import { idSchema } from '../../src/data/contracts';
export const calendarSettings = z
  .object({
    sourceId: z.string().min(1).max(80),
    enabled: z.boolean(),
    privacyMode: z.enum(['busy', 'title', 'full']),
    memberId: idSchema.nullable().optional(),
  })
  .strict();
