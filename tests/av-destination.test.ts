// Node's built-in runner (v24 strips types natively): `node --test tests/av-destination.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// AV rail — the destination resolver as a whole: ONE verdict for the three kinds an ad may point at
// (article of an AV site · path of a redirect domain · chat on a Chat Builder subdomain), and the
// catalog the card reads. ActiveView's API, the pages and DNS are the only doubles (all external).
import "./_resolve-hook.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

process.env.AV_API_KEY = "k".repeat(64) + ":" + "s".repeat(20);
process.env.AV_API_BASE = "https://av.test";
delete process.env.AV_CHAT_GATEWAYS;
delete process.env.AV_CHAT_SCRIPT_CDN;
// The redirect domain's liveness is the resolver's own non-production seam (no DNS / HTTPS probe);
// the tests of the probe itself drop it.
const LIVE_SEAM = "redirect.thecadrion.com";
process.env.AV_TEST_LIVE_REDIRECT_DOMAINS = LIVE_SEAM;
const dest = await import("../lib/av-destination.ts");

const GATEWAY = "assistant-quiz-infrastructure-gateway.activeview.app";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const site = (domain: string) => ({ delegation_type: "MANAGE_PARTNER", domain, network_code: "2550370616", parent_network_code: "198073784", site_name: domain });
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
const SCRIPT_URL = "https://scr.actview.net/chatthecadrion.js";

type Page = number | { body: string; type?: string } | { finalUrl: string } | "throw";
type World = {
  /** The sites GET /me names (default: the one site). */
  sites?: string[];
  /** What ActiveView's redirect list answers: the list, or a refusal (403 is never retried). */
  redirects?: "ok" | "forbidden";
  /** CNAMEs per host; a host missing here has none (ENOTFOUND). */
  cnames?: Record<string, string[]>;
  /** Pages per URL: a status, a body, a page whose final URL is elsewhere, or a request that
   *  throws; a URL missing here is an unexpected fetch. */
  pages?: Record<string, Page>;
};

async function inWorld<T>(w: World, run: (calls: string[], dnsCalls: string[]) => Promise<T>): Promise<T> {
  dest._resetAvDestinationCaches();
  const calls: string[] = [];
  const dnsCalls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://av.test/me") return json({ response: { publisher_id: "f845", sites: (w.sites ?? ["thecadrion.com"]).map(site) } });
    if (url === "https://av.test/v1/redirects") return w.redirects === "forbidden" ? json({ message: "route disabled" }, 403) : json(REDIRECTS);
    if (url === "https://av.test/v1/redirects/paths/path1/mappings") return json(MAPPINGS);
    if (url === "https://thecadrion.com/sitemap.xml") return new Response(SITEMAP, { status: 200 });
    if (/\/sitemap\.xml$/.test(url)) return new Response("<urlset></urlset>", { status: 200 });
    const page = w.pages?.[url];
    if (page === undefined) throw new Error(`unexpected fetch ${url}`);
    if (page === "throw") throw new Error("connect ETIMEDOUT");
    const res =
      typeof page === "number"
        ? new Response("<html><title>Page</title></html>", { status: page })
        : "body" in page
          ? new Response(page.body, { status: 200, headers: page.type ? { "content-type": page.type } : {} })
          : new Response("<html><title>Page</title></html>", { status: 200 });
    Object.defineProperty(res, "url", { value: typeof page === "object" && "finalUrl" in page ? page.finalUrl : url });
    return res;
  }) as typeof fetch;
  const cname = mock.method(dns.Resolver.prototype, "resolveCname", async (host: string) => {
    dnsCalls.push(host);
    const a = w.cnames?.[host];
    if (!a) throw Object.assign(new Error(`queryCname ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  });
  try {
    return await run(calls, dnsCalls);
  } finally {
    globalThis.fetch = real;
    cname.mock.restore();
  }
}

const CHAT = "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc523";
const CHAT_HOST = { cnames: { "chat.thecadrion.com": [GATEWAY] } };
const SERVED = { body: "/* ad script */ (()=>{})();", type: "application/javascript" };
const HOST_READY = { "https://chat.thecadrion.com/worker.js": { body: WORKER }, [SCRIPT_URL]: SERVED };
const CHAT_READY = { ...CHAT_HOST, pages: { ...HOST_READY, [CHAT]: 200 } satisfies Record<string, Page> };
const ARTICLE = "https://thecadrion.com/forklift-certification-mobile-app-us-en";
const IS_CHAT = { ok: true, kind: "chat", base: CHAT, site: "thecadrion.com" };

// ---------- chat ----------

test("a launched chat link resolves as kind chat, tracking params dropped", async () => {
  await inWorld(CHAT_READY, async () => {
    assert.deepEqual(await dest.resolveAvDestination(`${CHAT}&utm_source=facebook&utm_campaign=av015#x`), IS_CHAT);
  });
});

