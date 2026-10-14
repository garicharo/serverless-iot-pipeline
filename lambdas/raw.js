const { DynamoDBClient, QueryCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");

const dynamo = new DynamoDBClient({});

exports.handler = async (event) => {
  const config = await getConfig(event.deviceId);
  const window = await lastFive(event.deviceId);
  return { ...event, config, window };
};

async function getConfig(deviceId) {
  const result = await dynamo.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: { deviceId: { S: deviceId }, sk: { S: "config" } },
    // The five and the config must not be a stale window. The production
    // ConsistentRead flag was not recovered; this repository turns it on.
    ConsistentRead: true,
  }));
  if (!result.Item) {
    return null;
  }
  return {
    level: result.Item.level && result.Item.level.S,
    groupId: result.Item.groupId && result.Item.groupId.S,
    kind: result.Item.kind && result.Item.kind.S,
    scope: result.Item.scope && result.Item.scope.S,
  };
}

async function lastFive(deviceId) {
  const result = await dynamo.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    IndexName: "by-time",
    KeyConditionExpression: "deviceId = :id",
    ExpressionAttributeValues: { ":id": { S: deviceId } },
    ScanIndexForward: false,
    Limit: 5,
    ConsistentRead: true,
  }));
  return (result.Items || [])
    .map((item) => ({
      timestampMs: Number(item.timestampMs.N),
      cumulative: item.cumulative ? Number(item.cumulative.N) : undefined,
    }))
    .reverse();
}
