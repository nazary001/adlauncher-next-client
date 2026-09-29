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

function validateSettings(settings) {
  const requiredFields = ["key", "terms", "theme", "config", "botNames"];
  return requiredFields.filter((field) => !settings[field]).length === 0;
}

function loadRemoteScript({ disable, fileName, baseUrl = "https://scr.actview.net" }) {
  if (disable || fileName === "") return Promise.resolve();
  const script = document.createElement("script");
  script.src = \`\${baseUrl}/\${fileName.trim()}.js\`;
  document.head.appendChild(script);
}

async function initializeAssistant() {
  if (!validateSettings(assistantQuizSettings)) throw new Error("Invalid assistantQuizSettings configuration");
  await loadRemoteScript({
    disable: Boolean(assistantQuizSettings?.config?.disable),
    fileName: assistantQuizSettings.script,
  });
}

initializeAssistant();
`;
const WORKER_URL = "https://chat.thecadrion.com/worker.js";
const SCRIPT_URL = "https://scr.actview.net/chatthecadrion.js";

type Page = number | { body: string; type?: string } | { finalUrl: string } | "throw" | "hang";
type World = {
  /** The sites GET /me names (default: the one site). */
  sites?: string[];
  /** What ActiveView's redirect list answers: the list, or a refusal (403 is never retried). */
  redirects?: "ok" | "forbidden";
  /** The redirect domain the list names (default: redirect.thecadrion.com). */
  redirectDomain?: string;
  /** Where the one redirect path (/jobs) sends its visitors (default: 100% to the article). */
  mappings?: { url: string; percentage: number | string | null }[];
  /** How many reads of those targets ActiveView refuses before it answers (403 is never retried). */
  mappingsFail?: number;
  /** CNAMEs per host, or "down" (neither the resolver nor DNS-over-HTTPS can be asked); a host
   *  missing here has none (ENOTFOUND). */
  cnames?: Record<string, string[] | "down">;
  /** Pages per URL: a status, a body, a page whose final URL is elsewhere, a request that throws or
   *  one that never answers; a URL missing here is an unexpected fetch. */
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
    if (url === "https://av.test/v1/redirects") {
      if (w.redirects === "forbidden") return json({ message: "route disabled" }, 403);
      return json(w.redirectDomain ? { redirectDomains: [{ ...REDIRECTS.redirectDomains[0], name: w.redirectDomain }] } : REDIRECTS);
    }
    if (url === "https://av.test/v1/redirects/paths/path1/mappings") {
      if (w.mappingsFail && w.mappingsFail > 0) {
        w.mappingsFail -= 1;
        return json({ message: "route disabled" }, 403);
      }
      return json(w.mappings ?? MAPPINGS);
    }
    if (url === "https://thecadrion.com/sitemap.xml") return new Response(SITEMAP, { status: 200 });
    if (/\/sitemap\.xml$/.test(url)) return new Response("<urlset></urlset>", { status: 200 });
    const page = w.pages?.[url];
    if (page === undefined) throw new Error(`unexpected fetch ${url}`);
    if (page === "throw") throw new Error("connect ETIMEDOUT");
    if (page === "hang") return new Promise<Response>(() => {});
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
    // "down": the resolver times out, and DNS-over-HTTPS (not among the pages) cannot be asked either
    if (a === "down") throw Object.assign(new Error(`queryCname ETIMEOUT ${host}`), { code: "ETIMEOUT" });
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
const HOST_READY = { [WORKER_URL]: { body: WORKER }, [SCRIPT_URL]: SERVED };
/** The same host before ActiveView assigned its ad script ("Pending monetization"). */
const HOST_PENDING = { [WORKER_URL]: { body: WORKER.replace("chatthecadrion", "") } };
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

test("a chat's address on a listed chat host never becomes an ARTICLE when its CNAME cannot be seen (a proxied record)", async () => {
  // The host is a site of its own in GET /me and its CNAME is hidden: the chat check says "not a
  // chat host". An address that names a chat id is still no article — the dashboard's path form
  // would otherwise reach an ad past the chat's gate.
  const sites = ["thecadrion.com", "chat.thecadrion.com"];
  const path = "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523";
  for (const raw of [`${path}/`, CHAT]) {
    await inWorld({ sites, pages: { [path]: 200, [CHAT]: 200 } }, async (calls) => {
      const r = await dest.resolveAvDestination(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(!r.ok && r.status, 400, raw);
      assert.match(!r.ok ? r.error : "", /^destination_not_av — chat\.thecadrion\.com .*chat gateway/, raw);
      assert.ok(!calls.includes(path) && !calls.includes(CHAT), "the address is never fetched as an article");
    });
  }
});

test("an article that redirects to a chat is refused: a chat is launched as a chat, through its own gate", async () => {
  for (const chatUrl of [CHAT, "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/"]) {
    await inWorld({ ...CHAT_HOST, pages: { [ARTICLE]: { finalUrl: chatUrl } } }, async () => {
      const r = await dest.resolveAvDestination(ARTICLE);
      assert.equal(r.ok, false, chatUrl);
      assert.equal(!r.ok && r.status, 400, chatUrl);
      assert.match(!r.ok ? r.error : "", /^destination_invalid — .*redirects to a chat/, chatUrl);
    });
  }
});

test("an article that redirects to another page of its own site — or of a subdomain of it — still resolves", async () => {
  for (const finalUrl of ["https://thecadrion.com/forklift-certification-mobile-app-us-en-2", "https://www.thecadrion.com/forklift-certification-mobile-app-us-en", "https://m.thecadrion.com/forklift-certification-mobile-app-us-en"]) {
    await inWorld({ pages: { [ARTICLE]: { finalUrl } } }, async () => {
      assert.deepEqual(await dest.resolveAvDestination(ARTICLE), { ok: true, kind: "article", base: ARTICLE, site: "thecadrion.com" }, finalUrl);
    });
  }
});

test("a redirect domain belongs to the NEAREST site it is a subdomain of — a subdomain site keeps its own redirect domain", async () => {
  await inWorld({ sites: ["thecadrion.com", "blog.thecadrion.com"], redirectDomain: "redirect.blog.thecadrion.com" }, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.redirects.map((r) => [r.domain, r.site]), [["redirect.blog.thecadrion.com", "blog.thecadrion.com"]]);
  });
  await inWorld({ sites: ["blog.thecadrion.com", "thecadrion.com"] }, async () => {
    const cat = await dest.avDestinationCatalog({ titles: false });
    assert.deepEqual(cat.redirects.map((r) => [r.domain, r.site]), [["redirect.thecadrion.com", "thecadrion.com"]]);
  });
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

test("the chat probe runs ALONGSIDE the rest of the catalog, not before it", async () => {
  await inWorld({ ...CHAT_HOST, pages: HOST_READY }, async (calls) => {
    await dest.avDestinationCatalog({ titles: false });
    const at = (u: string) => calls.indexOf(u);
    assert.ok(at(SCRIPT_URL) >= 0, "the probe ran");
    assert.ok(at("https://thecadrion.com/sitemap.xml") < at(SCRIPT_URL), `the sitemap was asked for while the probe was still running: ${calls.join(" > ")}`);
  });
});

test("the card's Retry re-reads the chat host too", async () => {
  await inWorld({ ...CHAT_HOST, pages: HOST_PENDING }, async (calls) => {
    await dest.avDestinationCatalog({ titles: false });
    await dest.avDestinationCatalog({ titles: false });
    assert.equal(calls.filter((u) => u === WORKER_URL).length, 1, "a card load inside the hint's minute does not re-read the host");
    const cat = await dest.avDestinationCatalog({ titles: false, force: true });
    assert.equal(calls.filter((u) => u === WORKER_URL).length, 2, "Retry does");
    assert.equal(cat.chats[0]?.live, false);
  });
});

test("a chat host that does not answer does not hold the catalog back: after 2.5 s it is listed as still being checked", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await inWorld({ ...CHAT_HOST, pages: { [WORKER_URL]: "hang" } }, async () => {
      let done = false;
      const pending = dest.avDestinationCatalog({ titles: false }).then((cat) => {
        done = true;
        return cat;
      });
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
      assert.equal(done, false, "inside the budget the catalog waits for the probe");
      mock.timers.tick(2_499);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(done, false);
      mock.timers.tick(1);
      const cat = await pending;
      assert.deepEqual(cat.articles.map((a) => a.url), [ARTICLE]);
      assert.deepEqual(cat.redirects.map((r) => r.domain), ["redirect.thecadrion.com"]);
      assert.deepEqual(cat.chats.map((c) => [c.host, c.site, c.live]), [["chat.thecadrion.com", "thecadrion.com", false]]);
      assert.match(cat.chats[0].liveReason ?? "", /^destination_check_failed — chat\.thecadrion\.com is still being checked/);
    });
  } finally {
    mock.timers.reset();
  }
});

test("a chat probe that answers inside its budget is what the catalog shows — the budget changes nothing then", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await inWorld({ ...CHAT_HOST, pages: HOST_READY }, async () => {
      const cat = await dest.avDestinationCatalog({ titles: false });
      assert.deepEqual(cat.chats, [{ host: "chat.thecadrion.com", site: "thecadrion.com", live: true }]);
    });
  } finally {
    mock.timers.reset();
  }
});