test("the dashboard's path form of a chat address resolves to the same canonical chat", async () => {
  await inWorld(CHAT_READY, async () => {
    assert.deepEqual(await dest.resolveAvDestination("https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/"), IS_CHAT);
  });
});

test("a chat still resolves while ActiveView's redirect list is unavailable", async () => {
  await inWorld({ ...CHAT_READY, redirects: "forbidden" }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(CHAT), IS_CHAT);
  });
});

test("a chat on a host without ads yet is the buyer's fix (400), with the chat's own reason", async () => {
  await inWorld({ ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": { body: WORKER.replace("chatthecadrion", "") }, [CHAT]: 200 } }, async () => {
    const r = await dest.resolveAvDestination(CHAT);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
  });
});

test("a chat host whose ad settings cannot be read is a failed check (502)", async () => {
  await inWorld({ ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": 500, [CHAT]: 200 } }, async () => {
    const r = await dest.resolveAvDestination(CHAT);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
  });
});

test("a chat address on the site itself (not its chat subdomain) is refused like the home page", async () => {
  for (const home of ["https://thecadrion.com/?asst=6a2312cef9f4e11b130fc523", "https://www.thecadrion.com/?asst=6a2312cef9f4e11b130fc523"]) {
    await inWorld({ pages: { [home]: 200 } }, async (calls, dnsCalls) => {
      const r = await dest.resolveAvDestination(home);
      assert.equal(r.ok, false, home);
      assert.equal(!r.ok && r.status, 400, home);
      assert.match(!r.ok ? r.error : "", /^destination_invalid — .*home page/, home);
      assert.ok(!calls.includes(home), "the home page is never fetched as a destination");
      assert.deepEqual(dnsCalls, [], home);
    });
  }
});

test("a chat host that ActiveView ALSO lists as a site of its own still goes through the chat's gate, in either list order", async () => {
  for (const sites of [
    ["thecadrion.com", "chat.thecadrion.com"],
    ["chat.thecadrion.com", "thecadrion.com"],
  ]) {
    const pending = { ...CHAT_HOST, sites, pages: { "https://chat.thecadrion.com/worker.js": { body: WORKER.replace("chatthecadrion", "") }, [CHAT]: 200, "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523": 200 } satisfies Record<string, Page> };
    for (const raw of [CHAT, "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/"]) {
      await inWorld(pending, async () => {
        const r = await dest.resolveAvDestination(raw);
        assert.equal(r.ok, false, `${sites.join(",")} ${raw}`);
        assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /, `${sites.join(",")} ${raw}`);
      });
    }
    await inWorld({ ...CHAT_READY, sites }, async () => {
      assert.deepEqual(await dest.resolveAvDestination(CHAT), IS_CHAT, sites.join(","));
    });
  }
});

