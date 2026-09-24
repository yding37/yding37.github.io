// Lambda entry point.
//
// Two ways in:
//   1. The public Function URL (the reading-list page). Event has requestContext.http.
//   2. Direct invocation: the Friday schedule, and deploy.sh for import and member
//      recovery. These require IAM permission to invoke the function, so they are
//      not reachable from the page no matter what a request body says.
//
// CORS headers are added by the Function URL configuration, not here. Adding them
// in code as well produces duplicate headers, which browsers reject.

import { login, makeToken, requireMember, requireAdmin } from './auth.mjs';
import { list, me, vote, submit, setState } from './papers.mjs';
import { lookup } from './lookup.mjs';
import { postDigest } from './digest.mjs';
import { adminOp, importData, saveMember } from './admin.mjs';
import { CONFIG, HttpError } from './util.mjs';

const MAX_BODY = 64 * 1024;

function respond(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new HttpError(413, 'Request too large.');
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

async function routeHttp(event) {
  const method = event.requestContext.http.method;
  const sourceIp = event.requestContext.http.sourceIp;

  if (method === 'GET') {
    const action = (event.queryStringParameters && event.queryStringParameters.action) || 'list';
    if (action === 'list') return list();
    if (action === 'ping') return { ok: true, api_version: CONFIG.API_VERSION };
    throw new HttpError(400, 'Unknown action: ' + action);
  }
  if (method !== 'POST') throw new HttpError(405, 'Use GET or POST.');

  const body = parseBody(event);
  switch (body.action) {
    case 'login': {
      const m = await login(body, sourceIp);
      const extra = await me(m);
      return { ok: true, token: await makeToken(m), member: m.name, admin: !!m.admin, my_weights: extra.my_weights, me: extra.me };
    }
    case 'me':     return me(await requireMember(body.token));
    case 'vote':   return vote(await requireMember(body.token), body);
    case 'submit': return submit(await requireMember(body.token), body);
    case 'state':  return setState(await requireMember(body.token), body);
    case 'lookup': await requireMember(body.token); return lookup(body);
    case 'admin':  return adminOp(await requireAdmin(body.token), body);
    default:       throw new HttpError(400, 'Unknown action: ' + body.action);
  }
}

async function routeInternal(event) {
  switch (event && event.action) {
    case 'digest':     return postDigest();
    case 'import':     return importData(event);
    case 'set_member': return saveMember({ name: event.name, passcode: event.passcode, admin: event.admin }, null);
    case 'ping':       return { ok: true, api_version: CONFIG.API_VERSION };
    default:           throw new HttpError(400, 'Unknown internal action.');
  }
}

export async function handler(event) {
  const isHttp = !!(event && event.requestContext && event.requestContext.http);
  try {
    const result = isHttp ? await routeHttp(event) : await routeInternal(event);
    return isHttp ? respond(200, result) : result;
  } catch (err) {
    if (err instanceof HttpError) {
      const body = { ok: false, error: err.message, ...err.extra };
      return isHttp ? respond(err.status, body) : body;
    }
    console.error(err);
    const body = { ok: false, error: 'Something went wrong on the server.' };
    return isHttp ? respond(500, body) : body;
  }
}
