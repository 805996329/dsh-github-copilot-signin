/**
 * Drive the plugin's tools against a fake Cordis context.
 *
 * Verifies what needs no network: tool registration, the cards the plugin asks, the
 * notice relay (device code + verification url), cancellation on both cards, the
 * GitHub Enterprise path, the explicit-domain path, sign-out, an early flow failure,
 * and the diagnostic when no authorization flow is registered.
 *
 * The module under test is `../index.js` exactly as shipped — nothing here rewrites
 * it. Its three harness imports are resolved from this directory's `node_modules`,
 * because the plugin's peers are not installable outside a DSH runtime:
 *
 *   mkdir -p test/node_modules/@deepseek-ai
 *   # @deepseek-ai/dsh-tools        -> { defineTool: (options) => options }
 *   # @deepseek-ai/dsh-authorization-> { AuthorizationDeclinedError }
 *   # @deepseek-ai/dsh-credentials  -> { credentialKey: (scope, id) => `${scope}/${id}` }
 *
 * Run: node test/selftest.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

let moduleUnderTest;
try {
  moduleUnderTest = await import(pathToFileURL(join(packageRoot, 'index.js')).href);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error(
    'selftest: the plugin peers are not resolvable. Install them, or create the three\n' +
      'stub packages described in this file\'s header under test/node_modules/@deepseek-ai/.',
  );
  process.exit(2);
}
const { apply, name, inject } = moduleUnderTest;

// --- question ids the plugin puts on the wire, and what a scripted human answers ---
const ANSWER_KEYS = {
  domain: 'domain',
  'enterprise-host': 'enterpriseHost',
  'device-code': 'deviceCode',
  'flow-prompt': 'flow',
};

const GITHUB_COM_LABEL = 'github.com (Recommended)';
const GHE_LABEL = 'GitHub Enterprise Server';
const DONE = "I've finished in the browser";
const CANCEL = 'Cancel sign-in';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scripted human plus the fake harness services the plugin needs.
 *
 * `answers` maps an answer key to the answer given; a key with no scripted answer
 * stays unanswered, which is how a card behaves until the human acts. A flow that
 * must stay parked until the human confirms awaits `phase.deviceCodeAnswered`.
 */
