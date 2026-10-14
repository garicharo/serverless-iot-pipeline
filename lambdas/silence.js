const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { silenceHours } = require("./rules");

const sns = new SNSClient({});

exports.handler = async (event) => {
  const devices = event.devices || [];
  let published = 0;
  for (const device of devices) {
    const hours = silenceHours(event.nowMs, device.lastSeenMs);
    if (!hours) {
      continue;
    }
    await sns.send(new PublishCommand({
      TopicArn: process.env.TOPIC_ARN,
      Message: JSON.stringify({ deviceId: device.deviceId, hours }),
    }));
    published += 1;
  }
  return { published };
};
