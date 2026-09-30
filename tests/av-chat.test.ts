// Node's built-in runner (v24 strips types natively): `node --test tests/av-chat.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts imports below are a Node requirement.
// AV rail — the CHAT destination (ActiveView → Chat Builder): a chat lives on a subdomain of an AV
// site whose CNAME points at AV's chat gateway (chat.thecadrion.com →
// assistant-quiz-infrastructure-gateway.activeview.app, live 29.09). The external API lists no chats,
// so the host is recognized by that CNAME, and a launch is refused unless the host SHOWS ADS: its
// public /worker.js must carry a chat key, name an ad script of its own, and that script must be
// served by AV's CDN. Everything here is read live off AV's chat hosts (29.09); DNS and the GETs are
// the only doubles (all external).
import "./_resolve-hook.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

const chat = await import("../lib/av-chat.ts");
// The shipped registry of known chats (lib/av-link AV_KNOWN_CHATS — lp1.thecadrion.com) would add
// its hosts to every probe of thecadrion.com; the tests below name the known chats they need.
chat._setAvKnownChats([]);

const GATEWAY = "assistant-quiz-infrastructure-gateway.activeview.app";
const HOST = "chat.thecadrion.com";
const ID = "6a2312cef9f4e11b130fc523";
/** The canonical chat address: the id rides the query (the form every AV chat host answers). */
const BASE = `https://${HOST}/?asst=${ID}`;
const WORKER_URL = `https://${HOST}/worker.js`;
const SCRIPT = "chatthecadrion";
const SCRIPT_URL = `https://scr.actview.net/${SCRIPT}.js`;
/** What lib/av-destination hands over: lib/av-link's shape of the stored URL. */
const SHAPE = { base: BASE, host: HOST, path: "/" };
const KEY = "aq_00000000000000000000000000000000:0000000000000000";

/** The gateway's own answer for a host it has no route for (read live 29.09, chat.thecadrion.com
 *  before the Chat Builder activation was finished). */
const NO_ROUTE = '{\n  "message":"no Route matched with those values",\n  "request_id":"e3472a6a44d7bb6634c54158b1ac6d13"\n}';
/** AV's script CDN for a file it does not have (read live 29.09: 403, application/xml). */
const NO_SCRIPT = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';

/** The loader every worker.js carries below its settings — it names `script` and `disable` too. */
const LOADER = `
function validateSettings(settings) {
  const requiredFields = ["key", "terms", "theme", "config", "botNames"];
  const missingFields = requiredFields.filter((field) => !settings[field]);
  return missingFields.length === 0;
}

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

/** A chat host's /worker.js as AV serves it for a configured host (read live 29.09): the settings
 *  are a JSON-style literal with QUOTED keys, followed by the loader. */
const worker = (script: string, disable = false, key = KEY) => `const assistantQuizSettings = {
  "key": "${key}",
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
${LOADER}`;

/** The default TEMPLATE a host serves until its chat is published (read live 29.09 on five hosts):
 *  BARE keys, `config` before `botNames`, trailing commas, an empty key and an empty script. */
const template = (key = "", script = "") => `const assistantQuizSettings = {
  key: "${key}",
  script: "${script}",
  config: {
    disable: false,
    disableTopAndContent: false,
    disableContent: false,
    quantityResponses: 2,
  },
  botNames: ["Assistant AI"],
  profileImageUrl: "",
  terms: {
    company: "20XX Acme Inc",
    footer: "Usage implies acceptance of",
    terms: "Terms",
    termsUrl: "#",
    privacy: "Privacy",
    privacyUrl: "#",
  },
  theme: {
    "chat-background": "#f4f4f5",
    "ad-label": "rgb(107, 114, 128)",
  }
};
${LOADER}`;

/** Read live 29.09: a settings literal WITHOUT `script` (config present). */
const NO_SCRIPT_KEY = `const assistantQuizSettings = {
  "key": "${KEY}",
  "botNames": [
    "teste"
  ],
  "terms": {
    "company": "",
    "footer": "by using this, you accept",
    "terms": "Terms",
    "termsUrl": "#",
    "privacy": "Privacy",
    "privacyUrl": "#"
  },
  "theme": {
    "chat-background": "#f4f4f5"
  },
  "config": {
    "disable": false,
    "disableTopAndContent": false,
    "quantityResponses": 2
  }
};
${LOADER}`;

/** Read live 29.09: a settings literal with neither `script` nor `config`. */
const KEY_AND_NAMES_ONLY = `const assistantQuizSettings = {
  "key": "${KEY}",
  "botNames": [
    "John",
    "James"
  ]
};
${LOADER}`;

const dnsError = (code: string) => Object.assign(new Error(`queryCname ${code}`), { code });

/** Replace the resolver's CNAME lookup for one test; `answers` maps a host to its CNAMEs, an error
 *  code, or "hang" (a name server that never answers). */
function stubCname(answers: Record<string, string[] | string>) {
  const calls: string[] = [];
  const m = mock.method(dns.Resolver.prototype, "resolveCname", async (host: string) => {
    calls.push(host);
    const a = answers[host];
    if (a === undefined) throw dnsError("ENOTFOUND");
    if (a === "hang") return new Promise<string[]>(() => {});
    if (typeof a === "string") throw dnsError(a);
    return a;
  });
  const cancel = mock.method(dns.Resolver.prototype, "cancel", () => {});
  return {
    calls,
    restore: () => {
      m.mock.restore();
      cancel.mock.restore();
    },
  };
}

type Page = { status: number; finalUrl?: string; body?: string; type?: string; location?: string; server?: string } | "throw" | "tls";

/** What fetch throws for a host still behind the gateway's default certificate (read live 29.09:
 *  chat.thecadrion.com served Kong's self-signed CN=localhost before its activation). */
const tlsError = () =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });

/** Replace fetch for one test; `pages` maps a URL to its answer. Every request's init is kept. */
function stubPages(pages: Record<string, Page>) {
  const calls: string[] = [];
  const inits: Record<string, RequestInit | undefined> = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits[url] = init;
    const p = pages[url];
    if (p === undefined) throw new Error(`unexpected fetch ${url}`);
    if (p === "throw") throw new Error("connect ETIMEDOUT");
    if (p === "tls") throw tlsError();
    const headers: Record<string, string> = {};
    if (p.type) headers["content-type"] = p.type;
    if (p.location) headers.location = p.location;
    if (p.server) headers.server = p.server;
    const res = new Response(p.status === 301 || p.status === 302 ? null : (p.body ?? "<html><title>Assistant Chat</title></html>"), { status: p.status, headers });
    Object.defineProperty(res, "url", { value: p.finalUrl ?? url });
    return res;
  }) as typeof fetch;
  return { calls, inits, restore: () => (globalThis.fetch = real) };
}

/** DNS-over-HTTPS is the resolver's fallback; what a test asserts on is the requests to the HOST. */
const DOH = (host: string) => `https://dns.google/resolve?name=${host}&type=CNAME`;
const toHost = (calls: string[], host: string) => calls.filter((u) => new URL(u).hostname === host);

const ENV = ["AV_CHAT_GATEWAYS", "AV_CHAT_SCRIPT_CDN", "AV_CHAT_LOADER_CHECK"] as const;

async function withStubs<T>(
  cnames: Record<string, string[] | string>,
  pages: Record<string, Page>,
  run: (s: { dnsCalls: string[]; pageCalls: string[]; inits: Record<string, RequestInit | undefined> }) => Promise<T>,
): Promise<T> {
  chat._resetAvChatCaches();
  const prev = ENV.map((k) => process.env[k]);
  for (const k of ENV) delete process.env[k];
  const d = stubCname(cnames);
  const p = stubPages(pages);
  try {
    return await run({ dnsCalls: d.calls, pageCalls: p.calls, inits: p.inits });
  } finally {
    d.restore();
    p.restore();
    ENV.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
}

const SERVED: Page = { status: 200, body: "/* the chat host's ad script */ (()=>{})();", type: "application/javascript" };
/** The world where the chat is fully set up: activated host, its ad script served, the address answering. */
const READY: Record<string, Page> = { [WORKER_URL]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED, [BASE]: { status: 200 } };
const refused = (r: { ok: boolean }) => assert.equal(r.ok, false);

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

test("a name server that never answers is given up after 3 s for DNS-over-HTTPS, not after the resolver's own half minute", async () => {
  const answer = JSON.stringify({ Status: 0, Answer: [{ name: "chat.thecadrion.com.", type: 5, TTL: 300, data: `${GATEWAY}.` }] });
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["setTimeout"] });
  const d = stubCname({ [HOST]: "hang" });
  const p = stubPages({ [DOH(HOST)]: { status: 200, body: answer } });
  try {
    const verdict = chat.avChatHost(HOST);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(p.calls, [], "the fallback waits for the resolver's bound");
    mock.timers.tick(3_000);
    assert.deepEqual(await verdict, { chat: true, gateway: GATEWAY });
    assert.deepEqual(p.calls, [DOH(HOST)]);
  } finally {
    mock.timers.reset();
    d.restore();
    p.restore();
  }
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

test("a string that is not a host name reaches neither DNS nor DNS-over-HTTPS", async () => {
  for (const junk of ["chat.thecadrion.com/x?y=1", "chat.thecadrion.com&type=A", "chat thecadrion.com", "chat.thecadrion.com:8443", "", "localhost"]) {
    await withStubs({}, {}, async ({ dnsCalls, pageCalls }) => {
      const r = await chat.avChatHost(junk);
      assert.equal(r.chat, false, junk);
      assert.deepEqual(dnsCalls, [], junk);
      assert.deepEqual(pageCalls, [], junk);
    });
  }
});

test("AV_CHAT_GATEWAYS overrides the gateway list", async () => {
  await withStubs({ [HOST]: ["chat-gw.new-av.example"], "old.thecadrion.com": [GATEWAY] }, {}, async () => {
    process.env.AV_CHAT_GATEWAYS = " Chat-GW.new-av.example. , second-gw.example ";
    assert.deepEqual(await chat.avChatHost(HOST), { chat: true, gateway: "chat-gw.new-av.example" });
    assert.equal((await chat.avChatHost("old.thecadrion.com")).chat, false, "the default gateway no longer counts once overridden");
  });
});

test("a chat-host verdict is cached: a second resolve does not query DNS again", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, {}, async ({ dnsCalls }) => {
    await chat.avChatHost(HOST);
    await chat.avChatHost(HOST);
    assert.deepEqual(dnsCalls, [HOST]);
  });
});