// ---------- the chat's gate cannot be walked around ----------

const CHAT_PATH_FORM = "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523";
const BOTH_ORDERS = (a: string, b: string) => [
  [a, b],
  [b, a],
];

test("a page of a chat host that ActiveView also lists as a site is no article: only a chat's address is a destination there", async () => {
  const page = "https://chat.thecadrion.com/some-page";
  for (const sites of BOTH_ORDERS("thecadrion.com", "chat.thecadrion.com")) {
    await inWorld({ ...CHAT_HOST, sites, pages: { ...HOST_READY, [page]: 200 } }, async (calls) => {
      const r = await dest.resolveAvDestination(page);
      assert.equal(r.ok, false, sites.join(","));
      assert.equal(!r.ok && r.status, 400, sites.join(","));
      assert.match(!r.ok ? r.error : "", /^chat_url_invalid — /, sites.join(","));
      assert.ok(!calls.includes(page), "the page is never fetched as an article");
    });
  }
});

test("a chat's own refusal is said even while ActiveView's redirect list is unavailable", async () => {
  await inWorld({ ...CHAT_HOST, redirects: "forbidden", pages: { ...HOST_PENDING, [CHAT]: 200 } }, async () => {
    const r = await dest.resolveAvDestination(CHAT);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
  });
});

