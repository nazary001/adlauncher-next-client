#!/usr/bin/env node
// Idempotent setup of the S3 bucket that holds launch creatives (replaces Vercel Blob, owner ask
// 08.10: "версель использовать для трансфера медиа дорого … на амазоне s3"). Safe to re-run.
//
//   node scripts/creatives-bucket-setup.mjs --dry-run
//   node scripts/creatives-bucket-setup.mjs            (creds from the environment / .env.local)
//
// What it guarantees:
//   • the bucket exists in the region (CREATIVES_S3_BUCKET / CREATIVES_S3_REGION);
//   • public READ by bucket POLICY on creatives/* and keep/* only (ACLs stay blocked) — Meta, LION,
//     TOOL, TikTok and Google fetch a creative by its plain https URL;
//   • CORS that lets the launcher's own origins PUT straight from the browser and READ the part
//     ETags (ExposeHeaders — without it a multipart upload cannot be completed);
//   • lifecycle: creatives/* expire after 14 days, abandoned multipart uploads after 2 days.
//     keep/* (remembered TikTok identities) never expires.
// Credentials are never printed.
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    bucket: { type: "string" },
    region: { type: "string" },
    origin: { type: "string", multiple: true },
    "expire-days": { type: "string" },
    // An env file holding the credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or the
    // CREATIVES_S3_* pair) — e.g. the migration box's aws.env. Never printed.
    "env-file": { type: "string" },
  },
});

if (values["env-file"]) {
  process.loadEnvFile(path.resolve(values["env-file"]));
} else if (!process.env.CREATIVES_S3_BUCKET) {
  for (const f of [".env.local", ".env"]) {
    const p = path.resolve(process.cwd(), f);
    if (existsSync(p)) {
      process.loadEnvFile(p);
      break;
    }
  }
}

const bucket = values.bucket || process.env.CREATIVES_S3_BUCKET || "";
const region = values.region || process.env.CREATIVES_S3_REGION || process.env.AWS_REGION || "eu-central-1";
const accessKeyId = process.env.CREATIVES_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.CREATIVES_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
const expireDays = Math.max(1, Number(values["expire-days"] || 14));
// The browser origins allowed to PUT. Reads stay open to everyone (the objects are public anyway).
const putOrigins = [
  "https://adlauncher.gcamazingtool.xyz",
  "https://*.vercel.app",
  "http://localhost:*",
  "http://127.0.0.1:*",
  ...(values.origin ?? []),
];

if (!bucket) {
  console.error("CREATIVES_S3_BUCKET is not set (env, .env.local or --bucket)");
  process.exit(2);
}

const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "PublicReadCreatives",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: [`arn:aws:s3:::${bucket}/creatives/*`, `arn:aws:s3:::${bucket}/keep/*`],
    },
  ],
};
const cors = {
  CORSRules: [
    {
      AllowedOrigins: putOrigins,
      AllowedMethods: ["PUT", "GET", "HEAD"],
      AllowedHeaders: ["*"],
      ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
      MaxAgeSeconds: 3000,
    },
    {
      AllowedOrigins: ["*"],
      AllowedMethods: ["GET", "HEAD"],
      AllowedHeaders: ["*"],
      ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
      MaxAgeSeconds: 86400,
    },
  ],
};
const lifecycle = {
  Rules: [
    { ID: "creatives-expire", Status: "Enabled", Filter: { Prefix: "creatives/" }, Expiration: { Days: expireDays } },
    { ID: "abort-incomplete-multipart", Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } },
  ],
};

console.log(`bucket=${bucket} region=${region} credsPresent=${Boolean(accessKeyId && secretAccessKey)} expireDays=${expireDays}`);
if (values["dry-run"]) {
  console.log("DRY RUN — would ensure:");
  console.log("  - bucket exists (CreateBucket when missing)");
  console.log("  - PublicAccessBlock {BlockPublicAcls:true, IgnorePublicAcls:true, BlockPublicPolicy:false, RestrictPublicBuckets:false}");
  console.log("  - policy  " + JSON.stringify(policy));
  console.log("  - cors    " + JSON.stringify(cors));
  console.log("  - lifecycle " + JSON.stringify(lifecycle));
  process.exit(0);
}
if (!accessKeyId || !secretAccessKey) {
  console.error("AWS credentials are not set (CREATIVES_S3_ACCESS_KEY_ID / CREATIVES_S3_SECRET_ACCESS_KEY)");
  process.exit(2);
}

const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} = await import("@aws-sdk/client-s3");
const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 4 });

let exists = true;
try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
} catch (e) {
  const code = e?.$metadata?.httpStatusCode;
  if (code === 404 || e?.name === "NotFound" || e?.name === "NoSuchBucket") exists = false;
  else throw e;
}
if (exists) console.log("bucket exists — skipping create");
else {
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(region !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}),
    }),
  );
  console.log("bucket created");
}
await s3.send(
  new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false },
  }),
);
console.log("public access block set (policy-based public read allowed; ACLs blocked)");
await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
console.log("bucket policy set: public read on creatives/* and keep/*");
await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: cors }));
console.log("CORS set: PUT from the launcher origins, GET/HEAD from anywhere, ETag exposed");
await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: lifecycle }));
const lc = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
console.log("lifecycle set: " + (lc.Rules ?? []).map((r) => r.ID).join(", "));
console.log(`\nDONE. Public base: https://${bucket}.s3.${region}.amazonaws.com`);
