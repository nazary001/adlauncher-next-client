#!/usr/bin/env node
// A REAL end-to-end smoke of the S3 creative store against the live bucket. The integrator runs it
// ONCE the bucket exists (scripts/creatives-bucket-setup.mjs) — it signs through the same library the
// app uses (lib/creative-store) and uploads straight to S3 with fetch, exactly as the browser will.
//
//   node scripts/creatives-smoke.mjs --env-file path/to/aws.env
//   node scripts/creatives-smoke.mjs                 (creds from .env.local / .env)
//
// If the bucket does not exist yet (NoSuchBucket) or the store is not configured, it REPORTS that and
// exits 0 — that is the "not set up yet" state, not a failure. Any real step failure prints FAIL and
// exits 1. Credentials are never printed.
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "env-file": { type: "string" } } });
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

const store = await import("../lib/creative-store.ts");
const { creativeS3Base, creativeUrl } = await import("../lib/creative-url.ts");

const ORIGIN = "https://adlauncher.gcamazingtool.xyz";
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const s3Base = () => creativeS3Base(process.env);

let failed = false;
let skipped = false;
function pass(step, extra = "") {
  console.log(`PASS  ${step}${extra ? " — " + extra : ""}`);
}
function fail(step, reason) {
  failed = true;
  console.log(`FAIL  ${step} — ${reason}`);
}

// A plain GET of a public creative URL (CDN or bucket origin), optionally with a Range / Origin.
async function getBytes(url, headers = {}) {
  const r = await fetch(url, { headers });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body };
}

// S3 client only for cleanup (DeleteObject) — the store itself never deletes per launch.
async function deleteKeys(keys) {
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: (process.env.CREATIVES_S3_REGION || "eu-central-1").trim(),
    credentials: {
      accessKeyId: (process.env.CREATIVES_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "").trim(),
      secretAccessKey: (process.env.CREATIVES_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
    },
    maxAttempts: 3,
  });
  const bucket = (process.env.CREATIVES_S3_BUCKET || "").trim();
  for (const key of keys) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (e) {
      console.log(`      (cleanup) could not delete ${key}: ${e?.name || e?.message}`);
    }
  }
}

function isNoSuchBucket(text, status) {
  return (text && /NoSuchBucket/i.test(text)) || status === 404;
}

