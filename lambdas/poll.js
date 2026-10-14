const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { readingsFromPartner } = require("./rules");

const lambda = new LambdaClient({});

exports.handler = async () => {
  const url = process.env.PARTNER_URL;
  if (!url) {
    throw new Error("PARTNER_URL is required");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`partner status ${response.status}`);
  }
  const readings = readingsFromPartner(await response.json());
  for (const reading of readings) {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.INGEST_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(reading)),
    }));
  }
  return { accepted: readings.length };
};