test("an article of a subdomain site resolves while DNS cannot be asked — only an address that names a chat waits for DNS", async () => {
  const article = "https://blog.thecadrion.com/some-post";
  const named = "https://blog.thecadrion.com/6a2312cef9f4e11b130fc523";
  for (const sites of BOTH_ORDERS("thecadrion.com", "blog.thecadrion.com")) {
    const world: World = { sites, cnames: { "blog.thecadrion.com": "down" }, pages: { [article]: 200, [named]: 200 } };
    await inWorld(world, async () => {
      assert.deepEqual(await dest.resolveAvDestination(article), { ok: true, kind: "article", base: article, site: "blog.thecadrion.com" }, sites.join(","));
    });
    await inWorld(world, async (calls) => {
      const r = await dest.resolveAvDestination(named);
      assert.equal(r.ok, false, sites.join(","));
      assert.equal(!r.ok && r.status, 502, sites.join(","));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the DNS lookup of blog\.thecadrion\.com failed/, sites.join(","));
      assert.ok(!calls.includes(named), "never fetched as an article");
    });
  }
});

test("a chat's address on a site with NO listed parent is refused: its host cannot be checked as a chat subdomain", async () => {
  // ActiveView listing a chat host alone is a guess about GET /me — pinned so that it stays closed:
  // the dashboard's path form would otherwise resolve as an ARTICLE, past every check of the chat.
  for (const raw of [CHAT_PATH_FORM, `${CHAT_PATH_FORM}/`, "https://thecadrion.com/6a2312cef9f4e11b130fc523", "https://www.thecadrion.com/6a2312cef9f4e11b130fc523/"]) {
    const sites = raw.includes("//chat.") ? ["chat.thecadrion.com"] : ["thecadrion.com"];
    await inWorld({ ...CHAT_HOST, sites, redirectDomain: "redirect.elsewhere.example", pages: { ...HOST_READY, [CHAT]: 200 } }, async (calls, dnsCalls) => {
      const r = await dest.resolveAvDestination(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(!r.ok && r.status, 400, raw);
      assert.match(!r.ok ? r.error : "", /^destination_invalid — .* is a chat's address/, raw);
      assert.deepEqual(calls.filter((u) => !u.startsWith("https://av.test/")), [], "nothing of the host is fetched");
      assert.deepEqual(dnsCalls, [], raw);
    });
  }
});

test("an article that redirects to a page of its OWN host is an article, whatever that page is called", async () => {
  await inWorld({ pages: { [ARTICLE]: { finalUrl: "https://thecadrion.com/6a2312cef9f4e11b130fc523" } } }, async () => {
    assert.deepEqual(await dest.resolveAvDestination(ARTICLE), { ok: true, kind: "article", base: ARTICLE, site: "thecadrion.com" });
  });
});

// ---------- a host under two listed sites ----------

test("a redirect domain under TWO listed sites belongs to the nearest one — in the catalog and in the launch's verdict, in either order of GET /me", async () => {
  process.env.AV_TEST_LIVE_REDIRECT_DOMAINS = "redirect.blog.thecadrion.com";
  try {
    for (const sites of BOTH_ORDERS("thecadrion.com", "blog.thecadrion.com")) {
      await inWorld({ sites, redirectDomain: "redirect.blog.thecadrion.com" }, async () => {
        const cat = await dest.avDestinationCatalog({ titles: false });
        assert.deepEqual(cat.redirects.map((r) => [r.domain, r.site]), [["redirect.blog.thecadrion.com", "blog.thecadrion.com"]], sites.join(","));
        const r = await dest.resolveAvDestination("https://redirect.blog.thecadrion.com/jobs");
        assert.equal(r.ok && r.kind, "redirect", sites.join(","));
        assert.equal(r.ok && r.site, "blog.thecadrion.com", sites.join(","));
      });
    }
  } finally {
    process.env.AV_TEST_LIVE_REDIRECT_DOMAINS = LIVE_SEAM;
  }
});

test("a chat under TWO listed sites goes through the chat's gate and is reported for the ROOT site, in either order of GET /me", async () => {
  const host = "chat.blog.thecadrion.com";
  const base = `https://${host}/?asst=6a2312cef9f4e11b130fc523`;
  for (const sites of BOTH_ORDERS("thecadrion.com", "blog.thecadrion.com")) {
    await inWorld({ sites, cnames: { [host]: [GATEWAY] }, pages: { [`https://${host}/worker.js`]: { body: WORKER }, [SCRIPT_URL]: SERVED, [base]: 200 } }, async () => {
      assert.deepEqual(await dest.resolveAvDestination(base), { ok: true, kind: "chat", base, site: "thecadrion.com" }, sites.join(","));
    });
    await inWorld({ sites, cnames: { [host]: [GATEWAY] }, pages: { [`https://${host}/worker.js`]: { body: WORKER.replace("chatthecadrion", "") }, [base]: 200 } }, async () => {
      const r = await dest.resolveAvDestination(base);
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /, sites.join(","));
    });
  }
});

// ---------- a redirect path that sends visitors to a chat ----------

const JOBS = "https://redirect.thecadrion.com/jobs";
/** /jobs split between the article and a chat. */
const toChat = (percentage: number, url = CHAT) => [
  { url: ARTICLE, percentage: 100 - percentage },
  { url, percentage },
];

test("a redirect path that sends visitors to a chat WITHOUT ads is refused with the chat's reason — a redirect is no way around the chat's gate", async () => {
  for (const target of [CHAT, `${CHAT_PATH_FORM}/`, `${CHAT}&utm_source=x`]) {
    await inWorld({ ...CHAT_HOST, mappings: toChat(40, target), pages: { ...HOST_PENDING, [CHAT]: 200 } }, async () => {
      const r = await dest.resolveAvDestination(JOBS);
      assert.equal(r.ok, false, target);
      assert.equal(!r.ok && r.status, 400, target);
      assert.match(
        !r.ok ? r.error : "",
        /^redirect_target_not_ready — redirect\.thecadrion\.com\/jobs sends 40% of its visitors to the chat https:\/\/chat\.thecadrion\.com\/\?asst=6a2312cef9f4e11b130fc523: chat_not_monetized — /,
        target,
      );
    });
  }
});

test("a redirect path that sends visitors to a chat that shows ads resolves, its targets as ActiveView lists them", async () => {
  await inWorld({ ...CHAT_READY, mappings: toChat(40) }, async () => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.equal(r.ok && r.kind, "redirect");
    assert.deepEqual(r.ok && r.kind === "redirect" && r.mappings, toChat(40));
  });
});

