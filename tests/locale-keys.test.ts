// Node's built-in runner: `node --test tests/locale-keys.test.ts`. The static Meta ad-locale table the
// VC route targets languages with (no Graph token needed — the TOOL path may have none).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALE_KEYS, localeKeysOf } from "../lib/locale-keys.ts";
import { LOCALES } from "../lib/catalog.ts";

test("every language the card offers is in the table (or is an \"(all)\" pick)", () => {
  for (const name of LOCALES) {
    if (/\(all\)/i.test(name)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(LOCALE_KEYS, name), name);
  }
});

test("localeKeysOf: known names → Meta keys (deduped), (all) → nothing, unmapped → unknown", () => {
  assert.deepEqual(localeKeysOf(["Portuguese (Brazil)", "Spanish (Spain)", "Portuguese (Brazil)"]), { ids: [16, 7], unknown: [] });
  assert.deepEqual(localeKeysOf(["English (all)", "Spanish (all)"]), { ids: [], unknown: [] });
  assert.deepEqual(localeKeysOf(["Chinese (traditional)"]).ids, [21, 22]);
  assert.deepEqual(localeKeysOf(["Zulu", "Klingon", "German"]), { ids: [5], unknown: ["Zulu", "Klingon"] });
  assert.deepEqual(localeKeysOf([]), { ids: [], unknown: [] });
});
