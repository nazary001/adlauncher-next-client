// Node's built-in runner (v24 strips types natively): `node --test tests/av-chat.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// AV rail — the CHAT destination (ActiveView → Chat Builder): a chat lives on a subdomain of an AV
// site whose CNAME points at AV's chat gateway (chat.thecadrion.com →
// assistant-quiz-infrastructure-gateway.activeview.app, live 29.09). The external API lists no chats,
// so the host is recognized by that CNAME, and the launch is refused unless the host SHOWS ADS: its
// public /worker.js names the ad script AV assigns after its review (empty = "Pending monetization",
// traffic would earn nothing). DNS and the two GETs are the only doubles (all external).
import "./_resolve-hook.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

const chat = await import("../lib/av-chat.ts");

const GATEWAY = "assistant-quiz-infrastructure-gateway.activeview.app";
const HOST = "chat.thecadrion.com";
const ID = "6a2312cef9f4e11b130fc523";
/** The canonical chat address: the id rides the query (the form every AV chat host answers). */
const BASE = `https://${HOST}/?asst=${ID}`;
const WORKER_URL = `https://${HOST}/worker.js`;
/** What lib/av-destination hands over: lib/av-link's shape of the stored URL. */
const SHAPE = { base: BASE, host: HOST, path: "/" };

/** The gateway's own answer for a host it has no route for (read live 29.09, chat.thecadrion.com
 *  before the Chat Builder activation was finished). */
const NO_ROUTE = '{\n  "message":"no Route matched with those values",\n  "request_id":"e3472a6a44d7bb6634c54158b1ac6d13"\n}';

/** A chat host's /worker.js as AV serves it (read live 29.09 on other publishers' chat hosts): the
 *  settings are a JSON-style literal with QUOTED keys, followed by the loader code — which itself
 *  mentions `script` and `disable`, so only the settings literal may be read. */
const worker = (script: string, disable = false) => `const assistantQuizSettings = {
  "key": "aq_00000000000000000000000000000000:0000000000000000",
  "script": "${script}",
  "botNames": [
    "Anna",
    "Sophia"
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
    "chat-text": "rgb(42, 44, 44)",
    "chat-background": "#f4f4f5"
  },
  "config": {
    "disable": ${disable},
    "disableContent": true,
    "quantityResponses": 2,
    "disableTopAndContent": false
  }
};

function loadRemoteScript({ disable, fileName, baseUrl = "https://scr.actview.net" }) {
  if (disable || fileName === "") {
    console.log("[AV Assistant] Remote script loading is disabled");
    return Promise.resolve();
  }
  const script = document.createElement("script");
  script.src = \`\${baseUrl}/\${fileName.trim()}.js\`;
  document.head.appendChild(script);
}

loadRemoteScript({ disable: Boolean(assistantQuizSettings?.config?.disable), fileName: assistantQuizSettings.script });
`;

const dnsError = (code: string) => Object.assign(new Error(`queryCname ${code}`), { code });

/** Replace dns.resolveCname for one test; `answers` maps a host to its CNAMEs or an error code. */
function stubCname(answers: Record<string, string[] | string>) {
  const calls: string[] = [];
  const m = mock.method(dns, "resolveCname", async (host: string) => {
    calls.push(host);
    const a = answers[host];
    if (a === undefined) throw dnsError("ENOTFOUND");
    if (typeof a === "string") throw dnsError(a);
    return a;
  });
  return { calls, restore: () => m.mock.restore() };
}

type Page = { status: number; finalUrl?: string; body?: string } | "throw" | "tls";

/** What fetch throws for a host still behind the gateway's default certificate (read live 29.09:
 *  chat.thecadrion.com served Kong's self-signed CN=localhost before its activation). */
const tlsError = () =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });

/** Replace fetch for one test; `pages` maps a URL to its answer (+ the URL fetch finally landed on). */
function stubPages(pages: Record<string, Page>) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const p = pages[url];
    if (p === undefined) throw new Error(`unexpected fetch ${url}`);
    if (p === "throw") throw new Error("connect ETIMEDOUT");
    if (p === "tls") throw tlsError();
    const res = new Response(p.body ?? "<html><title>Assistant Chat</title></html>", { status: p.status });
    Object.defineProperty(res, "url", { value: p.finalUrl ?? url });
    return res;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

/** DNS-over-HTTPS is the resolver's fallback; what a test asserts on is the requests to the HOST. */
const DOH = (host: string) => `https://dns.google/resolve?name=${host}&type=CNAME`;
const toHost = (calls: string[], host: string) => calls.filter((u) => new URL(u).hostname === host);