test("'not a chat host' is never served from the cache: a CNAME added a moment ago is seen at once", async () => {
  chat._resetAvChatCaches();
  const before = stubCname({});
  try {
    assert.equal((await chat.avChatHost(HOST)).chat, false);
  } finally {
    before.restore();
  }
  const after = stubCname({ [HOST]: [GATEWAY] });
  try {
    assert.deepEqual(await chat.avChatHost(HOST), { chat: true, gateway: GATEWAY });
  } finally {
    after.restore();
  }
});

test("a failed DNS check is NOT cached — the next resolve asks again", async () => {
  await withStubs({ [HOST]: "ETIMEOUT" }, { [DOH(HOST)]: "throw" }, async ({ dnsCalls }) => {
    await chat.avChatHost(HOST);
    await chat.avChatHost(HOST);
    assert.deepEqual(dnsCalls, [HOST, HOST]);
  });
});

// ---------- may an ad point at this chat? ----------

test("a chat on an activated host whose ad script is served resolves as kind chat", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, BASE]);
  });
});

test("no request of the check follows a redirect", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ inits }) => {
    await chat.resolveAvChat(SHAPE, "thecadrion.com");
    for (const url of [WORKER_URL, SCRIPT_URL, BASE]) assert.equal(inits[url]?.redirect, "manual", url);
  });
});

test("the path form of a chat address resolves to the canonical ?asst= address, and that one is checked", async () => {
  const pathForm = { base: `https://${HOST}/${ID}`, host: HOST, path: `/${ID}` };
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    assert.deepEqual(await chat.resolveAvChat(pathForm, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, BASE]);
  });
});

test("a chat on any other chat subdomain of the site resolves too (the label is the publisher's choice)", async () => {
  for (const host of ["ai.thecadrion.com", "c1.talk.thecadrion.com"]) {
    const base = `https://${host}/?asst=${ID}`;
    await withStubs({ [host]: [GATEWAY] }, { [`https://${host}/worker.js`]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED, [base]: { status: 200 } }, async () => {
      assert.deepEqual(await chat.resolveAvChat({ base, host, path: "/" }, "thecadrion.com"), { ok: true, kind: "chat", base, site: "thecadrion.com" }, host);
    });
  }
});

test("a host that still serves the template (no chat key) is an unpublished chat: refused, nothing else fetched", async () => {
  for (const body of [template(), template("", "localhost")]) {
    await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body }, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400);
      assert.match(!r.ok ? r.error : "", /^chat_not_live — chat\.thecadrion\.com has no chat key.*Chat Builder/);
      assert.deepEqual(pageCalls, [WORKER_URL]);
    });
  }
});

test("a chat host AV has not enabled ads on yet (no ad script = Pending monetization) is refused", async () => {
  for (const body of [worker(""), worker(" "), template(KEY, ""), NO_SCRIPT_KEY, KEY_AND_NAMES_ONLY]) {
    await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body }, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, body.slice(0, 120));
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — chat\.thecadrion\.com .*Pending monetization/, body.slice(0, 120));
      assert.deepEqual(pageCalls, [WORKER_URL], "neither the script CDN nor the chat page is asked");
    });
  }
});

test("a chat host that still names the template's placeholder ad script is refused without asking the CDN", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker("LocalHost") }, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — .*placeholder/);
    assert.deepEqual(pageCalls, [WORKER_URL]);
  });
});

test("a chat host whose ads are switched off in its config is refused", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT, true) } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — ads are switched off on chat\.thecadrion\.com/);
    assert.deepEqual(pageCalls, [WORKER_URL]);
  });
});

test("ads switched off in any way the page's loader reads as true are off", async () => {
  // The loader takes Boolean(config.disable): a string or a number switches the ads off too.
  for (const off of ['"true"', "1", '"yes"']) {
    const body = worker(SCRIPT).replace('"disable": false', `"disable": ${off}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, off);
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — ads are switched off/, off);
      assert.deepEqual(pageCalls, [WORKER_URL], off);
    });
  }
});

test("an empty list of agent names is still a list: the page starts and loads its ads (read live on two monetized hosts)", async () => {
  for (const names of ["[]", "[\n  ]"]) {
    const body = worker(SCRIPT).replace(/"botNames": \[[^\]]*\]/, `"botNames": ${names}`);
    assert.ok(body.includes(`"botNames": ${names}`), "the fixture really has an empty list");
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" }, names);
    });
  }
});

test("the settings are read at the literal's OWN level: a key, a script or a part nested deeper never stands in for the host's", async () => {
  const nestedScript = worker("").replace('"company": "Thecadrion"', '"company": "Thecadrion",\n    "script": "somebodyelses",\n    "key": "nested"');
  const nestedKey = worker(SCRIPT, false, "").replace('"company": "Thecadrion"', '"company": "Thecadrion",\n    "key": "aq_nested:0000"');
  const nestedTerms = worker(SCRIPT)
    .replace(/"terms": \{[^}]*\}/, '"terms": null')
    .replace('"chat-background": "#f4f4f5"', '"chat-background": "#f4f4f5",\n    "terms": { "company": "nested" }');
  const cases: [string, string, RegExp][] = [
    ["a script nested in terms", nestedScript, /^chat_not_monetized — .*Pending monetization/],
    ["a key nested in terms", nestedKey, /^chat_not_live — .*no chat key/],
    ["terms: null next to a nested terms", nestedTerms, /^chat_not_monetized — .*\bterms\b/],
  ];
  for (const [what, body, want] of cases) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, what);
      assert.match(!r.ok ? r.error : "", want, what);
      assert.deepEqual(pageCalls, [WORKER_URL], what);
    });
  }
});

test("settings that come after the keys' usual place are read all the same (live hosts serve five key orders)", async () => {
  const keyLast = `const assistantQuizSettings = {
  "theme": { "chat-background": "#f4f4f5" },
  "terms": { "company": "Thecadrion", "termsUrl": "https://thecadrion.com/terms" },
  "config": { "quantityResponses": 2, "disable": false },
  "botNames": ["Anna"],
  "script": "${SCRIPT}",
  "key": "${KEY}"
};
${LOADER}`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: keyLast } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
});

test("a commented-out sample of the settings above the real ones is not the settings", async () => {
  const commented = `// const assistantQuizSettings = { key: "${KEY}", script: "${SCRIPT}", botNames: ["x"], terms: {}, theme: {}, config: { disable: false } };
/* const assistantQuizSettings = { key: "${KEY}", script: "${SCRIPT}", botNames: ["x"], terms: {}, theme: {}, config: {} }; */
${worker("")}`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: commented } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — .*Pending monetization/);
    assert.deepEqual(pageCalls, [WORKER_URL]);
  });
});

test("settings that are not plain data (a value computed in code) cannot be vouched for: a failed check (502)", async () => {
  for (const value of ["getScript()", "`chatthecadrion`", "SCRIPT_NAME", "!0 ? 'a' : 'b'"]) {
    const body = worker(SCRIPT).replace(`"script": "${SCRIPT}"`, `"script": ${value}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, value);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the ad settings of chat\.thecadrion\.com could not be read/, value);
      assert.deepEqual(pageCalls, [WORKER_URL], value);
    });
  }
});

test("a text in the settings that looks like their end (\"};\") or like a key does not cut them short", async () => {
  const tricky = worker(SCRIPT).replace('"footer": "by using this, you accept"', '"footer": "by using this }; you accept, \\"script\\": \\"\\", key: \'\'"');
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: tricky } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
});

