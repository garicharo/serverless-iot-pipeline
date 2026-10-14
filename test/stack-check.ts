import * as assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new App();
const east = new PipelineStack(app, "PipelineEast", {
  role: "primary",
  env: { region: "us-east-1" },
});
const west = new PipelineStack(app, "PipelineWest", {
  role: "standby",
  env: { region: "us-west-1" },
});
const primary = Template.fromStack(east);
const standby = Template.fromStack(west);

primary.resourceCountIs("AWS::DynamoDB::Table", 1);
primary.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
standby.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
primary.hasResourceProperties("AWS::DynamoDB::Table", {
  KeySchema: [
    { AttributeName: "deviceId", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  LocalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "by-time" })]),
  GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: "by-group" })]),
});

primary.hasResourceProperties("AWS::Lambda::Function", {
  Handler: "ingest.handler",
  MemorySize: 256,
  Timeout: 30,
});
primary.hasResourceProperties("AWS::Lambda::Function", {
  Handler: "poll.handler",
  Timeout: 60,
});
primary.hasResourceProperties("AWS::SQS::Queue", {
  FifoQueue: true,
  ContentBasedDeduplication: false,
});
primary.resourceCountIs("AWS::KinesisFirehose::DeliveryStream", 1);
primary.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
primary.resourceCountIs("AWS::ApiGateway::RestApi", 1);
primary.resourceCountIs("AWS::Glue::Table", 1);
primary.resourceCountIs("AWS::RDS::GlobalCluster", 1);
standby.resourceCountIs("AWS::RDS::GlobalCluster", 0);
standby.resourceCountIs("AWS::RDS::DBCluster", 1);
primary.resourceCountIs("AWS::EC2::Instance", 1);
standby.resourceCountIs("AWS::EC2::Instance", 0);
primary.resourceCountIs("AWS::Route53::RecordSet", 2);
standby.resourceCountIs("AWS::Route53::RecordSet", 0);
primary.hasResourceProperties("AWS::Route53::RecordSet", { Failover: "PRIMARY" });
primary.hasResourceProperties("AWS::Route53::RecordSet", { Failover: "SECONDARY" });
primary.hasResourceProperties("AWS::IoT::TopicRule", {
  TopicRulePayload: Match.objectLike({ RuleDisabled: false }),
});
standby.hasResourceProperties("AWS::IoT::TopicRule", {
  TopicRulePayload: Match.objectLike({ RuleDisabled: true }),
});

for (const rule of Object.values(primary.findResources("AWS::Events::Rule"))) {
  assert.equal(rule.Properties.State, "ENABLED");
}
for (const rule of Object.values(standby.findResources("AWS::Events::Rule"))) {
  assert.equal(rule.Properties.State, "DISABLED");
}

console.log("stack checks passed");
