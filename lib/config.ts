/**
 * Defaults for this repository. They are not copied from a production console.
 * Memory, timeouts, Aurora capacity, the bridge instance, and the health-check
 * interval were not recovered.
 */
export const regions = {
  primary: "us-east-1",
  standby: "us-west-1",
} as const;

export const defaults = {
  lambdaMemoryMb: 256,
  lambdaTimeoutSeconds: 30,
  pollTimeoutSeconds: 60,
  stateMachineTimeoutHours: 1,
  silenceCheckHours: 1,
  healthCheckIntervalSeconds: 30,
  healthCheckFailureThreshold: 3,
  dnsTtlSeconds: "60",
  auroraEngineVersion: "15.4",
  auroraMajorVersion: "15",
  serverlessMinAcu: 0.5,
  serverlessMaxAcu: 2,
  backupRetentionDays: 7,
  bridgeInstanceType: "t3.micro",
  firehoseBufferSeconds: 60,
  firehoseBufferMb: 64,
  globalClusterIdentifier: "iot-history",
  databaseName: "history",
  glueDatabase: "iot_readings",
  glueTable: "readings",
  mqttTopic: "readings/+",
};

export type PipelineRole = "primary" | "standby";
