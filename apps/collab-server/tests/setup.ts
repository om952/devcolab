// Populate the env the modules under test validate at import time.
// Individual tests override process.env where they need different values.
process.env.NODE_ENV ||= "test";
process.env.DATABASE_URL ||= "postgresql://devcolab:devcolab@localhost:5433/devcolab";
process.env.JWT_SECRET ||= "test-jwt-secret-at-least-16-chars";
process.env.CORS_ORIGIN ||= "http://localhost:3000";
process.env.AI_SERVICE_URL ||= "http://localhost:8000";
// Keep tests off Redis so limiter state stays in-process and isolated.
delete process.env.REDIS_URL;
