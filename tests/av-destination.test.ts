// Node's built-in runner (v24 strips types natively): `node --test tests/av-destination.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// AV rail — the destination resolver as a whole: ONE verdict for the three kinds an ad may point at
// (article of an AV site · path of a redirect domain · chat on a Chat Builder subdomain), and the
// catalog the card reads. ActiveView's API, the pages and DNS are the only doubles (all external).
import "./_resolve-hook.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.AV_API_KEY = "k".repeat(64) + ":" + "s".repeat(20);
process.env.AV_API_BASE = "https://av.test";
// The redirect domain's liveness is the resolver's own non-production seam (no DNS / HTTPS probe).
process.env.AV_TEST_LIVE_REDIRECT_DOMAINS = "redirect.thecadrion.com";
const dest = await import("../lib/av-destination.ts");

const GATEWAY = "assistant-quiz-infrastructure-gateway.activeview.app";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const ME = {
  response: {
    publisher_id: "f845",
    sites: [{ delegation_type: "MANAGE_PARTNER", domain: "thecadrion.com", network_code: "2550370616", parent_network_code: "198073784", site_name: "thecadrion.com" }],
  },
};
const REDIRECTS = {
  redirectDomains: [{ id: "cmue7hk5p000ts60oo7x9557n", name: "redirect.thecadrion.com", createdAt: "2026-09-25T00:00:00.000Z", redirectPaths: [{ id: "path1", path: "/jobs" }] }],
};
const MAPPINGS = [{ url: "https://thecadrion.com/forklift-certification-mobile-app-us-en", percentage: 100 }];
// The second entry is the home page with a chat id in its query — a shape lib/av-link keeps for chat
// hosts, and one that must never be offered as an ARTICLE of the site.
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://thecadrion.com/forklift-certification-mobile-app-us-en</loc></url><url><loc>https://thecadrion.com/?asst=6a2312cef9f4e11b130fc523</loc></url></urlset>`;
/** A chat host's /worker.js with ads enabled (read live 29.09 on other publishers' chat hosts:
 *  a JSON-style settings literal with quoted keys). */
const WORKER = `const assistantQuizSettings = {
  "key": "aq_00000000000000000000000000000000:0000000000000000",
  "script": "chatthecadrion",
  "botNames": [
    "Anna"
  ],
  "profileImageUrl": "https://cdn.example/avatar.png",
  "terms": {
    "terms": "Terms",
    "footer": "by using this, you accept",
    "company": "Thecadrion",
    "privacy": "Privacy",
    "termsUrl": "https://thecadrion.com/terms",
    "privacyUrl": "https://thecadrion.com/privacy"
  },
  "theme": {
    "chat-background": "#f4f4f5"
  },
  "config": {
    "disable": false,
    "disableContent": true,
    "quantityResponses": 2,
    "disableTopAndContent": false
  }
};
`;

type World = {
  /** What ActiveView's redirect list answers: the list, or a refusal (403 is never retried). */
  redirects?: "ok" | "forbidden";
  /** CNAMEs per host; a host missing here has none (ENOTFOUND). */
  cnames?: Record<string, string[]>;
  /** Pages per URL: a status (an HTML body) or a body; a URL missing here is an unexpected fetch. */
  pages?: Record<string, number | string>;
};

async function inWorld<T>(w: World, run: (calls: string[]) => Promise<T>): Promise<T> {
  dest._resetAvDestinationCaches();
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://av.test/me") return json(ME);
    if (url === "https://av.test/v1/redirects") return w.redirects === "forbidden" ? json({ message: "route disabled" }, 403) : json(REDIRECTS);
    if (url === "https://av.test/v1/redirects/paths/path1/mappings") return json(MAPPINGS);
    if (url === "https://thecadrion.com/sitemap.xml") return new Response(SITEMAP, { status: 200 });
    const page = w.pages?.[url];
    if (page === undefined) throw new Error(`unexpected fetch ${url}`);
    const res = typeof page === "number" ? new Response("<html><title>Page</title></html>", { status: page }) : new Response(page, { status: 200 });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  const cname = mock.method(dns, "resolveCname", async (host: string) => {
    const a = w.cnames?.[host];
    if (!a) throw Object.assign(new Error(`queryCname ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  });
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
    cname.mock.restore();
  }
}

const CHAT = "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc523";
const CHAT_HOST = { cnames: { "chat.thecadrion.com": [GATEWAY] } };
const CHAT_READY = { ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": WORKER, [CHAT]: 200 } };
const ARTICLE = "https://thecadrion.com/forklift-certification-mobile-app-us-en";

test("a launched chat link resolves as kind chat, tracking params dropped", async () => {
  await inWorld(CHAT_READY, async () => {
    assert.deepEqual(await dest.resolveAvDestination(`${CHAT}&utm_source=facebook&utm_campaign=av015#x`), { ok: true, kind: "chat", base: CHAT, site: "thecadrion.com" });
  });
});

test("the dashboard's path form of a chat address resolves to the same canonical chat", async () => {
  await inWorld(CHAT_READY, async () => {
    assert.deepEqual(await dest.resolveAvDestination("https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/"), { ok: true, kind: "chat", base: CHAT, site: "thecadrion.com" });
  });
});

test("a chat still resolves while ActiveView's redirect list is unavailable", async () => {
  await inWorld({ ...CHAT_READY, redirects: "forbidden" }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(CHAT), { ok: true, kind: "chat", base: CHAT, site: "thecadrion.com" });
  });
});

