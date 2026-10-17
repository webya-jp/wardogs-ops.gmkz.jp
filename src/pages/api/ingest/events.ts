// POST /api/ingest/events(キルフィードの受信。観測モード)。docs/API.md 10 章、docs/ARCHITECTURE.md 5.8・17.6。
// ログイン Cookie・Origin 検査・管理者の有無を見ず、受信用トークン(Authorization: Bearer)で認証する(middleware の例外。パスの完全一致だけ)。
// 応答は 204 か ApiFailure。トークン・本文・Authorization・接続元 IP をログに出さない。
import type { APIRoute } from 'astro';
import { getFeatures, invalidateD1Cache } from '../../../lib/config';
import { handleIngest } from '../../../lib/feed';
import { discardBody, errName, getWaitUntil, jsonError, methodNotAllowed } from '../../../lib/http';
import { getEnv } from '../../../lib/runtime';
import { FEED_MAX_BODY_BYTES } from '../../../types/api';

export const POST: APIRoute = async (context) => {
  try {
    const db = (await getFeatures(getEnv())).db;
    if (!db) {
      await discardBody(context.request, FEED_MAX_BODY_BYTES);
      return jsonError('NOT_CONFIGURED');
    }
    return await handleIngest(db, context.request, { waitUntil: getWaitUntil(context.locals) });
  } catch (err) {
    invalidateD1Cache();
    console.error(JSON.stringify({ kind: 'ingest-error', error: errName(err) }));
    return jsonError('INTERNAL_ERROR');
  }
};

export const ALL: APIRoute = async (context) => {
  await discardBody(context.request, FEED_MAX_BODY_BYTES);
  return methodNotAllowed();
};