test("a chat target that gets no visitors (weight 0), or whose host is none of ours, is not the launch's business", async () => {
  await inWorld({ ...CHAT_HOST, mappings: toChat(0), pages: HOST_PENDING }, async (calls, dnsCalls) => {
    assert.equal((await dest.resolveAvDestination(JOBS)).ok, true);
    assert.deepEqual(dnsCalls, []);
    assert.ok(!calls.includes(WORKER_URL));
  });
  for (const foreign of ["https://chat.other-site.com/?asst=6a2312cef9f4e11b130fc523", "https://chat.notthecadrion.com/6a2312cef9f4e11b130fc523"]) {
    await inWorld({ cnames: { [new URL(foreign).hostname]: [GATEWAY] }, mappings: toChat(50, foreign) }, async (_calls, dnsCalls) => {
      assert.equal((await dest.resolveAvDestination(JOBS)).ok, true, foreign);
      assert.deepEqual(dnsCalls, [], foreign);
    });
  }
});

test("a chat target whose host could not be checked is a failed check (502), not a launch", async () => {
  await inWorld({ cnames: { "chat.thecadrion.com": "down" }, mappings: toChat(40) }, async () => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^redirect_target_not_ready — .*: destination_check_failed — the DNS lookup of chat\.thecadrion\.com failed/);
  });
});

