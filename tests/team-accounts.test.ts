// Which of a LION profile's ad accounts a team is offered (lib/team.ts): a profile lists its
// persona's own PERSONAL ad account next to the team's business accounts.
// Run: node --test tests/team-accounts.test.ts
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPersonalAccount, teamConfig, teamOffersAccount } from "../lib/team.ts";

const GLO1 = teamConfig("glo-01");
const GLO2 = teamConfig("glo-02");

// The five GLO-02 profiles as LION listed them on 13.10: 51 DRGC-VD-C1-BR-* accounts each, plus one
// account named exactly after the profile's persona — the personal one.
const PERSONAS = ["Адель Иванова", "Ольга Афанасьева", "Анютик Чернова", "Юлия Скворцова", "Даша Медведева"];

test("a personal account is the one named after the profile's own persona", () => {
  for (const persona of PERSONAS) {
    assert.equal(isPersonalAccount(persona, persona), true, persona);
    assert.equal(isPersonalAccount("DRGC-VD-C1-BR-568", persona), false, persona);
  }
  // spacing and letter case are LION's to vary
  assert.equal(isPersonalAccount("  адель   иванова ", "Адель Иванова"), true);
  // another persona's name is not THIS profile's personal account
  assert.equal(isPersonalAccount("Ольга Афанасьева", "Адель Иванова"), false);
  // a profile whose persona name LION leaves empty (FARM / RENT) has no account this can name
  assert.equal(isPersonalAccount("", ""), false);
  assert.equal(isPersonalAccount("GC-HS-VD-C1-BR-12", ""), false);
  assert.equal(isPersonalAccount("", "Адель Иванова"), false);
  assert.equal(isPersonalAccount(null, undefined), false);
});

test("glo-02 is offered only the business accounts; glo-01 keeps every account it had", () => {
  assert.equal(GLO2.personalAccounts, false);
  assert.equal(GLO1.personalAccounts, true);
  for (const persona of PERSONAS) {
    assert.equal(teamOffersAccount(persona, persona, GLO2), false, persona);
    assert.equal(teamOffersAccount("DRGC-VD-C1-BR-618", persona, GLO2), true, persona);
  }
  // the persona is not known (the profile list could not be read) → nothing is hidden
  assert.equal(teamOffersAccount("Адель Иванова", "", GLO2), true);
  // the first team: exactly as before, whatever the account is called
  assert.equal(teamOffersAccount("Allie Hoile", "Allie Hoile", GLO1), true);
  assert.equal(teamOffersAccount("GC-HS-VD-C1-BR-12", "Allie Hoile", GLO1), true);
});
