import request from 'supertest';
import { jest } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import {
  createRemittanceBodySchema,
  createRemittanceSchema,
  submitRemittanceBodySchema,
  submitRemittanceSchema,
  positiveNumericStringSchema,
  amountSchema,
  currencySchema,
  ALLOWED_CURRENCIES,
  STELLAR_ADDRESS_REGEX,
  BASE64_REGEX,
} from '../schemas/remittanceSchemas.js';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';

const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const VALID_XDR =
  'AAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const mockCreateRemittance = jest.fn(
  async (payload: {
    senderAddress: string;
    recipientAddress: string;
    amount: number;
    fromCurrency: string;
    toCurrency: string;
    memo?: string;
  }) => ({
    id: 'remittance-123',
    senderId: payload.senderAddress,
    recipientAddress: payload.recipientAddress,
    amount: payload.amount,
    fromCurrency: payload.fromCurrency,
    toCurrency: payload.toCurrency,
    memo: payload.memo,
    status: 'pending' as const,
    xdr: VALID_XDR,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
);

const mockGetRemittance = jest.fn(async (id: string) => ({
  id,
  senderId: SENDER,
  recipientAddress: RECIPIENT,
  amount: 100,
  fromCurrency: 'USDC',
  toCurrency: 'USDC',
  status: 'pending' as const,
  xdr: VALID_XDR,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));

const mockUpdateRemittanceStatus = jest.fn(async (id: string, status: string, txHash?: string) => ({
  id,
  status,
  txHash,
}));

jest.unstable_mockModule('../services/remittanceService.js', () => ({
  remittanceService: {
    createRemittance: mockCreateRemittance,
    getRemittances: jest.fn(),
    getRemittance: mockGetRemittance,
    updateRemittanceStatus: mockUpdateRemittanceStatus,
  },
}));

const mockSubmitSignedTx = jest.fn(async () => ({
  txHash: '0x1234567890abcdef',
  status: 'SUCCESS',
}));

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    submitSignedTx: mockSubmitSignedTx,
  },
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
  },
}));

jest.unstable_mockModule('../services/notificationService.js', () => ({
  notificationService: {
    createNotification: jest.fn(async () => ({ id: 'notif-1' })),
    emitNotification: jest.fn(),
  },
}));

const mockQuery = jest.fn().mockResolvedValue({
  rows: [{ id: 'notif-1' }],
  rowCount: 1,
});
jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
  pool: { query: mockQuery, connect: jest.fn(), end: jest.fn() },
}));

const { default: app } = await import('../app.js');

