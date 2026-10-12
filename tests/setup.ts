process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://searchops:searchops@localhost:5432/searchops_test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.APP_URL ??= "http://localhost:3000";
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false"; // never inherit the dev .env override