test("settings the page itself would refuse (a part its loader requires is missing) are refused: it never loads the ad script", async () => {
  const noConfig = worker(SCRIPT).replace(/,\s*"config": \{[^}]*\}/, "");
  const noTerms = worker(SCRIPT).replace(/\s*"terms": \{[^}]*\},/, "");
  const noNames = worker(SCRIPT).replace(/\s*"botNames": \[[^\]]*\],/, "");
  for (const [body, part] of [
    [noConfig, "config"],
    [noTerms, "terms"],
    [noNames, "botNames"],
  ] as const) {
    assert.ok(!new RegExp(`"${part}"`).test(body.slice(0, body.indexOf("};"))), `the fixture really has no ${part}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, part);
      assert.match(!r.ok ? r.error : "", new RegExp(`^chat_not_monetized — .*\\b${part}\\b`), part);
      assert.deepEqual(pageCalls, [WORKER_URL], part);
    });
  }
});

// ---------- the rest of the file: is it the loader the settings are read for? ----------

/** The settings literal alone — what a fixture's loader follows. */
const literalOf = (body: string) => body.slice(0, body.indexOf(LOADER));
const CALL = "loadRemoteScript({ disable: Boolean(assistantQuizSettings?.config?.disable), fileName: assistantQuizSettings.script });";

test("the loader as live hosts carry it (the call spread over lines, inside an async start-up) is the loader", async () => {
  const live = `${literalOf(worker(SCRIPT))}
/**
 * Validates that assistantQuizSettings has all required properties
 */
function validateSettings(settings) {
  const requiredFields = ["key", "terms", "theme", "config", "botNames"];
  const missingFields = requiredFields.filter((field) => !settings[field]);
  if (missingFields.length > 0) {
    console.error(\`[AV Assistant] Missing required settings: \${missingFields.join(", ")}\`);
    return false;
  }
  return true;
}

function loadRemoteScript({
  disable,
  fileName,
  baseUrl = "https://scr.actview.net",
}) {
  return new Promise((resolve) => resolve());
}

async function initializeAssistant() {
  try {
    if (!validateSettings(assistantQuizSettings)) {
      throw new Error("Invalid assistantQuizSettings configuration");
    }
    loadConstants(assistantQuizSettings);
    loadTheme(assistantQuizSettings.theme);
    await loadRemoteScript({
      disable: Boolean(assistantQuizSettings?.config?.disable),
      fileName: assistantQuizSettings.script,
    });
  } catch (error) {
    console.error("[AV Assistant] Failed to initialize:", error);
  }
}

initializeAssistant();
`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: live } }, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
});

test("settings whose file does not load the ad script FROM THEM cannot be vouched for: a failed check (502)", async () => {
  const literal = literalOf(worker(SCRIPT));
  const cases: [string, string][] = [
    ["the literal alone, no loader", literal],
    ["a loader that takes the ad script from another setting", worker(SCRIPT).replace("fileName: assistantQuizSettings.script", "fileName: assistantQuizSettings.adScript")],
    ["a loader that names the script itself", worker(SCRIPT).replace("fileName: assistantQuizSettings.script", 'fileName: "somebodyelses"')],
    ["a loader that reads another object's script", worker(SCRIPT).replace("fileName: assistantQuizSettings.script", "fileName: defaults.script")],
    ["the loader's call only in a comment", `${literal}\n// ${CALL}\n/* ${CALL} */\n`],
    ["the loader's call only in a text", `${literal}\nconst sample = "${CALL.replace(/"/g, "'")}";\nconst other = \`${CALL}\`;\n`],
  ];
  for (const [what, body] of cases) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, what);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the settings file of chat\.thecadrion\.com is not in a form the launcher knows \(.*ad script/, what);
      assert.deepEqual(pageCalls, [WORKER_URL], what);
    });
  }
});

test("settings the file CHANGES after the literal cannot be vouched for: a failed check (502)", async () => {
  for (const later of [
    'assistantQuizSettings.script = "";',
    'assistantQuizSettings["script"] = "";',
    "assistantQuizSettings.config.disable = true;",
    "assistantQuizSettings . config = { disable: true };",
    "Object.assign(assistantQuizSettings, { script: '' });",
    "assistantQuizSettings.script ||= 'other';",
    "delete assistantQuizSettings.script;",
  ]) {
    const body = worker(SCRIPT).replace(LOADER, `\n${later}\n${LOADER}`);
    assert.ok(body.includes(later), "the fixture really carries the statement");
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, later);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the settings file of chat\.thecadrion\.com is not in a form the launcher knows \(.*changes/, later);
      assert.deepEqual(pageCalls, [WORKER_URL], later);
    });
  }
});

test("a loader that only READS the settings, or writes about them in a comment, is the loader", async () => {
  const reads = worker(SCRIPT).replace(
    LOADER,
    `${LOADER}
// assistantQuizSettings.script = "set by ActiveView"; (a note, not code)
const note = "assistantQuizSettings.script = ''";
if (assistantQuizSettings.script === "" || assistantQuizSettings.config.disable == true) console.log("no ads");
const names = (assistantQuizSettings) => assistantQuizSettings.botNames;
window.chatSettings = assistantQuizSettings;
`,
  );
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: reads } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
});

test("the parts the page requires are the ones ITS loader lists", async () => {
  const LIST = '["key", "terms", "theme", "config", "botNames"]';
  assert.ok(worker(SCRIPT).includes(LIST), "the fixture's loader carries the list");
  // one more part than the launcher knows: the page would stop, so would the ads
  const stricter = worker(SCRIPT).replace(LIST, '["key", "terms", "theme", "config", "botNames", "welcome"]');
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: stricter } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — the settings of chat\.thecadrion\.com are incomplete \(no welcome\)/);
    assert.deepEqual(pageCalls, [WORKER_URL]);
  });
  // one part fewer: settings without it start the page all the same
  const looser = worker(SCRIPT)
    .replace(/\s*"botNames": \[[^\]]*\],/, "")
    .replace(LIST, "['key', 'terms', 'theme', 'config']");
  assert.ok(!literalOf(looser).includes("botNames"), "the fixture really has no botNames");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: looser } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
  // a list that requires nothing — the chat key is the launcher's own requirement, whatever the list
  const nothing = worker(SCRIPT).replace(/\s*"botNames": \[[^\]]*\],/, "").replace(LIST, "[]");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: nothing } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT, false, "").replace(LIST, "[]") } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_live — .*no chat key/);
  });
});

test("an older loader that validates nothing (read live on six hosts) is judged by the parts every loader uses", async () => {
  const old = (body: string) => body.replace(/function validateSettings[\s\S]*?\n}\n/, "");
  assert.ok(!old(worker(SCRIPT)).includes("requiredFields"), "the fixture really validates nothing");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: old(worker(SCRIPT)) } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
  const noTheme = old(worker(SCRIPT)).replace(/\s*"theme": \{[^}]*\},/, "");
  assert.ok(!literalOf(noTheme).includes('"theme"'), "the fixture really has no theme");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: noTheme } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — .*\btheme\b/);
  });
});

test("a loader whose list of required parts cannot be read is a failed check (502)", async () => {
  const LIST = '["key", "terms", "theme", "config", "botNames"]';
  for (const list of ["REQUIRED_FIELDS", "[...BASE_FIELDS, 'botNames']", '["key", 5]', '["key", ""]', "Object.keys(schema)"]) {
    const body = worker(SCRIPT).replace(LIST, list);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, list);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the settings file of chat\.thecadrion\.com is not in a form the launcher knows \(.*requires/, list);
      assert.deepEqual(pageCalls, [WORKER_URL], list);
    });
  }
  // a validation with no list at all: what it wants is unknown
  const renamed = worker(SCRIPT).replace(/requiredFields/g, "mustHave");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: renamed } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /is not in a form the launcher knows \(.*requires/);
  });
});

test("what is wrong with the HOST is said before what is unknown about its loader", async () => {
  // An unpublished or pending host is the buyer's / ActiveView's move whatever the loader looks like.
  const noLoader = (body: string) => literalOf(body);
  const cases: [string, RegExp][] = [
    [noLoader(template()), /^chat_not_live — .*no chat key/],
    [noLoader(worker("")), /^chat_not_monetized — .*Pending monetization/],
    [noLoader(worker(SCRIPT, true)), /^chat_not_monetized — ads are switched off/],
  ];
  for (const [body, want] of cases) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, String(want));
      assert.match(!r.ok ? r.error : "", want);
    });
  }
});

// ---------- a loader in the forms a next release may take ----------

/** The fixture's loader with its start-up call replaced. */
const withCall = (call: string) => worker(SCRIPT).replace(CALL, call);
const D = "disable: Boolean(assistantQuizSettings?.config?.disable)";
/** The fixture's loader as the terser Next bundles minifies it (default options). */
const MINIFIED =
  'function validateSettings(e){return 0===["key","terms","theme","config","botNames"].filter((t=>!e[t])).length}' +
  'function loadRemoteScript({disable:e,fileName:t,baseUrl:i="https://scr.actview.net"}){if(e||""===t)return console.log("[AV Assistant] Remote script loading is disabled"),Promise.resolve();' +
  "const s=document.createElement(\"script\");s.src=`${i}/${t.trim()}.js`,document.head.appendChild(s)}" +
  "loadRemoteScript({disable:Boolean(assistantQuizSettings?.config?.disable),fileName:assistantQuizSettings.script});";

