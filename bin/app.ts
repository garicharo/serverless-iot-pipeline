#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { regions } from "../lib/config";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

function env(region: string): cdk.Environment {
  return account ? { account, region } : { region };
}

new PipelineStack(app, "PipelineEast", {
  role: "primary",
  env: env(regions.primary),
  description: "IoT pipeline primary in us-east-1. This stack receives traffic.",
});

new PipelineStack(app, "PipelineWest", {
  role: "standby",
  env: env(regions.standby),
  description: "IoT pipeline standby in us-west-1. Deployed, with schedules off.",
});
