process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'test-only-secret-with-at-least-32-characters';