test("a loader that still loads the ad script the settings name is known in every form that keeps the name as it is", async () => {
  const forms: [string, string][] = [
    ["the script read by its quoted name", withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings["script"] });`)],
    ["the script read by its quoted name, optionally", withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings?.['script'] });`)],
    ["the property name quoted", withCall(`loadRemoteScript({ ${D}, "fileName": assistantQuizSettings.script });`)],
    ["an empty fallback (only an empty script falls back — and that one is refused anyway)", withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings.script || "" });`)],
    ["a nullish fallback", withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings.script ?? "" });`)],
    ["the name as a string", withCall(`loadRemoteScript({ ${D}, fileName: String(assistantQuizSettings.script) });`)],
    ["the name in parentheses", withCall(`loadRemoteScript({ ${D}, fileName: (assistantQuizSettings.script) });`)],
    ["an optional call", withCall(`loadRemoteScript?.({ ${D}, fileName: assistantQuizSettings.script });`)],
    ["a nested object before the name", withCall(`loadRemoteScript({ retry: { max: 2, delay: 1000 }, ${D}, fileName: assistantQuizSettings.script });`)],
    ["a callback before the name", withCall(`loadRemoteScript({ onError: (e) => { console.error(e); }, ${D}, fileName: assistantQuizSettings.script });`)],
    ["the settings handed to the chat app", withCall(`window.assistantQuizSettings = assistantQuizSettings;\nglobalThis . assistantQuizSettings = assistantQuizSettings;\n${CALL}`)],
    ["a regex with a backtick before the call", withCall(`const ticks = /\`/g;\n${CALL}`)],
    ["a regex with a quote on the call's line", withCall(`const q = /"/g; ${CALL}`)],
    ["a regex that holds /* with no comment after it", withCall(`const trailing = /\\/*$/;\n${CALL}`)],
    ["a regex ending in an escaped slash on the call's line", withCall(`const slash = /\\//; ${CALL}`)],
    ["a division next to texts", withCall(`const half = "a".length / 2; const q = 'b' / 2;\n${CALL}`)],
    ["a division right after a text, a slash in a text later on the line", withCall(`const q = "x" / 2, s = "/"; ${CALL}`)],
    ["minified", `${literalOf(worker(SCRIPT))}${MINIFIED}`],
  ];
  for (const [what, body] of forms) {
    assert.ok(body !== worker(SCRIPT), `the fixture really changed: ${what}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" }, what);
    });
  }
  // the minified loader still requires its parts
  const minifiedNoNames = `${literalOf(worker(SCRIPT).replace(/\s*"botNames": \[[^\]]*\],/, ""))}${MINIFIED}`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: minifiedNoNames } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — .*incomplete \(no botNames\)/);
  });
});

test("a file minified as a whole (booleans written !0 / !1) is read like the one it was made from", async () => {
  const settings = (disable: string) =>
    `const assistantQuizSettings={key:"${KEY}",script:"${SCRIPT}",botNames:["Anna","Sophia"],terms:{company:"Thecadrion"},theme:{"chat-background":"#f4f4f5"},config:{disable:${disable},disableContent:!0,quantityResponses:2}};`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: `${settings("!1")}${MINIFIED}` } }, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: `${settings("!0")}${MINIFIED}` } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — ads are switched off/);
  });
});

test("a file whose lines end in a carriage return only is read like any other", async () => {
  const body = worker(SCRIPT).replace(CALL, `// the start-up\n${CALL}`).replace(/\n/g, "\r");
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
});

test("a loader that switches the ads off by itself — whatever the settings say — is not known", async () => {
  for (const [what, body] of [
    ["in its call", withCall(`loadRemoteScript({ disable: true, fileName: assistantQuizSettings.script });`)],
    ["from somewhere else", withCall(`loadRemoteScript({ disable: window.AV_ADS_OFF, fileName: assistantQuizSettings.script });`)],
    ["as its default, the call naming none", worker(SCRIPT).replace("{ disable, fileName,", "{ disable = true, fileName,").replace(CALL, "loadRemoteScript({ fileName: assistantQuizSettings.script });")],
  ] as const) {
    assert.ok(body !== worker(SCRIPT), `the fixture really changed: ${what}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, what);
      assert.match(!r.ok ? r.error : "", /is not in a form the launcher knows \(its ads are switched off by something else than the settings\)/, what);
      assert.deepEqual(pageCalls, [WORKER_URL], what);
    });
  }
  for (const [what, body] of [
    ["the settings' switch, as every live loader reads it", worker(SCRIPT)],
    ["the settings' switch, read plainly", withCall(`loadRemoteScript({ disable: assistantQuizSettings.config.disable, fileName: assistantQuizSettings.script });`)],
    ["the settings' switch, negated twice", withCall(`loadRemoteScript({ disable: !!assistantQuizSettings?.config?.["disable"], fileName: assistantQuizSettings.script });`)],
    ["no switch in the call, none by default", worker(SCRIPT).replace(CALL, "loadRemoteScript({ fileName: assistantQuizSettings.script });")],
    ["a switch that is off", withCall(`loadRemoteScript({ disable: false, fileName: assistantQuizSettings.script });`)],
  ] as const) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true, what);
    });
  }
});

test("a script name with blanks around it cannot be vouched for: whether the page trims them depends on its loader", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: worker(` ${SCRIPT} `) } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — the ad script of chat\.thecadrion\.com is named " chatthecadrion " — with blanks around it/);
    assert.deepEqual(pageCalls, [WORKER_URL]);
  });
});

test("a loader that changes the script's NAME on the way is not known: the file checked would not be the file loaded", async () => {
  for (const value of ["assistantQuizSettings.script.toLowerCase()", "assistantQuizSettings.script + '.min'", "`${assistantQuizSettings.script}-v2`", "prefix + assistantQuizSettings.script"]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: withCall(`loadRemoteScript({ ${D}, fileName: ${value} });`) } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, value);
      assert.match(!r.ok ? r.error : "", /is not in a form the launcher knows \(nothing in it loads the ad script the settings name\)/, value);
      assert.deepEqual(pageCalls, [WORKER_URL], value);
    });
  }
});

test("a loader that takes its ad scripts from another CDN than the one checked is not known — until the launcher is told where", async () => {
  const other = worker(SCRIPT).replace('baseUrl = "https://scr.actview.net"', 'baseUrl = "https://cdn.new-av.example"');
  const named = withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings.script, baseUrl: "https://cdn.new-av.example" });`);
  const computed = withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings.script, baseUrl: CDN });`);
  const nowhere = worker(SCRIPT).replace('baseUrl = "https://scr.actview.net"', "baseUrl = window.AV_CDN");
  for (const [what, body, why] of [
    ["its default", other, /its ad scripts come from https:\/\/cdn\.new-av\.example, the launcher checks https:\/\/scr\.actview\.net — AV_CHAT_SCRIPT_CDN/],
    ["named in the call", named, /its ad scripts come from https:\/\/cdn\.new-av\.example, the launcher checks https:\/\/scr\.actview\.net — AV_CHAT_SCRIPT_CDN/],
    ["computed in the call", computed, /where it takes its ad scripts from cannot be read/],
    ["computed as the default", nowhere, /where it takes its ad scripts from cannot be read/],
  ] as const) {
    assert.ok(body !== worker(SCRIPT), `the fixture really changed: ${what}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, what);
      assert.match(!r.ok ? r.error : "", why, what);
      assert.deepEqual(pageCalls, [WORKER_URL], what);
    });
  }
  const moved = `https://cdn.new-av.example/${SCRIPT}.js`;
  for (const body of [other, named]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body }, [moved]: SERVED }, async ({ pageCalls }) => {
      process.env.AV_CHAT_SCRIPT_CDN = "https://cdn.new-av.example";
      assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
      assert.deepEqual(pageCalls, [WORKER_URL, moved, BASE], "the file checked is the file the page loads");
    });
  }
  // the checked CDN named in the call is the checked CDN
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: withCall(`loadRemoteScript({ ${D}, fileName: assistantQuizSettings.script, baseUrl: "https://scr.actview.net/" });`) } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
});

