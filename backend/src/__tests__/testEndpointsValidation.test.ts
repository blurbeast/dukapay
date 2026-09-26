import type { Request, Response } from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { createTestLoanBodySchema, createTestLoanSchema } from '../schemas/loanSchemas.js';
import { registerTestUserBodySchema, registerTestUserSchema } from '../schemas/authSchemas.js';
import { isTestEndpointAllowed, disableInProduction } from '../middleware/testEndpointGuard.js';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';

const VALID_STELLAR_BORROWER = Keypair.random().publicKey();
const VALID_STELLAR_USER = Keypair.random().publicKey();
const INVALID_STELLAR_ADDRESS = 'S' + VALID_STELLAR_BORROWER.slice(1);

const mockQuery = jest.fn();
jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
  pool: { query: mockQuery, connect: jest.fn(), end: jest.fn() },
}));

const { default: app } = await import('../app.js');

const authHeader = (publicKey = VALID_STELLAR_BORROWER) => {
  const token = jwt.sign(
    {
      sub: publicKey,
      publicKey,
    },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
};

describe('Test Endpoints Zod Schemas Unit Tests', () => {
  describe('createTestLoanBodySchema', () => {
    it('accepts valid payload with termDays, amount, rate, and borrower', () => {
      const result = createTestLoanBodySchema.safeParse({
        borrower: VALID_STELLAR_BORROWER,
        amount: 5000,
        rate: 1500,
        termDays: 30,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(5000);
        expect(result.data.rate).toBe(1500);
        expect(result.data.termDays).toBe(30);
        expect(result.data.borrower).toBe(VALID_STELLAR_BORROWER);
      }
    });

    it('accepts valid payload with term and defaults rate to 1200 bps', () => {
      const result = createTestLoanBodySchema.safeParse({
        amount: '1000',
        term: '12',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(1000);
        expect(result.data.rate).toBe(1200);
        expect(result.data.term).toBe(12);
        expect(result.data.borrower).toBeUndefined();
      }
    });

    it('rejects negative or zero amount', () => {
      expect(createTestLoanBodySchema.safeParse({ amount: 0, termDays: 30 }).success).toBe(false);
      expect(createTestLoanBodySchema.safeParse({ amount: -100, termDays: 30 }).success).toBe(
        false,
      );
      expect(createTestLoanBodySchema.safeParse({ amount: '0', termDays: 30 }).success).toBe(false);
      expect(createTestLoanBodySchema.safeParse({ amount: '-50', termDays: 30 }).success).toBe(
        false,
      );
      expect(createTestLoanBodySchema.safeParse({ amount: 'abc', termDays: 30 }).success).toBe(
        false,
      );
    });

    it('rejects rate outside 0-10000 bps bound', () => {
      expect(
        createTestLoanBodySchema.safeParse({ amount: 1000, termDays: 30, rate: -1 }).success,
      ).toBe(false);
      expect(
        createTestLoanBodySchema.safeParse({ amount: 1000, termDays: 30, rate: 10001 }).success,
      ).toBe(false);
      expect(
        createTestLoanBodySchema.safeParse({ amount: 1000, termDays: 30, rate: 0 }).success,
      ).toBe(true);
      expect(
        createTestLoanBodySchema.safeParse({ amount: 1000, termDays: 30, rate: 10000 }).success,
      ).toBe(true);
    });

    it('rejects non-positive termDays or term', () => {
      expect(createTestLoanBodySchema.safeParse({ amount: 1000, termDays: 0 }).success).toBe(false);
      expect(createTestLoanBodySchema.safeParse({ amount: 1000, termDays: -5 }).success).toBe(
        false,
      );
      expect(createTestLoanBodySchema.safeParse({ amount: 1000, term: 0 }).success).toBe(false);
      expect(createTestLoanBodySchema.safeParse({ amount: 1000, term: -1 }).success).toBe(false);
      expect(createTestLoanBodySchema.safeParse({ amount: 1000 }).success).toBe(false);
    });

    it('rejects invalid Stellar address for borrower', () => {
      const result = createTestLoanBodySchema.safeParse({
        borrower: INVALID_STELLAR_ADDRESS,
        amount: 1000,
        termDays: 30,
      });
      expect(result.success).toBe(false);
    });

    it('validates createTestLoanSchema envelope', () => {
      const result = createTestLoanSchema.safeParse({
        body: { amount: 1000, term: 12 },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('registerTestUserBodySchema', () => {
    it('accepts valid email and password', () => {
      const result = registerTestUserBodySchema.safeParse({
        email: 'user@dukapay.test',
        password: 'securePassword123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@dukapay.test');
        expect(result.data.role).toBe('borrower');
      }
    });

    it('accepts valid email, password, publicKey, and role', () => {
      const result = registerTestUserBodySchema.safeParse({
        email: 'admin@dukapay.test',
        password: 'adminPassword123!',
        publicKey: VALID_STELLAR_USER,
        role: 'admin',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.publicKey).toBe(VALID_STELLAR_USER);
        expect(result.data.role).toBe('admin');
      }
    });

    it('rejects invalid email formats', () => {
      expect(
        registerTestUserBodySchema.safeParse({
          email: 'not-an-email',
          password: 'password123',
        }).success,
      ).toBe(false);
      expect(
        registerTestUserBodySchema.safeParse({
          email: '@domain.com',
          password: 'password123',
        }).success,
      ).toBe(false);
    });

    it('rejects password shorter than 8 characters', () => {
      expect(
        registerTestUserBodySchema.safeParse({
          email: 'test@example.com',
          password: 'short',
        }).success,
      ).toBe(false);
    });

    it('rejects password longer than 128 characters', () => {
      expect(
        registerTestUserBodySchema.safeParse({
          email: 'test@example.com',
          password: 'a'.repeat(129),
        }).success,
      ).toBe(false);
    });

    it('rejects invalid Stellar address for publicKey', () => {
      expect(
        registerTestUserBodySchema.safeParse({
          email: 'test@example.com',
          password: 'password123',
          publicKey: INVALID_STELLAR_ADDRESS,
        }).success,
      ).toBe(false);
    });

    it('rejects unknown role', () => {
      expect(
        registerTestUserBodySchema.safeParse({
          email: 'test@example.com',
          password: 'password123',
          role: 'superuser',
        }).success,
      ).toBe(false);
    });

    it('validates registerTestUserSchema envelope', () => {
      const result = registerTestUserSchema.safeParse({
        body: { email: 'test@example.com', password: 'password123' },
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('Production Disable Mechanism', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalEnable = process.env.ENABLE_TEST_ENDPOINTS;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.ENABLE_TEST_ENDPOINTS = originalEnable;
  });

  it('allows test endpoints in test environment', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_TEST_ENDPOINTS;
    expect(isTestEndpointAllowed()).toBe(true);
  });

  it('disables test endpoints when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isTestEndpointAllowed()).toBe(false);
  });

  it('disables test endpoints when ENABLE_TEST_ENDPOINTS is false', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_TEST_ENDPOINTS = 'false';
    expect(isTestEndpointAllowed()).toBe(false);
  });

  it('disableInProduction middleware throws 403 in production', () => {
    process.env.NODE_ENV = 'production';
    const next = jest.fn();
    const req = {} as Request;
    const res = {} as Response;

    expect(() => disableInProduction(req, res, next)).toThrow();
    expect(next).not.toHaveBeenCalled();
  });

  it('disableInProduction middleware calls next() in test environment', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_TEST_ENDPOINTS;
    const next = jest.fn();
    const req = {} as Request;
    const res = {} as Response;

    disableInProduction(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Test Endpoints HTTP Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/loans (createTestLoan)', () => {
    it('creates loan (200) with valid amount and term', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ loan_id: 101 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const res = await request(app).post('/api/loans').set(authHeader()).send({
        amount: 5000,
        term: 30,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBe(101);
      expect(res.body.loan).toMatchObject({
        id: 101,
        amount: 5000,
        term: 30,
        borrower: VALID_STELLAR_BORROWER,
        rate: 1200,
      });
    });

    it('creates loan (200) with explicit rate, termDays, and borrower', async () => {
      const explicitBorrower = Keypair.random().publicKey();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ loan_id: 102 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const res = await request(app).post('/api/loans').set(authHeader()).send({
        amount: 2500,
        termDays: 60,
        rate: 1000,
        borrower: explicitBorrower,
      });

      expect(res.status).toBe(200);
      expect(res.body.loan).toMatchObject({
        id: 102,
        amount: 2500,
        term: 60,
        borrower: explicitBorrower,
        rate: 1000,
      });
    });

    it('rejects (400) negative or zero amount', async () => {
      const res = await request(app)
        .post('/api/loans')
        .set(authHeader())
        .send({ amount: -100, term: 30 });

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects (400) rate exceeding 10000 bps', async () => {
      const res = await request(app)
        .post('/api/loans')
        .set(authHeader())
        .send({ amount: 1000, term: 30, rate: 15000 });

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects (400) negative termDays', async () => {
      const res = await request(app)
        .post('/api/loans')
        .set(authHeader())
        .send({ amount: 1000, termDays: -10 });

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects (400) invalid Stellar borrower address in body', async () => {
      const res = await request(app).post('/api/loans').set(authHeader()).send({
        amount: 1000,
        term: 30,
        borrower: 'invalid-stellar-address',
      });

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects (403) when disabled in production', async () => {
      const savedEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const res = await request(app)
          .post('/api/loans')
          .set(authHeader())
          .send({ amount: 1000, term: 30 });

        expect(res.status).toBe(403);
      } finally {
        process.env.NODE_ENV = savedEnv;
      }
    });
  });

  describe('POST /api/auth/register (registerTestUser)', () => {
    it('registers user (200) with valid email and password', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'testuser@dukapay.io',
        password: 'password123',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe('test-jwt-for-testuser@dukapay.io');
      expect(res.body.user).toMatchObject({
        email: 'testuser@dukapay.io',
        role: 'borrower',
      });
    });

    it('registers user (200) with explicit publicKey and role', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'lender@dukapay.io',
        password: 'password123',
        publicKey: VALID_STELLAR_USER,
        role: 'lender',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe(`test-jwt-for-${VALID_STELLAR_USER}`);
      expect(res.body.user).toMatchObject({
        email: 'lender@dukapay.io',
        publicKey: VALID_STELLAR_USER,
        role: 'lender',
      });
    });

    it('rejects (400) invalid email format', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'not-an-email',
        password: 'password123',
      });

      expect(res.status).toBe(400);
    });

    it('rejects (400) password shorter than 8 characters', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'user@dukapay.io',
        password: '123',
      });

      expect(res.status).toBe(400);
    });

    it('rejects (400) invalid Stellar address for publicKey', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'user@dukapay.io',
        password: 'password123',
        publicKey: 'invalid-address',
      });

      expect(res.status).toBe(400);
    });

    it('rejects (403) when disabled in production', async () => {
      const savedEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const res = await request(app).post('/api/auth/register').send({
          email: 'user@dukapay.io',
          password: 'password123',
        });

        expect(res.status).toBe(403);
      } finally {
        process.env.NODE_ENV = savedEnv;
      }
    });
  });
});
