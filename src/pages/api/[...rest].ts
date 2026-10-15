// 未定義の /api/* は 404 NOT_FOUND(JSON)。認証は middleware が先に行う
import { discardBody, jsonError } from '../../lib/http';
import type { APIRoute } from 'astro';

export const ALL: APIRoute = async (context) => {
  await discardBody(context.request);
  return jsonError('NOT_FOUND');
};
