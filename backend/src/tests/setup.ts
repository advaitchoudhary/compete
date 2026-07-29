import 'dotenv/config'

// Override env for test environment
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://allsports:password@localhost:5432/allsports_test'
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'
process.env.NODE_ENV = 'test'
