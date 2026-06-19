#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PoirotStack } from "../lib/poirot-stack";

const app = new cdk.App();

new PoirotStack(app, "PoirotStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    "Headless Claude Code on CodeBuild that investigates log-error spikes and production incidents.",
  // These come from cdk.json context; override with `-c repoOwner=... -c repoName=...`.
  repoOwner: app.node.tryGetContext("repoOwner"),
  repoName: app.node.tryGetContext("repoName"),
  claudeModel: app.node.tryGetContext("claudeModel"),
  // Optional: a log group to wire an example error-spike alarm to.
  targetLogGroupName: app.node.tryGetContext("targetLogGroupName"),
});
