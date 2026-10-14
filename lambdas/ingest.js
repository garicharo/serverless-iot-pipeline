const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { FirehoseClient, PutRecordCommand } = require("@aws-sdk/client-firehose");
const { SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");
const { dedupParts, readingKey, dayFromTimestamp } = require("./rules");

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
const firehose = new FirehoseClient({});
const steps = new SFNClient({});

exports.handler = async (event) => {
  const parts = dedupParts(event);
  const key = readingKey(parts.deviceId, parts.sourceId);
  const day = dayFromTimestamp(parts.timestampMs);
  const record = {
    ...parts.payload,
    deviceId: parts.deviceId,
    timestampMs: parts.timestampMs,
    day,
  };
  const item = {
    deviceId: { S: parts.deviceId },
    sk: { S: `reading#${key}` },
    timestampMs: { N: String(parts.timestampMs) },
    dedupKey: { S: key },
  };
  if (parts.payload.cumulative !== undefined && parts.payload.cumulative !== null) {
    item.cumulative = { N: String(parts.payload.cumulative) };
  }

  try {
    await dynamo.send(new PutItemCommand({
      TableName: process.env.TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(sk)",
    }));
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return response(200, { stored: false, key });
    }
    throw error;
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify({ deviceId: parts.deviceId, key }),
    MessageDeduplicationId: key.slice(0, 128),
    MessageGroupId: String(parts.deviceId).slice(0, 128),
  }));
  await firehose.send(new PutRecordCommand({
    DeliveryStreamName: process.env.DELIVERY_STREAM,
    Record: { Data: Buffer.from(JSON.stringify(record)) },
  }));
  await steps.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name: key.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 80),
    input: JSON.stringify({
      deviceId: parts.deviceId,
      key,
      timestampMs: parts.timestampMs,
      payload: record,
    }),
  }));
  return response(200, {
    stored: true,
    key,
    deviceId: parts.deviceId,
    timestampMs: parts.timestampMs,
    payload: record,
  });
};

function response(statusCode, body) {
  return { statusCode, body: JSON.stringify(body), ...body };
}