test("a target on a subdomain of ours that is no chat host does not stop the path, whatever its page is called", async () => {
  await inWorld({ cnames: { "pages.thecadrion.com": ["some-cdn.example"] }, mappings: toChat(40, "https://pages.thecadrion.com/6a2312cef9f4e11b130fc523") }, async (_calls, dnsCalls) => {
    assert.equal((await dest.resolveAvDestination(JOBS)).ok, true);
    assert.deepEqual(dnsCalls, ["pages.thecadrion.com"]);
  });
});

// ---------- what a redirect path sends to a chat, when it cannot be read or weighed ----------

test("a redirect path whose targets could not be read is not launched: a chat among them cannot be ruled out", async () => {
  await inWorld({ ...CHAT_HOST, mappingsFail: 2 }, async (calls) => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — the targets of redirect\.thecadrion\.com\/jobs could not be read \(.*\): a chat among them cannot be ruled out/);
    assert.equal(calls.filter((u) => u.endsWith("/mappings")).length, 2, "the targets were asked for once more before giving up");
  });
  await inWorld({ ...CHAT_READY, mappingsFail: 1, mappings: toChat(40) }, async () => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.equal(r.ok && r.kind, "redirect", "read on the second try — and its chat is ready");
    assert.deepEqual(r.ok && r.kind === "redirect" && r.mappings, toChat(40));
  });
  await inWorld({ ...CHAT_HOST, mappingsFail: 1, mappings: toChat(40), pages: { ...HOST_PENDING, [CHAT]: 200 } }, async () => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.match(!r.ok ? r.error : "", /^redirect_target_not_ready — .*chat_not_monetized — /, "read on the second try — and its chat is refused");
  });
});

test("a chat target whose weight could not be read is checked as one that gets visitors", async () => {
  for (const percentage of ["40%", null, "abc"]) {
    await inWorld({ ...CHAT_HOST, mappings: [{ url: ARTICLE, percentage: 60 }, { url: CHAT, percentage }], pages: { ...HOST_PENDING, [CHAT]: 200 } }, async () => {
      const r = await dest.resolveAvDestination(JOBS);
      assert.equal(r.ok, false, String(percentage));
      assert.match(!r.ok ? r.error : "", /^redirect_target_not_ready — .*chat_not_monetized — /, String(percentage));
    });
  }
});

test("a chat target on a site ActiveView lists without its parent is refused, as the chat itself would be", async () => {
  const other = "https://chat.other-site.com/?asst=6a2312cef9f4e11b130fc523";
  await inWorld({ sites: ["thecadrion.com", "chat.other-site.com"], mappings: toChat(30, other) }, async (calls, dnsCalls) => {
    const r = await dest.resolveAvDestination(JOBS);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^redirect_target_not_ready — .*sends 30% of its visitors to the chat https:\/\/chat\.other-site\.com\/\?asst=.*: destination_invalid — .* is a chat's address/);
    assert.deepEqual(dnsCalls, []);
    assert.ok(!calls.some((u) => u.startsWith("https://chat.other-site.com/")), "nothing of it is fetched");
  });
});

