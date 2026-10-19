// Target resolution (P3.4): which account and model a conversation starts on, before any
// engine starts, and which engine serves it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRegistry, newAccount } from "../src/auth/accounts/registry.mjs";
import { accountForProviderId, engineHomeFor, engineIdFor, engineParamsFor, resolveTarget, targetKey } from "../src/auth/accounts/target.mjs";

function fixture() {
  const doc = emptyRegistry();
  const mk = (o, status = "ready") => {
    const a = newAccount(o);
    a.status = status;
    doc.accounts.push(a);
    return a;
  };
  const personal = mk({ provider: "chatgpt", label: "default", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, migratedFrom: "3.0-default-home" });
  const orDefault = mk({ provider: "openrouter", label: "default", method: "api-key", credential: { kind: "secret", ref: "openrouter" }, defaultModel: "or/default-model", migratedFrom: "3.0-openrouter" });
  const work = mk({ provider: "openrouter", label: "work", method: "api-key", defaultModel: "or/work-model" });
  const client = mk({ provider: "openrouter", label: "client-a", method: "api-key" });
  const gone = mk({ provider: "openrouter", label: "old", method: "api-key" }, "needs-sign-in");
  const team = mk({ provider: "chatgpt", label: "team", method: "engine-login", credential: { kind: "engine-home", home: "a/h1" } });
  doc.engines.api.home = "api";
  doc.defaults.target = { account: work.id, model: null, effort: null };
  return { doc, personal, orDefault, work, client, gone, team };
}

test("precedence: a flag beats the window, the window beats AD_ACCOUNT, which beats the project, the default and 3.0", () => {
  const { doc, personal, work, client, team } = fixture();
  const all = { explicit: { account: "openrouter/client-a" }, window: { account: team.id }, env: { AD_ACCOUNT: "chatgpt/default" }, project: { provider: "openrouter", label: "work" }, projectTrusted: true, doc };
  let t = resolveTarget(all);
  assert.equal(t.account.id, client.id);
  assert.equal(t.source, "flag");
  t = resolveTarget({ ...all, explicit: {} });
  assert.equal(t.account.id, team.id);
  assert.equal(t.source, "window");
  t = resolveTarget({ ...all, explicit: {}, window: {} });
  assert.equal(t.account.id, personal.id);
  assert.equal(t.source, "env");
  t = resolveTarget({ ...all, explicit: {}, window: {}, env: {}, project: { provider: "chatgpt", label: "team" } });
  assert.equal(t.account.id, team.id);
  assert.equal(t.source, "project");
  t = resolveTarget({ ...all, explicit: {}, window: {}, env: {}, project: null });
  assert.equal(t.account.id, work.id);
  assert.equal(t.source, "global");
  doc.defaults.target = null;
  t = resolveTarget({ doc, legacyConfig: { model_provider: "openrouter", model: "or/legacy" } });
  assert.equal(t.source, "legacy");
  assert.equal(t.account.migratedFrom, "3.0-openrouter");
  assert.equal(t.model, "or/legacy");
  t = resolveTarget({ doc, legacyConfig: {} });
  assert.equal(t.account.id, personal.id);
});

test("AD_ACCOUNT ranks below the window's choice", () => {
  const { doc, team } = fixture();
  const t = resolveTarget({ window: { account: team.id }, env: { AD_ACCOUNT: "openrouter/client-a", AD_MODEL: "x/model" }, doc });
  assert.equal(t.account.id, team.id);
  assert.equal(t.source, "window");
  // AD_MODEL was meant for the env's account, not the window's.
  assert.equal(t.model, undefined);
});

test("a project selector in an untrusted folder is ignored", () => {
  const { doc, work, client } = fixture();
  const t = resolveTarget({ project: { provider: "openrouter", label: "client-a" }, projectTrusted: false, doc });
  assert.equal(t.account.id, work.id);
  assert.notEqual(t.account.id, client.id);
  assert.equal(t.source, "global");
  assert.deepEqual(t.notes, []);
});

test("a matching selector reports source project and says so once; a stray field or an unknown account is refused with a note", () => {
  const { doc, client } = fixture();
  let t = resolveTarget({ project: { provider: "openrouter", label: "Client-A", model: "m/one" }, projectTrusted: true, doc });
  assert.equal(t.account.id, client.id);
  assert.equal(t.source, "project");
  assert.equal(t.model, "m/one");
  assert.deepEqual(t.notes.map((n) => n.code), ["PROJECT_PICKS"]);
  assert.match(t.notes[0].text, /This project picks OpenRouter · client-a/);
  t = resolveTarget({ project: { provider: "openrouter", label: "client-a", endpoint: "https://evil.example/v1" }, projectTrusted: true, doc });
  assert.equal(t.source, "global");
  assert.deepEqual(t.notes.map((n) => n.code), ["PROJECT_IGNORED"]);
  assert.match(t.notes[0].text, /endpoint/);
  // A needs-sign-in account can't be picked by a project.
  t = resolveTarget({ project: { provider: "openrouter", label: "old" }, projectTrusted: true, doc });
  assert.equal(t.source, "global");
  assert.equal(t.notes[0].code, "PROJECT_IGNORED");
  // A flag wins: the project's pick isn't announced.
  t = resolveTarget({ explicit: { account: "openrouter/work" }, project: { provider: "openrouter", label: "client-a" }, projectTrusted: true, doc });
  assert.deepEqual(t.notes, []);
});

