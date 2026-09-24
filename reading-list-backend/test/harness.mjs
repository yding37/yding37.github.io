// Test harness: a fresh table in DynamoDB Local, and helpers that call the real
// Lambda handler with Function-URL-shaped events.

import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';

export const ENDPOINT = process.env.DDB_ENDPOINT || 'http://127.0.0.1:8765';
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.TABLE_NAME = process.env.TABLE_NAME || 'reading-list-test';

const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

export async function freshTable() {
  const TableName = process.env.TABLE_NAME;
  try { await raw.send(new DeleteTableCommand({ TableName })); } catch { /* absent */ }
  // Same shape as template.yaml.
  await raw.send(new CreateTableCommand({
    TableName,
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    ProvisionedThroughput: { ReadCapacityUnits: 15, WriteCapacityUnits: 10 },
  }));
  await raw.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } }));
}

let handlerMod;
export async function handler() {
  handlerMod = handlerMod || (await import('../lambda/index.mjs'));
  return handlerMod.handler;
}

export async function http(method, body, { ip = '203.0.113.7', query } = {}) {
  const h = await handler();
  const event = {
    rawPath: '/',
    queryStringParameters: query,
    requestContext: { http: { method, sourceIp: ip } },
    body: body ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
  const res = await h(event);
  return { status: res.statusCode, ...JSON.parse(res.body) };
}

export const post = (body, opts) => http('POST', body, opts);
export const listPapers = () => http('GET', null, { query: { action: 'list' } });
export async function internal(event) { return (await handler())(event); }

// ---------------------------------------------------------------- assertions
let passed = 0;
let failed = 0;
const failures = [];
export function check(label, cond, detail) {
  if (cond) { passed++; console.log('  ok    ' + label); }
  else { failed++; failures.push(label); console.log('  FAIL  ' + label + (detail !== undefined ? '   -> ' + JSON.stringify(detail) : '')); }
}
export function section(title) { console.log('\n== ' + title); }
export function summary() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
}