test("a loader with two lists of required parts cannot be judged by either: a failed check (502)", async () => {
  const LIST = '["key", "terms", "theme", "config", "botNames"]';
  const themeCheck = `function validateTheme(theme) {\n  const requiredFields = ["chat-background", "chat-text"];\n  return requiredFields.every((f) => Boolean(theme[f]));\n}\n\n`;
  for (const [what, body] of [
    ["another list of the same name first", worker(SCRIPT).replace("function validateSettings", `${themeCheck}function validateSettings`)],
    ["another list of the same name after", worker(SCRIPT).replace(CALL, `${themeCheck}${CALL}`)],
    ["two inline lists", worker(SCRIPT).replace(`const requiredFields = ${LIST};\n  const missingFields = requiredFields.filter`, `const missingFields = ${LIST}.filter`).replace(CALL, `const themeOk = ["chat-background"].every((f) => f);\n${CALL}`)],
  ] as const) {
    assert.ok(body !== worker(SCRIPT), `the fixture really changed: ${what}`);
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, what);
      assert.match(!r.ok ? r.error : "", /is not in a form the launcher knows \(what its page requires cannot be read\)/, what);
    });
  }
});

test("a list of required parts that is no short list of names cannot be judged, and a refusal names only a few parts", async () => {
  const LIST = '["key", "terms", "theme", "config", "botNames"]';
  for (const [what, list] of [
    ["a name longer than a name", JSON.stringify(["key", "x".repeat(200)])],
    ["more parts than any page has", JSON.stringify(Array.from({ length: 60 }, (_, i) => `part${i}`))],
  ] as const) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT).replace(LIST, list) } }, async () => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, what);
      assert.match(!r.ok ? r.error : "", /what its page requires cannot be read/, what);
      assert.ok(!r.ok && r.error.length < 500, `${what}: the error is ${!r.ok ? r.error.length : 0} characters long`);
    });
  }
  const tenMore = JSON.stringify(["key", "terms", "theme", "config", "botNames", ...Array.from({ length: 10 }, (_, i) => `extra${i}`)]);
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT).replace(LIST, tenMore) } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /incomplete \(no extra0, extra1, extra2, extra3, extra4 and 5 more\)/);
  });
});

test("a settings file that is mostly noise is judged at once: the reading of the loader is bounded", async () => {
  for (const noise of ["assistantQuizSettings[ ", "assistantQuizSettings.x", "/[", "'"]) {
    const body = `${worker(SCRIPT)}\n${noise.repeat(Math.floor(200_000 / noise.length))}`;
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      const started = performance.now();
      await chat.resolveAvChat(SHAPE, "thecadrion.com");
      const took = performance.now() - started;
      assert.ok(took < 1000, `${JSON.stringify(noise)} repeated: ${Math.round(took)} ms`);
    });
  }
});

test("AV_CHAT_LOADER_CHECK=off lets a loader the launcher does not know through — its settings are still judged", async () => {
  const unknown = withCall(`const options = { ${D}, fileName: assistantQuizSettings.script };\nloadRemoteScript(options);`);
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: unknown } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502, "known or not, the default is to check");
  });
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: unknown } }, async () => {
    process.env.AV_CHAT_LOADER_CHECK = "off";
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
  });
  for (const [body, want] of [
    [unknown.replace(/\s*"botNames": \[[^\]]*\],/, ""), /^chat_not_monetized — .*incomplete \(no botNames\)/],
    [unknown.replace(`"script": "${SCRIPT}"`, '"script": ""'), /^chat_not_monetized — .*Pending monetization/],
    [unknown.replace('"disable": false', '"disable": true'), /^chat_not_monetized — ads are switched off/],
  ] as const) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async () => {
      process.env.AV_CHAT_LOADER_CHECK = "off";
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.match(!r.ok ? r.error : "", want);
    });
  }
});

test("an ad script that is NAMED but not served (AV's CDN answers 403 / 404) is refused: the chat loads no ad code", async () => {
  // The CDN's own word for a file it does not have (read live 29.09: 403, application/xml, Server: AmazonS3).
  for (const page of [
    { status: 403, body: NO_SCRIPT, type: "application/xml" },
    { status: 404, body: NO_SCRIPT, type: "application/xml" },
    { status: 403, body: NO_SCRIPT, server: "AmazonS3" },
  ] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [SCRIPT_URL]: page }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — chat\.thecadrion\.com names the ad script "chatthecadrion" but .*not published/, JSON.stringify(page));
      assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL], "the chat page is not even fetched");
    });
  }
});

test("a 403 / 404 that is not the CDN's own word for a missing file (a block page, a proxy) is a failed check, not 'not published'", async () => {
  for (const page of [
    { status: 403, body: "<html>Request blocked</html>", type: "text/html" },
    { status: 404, body: "not found", type: "text/plain" },
    { status: 403, body: "" },
  ] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [SCRIPT_URL]: page }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the ad script of chat\.thecadrion\.com could not be checked/, JSON.stringify(page));
      assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL], JSON.stringify(page));
    });
  }
});

test("a script CDN that cannot vouch for the script (down, erroring, answering a page) is a failed check (502)", async () => {
  for (const page of ["throw", { status: 503, body: "" }, { status: 200, body: "<html>maintenance</html>", type: "text/html" }, { status: 301, location: "https://elsewhere.example/x.js" }] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [SCRIPT_URL]: page }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — the ad script of chat\.thecadrion\.com/, JSON.stringify(page));
      assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL], JSON.stringify(page));
    });
  }
});

test("an ad script name that is not a file name is never turned into a request", async () => {
  for (const name of ["../thecadrion", "a/b", "x?y=1", "chat thecadrion", "https://evil.example/x", "x#y", "%2e%2e"]) {
    await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker(name) }, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, name);
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — /, name);
      assert.deepEqual(pageCalls, [WORKER_URL], name);
    });
  }
});

test("a refusal never carries more of the remote settings than a name's worth", async () => {
  const long = `bad name ${"x".repeat(50_000)}`;
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker(long) }, [BASE]: { status: 200 } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.ok(!r.ok && r.error.length < 400, `the error is ${!r.ok ? r.error.length : 0} characters long`);
    assert.match(!r.ok ? r.error : "", /"bad name x+…"/);
  });
});

test("a script name with a dot is a file name (read live: \"chatcuponseamostras.com\")", async () => {
  const name = "chatthecadrion.com";
  const url = `https://scr.actview.net/${name}.js`;
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker(name) }, [url]: SERVED, [BASE]: { status: 200 } }, async ({ pageCalls }) => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(pageCalls, [WORKER_URL, url, BASE]);
  });
});

test("AV_CHAT_SCRIPT_CDN overrides where the ad script is looked for (an https origin only)", async () => {
  const moved = `https://cdn.new-av.example/${SCRIPT}.js`;
  // ActiveView moved its CDN: its loaders take their ad scripts from there, and the launcher is told
  const movedLoader = worker(SCRIPT).replace('baseUrl = "https://scr.actview.net"', 'baseUrl = "https://cdn.new-av.example"');
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: movedLoader }, [moved]: SERVED }, async ({ pageCalls }) => {
    process.env.AV_CHAT_SCRIPT_CDN = "https://CDN.new-av.example/";
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(pageCalls, [WORKER_URL, moved, BASE]);
  });
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    process.env.AV_CHAT_SCRIPT_CDN = "http://10.0.0.1/scripts";
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, BASE], "anything but an https origin is ignored");
  });
});

test("the ad settings are read from the settings literal only, whichever way its keys are written", async () => {
  // Decoys on BOTH sides of the literal: a defaults object above it that names no script and
  // switches ads off, and the same below it — neither may be mistaken for the host's settings.
  const decoy = `{ key: "", script: "", config: { disable: true } }`;
  const bareKeys = `const defaults = ${decoy};
const assistantQuizSettings = {
  key: '${KEY}',
  script: '${SCRIPT}',
  botNames: ["Anna"],
  terms: { company: "Thecadrion" },
  theme: {},
  config: { disable: false, disableContent: true, quantityResponses: 2 },
};
const fallback = ${decoy};
${LOADER}`;
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body: bareKeys } }, async () => {
    assert.deepEqual(await chat.resolveAvChat(SHAPE, "thecadrion.com"), { ok: true, kind: "chat", base: BASE, site: "thecadrion.com" });
  });
});

test("the settings file is read only as far as the settings need, whatever its size", async () => {
  const head = new TextEncoder().encode(worker(SCRIPT));
  const filler = new TextEncoder().encode(`// ${"x".repeat(64 * 1024 - 4)}\n`);
  let served = 0;
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        served += 1;
        c.enqueue(served === 1 ? head : filler);
      },
    });
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const res = url === WORKER_URL ? new Response(endless(), { status: 200 }) : new Response(url === SCRIPT_URL ? "/* ad script */" : "<html></html>", { status: 200, headers: url === SCRIPT_URL ? { "content-type": "application/javascript" } : {} });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.ok(served * 64 * 1024 <= 1024 * 1024, `read ${served} chunks of an endless file`);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("a chat host the gateway has no route for (activation unfinished) is the buyer's fix", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 404, body: NO_ROUTE } }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_not_live — .*Chat Builder/);
  });
});