async function withStubs<T>(
  cnames: Record<string, string[] | string>,
  pages: Record<string, Page>,
  run: (s: { dnsCalls: string[]; pageCalls: string[] }) => Promise<T>,
): Promise<T> {
  chat._resetAvChatCaches();
  const d = stubCname(cnames);
  const p = stubPages(pages);
  const prevEnv = process.env.AV_CHAT_GATEWAYS;
  try {
    return await run({ dnsCalls: d.calls, pageCalls: p.calls });
  } finally {
    d.restore();
    p.restore();
    if (prevEnv === undefined) delete process.env.AV_CHAT_GATEWAYS;
    else process.env.AV_CHAT_GATEWAYS = prevEnv;
  }
}

/** The world where the chat is fully set up: activated host, ads enabled, chat page answering. */
const READY = { [WORKER_URL]: { status: 200, body: worker("chatthecadrion") }, [BASE]: { status: 200 } };

// ---------- is the host a chat host? ----------

test("a subdomain whose CNAME is AV's chat gateway is a chat host (case and trailing dot ignored)", async () => {
  await withStubs({ [HOST]: ["Assistant-Quiz-Infrastructure-Gateway.ActiveView.app."] }, {}, async () => {
    assert.deepEqual(await chat.avChatHost(HOST), { chat: true, gateway: GATEWAY });
  });
});

test("a subdomain pointing anywhere else is not a chat host", async () => {
  await withStubs({ "redirect.thecadrion.com": ["redir-ee49mhsy80f9lmnucj0ejegc.actview.net"] }, {}, async () => {
    const r = await chat.avChatHost("redirect.thecadrion.com");
    assert.equal(r.chat, false);
    assert.equal(r.chat === false && r.failed, false, "a clean DNS answer is a verdict, not a failed check");
  });
});

test("a host with no CNAME at all (ENOTFOUND / ENODATA) is not a chat host", async () => {
  await withStubs({ "blog.thecadrion.com": "ENODATA" }, {}, async () => {
    const missing = await chat.avChatHost("nope.thecadrion.com");
    const noData = await chat.avChatHost("blog.thecadrion.com");
    assert.equal(missing.chat, false);
    assert.equal(missing.chat === false && missing.failed, false);
    assert.equal(noData.chat, false);
    assert.equal(noData.chat === false && noData.failed, false);
  });
});

test("a DNS outage (the resolver and DNS-over-HTTPS both down) is a FAILED check, never a 'not a chat host' verdict", async () => {
  await withStubs({ [HOST]: "ETIMEOUT" }, { [DOH(HOST)]: "throw" }, async () => {
    const r = await chat.avChatHost(HOST);
    assert.equal(r.chat, false);
    assert.equal(r.chat === false && r.failed, true);
    assert.match(r.chat === false ? (r.reason ?? "") : "", /ETIMEOUT.*connect ETIMEDOUT/);
  });
});

test("when the local resolver cannot be asked, the CNAME is read over DNS-over-HTTPS", async () => {
  const answer = JSON.stringify({
    Status: 0,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name: "chat.thecadrion.com.", type: 5 }],
    Answer: [{ name: "chat.thecadrion.com.", type: 5, TTL: 300, data: "assistant-quiz-infrastructure-gateway.activeview.app." }],
  });
  await withStubs({ [HOST]: "ECONNREFUSED" }, { [DOH(HOST)]: { status: 200, body: answer } }, async () => {
    assert.deepEqual(await chat.avChatHost(HOST), { chat: true, gateway: GATEWAY });
  });
});

test("DNS-over-HTTPS saying the host has no CNAME is a verdict, not a failure", async () => {
  const nxdomain = JSON.stringify({ Status: 3, Question: [{ name: "nope.thecadrion.com.", type: 5 }], Authority: [{ name: "thecadrion.com.", type: 6, TTL: 1800, data: "noor.ns.cloudflare.com." }] });
  const noRecord = JSON.stringify({ Status: 0, Question: [{ name: "blog.thecadrion.com.", type: 5 }], Authority: [{ name: "thecadrion.com.", type: 6, TTL: 1800, data: "noor.ns.cloudflare.com." }] });
  await withStubs(
    { "nope.thecadrion.com": "ECONNREFUSED", "blog.thecadrion.com": "ECONNREFUSED" },
    { [DOH("nope.thecadrion.com")]: { status: 200, body: nxdomain }, [DOH("blog.thecadrion.com")]: { status: 200, body: noRecord } },
    async () => {
      for (const host of ["nope.thecadrion.com", "blog.thecadrion.com"]) {
        const r = await chat.avChatHost(host);
        assert.equal(r.chat, false, host);
        assert.equal(r.chat === false && r.failed, false, host);
      }
    },
  );
});

