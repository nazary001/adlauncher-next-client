// `node --test tests/canonical-host.test.ts` — a page of the production launcher opened on a Vercel
// host (a deployment's own URL such as glo-02adlauncher-next-client-2f4r2blyi-…vercel.app, which shows
// THAT build for ever) is sent to the team's real site (owner 20.10: on such a URL he saw the 08.10
// build without Team logins, "но обнова выкачена"). APIs, framework files, previews and local runs
// are left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRedirectUrl } from "../lib/canonical-host.ts";

const base = {
  host: "glo-02adlauncher-next-client-2f4r2blyi-tools-8865s-projects.vercel.app",
  pathname: "/users",
  search: "?partner=br",
  method: "GET",
  selfOrigin: "https://glo-02adlauncher.gcamazingtool.xyz",
  vercelEnv: "production",
};

test("a page on a production deployment's own vercel.app URL goes to the real site, path and query kept", () => {
  assert.equal(canonicalRedirectUrl(base), "https://glo-02adlauncher.gcamazingtool.xyz/users?partner=br");
  assert.equal(canonicalRedirectUrl({ ...base, pathname: "/", search: "" }), "https://glo-02adlauncher.gcamazingtool.xyz/");
  assert.equal(canonicalRedirectUrl({ ...base, host: "glo-02adlauncher-next-client.vercel.app" }), "https://glo-02adlauncher.gcamazingtool.xyz/users?partner=br");
  assert.equal(canonicalRedirectUrl({ ...base, method: "HEAD" }), "https://glo-02adlauncher.gcamazingtool.xyz/users?partner=br");
});

test("the real site itself, APIs (cron, the queue's kicks, Blob callbacks), POSTs and framework files are never redirected", () => {
  assert.equal(canonicalRedirectUrl({ ...base, host: "glo-02adlauncher.gcamazingtool.xyz" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, host: "GLO-02ADLAUNCHER.gcamazingtool.xyz:443" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, pathname: "/api/launch-queue/cron" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, pathname: "/api" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, pathname: "/_next/data/x.json" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, method: "POST" }), null);
});

test("only on production, only from a vercel.app host, only with a usable ADL_SELF_ORIGIN", () => {
  assert.equal(canonicalRedirectUrl({ ...base, vercelEnv: "preview" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, vercelEnv: undefined }), null);
  assert.equal(canonicalRedirectUrl({ ...base, host: "localhost:3202" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, host: "some-other-domain.example" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, selfOrigin: "" }), null);
  assert.equal(canonicalRedirectUrl({ ...base, selfOrigin: undefined }), null);
  assert.equal(canonicalRedirectUrl({ ...base, selfOrigin: "not a url" }), null);
  // an origin that is itself a vercel.app host must not bounce a request between two vercel hosts
  assert.equal(canonicalRedirectUrl({ ...base, selfOrigin: "https://glo-02adlauncher-next-client.vercel.app/" }), "https://glo-02adlauncher-next-client.vercel.app/users?partner=br");
  assert.equal(canonicalRedirectUrl({ ...base, host: "glo-02adlauncher-next-client.vercel.app", selfOrigin: "https://glo-02adlauncher-next-client.vercel.app" }), null);
});