test("a chat host still behind the gateway's default certificate is an unfinished activation (400)", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: "tls" }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
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
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — .*EAI_AGAIN/);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("ad settings that cannot be read are a failed check (502): an unconfirmed chat never launches", async () => {
  for (const page of ["throw", { status: 500, body: "upstream error" }, { status: 200, body: "<html>not the settings file</html>" }, { status: 301, location: "https://elsewhere.example/worker.js" }] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: page }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", /^destination_check_failed — /, JSON.stringify(page));
      assert.deepEqual(pageCalls, [WORKER_URL], JSON.stringify(page));
    });
  }
});

test("a chat address that answers anything but 200 is refused — a redirect included, which is never followed", async () => {
  for (const page of [{ status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" }, { status: 301, location: "https://elsewhere.example/landing" }, { status: 302, location: `https://${HOST}/other` }] as Page[]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: page }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, JSON.stringify(page));
      assert.match(!r.ok ? r.error : "", new RegExp(`^chat_not_live — https://chat\\.thecadrion\\.com/\\?asst=6a2312cef9f4e11b130fc523 answered ${(page as { status: number }).status}`), JSON.stringify(page));
      assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, BASE], "nothing past the chat address is requested");
    });
  }
});

test("a chat address that answers with a passing trouble (408 / 429 / 5xx) is a failed check (502), and is asked again next time", async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 520]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: { status, body: "upstream" } }, async ({ pageCalls }) => {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 502, String(status));
      assert.match(!r.ok ? r.error : "", new RegExp(`^destination_check_failed — https://chat\\.thecadrion\\.com/\\?asst=6a2312cef9f4e11b130fc523 answered ${status}`), String(status));
      await chat.resolveAvChat(SHAPE, "thecadrion.com");
      assert.deepEqual(pageCalls.filter((u) => u === BASE), [BASE, BASE], String(status));
    });
  }
});

test("a chat that does not answer is a failed check (502), not the buyer's fix", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: "throw" }, async () => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /^destination_check_failed — /);
  });
});

test("a path on the chat host that names no chat id is refused before anything is fetched", async () => {
  const shape = { base: `https://${HOST}/some-article`, host: HOST, path: "/some-article" };
  await withStubs({ [HOST]: [GATEWAY] }, READY, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^chat_url_invalid — /);
    assert.deepEqual(pageCalls, []);
  });
});

test("a shape whose address names another host than the one it claims is refused before anything is fetched", async () => {
  const shape = { base: `https://evil.example/?asst=${ID}`, host: HOST, path: "/" };
  await withStubs({ [HOST]: [GATEWAY], "evil.example": [GATEWAY] }, { ...READY, [`https://evil.example/?asst=${ID}`]: { status: 200 } }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_invalid — /);
    assert.deepEqual(pageCalls, []);
  });
});

test("a subdomain that is not a chat host is destination_not_av and nothing of it is fetched", async () => {
  const shape = { base: "https://blog.thecadrion.com/post", host: "blog.thecadrion.com", path: "/post" };
  await withStubs({ "blog.thecadrion.com": ["some-cdn.example"] }, {}, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(shape, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 400);
    assert.match(!r.ok ? r.error : "", /^destination_not_av — blog\.thecadrion\.com/);
    assert.deepEqual(pageCalls, []);
  });
});

test("a DNS outage while resolving a chat is a failed check (502) and nothing of the host is fetched", async () => {
  await withStubs({ [HOST]: "ESERVFAIL" }, { [DOH(HOST)]: "throw" }, async ({ pageCalls }) => {
    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
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
      refused(r);
      assert.equal(!r.ok && r.status, 400, host);
      assert.deepEqual(dnsCalls, [], host);
      assert.deepEqual(pageCalls, [], host);
    });
  }
});

test("a host of another domain — a look-alike included — is never a chat of this site, even behind AV's gateway", async () => {
  for (const host of ["chat.other-site.com", "chat.notthecadrion.com", "notthecadrion.com", "thecadrion.com.evil.example"]) {
    const shape = { base: `https://${host}/?asst=${ID}`, host, path: "/" };
    await withStubs({ [host]: [GATEWAY] }, { [`https://${host}/worker.js`]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED, [shape.base]: { status: 200 } }, async ({ dnsCalls, pageCalls }) => {
      const r = await chat.resolveAvChat(shape, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400, host);
      assert.deepEqual(dnsCalls, [], host);
      assert.deepEqual(pageCalls, [], host);
    });
  }
});

// ---------- a refusal never turns into READY through a cache ----------

test("a host that STAYS pending is refused every time, and its settings are re-read every time", async () => {
  for (const body of [worker(""), worker(SCRIPT, true)]) {
    await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [WORKER_URL]: { status: 200, body } }, async ({ pageCalls }) => {
      for (const n of [1, 2]) {
        const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
        refused(r);
        assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /, `resolve ${n}`);
      }
      assert.deepEqual(pageCalls, [WORKER_URL, WORKER_URL]);
    });
  }
});

test("a host whose ad script stays unpublished is refused every time", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [SCRIPT_URL]: { status: 403, body: NO_SCRIPT, type: "application/xml" } }, async ({ pageCalls }) => {
    for (const n of [1, 2]) {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /, `resolve ${n}`);
    }
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, WORKER_URL, SCRIPT_URL]);
  });
});

test("a chat address that keeps answering 404 is refused every time", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { ...READY, [BASE]: { status: 404 } }, async () => {
    for (const n of [1, 2]) {
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.match(!r.ok ? r.error : "", /^chat_not_live — /, `resolve ${n}`);
    }
  });
});

test("a host that became ready is launchable at once: a refusal is never served from the cache", async () => {
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const pending = stubPages({ ...READY, [SCRIPT_URL]: { status: 403, body: NO_SCRIPT, type: "application/xml" } });
  try {
    refused(await chat.resolveAvChat(SHAPE, "thecadrion.com"));
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

test("a READY host whose ads were switched off: the card's Retry sees it and the next launch is refused", async () => {
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const ready = stubPages(READY);
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    ready.restore();
    const off = stubPages({ ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT, true) } });
    try {
      const hosts = await chat.avChatHosts(["thecadrion.com"], true);
      assert.equal(hosts[0]?.live, false);
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.equal(!r.ok && r.status, 400);
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
    } finally {
      off.restore();
    }
  } finally {
    d.restore();
    ready.restore();
  }
});

