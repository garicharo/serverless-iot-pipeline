import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as athena from "aws-cdk-lib/aws-athena";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { defaults, PipelineRole } from "./config";

export interface PipelineProps extends cdk.StackProps {
  role: PipelineRole;
}

/**
 * One regional stack. Primary us-east-1 receives traffic.
 * Standby us-west-1 is deployed with the poll and the MQTT rule disabled,
 * so a DNS failover does not start a second schedule.
 * DynamoDB stays a regional table: this stack does not declare streams or a global table.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id, props);
    const primary = props.role === "primary";
    cdk.Tags.of(this).add("pipeline", "serverless-iot");
    cdk.Tags.of(this).add("role", props.role);

    const vpc = this.network(primary);
    const table = this.devices();
    const bucket = this.archive();
    const dedup = new sqs.Queue(this, "Dedup", {
      fifo: true,
      contentBasedDeduplication: false,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const dlq = new sqs.Queue(this, "FailedSteps", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const silence = new sns.Topic(this, "Silence");
    this.catalog(bucket);

    const raw = this.fn("Raw", "raw.handler", defaults.lambdaTimeoutSeconds, {
      TABLE_NAME: table.tableName,
    });
    const format = this.fn("Format", "format.handler", defaults.lambdaTimeoutSeconds);
    const enrich = this.fn("Enrich", "enrich.handler", defaults.lambdaTimeoutSeconds, {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      GLUE_DATABASE: defaults.glueDatabase,
      GLUE_TABLE: defaults.glueTable,
    });
    const health = this.fn("Health", "health.handler", defaults.lambdaTimeoutSeconds);
    const silenceFn = this.fn("SilenceCheck", "silence.handler", defaults.lambdaTimeoutSeconds, {
      TOPIC_ARN: silence.topicArn,
    });
    table.grantReadData(raw);
    table.grantReadWriteData(enrich);
    bucket.grantPut(enrich);
    silence.grantPublish(silenceFn);
    enrich.addToRolePolicy(new iam.PolicyStatement({
      actions: ["glue:CreatePartition", "glue:GetPartition", "glue:GetTable"],
      resources: [
        `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog`,
        `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:database/${defaults.glueDatabase}`,
        `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${defaults.glueDatabase}/${defaults.glueTable}`,
      ],
    }));

    const machine = new sfn.StateMachine(this, "Stages", {
      timeout: cdk.Duration.hours(defaults.stateMachineTimeoutHours),
      definitionBody: sfn.DefinitionBody.fromChainable(
        this.step("RawStep", raw, dlq)
          .next(this.step("FormatStep", format, dlq))
          .next(this.step("EnrichStep", enrich, dlq)),
      ),
    });

    const hose = this.delivery(bucket);
    const ingest = this.fn("Ingest", "ingest.handler", defaults.lambdaTimeoutSeconds, {
      TABLE_NAME: table.tableName,
      QUEUE_URL: dedup.queueUrl,
      DELIVERY_STREAM: hose.ref,
      STATE_MACHINE_ARN: machine.stateMachineArn,
    });
    table.grantWriteData(ingest);
    dedup.grantSendMessages(ingest);
    machine.grantStartExecution(ingest);
    ingest.addToRolePolicy(new iam.PolicyStatement({
      actions: ["firehose:PutRecord"],
      resources: [hose.attrArn],
    }));

    const partnerUrl = new cdk.CfnParameter(this, "PartnerUrl", {
      type: "String",
      noEcho: true,
      description: "Solar generation endpoint. Not stored in the repository.",
    });
    const poll = this.fn("Poll", "poll.handler", defaults.pollTimeoutSeconds, {
      PARTNER_URL: partnerUrl.valueAsString,
      INGEST_FUNCTION_NAME: ingest.functionName,
    });
    ingest.grantInvoke(poll);

    const api = new apigw.RestApi(this, "IngestApi", {
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      deployOptions: { stageName: "live" },
    });
    api.root.addResource("readings").addMethod("POST", new apigw.LambdaIntegration(ingest));
    api.root.addResource("health").addMethod("GET", new apigw.LambdaIntegration(health));
    const apiHost = cdk.Fn.join(".", [
      api.restApiId,
      "execute-api",
      cdk.Aws.REGION,
      "amazonaws.com",
    ]);
    new cdk.CfnOutput(this, "ApiHost", { value: apiHost });

    const mqtt = new iot.CfnTopicRule(this, "MqttDoor", {
      topicRulePayload: {
        sql: `SELECT * FROM '${defaults.mqttTopic}'`,
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: !primary,
        actions: [{ lambda: { functionArn: ingest.functionArn } }],
      },
    });
    ingest.addPermission("IotInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: mqtt.attrArn,
    });

    new events.Rule(this, "SolarPoll", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      enabled: primary,
      description: "Poll solar generation. Disabled in the standby region.",
      targets: [new targets.LambdaFunction(poll)],
    });
    new events.Rule(this, "SilenceSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(defaults.silenceCheckHours)),
      enabled: primary,
      description: "Silence board. Disabled in the standby region.",
      targets: [new targets.LambdaFunction(silenceFn)],
    });

    this.history(vpc, primary);
    if (primary) {
      this.bridge(vpc);
      this.failover(apiHost);
    }

    new athena.CfnWorkGroup(this, "Queries", {
      name: "iot-readings",
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        resultConfiguration: {
          outputLocation: bucket.s3UrlForObject("athena-results/"),
        },
      },
    });
  }

  private network(primary: boolean): ec2.Vpc {
    if (!primary) {
      return new ec2.Vpc(this, "Vpc", {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        ],
      });
    }
    return new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
  }

  private devices(): dynamodb.Table {
    const table = new dynamodb.Table(this, "Devices", {
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addLocalSecondaryIndex({
      indexName: "by-time",
      sortKey: { name: "timestampMs", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    table.addGlobalSecondaryIndex({
      indexName: "by-group",
      partitionKey: { name: "groupKey", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "memberId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    return table;
  }

  private archive(): s3.Bucket {
    return new s3.Bucket(this, "Readings", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  private catalog(bucket: s3.Bucket): void {
    const database = new glue.CfnDatabase(this, "Catalog", {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: { name: defaults.glueDatabase },
    });
    const table = new glue.CfnTable(this, "ReadingsTable", {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: defaults.glueDatabase,
      tableInput: {
        name: defaults.glueTable,
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "day", type: "string" }],
        storageDescriptor: {
          columns: [
            { name: "deviceId", type: "string" },
            { name: "timestampMs", type: "bigint" },
            { name: "cumulative", type: "double" },
            { name: "delta", type: "double" },
          ],
          location: bucket.s3UrlForObject("readings/"),
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
        },
      },
    });
    table.addResourceDependency(database);
  }

  private delivery(bucket: s3.Bucket): firehose.CfnDeliveryStream {
    const role = new iam.Role(this, "HoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });
    bucket.grantWrite(role);
    return new firehose.CfnDeliveryStream(this, "ReadingsHose", {
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: role.roleArn,
        prefix: "readings/day=!{partitionKeyFromQuery:day}/",
        errorOutputPrefix: "errors/result=!{firehose:error-output-type}/",
        bufferingHints: {
          intervalInSeconds: defaults.firehoseBufferSeconds,
          sizeInMBs: defaults.firehoseBufferMb,
        },
        compressionFormat: "UNCOMPRESSED",
        dynamicPartitioningConfiguration: { enabled: true },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                { parameterName: "MetadataExtractionQuery", parameterValue: "{day:.day}" },
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
              ],
            },
          ],
        },
      },
    });
  }

  private step(id: string, fn: lambda.IFunction, dlq: sqs.Queue): tasks.LambdaInvoke {
    const invoke = new tasks.LambdaInvoke(this, id, {
      lambdaFunction: fn,
      outputPath: "$.Payload",
    });
    const send = new tasks.SqsSendMessage(this, `${id}ToDlq`, {
      queue: dlq,
      messageBody: sfn.TaskInput.fromJsonPathAt("$.error"),
    });
    invoke.addCatch(send.next(new sfn.Fail(this, `${id}Failed`)), { resultPath: "$.error" });
    return invoke;
  }

  private fn(
    id: string,
    handler: string,
    timeoutSeconds: number,
    environment?: Record<string, string>,
  ): lambda.Function {
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambdas")),
      handler,
      memorySize: defaults.lambdaMemoryMb,
      timeout: cdk.Duration.seconds(timeoutSeconds),
      environment,
    });
  }

  private history(vpc: ec2.Vpc, primary: boolean): void {
    const sg = new ec2.SecurityGroup(this, "HistorySg", { vpc, allowAllOutbound: true });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), "in-vpc clients");
    const dataSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
    if (primary) {
      const cluster = new rds.DatabaseCluster(this, "History", {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.of(
            defaults.auroraEngineVersion,
            defaults.auroraMajorVersion,
          ),
        }),
        credentials: rds.Credentials.fromGeneratedSecret("history"),
        defaultDatabaseName: defaults.databaseName,
        writer: rds.ClusterInstance.serverlessV2("writer"),
        serverlessV2MinCapacity: defaults.serverlessMinAcu,
        serverlessV2MaxCapacity: defaults.serverlessMaxAcu,
        vpc,
        vpcSubnets: dataSubnets,
        securityGroups: [sg],
        storageEncrypted: true,
        deletionProtection: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        backup: { retention: cdk.Duration.days(defaults.backupRetentionDays) },
      });
      const global = new rds.CfnGlobalCluster(this, "HistoryGlobal", {
        globalClusterIdentifier: defaults.globalClusterIdentifier,
        sourceDbClusterIdentifier: cluster.clusterArn,
        deletionProtection: true,
      });
      global.node.addDependency(cluster);
      return;
    }
    const subnets = new rds.CfnDBSubnetGroup(this, "HistorySubnets", {
      dbSubnetGroupDescription: "Standby history subnets",
      subnetIds: vpc.selectSubnets(dataSubnets).subnetIds,
    });
    const replica = new rds.CfnDBCluster(this, "HistoryReplica", {
      engine: "aurora-postgresql",
      engineVersion: defaults.auroraEngineVersion,
      globalClusterIdentifier: defaults.globalClusterIdentifier,
      dbSubnetGroupName: subnets.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      storageEncrypted: true,
      deletionProtection: true,
      serverlessV2ScalingConfiguration: {
        minCapacity: defaults.serverlessMinAcu,
        maxCapacity: defaults.serverlessMaxAcu,
      },
    });
    replica.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new rds.CfnDBInstance(this, "HistoryReplicaInstance", {
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
      dbClusterIdentifier: replica.ref,
    });
  }

  private bridge(vpc: ec2.Vpc): void {
    new ec2.Instance(this, "PlantBridge", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(defaults.bridgeInstanceType),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
      ),
      ssmSessionPermissions: true,
      requireImdsv2: true,
    });
  }

  private failover(apiHost: string): void {
    const zoneId = new cdk.CfnParameter(this, "HostedZoneId", { type: "String", default: "" });
    const recordName = new cdk.CfnParameter(this, "RecordName", { type: "String", default: "" });
    const westHost = new cdk.CfnParameter(this, "WestApiHost", { type: "String", default: "" });
    const ready = new cdk.CfnCondition(this, "DnsReady", {
      expression: cdk.Fn.conditionAnd(
        cdk.Fn.conditionNot(cdk.Fn.conditionEquals(zoneId.valueAsString, "")),
        cdk.Fn.conditionNot(cdk.Fn.conditionEquals(recordName.valueAsString, "")),
        cdk.Fn.conditionNot(cdk.Fn.conditionEquals(westHost.valueAsString, "")),
      ),
    });
    const health = new route53.CfnHealthCheck(this, "PrimaryHealth", {
      healthCheckConfig: {
        type: "HTTPS",
        fullyQualifiedDomainName: apiHost,
        port: 443,
        resourcePath: "/live/health",
        requestInterval: defaults.healthCheckIntervalSeconds,
        failureThreshold: defaults.healthCheckFailureThreshold,
      },
    });
    health.cfnOptions.condition = ready;
    const primaryRecord = new route53.CfnRecordSet(this, "PrimaryRecord", {
      hostedZoneId: zoneId.valueAsString,
      name: recordName.valueAsString,
      type: "CNAME",
      ttl: defaults.dnsTtlSeconds,
      setIdentifier: "east",
      failover: "PRIMARY",
      healthCheckId: health.attrHealthCheckId,
      resourceRecords: [apiHost],
    });
    const secondaryRecord = new route53.CfnRecordSet(this, "SecondaryRecord", {
      hostedZoneId: zoneId.valueAsString,
      name: recordName.valueAsString,
      type: "CNAME",
      ttl: defaults.dnsTtlSeconds,
      setIdentifier: "west",
      failover: "SECONDARY",
      resourceRecords: [westHost.valueAsString],
    });
    primaryRecord.cfnOptions.condition = ready;
    secondaryRecord.cfnOptions.condition = ready;
  }
}