test("an answer DNS-over-HTTPS cannot vouch for (a server failure, a non-JSON body) is a failed check", async () => {
  for (const page of [{ status: 200, body: JSON.stringify({ Status: 2 }) }, { status: 200, body: "<html>captive portal</html>" }, { status: 503, body: "" }] as Page[]) {
    await withStubs({ [HOST]: "ECONNREFUSED" }, { [DOH(HOST)]: page }, async () => {
      const r = await chat.avChatHost(HOST);
      assert.equal(r.chat, false, JSON.stringify(page));
      assert.equal(r.chat === false && r.failed, true, JSON.stringify(page));
    });
  }
});

test("a host the local resolver answers for is never asked over HTTPS", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, {}, async ({ pageCalls }) => {
    await chat.avChatHost(HOST);
    await chat.avChatHost("nope.thecadrion.com");
    assert.deepEqual(pageCalls, []);
  });
});

test("AV_CHAT_GATEWAYS overrides the gateway list", async () => {
  await withStubs({ [HOST]: ["chat-gw.new-av.example"], "old.thecadrion.com": [GATEWAY] }, {}, async () => {
    process.env.AV_CHAT_GATEWAYS = " Chat-GW.new-av.example. , second-gw.example ";
    assert.deepEqual(await chat.avChatHost(HOST), { chat: true, gateway: "chat-gw.new-av.example" });
    assert.equal((await chat.avChatHost("old.thecadrion.com")).chat, false, "the default gateway no longer counts once overridden");
  });
});

test("the chat-host verdict is cached: a second resolve does not query DNS again", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, {}, async ({ dnsCalls }) => {
    await chat.avChatHost(HOST);
    await chat.avChatHost(HOST);
    assert.deepEqual(dnsCalls, [HOST]);
  });
});

test("a failed DNS check is NOT cached — the next resolve asks again", async () => {
  await withStubs({ [HOST]: "ETIMEOUT" }, { [DOH(HOST)]: "throw" }, async ({ dnsCalls }) => {
    await chat.avChatHost(HOST);
    await chat.avChatHost(HOST);
    assert.deepEqual(dnsCalls, [HOST, HOST]);
  });
});

// ---------- may an ad point at this chat? ----------

test("a chat on an activated host with ads enabled resolves as kind chat", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, READY, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
});

test("the path form of a chat address resolves to the canonical ?asst= address, and that one is checked", async () => {
  const pathForm = { base: `https://${HOST}/${ID}`, host: HOST, path: `/${ID}` };
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    assert.deepEqual(await chat.resolveAvChat(pathForm, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
    assert.deepEqual(pageCalls, [WORKER_URL, BASE]);
  });
});

test("a chat host AV has not enabled ads on yet (no ad script = Pending monetization) is refused", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker("") }, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — chat\.thecadrion\.com/);
    assert.deepEqual(pageCalls, [WORKER_URL], "the chat page is not even fetched");
  });
});

test("the ad settings are read from the settings literal only, whichever way its keys are written", async () => {
  // The same settings with bare keys (the literal as a formatter prints it) — and a loader below
  // that names an EMPTY script, which must not be mistaken for the host's.
  const bareKeys = `const assistantQuizSettings = {
  key: "aq_0000:0000",
  script: 'chatthecadrion',
  botNames: ["Anna"],
  terms: { company: "Thecadrion" },
  theme: {},
  config: { disable: false, disableContent: true, quantityResponses: 2 },
};
const fallback = { script: "", config: { disable: true } };
`;
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: bareKeys }, [BASE]: { status: 200 } }, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
});

test("a chat host whose ads are switched off in its config is refused", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker("chatthecadrion", true) }, [BASE]: { status: 200 } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
  });
});

test("a chat host the gateway has no route for (activation unfinished) is the buyer's fix", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 404, body: NO_ROUTE } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_live — .*Chat Builder/);
  });
});

test("a chat host still behind the gateway's default certificate is an unfinished activation (400)", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: "tls" }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_live — chat\.thecadrion\.com .*certificate.*Chat Builder/);
  });
});

test("a failed request names its cause, not just 'fetch failed'", async () => {
  const cause = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }) });
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw cause;
  }) as typeof fetch;
  try {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — .*EAI_AGAIN/);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("ad settings that cannot be read are a failed check (502): an unconfirmed chat never launches", async () => {
  for (const page of ["throw", { status: 500, body: "upstream error" }, { status: 200, body: "<html>not the settings file</html>" }] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: page, [BASE]: { status: 200 } }, async () => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      assert.equal(r.ok, false, JSON.stringify(page));
      assert.equal(!r.ok && r.status, 502, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
    });
  }
});

test("a chat address that answers anything but 200 is refused", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_live — https:\/\/chat\.thecadrion\.com\/\?asst=6a2312cef9f4e11b130fc523 answered 404/);
  });
});

test("a chat URL that redirects off the chat host is refused", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: { status: 200, finalUrl: "https://elsewhere.example/landing" } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_invalid — .*elsewhere\.example/);
  });
});