test("a refusal drops the READY memory even when an older, overlapping check wrote it a moment before", async () => {
  // A launch reads the host while ads are on; a forced card refresh reads it after they were
  // switched off and answers LAST. The launch's READY must not outlive that refusal.
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  const gates: { url: string; release: (body: string) => void }[] = [];
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const answer = (body: string, type?: string) => {
      const res = new Response(body, { status: 200, headers: type ? { "content-type": type } : {} });
      Object.defineProperty(res, "url", { value: url });
      return res;
    };
    if (url === SCRIPT_URL) return answer("/* ad script */", "application/javascript");
    if (url === BASE) return answer("<html></html>");
    return new Promise<Response>((resolve) => gates.push({ url, release: (body) => resolve(answer(body)) }));
  }) as typeof fetch;
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    const launch = chat.resolveAvChat(SHAPE, "thecadrion.com");
    await settle();
    const refresh = chat.avChatHosts(["thecadrion.com"], true);
    await settle();
    assert.deepEqual(gates.map((g) => g.url), [WORKER_URL, WORKER_URL], "both checks are reading the host");
    gates[0].release(worker(SCRIPT));
    assert.equal((await launch).ok, true);
    gates[1].release(worker(SCRIPT, true));
    assert.equal((await refresh)[0]?.live, false);

    const next = chat.resolveAvChat(SHAPE, "thecadrion.com");
    await settle();
    assert.equal(gates.length, 3, "the next launch reads the host again instead of trusting the older READY");
    gates[2].release(worker(SCRIPT, true));
    const r = await next;
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — ads are switched off/);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("an older check that ENDS after a newer refusal does not bring READY back", async () => {
  // A launch reads the settings while ads are on and goes on to the script CDN; the card's Retry
  // reads them after ads were switched off and is refused at once — a refusal needs no CDN round
  // trip, so it ends first. The launch's CDN answer lands last: it is the OLDER reading.
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  const gates: { url: string; release: (body: string) => void }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = (body: string, type?: string) => {
      const res = new Response(body, { status: 200, headers: type ? { "content-type": type } : {} });
      Object.defineProperty(res, "url", { value: url });
      return res;
    };
    if (url === BASE) return answer("<html></html>");
    return new Promise<Response>((resolve) => gates.push({ url, release: (body) => resolve(answer(body, url === SCRIPT_URL ? "application/javascript" : undefined)) }));
  }) as typeof fetch;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  try {
    const launch = chat.resolveAvChat(SHAPE, "thecadrion.com");
    await settle();
    gates[0].release(worker(SCRIPT));
    await settle();
    assert.deepEqual(gates.map((g) => g.url), [WORKER_URL, SCRIPT_URL], "the launch is waiting for the script CDN");

    const retry = chat.avChatHosts(["thecadrion.com"], true);
    await settle();
    assert.equal(gates[2]?.url, WORKER_URL, "the newer check is reading the host");
    gates[2].release(worker(SCRIPT, true));
    assert.equal((await retry)[0]?.live, false);

    gates[1].release("/* ad script */");
    assert.equal((await launch).ok, true, "the launch keeps its own verdict");

    assert.equal((await chat.avChatHosts(["thecadrion.com"]))[0]?.live, false, "the card still shows the newer reading");
    const next = chat.resolveAvChat(SHAPE, "thecadrion.com");
    await settle();
    assert.equal(gates.length, 4, "the next launch reads the host again instead of trusting the older READY");
    gates[3].release(worker(SCRIPT, true));
    const r = await next;
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — ads are switched off/);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("a refusal takes the READY memory away whatever its age — and is not what the card remembers when a newer check has spoken", async () => {
  // The launch (started first) and the card's Retry (started second) both read the settings with
  // ads on; the CDN serves the Retry and, a moment later, no longer serves the launch: the launch's
  // refusal is the older CHECK and the newer word about the script.
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  const gates: { url: string; release: (res: Response) => void }[] = [];
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === WORKER_URL) return new Response(worker(SCRIPT), { status: 200 });
    if (url === BASE) return new Response("<html></html>", { status: 200 });
    return new Promise<Response>((resolve) => gates.push({ url, release: resolve }));
  }) as typeof fetch;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const served = () => new Response("/* ad script */", { status: 200, headers: { "content-type": "application/javascript" } });
  try {
    const launch = chat.resolveAvChat(SHAPE, "thecadrion.com");
    await settle();
    const retry = chat.avChatHosts(["thecadrion.com"], true);
    await settle();
    assert.deepEqual(gates.map((g) => g.url), [SCRIPT_URL, SCRIPT_URL], "both checks are waiting for the script CDN");
    gates[1].release(served());
    assert.equal((await retry)[0]?.live, true);
    gates[0].release(new Response(NO_SCRIPT, { status: 403, headers: { "content-type": "application/xml" } }));
    const refusedLaunch = await launch;
    refused(refusedLaunch);
    assert.match(!refusedLaunch.ok ? refusedLaunch.error : "", /^chat_not_monetized — .*not published/);

    const before = asked.filter((u) => u === WORKER_URL).length;
    const card = chat.avChatHosts(["thecadrion.com"]);
    await settle();
    assert.equal(asked.filter((u) => u === WORKER_URL).length, before + 1, "the card reads the host again: neither the READY nor the older check's refusal is served from memory");
    gates[2].release(served());
    assert.equal((await card)[0]?.live, true);
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("the READY verdict is per host: a pending host is refused after another host resolved", async () => {
  const HOST2 = "c2.thecadrion.com";
  const BASE2 = `https://${HOST2}/?asst=${ID}`;
  await withStubs({ [HOST]: [GATEWAY], [HOST2]: [GATEWAY] }, { ...READY, [`https://${HOST2}/worker.js`]: { status: 200, body: worker("") }, [BASE2]: { status: 200 } }, async () => {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    const r = await chat.resolveAvChat({ base: BASE2, host: HOST2, path: "/" }, "thecadrion.com");
    refused(r);
    assert.match(!r.ok ? r.error : "", /^chat_not_monetized — c2\.thecadrion\.com/);
  });
});

// ---------- the caches expire, and stay small ----------

/** The clock the caches read (Date.now), moved by hand. It must NOT start at 0: a cache that stores
 *  a timestamp may test it for truthiness. */
const T0 = Date.parse("2026-09-29T10:00:00Z");

test("the READY verdict lasts 5 minutes: inside it the host is not re-read, after it the host is re-read", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({ [HOST]: [GATEWAY] });
  const ready = stubPages(READY);
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    mock.timers.tick(4 * 60_000);
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(ready.calls.filter((u) => u === WORKER_URL), [WORKER_URL], "inside the TTL the settings are not read again");
    ready.restore();
    const off = stubPages({ ...READY, [WORKER_URL]: { status: 200, body: worker(SCRIPT, true) } });
    try {
      mock.timers.tick(60_000 + 1);
      const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
      refused(r);
      assert.match(!r.ok ? r.error : "", /^chat_not_monetized — /);
      assert.deepEqual(off.calls, [WORKER_URL]);
    } finally {
      off.restore();
    }
  } finally {
    ready.restore();
    d.restore();
    mock.timers.reset();
  }
});

test("the chat-host (CNAME) verdict lasts 5 minutes", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({ [HOST]: [GATEWAY] });
  try {
    await chat.avChatHost(HOST);
    mock.timers.tick(4 * 60_000);
    await chat.avChatHost(HOST);
    assert.deepEqual(d.calls, [HOST]);
    mock.timers.tick(60_000 + 1);
    await chat.avChatHost(HOST);
    assert.deepEqual(d.calls, [HOST, HOST]);
  } finally {
    d.restore();
    mock.timers.reset();
  }
});

test("a chat address proven live is re-checked after 10 minutes", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({ [HOST]: [GATEWAY] });
  const p = stubPages(READY);
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    mock.timers.tick(9 * 60_000);
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(p.calls.filter((u) => u === BASE), [BASE], "inside the TTL the chat address is not fetched again");
    mock.timers.tick(60_000 + 1);
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(p.calls.filter((u) => u === BASE), [BASE, BASE]);
  } finally {
    p.restore();
    d.restore();
    mock.timers.reset();
  }
});

test("the address cache stays bounded: past 500 chats the oldest is forgotten (any id answers, so ids are unbounded)", async () => {
  const idOf = (n: number) => n.toString(16).padStart(24, "0");
  const baseOf = (n: number) => `https://${HOST}/?asst=${idOf(n)}`;
  const pages: Record<string, Page> = { [WORKER_URL]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED };
  for (let n = 0; n <= 500; n++) pages[baseOf(n)] = { status: 200 };
  await withStubs({ [HOST]: [GATEWAY] }, pages, async ({ pageCalls }) => {
    for (let n = 0; n <= 500; n++) assert.equal((await chat.resolveAvChat({ base: baseOf(n), host: HOST, path: "/" }, "thecadrion.com")).ok, true);
    await chat.resolveAvChat({ base: baseOf(500), host: HOST, path: "/" }, "thecadrion.com");
    await chat.resolveAvChat({ base: baseOf(0), host: HOST, path: "/" }, "thecadrion.com");
    assert.equal(pageCalls.filter((u) => u === baseOf(500)).length, 1, "a recent address is still remembered");
    assert.equal(pageCalls.filter((u) => u === baseOf(0)).length, 2, "the oldest one was forgotten and is checked again");
  });
});

// ---------- the card's hint: which sites have a chat host, and is it ready ----------

test("the chat-host probe lists chat.<site> only for the sites that have one, ready once its ad script is served", async () => {
  await withStubs({ [HOST]: [GATEWAY], "chat.second-site.com": ["parking.example"] }, { [WORKER_URL]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED }, async () => {
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com", "second-site.com"]), [{ host: HOST, site: "thecadrion.com", live: true }]);
  });
});

test("the probe also reads a KNOWN chat's host — a subdomain other than chat.<site> (lp1, owner 30.09) — through the same gate", async () => {
  const LP1 = "lp1.thecadrion.com";
  chat._setAvKnownChats([{ host: LP1, id: ID, name: "Emily" }]);
  try {
    await withStubs({ [LP1]: [GATEWAY] }, { [`https://${LP1}/worker.js`]: { status: 200, body: worker("") } }, async ({ dnsCalls }) => {
      const hosts = await chat.avChatHosts(["thecadrion.com"], true);
      assert.deepEqual([...dnsCalls].sort(), [HOST, LP1].sort(), "chat.<site> and the known host are both read");
      assert.equal(hosts.length, 1, "chat.<site> is no chat host here — only the known one is listed");
      assert.equal(hosts[0].host, LP1);
      assert.equal(hosts[0].site, "thecadrion.com");
      assert.equal(hosts[0].live, false, "no ad script yet: the money gate still says not ready");
      assert.match(hosts[0].liveReason ?? "", /^chat_not_monetized — /);
    });
    await withStubs({ [LP1]: [GATEWAY] }, { [`https://${LP1}/worker.js`]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED }, async () => {
      assert.deepEqual(await chat.avChatHosts(["thecadrion.com"], true), [{ host: LP1, site: "thecadrion.com", live: true }]);
    });
  } finally {
    chat._setAvKnownChats([]);
  }
});