test("a subdomain that is a site of its own and no chat host keeps its articles", async () => {
  const article = "https://blog.thecadrion.com/some-post";
  await inWorld({ sites: ["thecadrion.com", "blog.thecadrion.com"], cnames: { "blog.thecadrion.com": ["some-cdn.example"] }, pages: { [article]: 200 } }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(article), { ok: true, kind: "article", base: article, site: "blog.thecadrion.com" });
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

test("a host that is not ours at all — a look-alike included — is refused before any page or DNS is touched", async () => {
  for (const host of ["chat.other-site.com", "chat.notthecadrion.com", "notthecadrion.com"]) {
    await inWorld({ cnames: { [host]: [GATEWAY] } }, async (calls, dnsCalls) => {
      const r = await dest.resolveAvDestination(`https://${host}/?asst=6a2312cef9f4e11b130fc523`);
      assert.equal(r.ok, false, host);
      assert.equal(!r.ok && r.status, 400, host);
      assert.match(!r.ok ? r.error : "", /^destination_not_av — .* is not an ActiveView site of ours/, host);
      assert.deepEqual(calls, ["https://av.test/me"], host);
      assert.deepEqual(dnsCalls, [], host);
    });
  }
});

// ---------- article (must not change) ----------

test("an article of the site resolves as kind article", async () => {
  await inWorld({ pages: { [ARTICLE]: 200 } }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(ARTICLE), { ok: true, kind: "article", base: ARTICLE, site: "thecadrion.com" });
  });
});

test("an article on www.<site> resolves as kind article, without a chat lookup", async () => {
  const www = "https://www.thecadrion.com/forklift-certification-mobile-app-us-en";
  await inWorld({ cnames: { "www.thecadrion.com": [GATEWAY] }, pages: { [www]: 200 } }, async (_calls, dnsCalls) => {
    assert.deepEqual(await dest.resolveAvDestination(www), { ok: true, kind: "article", base: www, site: "thecadrion.com" });
    assert.deepEqual(dnsCalls, []);
  });
});

test("an article that answers 404 is refused as not live (400)", async () => {
  const gone = "https://thecadrion.com/renamed-article";
  await inWorld({ pages: { [gone]: 404 } }, async () => {
    const r = await dest.resolveAvDestination(gone);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_not_live — https:\/\/thecadrion\.com\/renamed-article answered 404/);
  });
});

test("an article that redirects off the site — to a look-alike domain too — is refused (400)", async () => {
  for (const elsewhere of ["https://elsewhere.example/landing", "https://notthecadrion.com/landing"]) {
    await inWorld({ pages: { [ARTICLE]: { finalUrl: elsewhere } } }, async () => {
      const r = await dest.resolveAvDestination(ARTICLE);
      assert.equal(r.ok, false, elsewhere);
      assert.equal(!r.ok && r.status, 400, elsewhere);
      assert.match(!r.ok ? r.error : "", new RegExp(`^destination_invalid — .*${new URL(elsewhere).hostname.replace(/\./g, "\\.")}`), elsewhere);
    });
  }
});

test("an article that does not answer is a failed check (502), and is asked again next time", async () => {
  await inWorld({ pages: { [ARTICLE]: "throw" } }, async () => {
    const r = await dest.resolveAvDestination(ARTICLE);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
  });
  const again: string[] = [];
  const real = globalThis.fetch;
  const cname = mock.method(dns.Resolver.prototype, "resolveCname", async () => []);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    again.push(url);
    if (url === "https://av.test/me") return json({ response: { publisher_id: "f845", sites: [site("thecadrion.com")] } });
    if (url === "https://av.test/v1/redirects") return json(REDIRECTS);
    if (url === "https://av.test/v1/redirects/paths/path1/mappings") return json(MAPPINGS);
    const res = new Response("<html></html>", { status: 200 });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  try {
    assert.deepEqual(await dest.resolveAvDestination(ARTICLE), { ok: true, kind: "article", base: ARTICLE, site: "thecadrion.com" });
    assert.ok(again.includes(ARTICLE), "the failure was not remembered as a verdict");
  } finally {
    globalThis.fetch = real;
    cname.mock.restore();
  }
});

// ---------- redirect (must not change) ----------