test("a chat that does not answer is a failed check (502), not the buyer's fix", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: "throw" }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
  });
});

test("a path on the chat host that names no chat id is refused before anything is fetched", async () => {
  const shape = { base: `https://${HOST}/some-article`, host: HOST, path: "/some-article" };
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_url_invalid — /);
    assert.deepEqual(pageCalls, []);
  });
});

test("a subdomain that is not a chat host is destination_not_av and nothing of it is fetched", async () => {
  const shape = { base: "https://blog.thecadrion.com/post", host: "blog.thecadrion.com", path: "/post" };
  await withStubs({ "blog.thecadrion.com": ["some-cdn.example"] }, {}, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_not_av — blog\.thecadrion\.com/);
    assert.deepEqual(pageCalls, []);
  });
});

test("a DNS outage while resolving a chat is a failed check (502) and nothing of the host is fetched", async () => {
  await withStubs({ [HOST]: "ESERVFAIL" }, { [DOH(HOST)]: "throw" }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
    assert.deepEqual(toHost(pageCalls, HOST), []);
  });
});

test("the site itself (or www) is never a chat, whatever its DNS says", async () => {
  for (const host of ["thecadrion.com", "www.thecadrion.com"]) {
    const shape = { base: `https://${host}/?asst=${ID}`, host, path: "/" };
    await withStubs({ [host]: [GATEWAY] }, {}, async ({ dnsCalls, pageCalls }) => {
      const r = await chat.resolveAvChat(shape, "thecadrion.com");
      assert.equal(r.ok, false, host);
      assert.equal(!r.ok && r.status, 400, host);
      assert.deepEqual(dnsCalls, [], host);
      assert.deepEqual(pageCalls, [], host);
    });
  }
});

test("a host of ANOTHER domain is never a chat of this site, even behind AV's gateway", async () => {
  const shape = { base: `https://chat.other-site.com/?asst=${ID}`, host: "chat.other-site.com", path: "/" };
  await withStubs({ "chat.other-site.com": [GATEWAY] }, {}, async ({ dnsCalls, pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.deepEqual(dnsCalls, []);
    assert.deepEqual(pageCalls, []);
  });
});

// ---------- the card's hint: which sites have a chat host, and is it ready ----------

test("the chat-host probe lists chat.<site> only for the sites that have one, ready once ads are enabled", async () => {
  await withStubs(
    { [HOST]: [GATEWAY], "chat.second-site.com": ["parking.example"] },
    { [WORKER_URL]: { status: 200, body: worker("chatthecadrion") } },
    async () => {
      assert.deepEqual(await chat.avChatHosts(["thecadrion.com", "second-site.com"]), [{ host: HOST, site: "thecadrion.com", live: true }]);
    },
  );
});

test("a chat host whose activation is unfinished is listed as not live, pointing at Chat Builder", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 404, body: NO_ROUTE } }, async () => {
    const hosts = await chat.avChatHosts(["thecadrion.com"]);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, HOST);
    assert.equal(hosts[0].live, false);
    assert.match(hosts[0].liveReason ?? "", /^chat_not_live — .*Chat Builder/);
  });
});

test("a chat host without ads yet is listed as not live, saying it waits for ActiveView's review", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker("") } }, async () => {
    const hosts = await chat.avChatHosts(["thecadrion.com"]);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].live, false);
    assert.match(hosts[0].liveReason ?? "", /^chat_not_monetized — /);
  });
});

test("a chat host that does not answer is listed as not live, with the reason", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: "throw" }, async () => {
    const hosts = await chat.avChatHosts(["thecadrion.com"]);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].live, false);
    assert.match(hosts[0].liveReason ?? "", /connect ETIMEDOUT/);
  });
});

test("a forced probe (the card's Retry) re-reads DNS and the host instead of the cached verdict", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker("chatthecadrion") } }, async ({ dnsCalls, pageCalls }) => {
    await chat.avChatHosts(["thecadrion.com"]);
    await chat.avChatHosts(["thecadrion.com"]);
    assert.deepEqual(dnsCalls, [HOST], "an unforced probe answers from the cache");
    assert.deepEqual(pageCalls, [WORKER_URL]);
    await chat.avChatHosts(["thecadrion.com"], true);
    assert.deepEqual(dnsCalls, [HOST, HOST]);
    assert.deepEqual(pageCalls, [WORKER_URL, WORKER_URL]);
  });
});

test("a host that became ready is launchable at once: a refusal is never served from the cache", async () => {
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const pending = stubPages({ [WORKER_URL]: { status: 200, body: worker("") } });
  try {
    const before = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    assert.equal(before.ok, false);
    pending.restore();
    const ready = stubPages(READY);
    try {
      assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
    } finally {
      ready.restore();
    }
  } finally {
    d.restore();
    pending.restore();
  }
});