async function main() {
  if (!store.creativesConfigured()) {
    skipped = true;
    console.log("REPORT: the creative store is not configured (CREATIVES_S3_BUCKET + credentials) — nothing to smoke. Exit 0.");
    return;
  }
  console.log(`bucket=${(process.env.CREATIVES_S3_BUCKET || "").trim()} region=${(process.env.CREATIVES_S3_REGION || "eu-central-1").trim()}`);

  const cleanup = [];

  // ---- Step 1: plan + PUT a 300 KB file, then GET it back and compare bytes ----
  const small = crypto.randomBytes(300 * 1024);
  const smallSha = sha256(small);
  const plan1 = await store.planCreativeUpload({ size: small.length, type: "video/mp4", name: "smoke-small.mp4", sha256: smallSha });
  if (!plan1.ok) {
    fail("1 plan single", plan1.error);
    return;
  }
  if (plan1.state !== "single") {
    // 'exists' means a previous smoke left the object — delete and re-plan once.
    if (plan1.state === "exists") {
      await deleteKeys([plan1.key]);
    }
    const again = await store.planCreativeUpload({ size: small.length, type: "video/mp4", name: "smoke-small.mp4", sha256: smallSha });
    if (!again.ok || again.state !== "single") {
      fail("1 plan single", `expected single, got ${again.ok ? again.state : again.error}`);
      return;
    }
    Object.assign(plan1, again);
  }
  const put1 = await fetch(plan1.putUrl, { method: "PUT", headers: plan1.headers, body: small });
  if (!put1.ok) {
    const text = await put1.text().catch(() => "");
    if (isNoSuchBucket(text, put1.status)) {
      skipped = true;
      console.log(`REPORT: the bucket does not exist yet (PUT → ${put1.status} NoSuchBucket). Run scripts/creatives-bucket-setup.mjs first. Exit 0.`);
      return;
    }
    fail("1 PUT single", `${put1.status} ${text.slice(0, 120)}`);
    return;
  }
  cleanup.push(plan1.key);
  const back = await getBytes(plan1.url);
  if (back.status === 200 && Buffer.compare(back.body, small) === 0) pass("1 plan + PUT + GET single", `${small.length} bytes round-trip`);
  else fail("1 GET single", `status ${back.status}, ${back.body.length} bytes (expected ${small.length})`);

  // ---- Step 2: plan the same sha again → must be 'exists' ----
  const plan2 = await store.planCreativeUpload({ size: small.length, type: "video/mp4", name: "smoke-small.mp4", sha256: smallSha });
  if (plan2.ok && plan2.state === "exists" && plan2.key === plan1.key) pass("2 dedupe", "same bytes answered exists");
  else fail("2 dedupe", `expected exists, got ${plan2.ok ? plan2.state : plan2.error}`);

  // ---- Step 3: a PUT with the WRONG content-type must be refused (403, signed content-type) ----
  const wrong = crypto.randomBytes(4096);
  const wrongPlan = await store.planCreativeUpload({ size: wrong.length, type: "video/mp4", name: "smoke-wrongct.mp4", sha256: sha256(wrong) });
  if (!wrongPlan.ok || wrongPlan.state !== "single") {
    fail("3 wrong content-type", `could not plan: ${wrongPlan.ok ? wrongPlan.state : wrongPlan.error}`);
  } else {
    const bad = await fetch(wrongPlan.putUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: wrong });
    if (bad.status === 403) pass("3 wrong content-type refused", "403 as signed");
    else {
      fail("3 wrong content-type", `expected 403, got ${bad.status}`);
      if (bad.ok) cleanup.push(wrongPlan.key); // it unexpectedly landed — clean it up
    }
  }

  // ---- Step 4: multipart with a ~40 MB random buffer ----
  const big = crypto.randomBytes(40 * 1024 * 1024);
  const bigSha = sha256(big);
  let bigPlan = await store.planCreativeUpload({ size: big.length, type: "video/mp4", name: "smoke-big.mp4", sha256: bigSha });
  if (bigPlan.ok && bigPlan.state === "exists") {
    await deleteKeys([bigPlan.key]);
    bigPlan = await store.planCreativeUpload({ size: big.length, type: "video/mp4", name: "smoke-big.mp4", sha256: bigSha });
  }
  if (!bigPlan.ok || bigPlan.state !== "multipart") {
    fail("4 multipart", `expected multipart, got ${bigPlan.ok ? bigPlan.state : bigPlan.error}`);
  } else {
    const parts = [];
    let ok = true;
    for (const part of bigPlan.parts) {
      const start = (part.n - 1) * bigPlan.partSize;
      const slice = big.subarray(start, Math.min(big.length, start + bigPlan.partSize));
      const r = await fetch(part.url, { method: "PUT", body: slice });
      const etag = r.headers.get("etag");
      if (!r.ok || !etag) {
        fail("4 multipart part", `part ${part.n}: status ${r.status}, etag ${etag}`);
        ok = false;
        break;
      }
      parts.push({ n: part.n, etag });
    }
    if (ok) {
      const done = await store.completeCreativeUpload({ key: bigPlan.key, uploadId: bigPlan.uploadId, parts });
      if (done.ok) {
        cleanup.push(bigPlan.key);
        pass("4 multipart", `${parts.length} parts completed`);

        // ---- Step 5: a public GET of a byte range ----
        const range = await getBytes(creativeUrl(bigPlan.key, process.env), { Range: "bytes=0-99" });
        if (range.status === 206 && range.body.length === 100 && Buffer.compare(range.body, big.subarray(0, 100)) === 0) pass("5 range GET", "206, 100 bytes");
        else fail("5 range GET", `status ${range.status}, ${range.body.length} bytes`);

        // ---- Step 6: CORS preflight + ETag exposed on a cross-origin GET ----
        const objUrl = `${s3Base()}/${bigPlan.key}`;
        const pre = await fetch(objUrl, {
          method: "OPTIONS",
          headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
        });
        const allowOrigin = pre.headers.get("access-control-allow-origin");
        const allowMethods = pre.headers.get("access-control-allow-methods") || "";
        const preOk = (pre.status === 200 || pre.status === 204) && (allowOrigin === ORIGIN || allowOrigin === "*") && /PUT/i.test(allowMethods);
        if (preOk) pass("6 CORS preflight", `allow-origin ${allowOrigin}`);
        else fail("6 CORS preflight", `status ${pre.status}, allow-origin ${allowOrigin}, allow-methods ${allowMethods}`);

        const corsGet = await getBytes(objUrl, { Origin: ORIGIN, Range: "bytes=0-0" });
        const expose = (corsGet.headers.get("access-control-expose-headers") || "").toLowerCase();
        if (expose.includes("etag")) pass("6 ETag exposed", `expose-headers ${expose}`);
        else fail("6 ETag exposed", `expose-headers "${expose}" does not include ETag`);
      } else {
        fail("4 multipart complete", done.error);
      }
    }
  }

  // ---- cleanup ----
  if (cleanup.length) {
    await deleteKeys(cleanup);
    console.log(`cleanup: deleted ${cleanup.length} test object(s)`);
  }
}

main()
  .catch((e) => {
    // A NoSuchBucket thrown by cleanup/plan rather than surfaced as a response is still the "not set
    // up yet" state — report, don't crash red.
    if (e && /NoSuchBucket/i.test(String(e?.name || e?.message))) {
      console.log(`REPORT: the bucket does not exist yet (${e.name || e.message}). Run scripts/creatives-bucket-setup.mjs first. Exit 0.`);
      process.exit(0);
    }
    console.error(`SMOKE ERROR: ${e?.message || e}`);
    process.exit(1);
  })
  .then(() => {
    if (failed) {
      console.log("\nSMOKE: FAIL");
      process.exit(1);
    }
    if (!skipped) console.log("\nSMOKE: PASS");
  });
