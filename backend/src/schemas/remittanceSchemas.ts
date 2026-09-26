import { z } from 'zod';

// Stellar address regex (56 chars, starts with G, base32)
export const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

// Standard Base64 regex (multiples of 4 with valid padding)
export const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const ALLOWED_CURRENCIES = ['USDC', 'EURC', 'PHP', 'XLM'] as const;
export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

export const currencySchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
  z.enum(ALLOWED_CURRENCIES, {
    message: `Currency must be one of: ${ALLOWED_CURRENCIES.join(', ')}`,
  }),
);

export const positiveNumericStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Amount must be a positive numeric string')
  .refine((val) => Number(val) > 0, 'Amount must be greater than 0')
  .refine((val) => Number(val) <= 1_000_000, 'Amount exceeds maximum limit');

export const amountSchema = z.union([
  positiveNumericStringSchema,
  z
    .number()
    .positive('Amount must be greater than 0')
    .max(1_000_000, 'Amount exceeds maximum limit'),
]);

// Schema for POST /remittances body
export const createRemittanceBodySchema = z.object({
  recipientAddress: z
    .string()
    .regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address format')
    .describe("Recipient's Stellar public key"),
  amount: amountSchema.describe('Amount to send (positive numeric string or number)'),
  fromCurrency: currencySchema.describe('Source currency'),
  toCurrency: currencySchema.describe('Destination currency'),
  memo: z
    .string()
    .max(28, 'Memo must be 28 characters or less')
    .optional()
    .nullable()
    .describe('Optional transaction memo'),
});

// Schema for POST /remittances (envelope)
export const createRemittanceSchema = z.object({
  body: createRemittanceBodySchema,
});

// ISO date string validation
const isoDateString = z.string().refine((val) => !Number.isNaN(Date.parse(val)), {
  message: 'Must be a valid ISO-8601 date string',
});

// Schema for GET /remittances (list)
export const getRemittancesSchema = z.object({
  query: z.object({
    limit: z
      .string()
      .transform((v) => Math.min(parseInt(v, 10), 100))
      .pipe(z.number())
      .default(20)
      .optional(),
    offset: z.coerce.number().int().min(0).max(10000).default(0).optional(),
    cursor: z.string().optional(),
    status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
    from: isoDateString.optional(),
    to: isoDateString.optional(),
    q: z.string().max(255).optional(),
  }),
});

// Schema for GET /remittances/:id
export const getRemittanceSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Remittance ID is required').describe('Remittance ID (UUID format)'),
  }),
});

// Schema for POST /remittances/:id/submit params
export const submitRemittanceParamsSchema = z.object({
  id: z.string().min(1, 'Remittance ID is required').describe('Remittance ID (UUID format)'),
});

// Schema for POST /remittances/:id/submit body
export const submitRemittanceBodySchema = z.object({
  signedXdr: z
    .string()
    .min(1, 'Signed XDR is required')
    .regex(BASE64_REGEX, 'Signed XDR must be a valid base64-encoded string')
    .describe('Signed XDR transaction from Freighter wallet (base64 encoded)'),
});

// Schema for POST /remittances/:id/submit (envelope)
export const submitRemittanceSchema = z.object({
  params: submitRemittanceParamsSchema,
  body: submitRemittanceBodySchema,
});

export const submitRemittanceTransactionSchema = submitRemittanceSchema;

// Export types for TypeScript
export type CreateRemittanceBody = z.infer<typeof createRemittanceBodySchema>;
export type CreateRemittanceInput = z.infer<typeof createRemittanceSchema>;
export type SubmitRemittanceBody = z.infer<typeof submitRemittanceBodySchema>;
export type SubmitRemittanceParams = z.infer<typeof submitRemittanceParamsSchema>;
export type SubmitRemittanceInput = z.infer<typeof submitRemittanceSchema>;
export type GetRemittancesInput = z.infer<typeof getRemittancesSchema>;
export type GetRemittanceInput = z.infer<typeof getRemittanceSchema>;