test("a known chat host that is no subdomain of our sites is never probed", async () => {
  chat._setAvKnownChats([{ host: "lp1.elsewhere.com", id: ID, name: "not ours" }]);
  try {
    await withStubs({}, {}, async ({ dnsCalls }) => {
      assert.deepEqual(await chat.avChatHosts(["thecadrion.com"], true), []);
      assert.deepEqual(dnsCalls, [HOST]);
    });
  } finally {
    chat._setAvKnownChats([]);
  }
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

test("a chat host whose DNS could not be checked is listed as 'could not check' — never silently dropped as 'no chat host'", async () => {
  await withStubs({ [HOST]: "ETIMEOUT" }, { [DOH(HOST)]: "throw" }, async () => {
    const hosts = await chat.avChatHosts(["thecadrion.com"]);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, HOST);
    assert.equal(hosts[0].live, false);
    assert.match(hosts[0].liveReason ?? "", /^destination_check_failed — the DNS lookup of chat\.thecadrion\.com failed/);
  });
});

test("a forced probe (the card's Retry) re-reads DNS and the host instead of the cached verdict", async () => {
  await withStubs({ [HOST]: [GATEWAY] }, { [WORKER_URL]: { status: 200, body: worker(SCRIPT) }, [SCRIPT_URL]: SERVED }, async ({ dnsCalls, pageCalls }) => {
    await chat.avChatHosts(["thecadrion.com"]);
    await chat.avChatHosts(["thecadrion.com"]);
    assert.deepEqual(dnsCalls, [HOST], "an unforced probe answers from the cache");
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL]);
    await chat.avChatHosts(["thecadrion.com"], true);
    assert.deepEqual(dnsCalls, [HOST, HOST]);
    assert.deepEqual(pageCalls, [WORKER_URL, SCRIPT_URL, WORKER_URL, SCRIPT_URL]);
  });
});

test("the card's hint remembers a not-ready host for a minute (every card load would pay the probe) — a launch never reads that memory", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({ [HOST]: [GATEWAY] });
  const p = stubPages({ ...READY, [WORKER_URL]: { status: 200, body: worker("") } });
  try {
    assert.equal((await chat.avChatHosts(["thecadrion.com"]))[0].live, false);
    assert.equal((await chat.avChatHosts(["thecadrion.com"]))[0].live, false);
    assert.deepEqual(p.calls, [WORKER_URL], "the second card load answers from the hint's memory");
    refused(await chat.resolveAvChat(SHAPE, "thecadrion.com"));
    assert.deepEqual(p.calls, [WORKER_URL, WORKER_URL], "the launch re-read the host");
    mock.timers.tick(60_000 + 1);
    await chat.avChatHosts(["thecadrion.com"]);
    assert.deepEqual(p.calls, [WORKER_URL, WORKER_URL, WORKER_URL], "after a minute the hint re-reads it too");
  } finally {
    p.restore();
    d.restore();
    mock.timers.reset();
  }
});

test("a host the hint remembered as not ready is launchable the moment it is ready", async () => {
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const pending = stubPages({ ...READY, [WORKER_URL]: { status: 200, body: worker("") } });
  try {
    assert.equal((await chat.avChatHosts(["thecadrion.com"]))[0].live, false);
    pending.restore();
    const ready = stubPages(READY);
    try {
      assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
      assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), [{ host: HOST, site: "thecadrion.com", live: true }], "and the hint follows the launch's fresher verdict");
    } finally {
      ready.restore();
    }
  } finally {
    d.restore();
    pending.restore();
  }
});

test("the card's hint remembers a DNS check that FAILED for a minute (every card load would pay its timeouts) — a launch never reads that memory", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({ [HOST]: "ETIMEOUT" });
  const p = stubPages({ [DOH(HOST)]: "throw" });
  try {
    const first = await chat.avChatHosts(["thecadrion.com"]);
    assert.match(first[0]?.liveReason ?? "", /^destination_check_failed — the DNS lookup of chat\.thecadrion\.com failed/);
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), first);
    assert.deepEqual(d.calls, [HOST], "the second card load answers from the hint's memory");

    const r = await chat.resolveAvChat(SHAPE, "thecadrion.com");
    refused(r);
    assert.equal(!r.ok && r.status, 502);
    assert.deepEqual(d.calls, [HOST, HOST], "the launch asked DNS itself");

    await chat.avChatHosts(["thecadrion.com"], true);
    assert.deepEqual(d.calls, [HOST, HOST, HOST], "the card's Retry asks again");

    mock.timers.tick(60_000 + 1);
    await chat.avChatHosts(["thecadrion.com"]);
    assert.deepEqual(d.calls, [HOST, HOST, HOST, HOST], "after a minute the hint asks again");
  } finally {
    p.restore();
    d.restore();
    mock.timers.reset();
  }
});

test("a DNS check that failed for the card is forgotten the moment a check of the host succeeds", async () => {
  chat._resetAvChatCaches();
  const down = stubCname({ [HOST]: "ETIMEOUT" });
  const noDoh = stubPages({ [DOH(HOST)]: "throw" });
  try {
    assert.equal((await chat.avChatHosts(["thecadrion.com"]))[0]?.live, false);
  } finally {
    down.restore();
    noDoh.restore();
  }
  const up = stubCname({ [HOST]: [GATEWAY] });
  const ready = stubPages(READY);
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), [{ host: HOST, site: "thecadrion.com", live: true }], "the card follows the launch's fresher word");
  } finally {
    up.restore();
    ready.restore();
  }
});

// ---------- the card's hint: one probe per host at a time, and what it remembers ----------

test("a read of the card's hint while a probe of the host is running joins it — the card's Retry included", async () => {
  chat._resetAvChatCaches();
  const d = stubCname({ [HOST]: [GATEWAY] });
  const real = globalThis.fetch;
  const asked: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === WORKER_URL) await gate;
    const p = READY[url] as { status: number; body?: string; type?: string };
    const res = new Response(p.body ?? "<html></html>", { status: p.status, headers: p.type ? { "content-type": p.type } : {} });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  try {
    const load = chat.avChatHosts(["thecadrion.com"]);
    await new Promise((r) => setImmediate(r));
    const retry = chat.avChatHosts(["thecadrion.com"], true);
    await new Promise((r) => setImmediate(r));
    release?.();
    const [a, b] = await Promise.all([load, retry]);
    assert.deepEqual(a, [{ host: HOST, site: "thecadrion.com", live: true }]);
    assert.deepEqual(b, a);
    assert.deepEqual(asked.filter((u) => u === WORKER_URL), [WORKER_URL], "the host was read once");
    assert.deepEqual(d.calls, [HOST], "DNS was asked once");
    await chat.avChatHosts(["thecadrion.com"], true);
    assert.deepEqual(asked.filter((u) => u === WORKER_URL), [WORKER_URL, WORKER_URL], "a Retry after the probe ended reads the host again");
  } finally {
    globalThis.fetch = real;
    d.restore();
  }
});

test("the card's memory of a failed DNS check yields to a host a launch proved meanwhile", async () => {
  chat._resetAvChatCaches();
  let fail: (() => void) | undefined;
  let n = 0;
  const m = mock.method(dns.Resolver.prototype, "resolveCname", async () => {
    n += 1;
    if (n === 1) return new Promise<string[]>((_resolve, reject) => (fail = () => reject(Object.assign(new Error("queryCname ETIMEOUT"), { code: "ETIMEOUT" }))));
    return [GATEWAY];
  });
  const cancel = mock.method(dns.Resolver.prototype, "cancel", () => {});
  const p = stubPages({ ...READY, [DOH(HOST)]: "throw" });
  try {
    const card = chat.avChatHosts(["thecadrion.com"]);
    await new Promise((r) => setImmediate(r));
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true, "the launch proved the host");
    fail?.();
    assert.deepEqual(await card, [{ host: HOST, site: "thecadrion.com", live: true }], "the card's failing question yields to what the launch proved");
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), [{ host: HOST, site: "thecadrion.com", live: true }], "and nothing of the failure is remembered");
  } finally {
    p.restore();
    m.mock.restore();
    cancel.mock.restore();
  }
});

test("a site without a chat host is remembered so for the card a minute — its Retry asks again, a launch never reads it", async () => {
  chat._resetAvChatCaches();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const d = stubCname({});
  try {
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), []);
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), []);
    assert.deepEqual(d.calls, [HOST], "the second card load answers from memory");
    refused(await chat.resolveAvChat(SHAPE, "thecadrion.com"));
    assert.deepEqual(d.calls, [HOST, HOST], "the launch asked DNS itself");
    await chat.avChatHosts(["thecadrion.com"], true);
    assert.deepEqual(d.calls, [HOST, HOST, HOST], "Retry asks again");
    mock.timers.tick(60_000 + 1);
    await chat.avChatHosts(["thecadrion.com"]);
    assert.equal(d.calls.length, 4, "after a minute the card asks again");
  } finally {
    d.restore();
    mock.timers.reset();
  }
});

test("a CNAME added a moment ago is seen by the card at once when a launch saw it", async () => {
  chat._resetAvChatCaches();
  const before = stubCname({});
  try {
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), []);
  } finally {
    before.restore();
  }
  const after = stubCname({ [HOST]: [GATEWAY] });
  const p = stubPages(READY);
  try {
    assert.equal((await chat.resolveAvChat(SHAPE, "thecadrion.com")).ok, true);
    assert.deepEqual(await chat.avChatHosts(["thecadrion.com"]), [{ host: HOST, site: "thecadrion.com", live: true }]);
  } finally {
    p.restore();
    after.restore();
  }
});