const authHeader = (publicKey = SENDER, scopes = ['read:remittances', 'write:remittances']) => {
  const token = jwt.sign(
    {
      sub: publicKey,
      publicKey,
      scopes,
    },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
};

describe('Remittance Schemas Unit Tests', () => {
  describe('Stellar address validation', () => {
    it('validates a correct 56-character Stellar public key starting with G', () => {
      expect(STELLAR_ADDRESS_REGEX.test(RECIPIENT)).toBe(true);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100.50',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an address starting with S (secret seed)', () => {
      const invalid = 'S' + RECIPIENT.slice(1);
      expect(STELLAR_ADDRESS_REGEX.test(invalid)).toBe(false);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: invalid,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/Stellar/i);
      }
    });

    it('rejects an address with incorrect length', () => {
      const shortAddress = RECIPIENT.slice(0, 50);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: shortAddress,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an address with invalid base32 characters (0, 1, 8, 9)', () => {
      const invalidChars = 'G0189' + RECIPIENT.slice(5);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: invalidChars,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Amount validation (positive numeric string & bounds)', () => {
    it('accepts positive integer numeric string', () => {
      expect(positiveNumericStringSchema.safeParse('100').success).toBe(true);
      expect(amountSchema.safeParse('100').success).toBe(true);
    });

    it('accepts positive decimal numeric string', () => {
      expect(positiveNumericStringSchema.safeParse('100.50').success).toBe(true);
      expect(positiveNumericStringSchema.safeParse('0.01').success).toBe(true);
      expect(amountSchema.safeParse('100.50').success).toBe(true);
    });

    it('accepts positive numbers for backwards compatibility', () => {
      expect(amountSchema.safeParse(100).success).toBe(true);
      expect(amountSchema.safeParse(0.5).success).toBe(true);
    });

    it('rejects non-numeric string', () => {
      expect(positiveNumericStringSchema.safeParse('abc').success).toBe(false);
      expect(amountSchema.safeParse('abc').success).toBe(false);
      expect(positiveNumericStringSchema.safeParse('100abc').success).toBe(false);
    });

    it('rejects negative numeric strings', () => {
      expect(positiveNumericStringSchema.safeParse('-10').success).toBe(false);
      expect(amountSchema.safeParse('-10').success).toBe(false);
      expect(positiveNumericStringSchema.safeParse('-0.05').success).toBe(false);
    });

    it('rejects zero as numeric string or number', () => {
      expect(positiveNumericStringSchema.safeParse('0').success).toBe(false);
      expect(amountSchema.safeParse('0').success).toBe(false);
      expect(amountSchema.safeParse(0).success).toBe(false);
    });

    it('rejects amount exceeding 1,000,000', () => {
      expect(positiveNumericStringSchema.safeParse('1000001').success).toBe(false);
      expect(amountSchema.safeParse('1000001').success).toBe(false);
      expect(amountSchema.safeParse(1000001).success).toBe(false);
    });
  });

  describe('Currency validation against allowlist', () => {
    it.each(ALLOWED_CURRENCIES)('accepts allowed currency: %s', (currency) => {
      expect(currencySchema.safeParse(currency).success).toBe(true);
      const parsed = currencySchema.parse(currency.toLowerCase());
      expect(parsed).toBe(currency);
    });

    it('rejects currencies not in the allowlist', () => {
      expect(currencySchema.safeParse('BTC').success).toBe(false);
      expect(currencySchema.safeParse('ETH').success).toBe(false);
      expect(currencySchema.safeParse('DOGE').success).toBe(false);
      expect(currencySchema.safeParse('').success).toBe(false);
    });

    it('rejects invalid currency in createRemittanceBodySchema', () => {
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'UNSUPPORTED',
        toCurrency: 'USDC',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Memo length validation', () => {
    it('accepts memo within 28 characters', () => {
      const validMemo = 'Payment for invoice 12345';
      expect(validMemo.length).toBeLessThanOrEqual(28);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: validMemo,
      });
      expect(result.success).toBe(true);
    });

    it('accepts exact 28-character memo', () => {
      const memo28 = 'a'.repeat(28);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: memo28,
      });
      expect(result.success).toBe(true);
    });

    it('rejects memo longer than 28 characters', () => {
      const memo29 = 'a'.repeat(29);
      const result = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: memo29,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/28 characters/i);
      }
    });

    it('accepts optional / null memo', () => {
      const resultNull = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: null,
      });
      expect(resultNull.success).toBe(true);

      const resultUndefined = createRemittanceBodySchema.safeParse({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });
      expect(resultUndefined.success).toBe(true);
    });

    it('validates createRemittanceSchema envelope with body', () => {
      const result = createRemittanceSchema.safeParse({
        body: {
          recipientAddress: RECIPIENT,
          amount: '100',
          fromCurrency: 'USDC',
          toCurrency: 'USDC',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('signedXdr base64 validation', () => {
    it('validates a valid base64-encoded string', () => {
      expect(BASE64_REGEX.test(VALID_XDR)).toBe(true);
      expect(BASE64_REGEX.test('AAAA')).toBe(true);
      expect(BASE64_REGEX.test('AA==')).toBe(true);
      expect(BASE64_REGEX.test('AAA=')).toBe(true);

      const result = submitRemittanceBodySchema.safeParse({ signedXdr: VALID_XDR });
      expect(result.success).toBe(true);
    });

    it('rejects empty or whitespace signedXdr', () => {
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: '' }).success).toBe(false);
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: '   ' }).success).toBe(false);
    });

    it('rejects invalid base64 characters', () => {
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: 'not_base64!@#' }).success).toBe(
        false,
      );
    });

    it('rejects base64 strings with incorrect padding or length not multiple of 4', () => {
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: 'abc' }).success).toBe(false);
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: 'AAAAA' }).success).toBe(false);
      expect(submitRemittanceBodySchema.safeParse({ signedXdr: 'AAAA=' }).success).toBe(false);
    });

    it('validates submitRemittanceSchema envelope with params and body', () => {
      const result = submitRemittanceSchema.safeParse({
        params: { id: 'remittance-uuid-123' },
        body: { signedXdr: VALID_XDR },
      });
      expect(result.success).toBe(true);
    });

    it('rejects submitRemittanceSchema when id is missing or empty', () => {
      const result = submitRemittanceSchema.safeParse({
        params: { id: '' },
        body: { signedXdr: VALID_XDR },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('Remittance Controller HTTP Validation Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/remittances', () => {
    it('succeeds (201) with positive numeric string amount and valid fields', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: '150.75',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: 'Valid memo',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockCreateRemittance).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAddress: RECIPIENT,
          amount: 150.75,
          fromCurrency: 'USDC',
          toCurrency: 'USDC',
          memo: 'Valid memo',
        }),
      );
    });

    it('succeeds (201) with number amount', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: 250,
        fromCurrency: 'EURC',
        toCurrency: 'EURC',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockCreateRemittance).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 250,
          fromCurrency: 'EURC',
        }),
      );
    });

    it('rejects (400) invalid Stellar address for recipient', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: 'invalid-address-12345',
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });

    it('rejects (400) non-numeric amount string', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: 'one-hundred',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });

    it('rejects (400) negative amount', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: '-50.00',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });

    it('rejects (400) zero amount', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: '0',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });

    it('rejects (400) unsupported currency', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'DOGECOIN',
        toCurrency: 'USDC',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });

    it('rejects (400) memo exceeding 28 characters', async () => {
      const res = await request(app).post('/api/remittances').set(authHeader()).send({
        recipientAddress: RECIPIENT,
        amount: '100',
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: 'This memo is definitely longer than 28 chars',
      });

      expect(res.status).toBe(400);
      expect(mockCreateRemittance).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/remittances/:id/submit', () => {
    it('succeeds (200) with valid base64 signedXdr', async () => {
      const res = await request(app)
        .post('/api/remittances/remittance-123/submit')
        .set(authHeader())
        .send({
          signedXdr: VALID_XDR,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSubmitSignedTx).toHaveBeenCalledWith(VALID_XDR);
    });

    it('rejects (400) missing signedXdr', async () => {
      const res = await request(app)
        .post('/api/remittances/remittance-123/submit')
        .set(authHeader())
        .send({});

      expect(res.status).toBe(400);
      expect(mockSubmitSignedTx).not.toHaveBeenCalled();
    });

    it('rejects (400) non-base64 signedXdr', async () => {
      const res = await request(app)
        .post('/api/remittances/remittance-123/submit')
        .set(authHeader())
        .send({
          signedXdr: 'not-a-valid-base64-xdr-transaction!',
        });

      expect(res.status).toBe(400);
      expect(mockSubmitSignedTx).not.toHaveBeenCalled();
    });
  });
});