function createHarness({ flow, record, answers }) {
  const tools = new Map();
  const asked = [];
  const answered = [];
  const phase = { deviceCodeAnswered: undefined };
  const deviceCodeAnswered = new Promise((resolve) => {
    phase.deviceCodeAnswered = resolve;
  });
  let current = record;

  const credentials = {
    readRecord: async () => current,
    deleteRecord: async () => {
      current = undefined;
    },
  };

  // Mirrors the real registry's surface: register() stores a definition and returns
  // the exact disposer that removes it, and get(name) resolves it back. `effect`
  // exists because register() runs the insertion inside one.
  const toolsRegistry = {
    effect: (fn) => {
      const result = fn();
      return typeof result === 'function' ? result : () => {};
    },
    register: (definition) => {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    get: (name) => tools.get(name),
  };

  const ctx = {
    tools: toolsRegistry,
    authorization: {
      describe: (key) => (flow === undefined ? undefined : { key, label: 'GitHub Copilot', methods: [{ id: 'oauth' }], inFlight: false }),
      cancel: () => {},
      begin: async (request) => {
        request.interaction.notify({
          message: 'Enter this code on the verification page to finish signing in.',
          url: 'https://github.com/login/device',
          code: 'ABCD-1234',
        });
        await request.interaction.notify({ message: 'Enabling models…' });
        return flow(request);
      },
    },
    userQuestions: {
      ask: async (request) => {
        const question = request.questions[0];
        const key = ANSWER_KEYS[question.id];
        if (key === undefined) throw new Error(`selftest: unrecognised question id ${JSON.stringify(question.id)}`);
        asked.push(question);
        const scripted = answers[key];
        if (scripted === undefined) return new Promise(() => {}); // unanswered
        const answer = typeof scripted === 'function' ? await scripted(question, phase) : scripted;
        // Record the answer before releasing a flow parked on it, the way the real
        // service settles a call and its answer is observed together.
        answered.push(question.id);
        if (question.id === 'device-code') phase.deviceCodeAnswered();
        return { answers: [{ id: question.id, selected: [], ...answer }] };
      },
    },
    get: (key) => (key === 'credentials' ? credentials : undefined),
  };

  return { ctx, tools, asked, answered, phase, deviceCodeAnswered, getRecord: () => current };
}

const signIn = (ctx) => ctx.tools.get('github_copilot_sign_in');
const signOut = (ctx) => ctx.tools.get('github_copilot_sign_out');
const execCtx = () => ({ signal: new AbortController().signal });

/**
 * The harness refuses a tool result that is not lossless JSON, and an object member
 * whose value is `undefined` is exactly that. A real GitHub grant has no `account`
 * field, which is how this slipped through the first time: the fixtures all had one.
 * @param value - the value to inspect.
 * @returns one line per offending path, empty when the value is admissible.
 */
function losslessViolations(value, path = '$', seen = new Set()) {
  const problems = [];
  const walk = (v, p) => {
    if (v === undefined) { problems.push(`${p}: undefined`); return; }
    if (typeof v === 'number' && !Number.isFinite(v)) { problems.push(`${p}: non-finite`); return; }
    if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') { problems.push(`${p}: ${typeof v}`); return; }
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) { problems.push(`${p}: cycle`); return; }
    seen.add(v);
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${p}[${i}]`));
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype) problems.push(`${p}: exotic prototype`);
      for (const [k, member] of Object.entries(v)) walk(member, `${p}.${k}`);
    }
    seen.delete(v);
  };
  walk(value, path);
  return problems;
}

/** Assert every tool result in this case is admissible as a tool result. */
function expectLossless(label, value) {
  const problems = losslessViolations(value);
  assert.deepEqual(problems, [], `${label} returned a value the harness would refuse: ${problems.join('; ')}`);
}

// -------------------------------------------------------------------------------
// 1. package metadata
assert.equal(name, 'github-copilot-signin');
assert.deepEqual(inject, ['tools', 'authorization', 'userQuestions']);

// 2. no authorization flow registered -> an actionable diagnostic, nothing asked
{
  const h = createHarness({ flow: undefined, record: undefined, answers: {} });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'unavailable');
  assert.match(result.detail, /llm-pi-ai/);
  assert.equal(h.asked.length, 0, 'must not ask anything when the flow is missing');
  expectLossless('no-flow diagnostic', result);
  console.log('ok  no-flow diagnostic:', result.status);
}

// 3. happy path: domain card, device-code card, authorization
{
  let committed;
  const h = createHarness({
    flow: async () => {
      await h.phase.deviceCodeAnswered; // a real flow parks in its poll until confirmed
      committed = {
        kind: 'grant',
        payload: { type: 'oauth', access: 'copilot-token', expires: Date.now() + 1800000, availableModelIds: ['gpt-5.5', 'gpt-6-sol'], account: 'octocat' },
      };
      return { status: 'authorized' };
    },
    record: undefined,
    answers: {
      domain: { selected: [GITHUB_COM_LABEL] },
      deviceCode: async () => {
        await sleep(30); // the human walking to the browser
        return { selected: [DONE] };
      },
    },
  });
  h.ctx.get('credentials').readRecord = async () => committed;
  apply(h.ctx);

  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'authorized');
  assert.equal(result.credential.account, 'octocat');
  assert.equal(result.credential.modelCount, 2);
  assert.deepEqual(result.models, ['gpt-5.5', 'gpt-6-sol']);
  assert.deepEqual(h.answered, ['domain', 'device-code'], 'domain card then device-code card');
  const card = h.asked.find((q) => q.id === 'device-code');
  assert.match(card.question, /ABCD-1234/, 'the card must carry the user code');
  assert.match(card.question, /https:\/\/github\.com\/login\/device/, 'the card must carry the verification url');
  assert.ok(card.options.some((o) => o.label === DONE));
  expectLossless('happy path', result);
  console.log('ok  happy path:', result.status, '| cards:', h.answered.join(' -> '));
}

// 3b. REGRESSION: a real GitHub grant carries no `account` field. Describing it must
//     not emit an `account: undefined` member, which the harness refuses as a result.
{
  let committed;
  const h = createHarness({
    flow: async () => {
      await h.phase.deviceCodeAnswered;
      // Exactly the shape pi-ai stores for github.com: no account, no enterpriseUrl.
      committed = {
        kind: 'grant',
        payload: { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 1800000, availableModelIds: ['gpt-5.5'] },
      };
      return { status: 'authorized' };
    },
    record: undefined,
    answers: {
      domain: { selected: [GITHUB_COM_LABEL] },
      deviceCode: async () => {
        await sleep(20);
        return { selected: [DONE] };
      },
    },
  });
  h.ctx.get('credentials').readRecord = async () => committed;
  apply(h.ctx);

  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'authorized');
  assert.equal(Object.hasOwn(result.credential, 'account'), false, 'a missing account must be omitted, not set to undefined');
  expectLossless('grant without an account', result);
  console.log('ok  grant without account:', result.status, '| credential keys:', Object.keys(result.credential).join(','));
}

// 3c. REGRESSION: pi-ai's first prompt is "GitHub Enterprise URL/domain (blank for
//     github.com)" and a blank answer means github.com. Treating blank as a refusal
//     aborted the whole flow before it ever asked for a device code.
{
  let committed;
  const h = createHarness({
    flow: async (request) => {
      const host = await request.interaction.prompt({
        type: 'text',
        message: 'GitHub Enterprise URL/domain (blank for github.com)',
        placeholder: 'company.ghe.com',
      });
      assert.equal(host, '', 'a blank answer must reach the flow unchanged');
      await h.phase.deviceCodeAnswered;
      committed = { kind: 'grant', payload: { type: 'oauth', access: 'tok', expires: Date.now() + 60000, availableModelIds: ['gpt-5.5'] } };
      return { status: 'authorized' };
    },
    record: undefined,
    answers: {
      domain: { selected: [GITHUB_COM_LABEL] },
      flow: { custom: '' }, // the human pressed Enter on a blank field
      deviceCode: async () => {
        await sleep(30);
        return { selected: [DONE] };
      },
    },
  });
  h.ctx.get('credentials').readRecord = async () => committed;
  apply(h.ctx);

  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'authorized', 'a blank enterprise host must not cancel the sign-in');
  assert.deepEqual(h.answered, ['domain', 'flow-prompt', 'device-code']);
  expectLossless('blank enterprise host', result);
  console.log('ok  blank enterprise host:', result.status, '| cards:', h.answered.join(' -> '));
}

// 4. cancellation on the confirmation card aborts the attempt
{
  const h = createHarness({
    flow: (request) =>
      new Promise((resolve) => {
        request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
      }),
    record: undefined,
    answers: { domain: { selected: [GITHUB_COM_LABEL] }, deviceCode: { selected: [CANCEL] } },
  });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.answered, ['domain', 'device-code']);
  expectLossless('cancel on confirmation', result);
  console.log('ok  cancel on confirmation:', result.status);
}

// 5. cancellation on the domain card starts no flow and asks nothing else
{
  const h = createHarness({ flow: async () => ({ status: 'authorized' }), record: undefined, answers: { domain: { selected: [CANCEL] } } });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.answered, ['domain']);
  expectLossless('cancel on domain', result);
  console.log('ok  cancel on domain:', result.status);
}

// 6. GitHub Enterprise: the host is collected from a card, and pi-ai's own enterprise
//    prompt becomes a card too, so the flow needs no terminal
{
  const seen = [];
  const h = createHarness({
    flow: async (request) => {
      seen.push(await request.interaction.prompt({ type: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)', placeholder: 'company.ghe.com' }));
      await h.phase.deviceCodeAnswered;
      return { status: 'authorized' };
    },
    record: { kind: 'grant', payload: { type: 'oauth', access: 'tok', expires: Date.now() + 60000, availableModelIds: ['gpt-5.5'] } },
    answers: {
      domain: { selected: [GHE_LABEL] },
      enterpriseHost: { custom: 'company.ghe.com' },
      flow: { custom: 'company.ghe.com' },
      deviceCode: async () => {
        await sleep(40);
        return { selected: [DONE] };
      },
    },
  });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'reauthorized', 'an existing record means re-authorization');
  assert.deepEqual(seen, ['company.ghe.com'], 'the flow must receive the host typed into the card');
  assert.deepEqual(h.answered, ['domain', 'enterprise-host', 'flow-prompt', 'device-code']);
  assert.match(h.asked.find((q) => q.id === 'device-code').question, /company\.ghe\.com/);
  expectLossless('enterprise path', result);
  console.log('ok  enterprise path:', result.status, '| host given to pi-ai:', seen[0]);
}

// 7. an explicit domain argument skips the plugin's own domain cards
{
  const seen = [];
  const h = createHarness({
    flow: async (request) => {
      seen.push(await request.interaction.prompt({ type: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' }));
      await h.phase.deviceCodeAnswered;
      return { status: 'authorized' };
    },
    record: { kind: 'grant', payload: { type: 'oauth', access: 'tok', expires: Date.now() + 60000, availableModelIds: [] } },
    answers: {
      flow: { custom: 'ghe.example.com' },
      deviceCode: async () => {
        await sleep(40);
        return { selected: [DONE] };
      },
    },
  });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({ domain: 'ghe.example.com' }, execCtx());
  assert.equal(result.status, 'reauthorized');
  assert.deepEqual(seen, ['ghe.example.com']);
  assert.deepEqual(h.answered, ['flow-prompt', 'device-code'], 'no domain cards when the argument supplies the domain');
  expectLossless('explicit domain', result);
  console.log('ok  explicit domain:', result.status);
}

// 8. sign-out removes the stored record
{
  const h = createHarness({ flow: async () => ({ status: 'authorized' }), record: { kind: 'grant', payload: { type: 'oauth', access: 'tok' } }, answers: {} });
  apply(h.ctx);
  const result = await signOut(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'signed-out');
  assert.equal(h.getRecord(), undefined, 'the record must be gone');
  expectLossless('sign-out', result);
  console.log('ok  sign-out:', result.status);
}

// 9. a flow failure is reported without waiting for the human to answer a card
{
  const h = createHarness({
    flow: async () => {
      throw new Error('github.com unreachable');
    },
    record: undefined,
    answers: { domain: { selected: [GITHUB_COM_LABEL] } }, // the confirmation card stays unanswered
  });
  apply(h.ctx);
  const result = await signIn(h.ctx).execute({}, execCtx());
  assert.equal(result.status, 'failed');
  assert.match(result.detail, /github\.com unreachable/);
  assert.deepEqual(h.answered, ['domain'], 'the tool must not block on a card after the flow already failed');
  expectLossless('early failure', result);
  console.log('ok  early failure:', result.status);
}

console.log('\nall selftest assertions passed');
