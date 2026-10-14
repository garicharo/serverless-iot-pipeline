const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { GlueClient, CreatePartitionCommand } = require("@aws-sdk/client-glue");
const { groupKey, dayFromTimestamp } = require("./rules");

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const glue = new GlueClient({});

exports.handler = async (event) => {
  const day = dayFromTimestamp(event.timestampMs);
  await registerPartition(day);
  if (!event.config || !event.config.level || !event.config.groupId) {
    return { aggregated: false, delta: event.delta };
  }
  if (event.config.scope === "plant") {
    return {
      aggregated: false,
      reason: "plant meter is not added on top of line meters",
      delta: event.delta,
    };
  }
  if (event.delta === null || event.delta === undefined) {
    return { aggregated: false };
  }
  const key = groupKey(event.config.level, event.config.groupId);
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: {
      deviceId: { S: `group#${key}` },
      sk: { S: `total#${day}` },
    },
    UpdateExpression: "ADD total :delta SET groupKey = :groupKey, memberId = :day",
    ExpressionAttributeValues: {
      ":delta": { N: String(event.delta) },
      ":groupKey": { S: key },
      ":day": { S: day },
    },
  }));
  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: `summaries/day=${day}/${key}.json`,
    Body: JSON.stringify({ groupKey: key, day, delta: event.delta }),
  }));
  return { aggregated: true, groupKey: key, day, delta: event.delta };
};

async function registerPartition(day) {
  try {
    await glue.send(new CreatePartitionCommand({
      DatabaseName: process.env.GLUE_DATABASE,
      TableName: process.env.GLUE_TABLE,
      PartitionInput: {
        Values: [day],
        StorageDescriptor: {
          Location: `s3://${process.env.BUCKET_NAME}/readings/day=${day}/`,
          InputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          OutputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          SerdeInfo: { SerializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
        },
      },
    }));
  } catch (error) {
    if (error.name !== "AlreadyExistsException") {
      throw error;
    }
  }
}