test("a chat on a host without ads yet is the buyer's fix (400), with the chat's own reason", async () => {
  await inWorld({ ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": WORKER.replace("chatthecadrion", ""), [CHAT]: 200 } }, async () => {
    const r = await dest.resolveAvDestination(CHAT);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
  });
});

test("a chat address on the site itself (not its chat subdomain) is refused like the home page", async () => {
  await inWorld({ pages: { "https://thecadrion.com/?asst=6a2312cef9f4e11b130fc523": 200 } }, async (calls) => {
    const r = await dest.resolveAvDestination("https://thecadrion.com/?asst=6a2312cef9f4e11b130fc523");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_invalid — .*home page/);
    assert.ok(!calls.includes("https://thecadrion.com/?asst=6a2312cef9f4e11b130fc523"), "the home page is never fetched as a destination");
  });
});

test("a subdomain that is neither a redirect domain nor a chat host is refused as not ours", async () => {
  await inWorld({ cnames: { "blog.thecadrion.com": ["some-cdn.example"] } }, async () => {
    const r = await dest.resolveAvDestination("https://blog.thecadrion.com/post");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_not_av — blog\.thecadrion\.com/);
  });
});

test("an unknown subdomain while the redirect list is unavailable is a failed check, not a refusal", async () => {
  await inWorld({ redirects: "forbidden" }, async () => {
    const r = await dest.resolveAvDestination("https://redirect.thecadrion.com/jobs");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — redirect paths unavailable/);
  });
});

test("an article of the site still resolves as kind article", async () => {
  await inWorld({ pages: { [ARTICLE]: 200 } }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(ARTICLE), { ok: true, kind: "article", base: ARTICLE, site: "thecadrion.com" });
  });
});

test("a path of a live redirect domain still resolves as kind redirect, without a chat lookup", async () => {
  await inWorld({}, async () => {
    const lookups = mock.method(dns, "resolveCname", async () => {
      throw new Error("a redirect domain must not be looked up as a chat host");
    });
    try {
      assert.deepEqual(await dest.resolveAvDestination("https://redirect.thecadrion.com/jobs"), {
        ok: true,
        kind: "redirect",
        base: "https://redirect.thecadrion.com/jobs",
        site: "thecadrion.com",
        domainId: "cmue7hk5p000ts60oo7x9557n",
        pathId: "path1",
        mappings: MAPPINGS,
      });
      assert.equal(lookups.mock.callCount(), 0);
    } finally {
      lookups.mock.restore();
    }
  });
});

test("a host that is not ours at all is refused before any page or DNS is touched", async () => {
  await inWorld({ cnames: { "chat.other-site.com": [GATEWAY] } }, async (calls) => {
    const r = await dest.resolveAvDestination("https://chat.other-site.com/?asst=6a2312cef9f4e11b130fc523");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_not_av — chat\.other-site\.com is not an ActiveView site of ours/);
    assert.deepEqual(calls, ["https://av.test/me"]);
  });
});

test("the catalog lists the site's chat host next to its articles and redirect domains", async () => {
  await inWorld({ ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": WORKER } }, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.chats, [{ host: "chat.thecadrion.com", site: "thecadrion.com", live: true }]);
    assert.deepEqual(cat.articles.map((a) => a.url), [ARTICLE]);
    assert.deepEqual(cat.redirects.map((r) => r.domain), ["redirect.thecadrion.com"]);
  });
});

test("a site without a chat host has an empty chat list and the rest of the catalog intact", async () => {
  await inWorld({}, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.chats, []);
    assert.deepEqual(cat.articles.map((a) => a.url), [ARTICLE]);
  });
});