test("a path of a live redirect domain resolves as kind redirect, without a chat lookup", async () => {
  await inWorld({ cnames: { "redirect.thecadrion.com": [GATEWAY] } }, async (_calls, dnsCalls) => {
    assert.deepEqual(await dest.resolveAvDestination("https://redirect.thecadrion.com/jobs"), {
      ok: true,
      kind: "redirect",
      base: "https://redirect.thecadrion.com/jobs",
      site: "thecadrion.com",
      domainId: "cmue7hk5p000ts60oo7x9557n",
      pathId: "path1",
      mappings: MAPPINGS,
    });
    assert.deepEqual(dnsCalls, [], "a redirect domain is never looked up as a chat host");
  });
});

test("a path the redirect domain does not have is refused (400)", async () => {
  await inWorld({}, async () => {
    const r = await dest.resolveAvDestination("https://redirect.thecadrion.com/no-such-path");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^redirect_path_unknown — \/no-such-path/);
  });
});

test("a redirect domain that is not live is refused (400): it does not resolve / does not answer", async () => {
  for (const mode of ["no-dns", "no-https"] as const) {
    delete process.env.AV_TEST_LIVE_REDIRECT_DOMAINS;
    // lib/av-destination imports `lookup` by NAME: the builtin's ESM exports are re-synced.
    const lookup = mock.method(dns, "lookup", async () => {
      if (mode === "no-dns") throw Object.assign(new Error("getaddrinfo ENOTFOUND redirect.thecadrion.com"), { code: "ENOTFOUND" });
      return { address: "203.0.113.7", family: 4 };
    });
    syncBuiltinESMExports();
    try {
      await inWorld({ pages: { "https://redirect.thecadrion.com/": "throw" } }, async (calls) => {
        const r = await dest.resolveAvDestination("https://redirect.thecadrion.com/jobs");
        assert.equal(r.ok, false, mode);
        assert.equal(!r.ok && r.status, 400, mode);
        assert.match(!r.ok ? r.error : "", mode === "no-dns" ? /^redirect_not_live — redirect\.thecadrion\.com does not resolve yet/ : /^redirect_not_live — redirect\.thecadrion\.com resolves but does not answer/, mode);
        assert.equal(lookup.mock.callCount(), 1, mode);
        assert.equal(calls.includes("https://redirect.thecadrion.com/"), mode === "no-https", mode);
      });
    } finally {
      lookup.mock.restore();
      syncBuiltinESMExports();
      process.env.AV_TEST_LIVE_REDIRECT_DOMAINS = LIVE_SEAM;
    }
  }
});

// ---------- the catalog ----------

test("the catalog lists the site's chat host next to its articles and redirect domains", async () => {
  await inWorld({ ...CHAT_HOST, pages: HOST_READY }, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.chats, [{ host: "chat.thecadrion.com", site: "thecadrion.com", live: true }]);
    assert.deepEqual(cat.articles.map((a) => a.url), [ARTICLE]);
    assert.deepEqual(cat.redirects.map((r) => r.domain), ["redirect.thecadrion.com"]);
  });
});

test("a chat host that is not ready rides the catalog with its reason — the articles and redirects are intact", async () => {
  await inWorld({ ...CHAT_HOST, pages: { "https://chat.thecadrion.com/worker.js": { body: WORKER.replace("chatthecadrion", "") } } }, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.equal(cat.chats.length, 1);
    assert.equal(cat.chats[0].live, false);
    assert.match(cat.chats[0].liveReason ?? "", /^chat_not_monetized — /);
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

test("a site's chat subdomain that ActiveView lists as a site is not probed as chat.chat.<site>", async () => {
  await inWorld({ ...CHAT_HOST, sites: ["thecadrion.com", "chat.thecadrion.com"], pages: HOST_READY }, async (_calls, dnsCalls) => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.chats, [{ host: "chat.thecadrion.com", site: "thecadrion.com", live: true }]);
    assert.ok(!dnsCalls.includes("chat.chat.thecadrion.com"));
  });
});
