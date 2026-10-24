import { Elysia } from 'elysia';

export function healthRoutes() {
  return new Elysia({ prefix: '/api/v1' }).get('/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));
}