test("not ready → TARGET_NOT_READY with the sign-in command; an unknown flag account → ACCOUNT_NOT_FOUND", () => {
  const { doc } = fixture();
  assert.throws(() => resolveTarget({ explicit: { account: "openrouter/old" }, doc }), (e) => e.code === "TARGET_NOT_READY" && /OpenRouter · old needs its key again: ad auth login openrouter --label old/.test(e.message));
  assert.throws(() => resolveTarget({ explicit: { account: "openrouter/nope" }, doc }), { code: "ACCOUNT_NOT_FOUND" });
});

test("the model: the account's default unless a level at or above it names one", () => {
  const { doc, work } = fixture();
  assert.equal(resolveTarget({ doc }).model, "or/work-model");
  assert.equal(resolveTarget({ explicit: { model: "or/flag-model" }, doc }).model, "or/flag-model");
  const t = resolveTarget({ explicit: { model: "or/flag-model", effort: "high" }, window: { account: work.id, model: "or/window-model" }, doc });
  assert.equal(t.model, "or/flag-model");
  assert.equal(t.effort, "high");
});

test("nothing names an account (a fresh 3.0 home): account null, source legacy", () => {
  const doc = emptyRegistry();
  const t = resolveTarget({ doc, legacyConfig: { model: "m" } });
  assert.equal(t.account, null);
  assert.equal(t.source, "legacy");
});

test("targetKey survives a label rename", () => {
  const { doc, work } = fixture();
  const before = targetKey(resolveTarget({ doc }));
  work.label = "renamed";
  assert.equal(targetKey(resolveTarget({ doc })), before);
  assert.equal(before, `${work.id}/openrouter/or/work-model/-`);
});

test("engineIdFor: api for API accounts (on @default or api/), the account id for a/<id> and for a ChatGPT @default", () => {
  const { doc, personal, work, team } = fixture();
  assert.equal(engineIdFor(work, doc), "api");
  assert.equal(engineHomeFor("api", doc), "api");
  doc.engines.api.home = "@default";
  assert.equal(engineHomeFor("api", doc), "@default");
  assert.equal(engineIdFor(team, doc), team.id);
  assert.equal(engineHomeFor(team.id, doc), "a/h1");
  assert.equal(engineIdFor(personal, doc), personal.id);
  assert.equal(engineHomeFor(personal.id, doc), "@default");
});

test("engineParamsFor: an API account's provider entry; an account home sends none", () => {
  const { doc, work, team } = fixture();
  assert.deepEqual(engineParamsFor({ account: work, model: "m" }, doc), { engineId: "api", modelProvider: work.providerEntry, model: "m", effort: undefined });
  assert.deepEqual(engineParamsFor({ account: team, model: undefined }, doc), { engineId: team.id, modelProvider: undefined, model: undefined, effort: undefined });
});

test("accountForProviderId: an entry, 3.0's openrouter → the adopted key, openai → @default, unknown → null", () => {
  const { doc, personal, orDefault, client } = fixture();
  assert.equal(accountForProviderId(doc, client.providerEntry).id, client.id);
  assert.equal(accountForProviderId(doc, "openrouter").id, orDefault.id);
  assert.equal(accountForProviderId(doc, "openai").id, personal.id);
  assert.equal(accountForProviderId(doc, "ad-openrouter-gone1234"), null);
});

test("a stale AD_ACCOUNT or window account never breaks a flag; without a flag it is skipped with a note", () => {
  const { doc, work, client } = fixture();
  let t = resolveTarget({ explicit: { account: "openrouter/client-a" }, window: { account: "acct_gone" }, env: { AD_ACCOUNT: "openrouter/removed" }, doc });
  assert.equal(t.account.id, client.id);
  assert.deepEqual(t.notes, []);
  t = resolveTarget({ env: { AD_ACCOUNT: "openrouter/removed", AD_MODEL: "meant/for-removed" }, doc });
  assert.equal(t.account.id, work.id);
  assert.equal(t.source, "global");
  assert.equal(t.model, "or/work-model", "the stale level's model is dropped with it");
  assert.equal(t.notes[0].code, "ACCOUNT_IGNORED");
  assert.match(t.notes[0].text, /AD_ACCOUNT "openrouter\/removed"/);
  // An ambiguous label is skipped the same way; a flag's is an error.
  t = resolveTarget({ window: { account: "default" }, doc });
  assert.equal(t.notes[0].code, "ACCOUNT_IGNORED");
  assert.throws(() => resolveTarget({ explicit: { account: "default" }, doc }), { code: "ACCOUNT_AMBIGUOUS" });
});
