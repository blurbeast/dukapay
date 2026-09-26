import { z } from 'zod';
import { stellarAddressSchema } from './stellarSchemas.js';

export const registerTestUserBodySchema = z.object({
  email: z
    .string()
    .email('Invalid email address format')
    .max(255, 'Email cannot exceed 255 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password cannot exceed 128 characters'),
  publicKey: stellarAddressSchema.optional(),
  role: z.enum(['borrower', 'lender', 'admin']).optional().default('borrower'),
});

export const registerTestUserSchema = z.object({
  body: registerTestUserBodySchema,
});

export type RegisterTestUserBody = z.infer<typeof registerTestUserBodySchema>;
export type RegisterTestUserInput = z.infer<typeof registerTestUserSchema>;
