// DynamoDB access. One table, partitioned by record type.
//
//   pk              sk                   what
//   PAPER           <paperId>            a paper and its lab-wide state
//   TALLY           <paperId>            running up/down totals across all weeks
//   LINK            <linkKey>            points at the paper using a link (dedupe)
//   MEMBER          <nameKey>            member, passcode hash, admin flag
//   VOTE#<week>     <nameKey>#<paperId>  a member's signed holding this week
//   USAGE#<week>    <nameKey>            votes and submissions spent this week
//   LOCK#IP         <ipKey>              failed sign-ins from an address
//   LOCK#ACCT       <nameKey>            failed sign-ins against a member
//   CONFIG          auth | slack         signing secret, Slack webhook
//
// Weekly items carry a TTL. Past weeks are never read, so who voted for what stops
// being reachable at the week boundary; DynamoDB deletes the rows afterwards.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, TransactWriteCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.DDB_ENDPOINT;   // set only when testing against DynamoDB Local
const client = new DynamoDBClient(endpoint
  ? { endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
  : {});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME || 'reading-list';

export const K = {
  paper: (id) => ({ pk: 'PAPER', sk: id }),
  tally: (id) => ({ pk: 'TALLY', sk: id }),
  link: (key) => ({ pk: 'LINK', sk: key }),
  member: (key) => ({ pk: 'MEMBER', sk: key }),
  vote: (week, member, paperId) => ({ pk: 'VOTE#' + week, sk: member + '#' + paperId }),
  usage: (week, member) => ({ pk: 'USAGE#' + week, sk: member }),
  ipLock: (ip) => ({ pk: 'LOCK#IP', sk: ip }),
  acctLock: (member) => ({ pk: 'LOCK#ACCT', sk: member }),
  config: (name) => ({ pk: 'CONFIG', sk: name }),
};

export async function get(key, consistent = false) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: key, ConsistentRead: consistent }));
  return r.Item || null;
}

export async function put(item, condition, values) {
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: item,
    ConditionExpression: condition,
    ExpressionAttributeValues: values,
  }));
}

export async function del(key) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));
}

export async function update(params) {
  const r = await ddb.send(new UpdateCommand({ TableName: TABLE, ReturnValues: 'ALL_NEW', ...params }));
  return r.Attributes || null;
}

/** Every item in one partition, following pagination. */
export async function queryAll(pk, { prefix, consistent = false } = {}) {
  const out = [];
  let start;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :pre)' : 'pk = :pk',
      ExpressionAttributeValues: prefix ? { ':pk': pk, ':pre': prefix } : { ':pk': pk },
      ConsistentRead: consistent,
      ExclusiveStartKey: start,
    }));
    out.push(...(r.Items || []));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

export async function transact(items) {
  const TransactItems = items.filter(Boolean).map((op) => {
    const [kind] = Object.keys(op);
    return { [kind]: { TableName: TABLE, ...op[kind] } };
  });
  await ddb.send(new TransactWriteCommand({ TransactItems }));
}

/** Unconditional writes, 25 per request, retrying anything DynamoDB hands back. */
export async function batchPut(items) {
  for (let i = 0; i < items.length; i += 25) {
    let request = { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
    for (let tries = 0; request && Object.keys(request).length && tries < 8; tries++) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: request }));
      request = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length ? r.UnprocessedItems : null;
      if (request) await new Promise((res) => setTimeout(res, 100 * 2 ** tries));
    }
  }
}

/**
 * Which items in a cancelled transaction failed their condition, by position.
 * Returns null when the failure was not a condition failure at all.
 */
export function conditionFailures(err) {
  if (err && err.name === 'ConditionalCheckFailedException') return [0];
  if (err && err.name === 'TransactionCanceledException') {
    const reasons = err.CancellationReasons || [];
    const failed = reasons.map((r, i) => (r && r.Code === 'ConditionalCheckFailed' ? i : -1)).filter((i) => i >= 0);
    if (failed.length) return failed;
    if (reasons.some((r) => r && r.Code === 'TransactionConflict')) return [];
  }
  if (err && err.name === 'TransactionConflictException') return [];
  return null;
}