test("the chat targets of a redirect path are checked side by side, and within 25 s", async () => {
  const second = "https://talk.thecadrion.com/?asst=6a2312cef9f4e11b130fc523";
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await inWorld(
      {
        cnames: { "chat.thecadrion.com": [GATEWAY], "talk.thecadrion.com": [GATEWAY] },
        mappings: [{ url: CHAT, percentage: 50 }, { url: second, percentage: 50 }],
        pages: { [WORKER_URL]: "hang", "https://talk.thecadrion.com/worker.js": "hang" },
      },
      async (calls) => {
        let answer: Awaited<ReturnType<typeof dest.resolveAvDestination>> | null = null;
        const pending = dest.resolveAvDestination(JOBS).then((r) => (answer = r));
        for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
        assert.ok(calls.includes(WORKER_URL) && calls.includes("https://talk.thecadrion.com/worker.js"), "both hosts are read at once");
        mock.timers.tick(24_999);
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        assert.equal(answer, null);
        mock.timers.tick(1);
        const r = await pending;
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.status, 502);
        assert.match(!r.ok ? r.error : "", /^destination_check_failed — the chat targets of redirect\.thecadrion\.com\/jobs could not all be checked in 25 s/);
      },
    );
  } finally {
    mock.timers.reset();
  }
});

// ---------- a DNS check that could not be made never opens the article branch on a chat host ----------

test("a page of the site's own chat host is never an ARTICLE on a DNS check that could not be made", async () => {
  // ActiveView lists the chat host as a site of its own; DNS cannot be asked: its CNAME cannot be seen.
  const page = "https://chat.thecadrion.com/start";
  for (const sites of BOTH_ORDERS("thecadrion.com", "chat.thecadrion.com")) {
    await inWorld({ sites, cnames: { "chat.thecadrion.com": "down" }, pages: { [page]: 200 } }, async (calls) => {
      const r = await dest.resolveAvDestination(page);
      assert.equal(r.ok, false, sites.join(","));
      assert.equal(!r.ok && r.status, 502, sites.join(","));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the DNS lookup of chat\.thecadrion\.com failed/, sites.join(","));
      assert.ok(!calls.includes(page), "never fetched as an article");
    });
  }
});

test("a listed host once seen behind AV's chat gateway stays a chat host for its pages, also when DNS cannot be asked later", async () => {
  const host = "talk.thecadrion.com";
  const base = `https://${host}/?asst=6a2312cef9f4e11b130fc523`;
  const page = `https://${host}/start`;
  const cnames: Record<string, string[] | "down"> = { [host]: [GATEWAY] };
  const world: World = { sites: ["thecadrion.com", host], cnames, pages: { [`https://${host}/worker.js`]: { body: WORKER }, [SCRIPT_URL]: SERVED, [base]: 200, [page]: 200 } };
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-29T10:00:00Z") });
  try {
    await inWorld(world, async (calls) => {
      assert.equal((await dest.resolveAvDestination(base)).ok, true, "seen behind the gateway");
      cnames[host] = "down";
      mock.timers.tick(6 * 60_000); // past the CNAME verdict's 5 minutes
      const r = await dest.resolveAvDestination(page);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 502);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the DNS lookup of talk\.thecadrion\.com failed/);
      assert.ok(!calls.includes(page), "never fetched as an article");
    });
  } finally {
    mock.timers.reset();
  }
});

// ---------- the catalog hands on a probe that is still running ----------

test("a chat probe that loses the catalog's race is listed as pending, and handed on to finish after the answer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await inWorld({ ...CHAT_HOST, pages: { [WORKER_URL]: "hang" } }, async () => {
      const handed: Promise<unknown>[] = [];
      const pending = dest.avDestinationCatalog({ titles: false, onPending: (p) => handed.push(p) });
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
      mock.timers.tick(2_500);
      const cat = await pending;
      assert.deepEqual(cat.chats.map((c) => [c.host, c.live, c.pending]), [["chat.thecadrion.com", false, true]]);
      assert.equal(handed.length, 1, "the probe still running is handed on (the route keeps it alive)");
    });
    await inWorld({ ...CHAT_HOST, pages: HOST_READY }, async () => {
      const handed: Promise<unknown>[] = [];
      const cat = await dest.avDestinationCatalog({ titles: false, onPending: (p) => handed.push(p) });
      assert.deepEqual(cat.chats, [{ host: "chat.thecadrion.com", site: "thecadrion.com", live: true }]);
      assert.equal(handed.length, 0, "a probe that answered in time is not");
    });
  } finally {
    mock.timers.reset();
  }
});
