/**
 * dsh-github-copilot-signin — sign a DSH session in to GitHub Copilot (or another
 * pi-ai catalog provider) through the product's own authorization seam.
 *
 * Design rules this plugin holds to:
 *
 *   1. It implements no OAuth. `ctx.authorization.begin()` runs the flow that
 *      `@deepseek-ai/dsh-llm-pi-ai` already registered for the provider, which is
 *      pi-ai's own device-code login. Client ids, Copilot integration headers, the
 *      API version, the token exchange and the model catalog all stay owned by
 *      pi-ai, so this plugin does not rot when upstream changes them.
 *
 *   2. It writes no credential. The seam's commit contract writes the record under
 *      `llm-pi-ai/<provider>` and refuses a flow that resolved without committing,
 *      so `begin()` returning `authorized` means the record is really stored.
 *
 *   3. It renders no bespoke UI. The seam's neutral vocabulary (a notice carrying a
 *      url and a code, plus plain questions) is relayed into the session's question
 *      card, which every desktop GUI already draws. Nothing about the flow is
 *      GitHub-specific, so the same plugin signs in to any catalog provider that
 *      ships a login.
 *
 * @module dsh-github-copilot-signin
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization';
import { credentialKey } from '@deepseek-ai/dsh-credentials';

/** Providers this plugin is known to be useful for; any catalog provider with a login works. */
const DEFAULT_PROVIDER = 'github-copilot';

/** Domain answer that means "github.com", matching pi-ai's own enterprise prompt semantics. */
const GITHUB_COM_LABEL = 'github.com (Recommended)';
const GHE_LABEL = 'GitHub Enterprise Server';

/** How long to wait for GitHub to issue a device code before giving up. */
const DEVICE_CODE_WAIT_MS = 60_000;

/** How long to wait for a signed-in credential to look usable before reporting anyway. */
const USABLE_READ_ATTEMPTS = 5;
const USABLE_READ_DELAY_MS = 400;

/** A device code is the only notice this plugin needs to show; the rest are progress. */
const ANSWERS = {
  done: "I've finished in the browser",
  cancel: 'Cancel sign-in',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Render one value for a tool result. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** Tool results must survive a strict JSON round trip; an `undefined` member does not. */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = withoutUndefined(member);
  }
  return out;
}

/**
 * Key facts about the credential the seam stored, with no secret material.
 * Every optional member is omitted rather than set to `undefined`: a tool result
 * carrying an `undefined` member is not lossless JSON and the harness refuses it.
 * @param {object|undefined} record - the credential record, if any.
 * @returns a small, log-safe description.
 */
function describeRecord(record) {
  if (record === undefined) return { stored: false };
  if (record.kind !== 'grant') return { stored: true, kind: record.kind };
  const payload = record.payload ?? {};
  return withoutUndefined({
    stored: true,
    kind: 'grant',
    type: payload.type,
    account: payload.account,
    expiresAt: typeof payload.expires === 'number' ? new Date(payload.expires).toISOString() : undefined,
    modelCount: Array.isArray(payload.availableModelIds) ? payload.availableModelIds.length : 0,
  });
}

/** Wait briefly for the stored credential to carry a usable access token. */
async function readUsableRecord(credentials, recordKey) {
  let record;
  for (let attempt = 0; attempt < USABLE_READ_ATTEMPTS; attempt += 1) {
    record = await credentials.readRecord(recordKey);
    const payload = record?.payload;
    if (record?.kind === 'grant' && typeof payload?.access === 'string' && payload.access.length > 0) return record;
    await sleep(USABLE_READ_DELAY_MS);
  }
  return record;
}

/**
 * Ask one question through the session's own question card.
 * @param ctx - plugin context carrying `userQuestions`.
 * @param exec - tool execution context supplying the owning agent and signal.
 * @param question - the single question to put to the human.
 * @returns the answered item, or undefined when no answer arrived.
 */
async function askOne(ctx, exec, question) {
  const result = await ctx.userQuestions.ask({
    questions: [question],
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    signal: exec.signal,
  });
  return result.answers[0];
}

/**
 * Resolve which domain to sign in against. The answer decides both what pi-ai is
 * told (as its enterprise-domain prompt reply) and whether we must ask for a host.
 * @param ctx - plugin context.
 * @param exec - tool execution context.
 * @param requested - the `domain` tool argument, if the caller supplied one.
 * @returns the enterprise domain to hand pi-ai, or undefined for github.com.
 */
async function resolveDomain(ctx, exec, requested) {
  if (typeof requested === 'string' && requested.trim().length > 0) {
    return { domain: requested.trim(), accountKind: 'assumed' };
  }
  const answer = await askOne(ctx, exec, {
    id: 'domain',
    header: 'GitHub Copilot',
    question: 'Which GitHub are you signing in to?',
    options: [
      { label: GITHUB_COM_LABEL, description: 'Public github.com accounts and GitHub Copilot Business.' },
      { label: GHE_LABEL, description: 'A self-hosted GitHub Enterprise Server domain.' },
    ],
  });
  if (answer === undefined || answer.selected?.includes(ANSWERS.cancel)) return { cancelled: true };
  if (!answer.selected?.includes(GHE_LABEL)) return { domain: undefined };

  const host = await askOne(ctx, exec, {
    id: 'enterprise-host',
    header: 'GitHub Copilot',
    question: 'Enter your GitHub Enterprise Server host, for example company.ghe.com',
  });
  const value = (host?.custom ?? '').trim();
  if (value.length === 0) return { cancelled: true };
  return { domain: value };
}

function registerSignInTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'github_copilot_sign_in',
    description:
      'Sign the user in to GitHub Copilot by starting the official GitHub device-code flow. ' +
      'The user is shown a verification URL and a short code to enter in their browser; no terminal is needed. ' +
      'Call this when the user asks to connect, log in to, or bridge their GitHub Copilot subscription, ' +
      'or when a Copilot model request fails for a missing credential.',
    parameters: {
      domain: {
        type: 'string',
        description:
          'GitHub Enterprise Server domain (for example company.ghe.com). Omit for github.com; the user is asked when it is omitted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          detail: { type: 'string' },
          credential: {
            type: 'object',
            additionalProperties: true,
            properties: {
              stored: { type: 'boolean', required: true },
              type: { type: 'string' },
              account: { type: 'string' },
              expiresAt: { type: 'string' },
              modelCount: { type: 'number' },
            },
          },
          models: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const provider = DEFAULT_PROVIDER;
      const recordKey = credentialKey('llm-pi-ai', provider);

      const flow = ctx.authorization.describe(recordKey);
      if (flow === undefined) {
        // The adapter registers one flow per *configured* route, so this state means
        // the route is missing — not that the adapter is unmounted. A fresh DSH mounts
        // llm-pi-ai with no providers at all, which is the common way in here.
        return {
          status: 'unavailable',
          provider,
          detail:
            `The "${provider}" provider route is not configured, so no authorization flow exists for "${recordKey}". ` +
            'Add it in DSH: Settings → Models → Add model provider → Third-party model provider → choose ' +
            `"${provider}" → Save, then reload the page and ask again. ` +
            '(A composition that does not mount @deepseek-ai/dsh-llm-pi-ai at all shows the same error: the route has ' +
            'to exist before any provider can be signed into.)',
        };
      }

      const credentials = ctx.get('credentials');
      const before = credentials === undefined ? undefined : await credentials.readRecord(recordKey);
      const alreadySignedIn = before !== undefined;

      const domainChoice = await resolveDomain(ctx, exec, args.domain);
      if (domainChoice.cancelled === true) return { status: 'cancelled', provider };

      // Everything the flow tells the human, restated for the question card.
      let verificationUri;
      let userCode;
      let lastNotice;

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      exec.signal?.addEventListener('abort', onAbort, { once: true });

      // Declared before the flow starts: `begin()` runs synchronously up to its first
      // await, so it can deliver the device code through `notify` before this module
      // reaches any later line. Declaring it below the call would hit the temporal dead
      // zone and fail every sign-in.
      const deviceCodeReady = Promise.withResolvers();

      // The flow is started first so its device code is available to the card, then
      // awaited through a settled-state handle: racing the human's answer against the
      // raw promise would leave an unhandled rejection when the flow fails early.
      const state = { done: false, outcome: undefined, error: undefined };
      const settled = (async () => {
        try {
          state.outcome = await ctx.authorization.begin({
            key: recordKey,
            method: 'oauth',
            signal: controller.signal,
            interaction: {
              notify(notice) {
                lastNotice = notice.message;
                if (typeof notice.url === 'string') verificationUri = notice.url;
                if (typeof notice.code === 'string') {
                  userCode = notice.code;
                  // Unblocks the confirmation card. Resolving twice is harmless.
                  deviceCodeReady.resolve();
                }
              },
              async prompt(question) {
                const answered = await askOne(ctx, exec, {
                  id: 'flow-prompt',
                  header: 'GitHub Copilot',
                  question: question.message,
                  ...(question.placeholder === undefined ? {} : { detail: `Example: ${question.placeholder}` }),
                });
                // A blank answer is data, not a refusal: pi-ai asks for a GitHub
                // Enterprise host and documents "blank for github.com". Treating blank as
                // a decline aborted the flow before it ever requested a device code.
                if (answered === undefined) throw new AuthorizationDeclinedError();
                const chosen = answered.selected?.[0];
                if (chosen !== undefined && chosen === ANSWERS.cancel) throw new AuthorizationDeclinedError();
                return (answered.custom ?? chosen ?? '').trim();
              },
            },
          });
        } catch (error) {
          state.error = error;
          // The tool reports a sanitized line; the full reason belongs in the log.
          ctx.logger?.warn?.(`github-copilot-signin: authorization attempt failed: ${error?.stack ?? error?.message ?? String(error)}`);
        } finally {
          state.done = true;
        }
      })();

      // The device code arrives through `notify`, so the confirmation card is rendered
      // only once it is in hand: asking earlier would show the human a placeholder and
      // leave them with no code. The wait is bounded so a stalled provider cannot hang
      // the tool, and a failure that lands first is reported without waiting for it.
      const deviceCodeDeadline = sleep(DEVICE_CODE_WAIT_MS).then(() => 'timeout');
      const codeArrived = deviceCodeReady.promise.then(() => 'ready');

      const failureFirst = settled.then(() => {
        if (state.error !== undefined || state.outcome?.status !== 'authorized') return state;
        return new Promise(() => {}); // an authorization is not a completion until confirmed
      });

      const gate = await Promise.race([codeArrived, deviceCodeDeadline, failureFirst]);
      if (gate === 'timeout') {
        ctx.authorization.cancel(recordKey);
        controller.abort();
        exec.signal?.removeEventListener('abort', onAbort);
        await settled;
        return withoutUndefined({
          status: 'failed',
          provider,
          detail: `GitHub did not issue a device code within ${Math.round(DEVICE_CODE_WAIT_MS / 1000)}s. ${lastNotice ?? ''}`.trim(),
        });
      }
      if (gate === state) {
        exec.signal?.removeEventListener('abort', onAbort);
        if (state.error !== undefined) {
          return withoutUndefined({ status: 'failed', provider, detail: `The authorization attempt failed: ${state.error.message ?? String(state.error)}` });
        }
        return withoutUndefined({ status: state.outcome?.status ?? 'failed', provider, detail: lastNotice });
      }

      const answered = await Promise.race([
        askOne(ctx, exec, {
          id: 'device-code',
          header: 'GitHub Copilot',
          question:
            (domainChoice.domain === undefined
              ? 'Open https://github.com/login/device in your browser, then enter this code:\n\n'
              : `Open the device login page for ${domainChoice.domain} in your browser, then enter this code:\n\n`) +
            `${userCode}\n\n` +
            `${verificationUri === undefined ? '' : `Link: ${verificationUri}\n\n`}` +
            'Tell me when you have finished, and I will confirm the sign-in.',
          options: [
            { label: ANSWERS.done, description: 'GitHub has accepted the code and asked you to authorise GitHub Copilot.' },
            { label: ANSWERS.cancel, description: 'Stop the sign-in attempt.' },
          ],
        }),
        failureFirst,
      ]);

      if (answered !== undefined && answered.selected?.includes(ANSWERS.cancel) === true) {
        ctx.authorization.cancel(recordKey);
        controller.abort();
      }

      await settled;
      exec.signal?.removeEventListener('abort', onAbort);

      if (state.error !== undefined) {
        const error = state.error;
        if (error?.code === 'DECLINED' || error?.name === 'AuthorizationDeclinedError') {
          controller.abort();
          return withoutUndefined({ status: 'cancelled', provider });
        }
        return withoutUndefined({ status: 'failed', provider, detail: `The authorization attempt failed: ${error?.message ?? String(error)}` });
      }

      const outcome = state.outcome;
      if (outcome?.status !== 'authorized') {
        return withoutUndefined({ status: outcome?.status ?? 'failed', provider, detail: lastNotice });
      }

      const record = credentials === undefined ? undefined : await readUsableRecord(credentials, recordKey);
      const described = describeRecord(record);
      const models = record?.kind === 'grant' && Array.isArray(record.payload?.availableModelIds)
        ? record.payload.availableModelIds.filter((id) => typeof id === 'string')
        : [];

      return withoutUndefined({
        status: alreadySignedIn ? 'reauthorized' : 'authorized',
        provider,
        detail:
          models.length === 0
            ? 'Signed in. GitHub reported no account-enabled models yet; reopen the model picker to refresh.'
            : `Signed in. ${models.length} model(s) are enabled for this account.`,
        credential: described,
        models,
      });
    },
  }));
}

function registerSignOutTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'github_copilot_sign_out',
    description:
      'Forget the stored GitHub Copilot authorization for this DSH install. This deletes the local credential record only; ' +
      'it does not revoke the grant on GitHub.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => text(value),
    },
    async execute() {
      const provider = DEFAULT_PROVIDER;
      const recordKey = credentialKey('llm-pi-ai', provider);
      const credentials = ctx.get('credentials');
      if (credentials === undefined) {
        return { status: 'unavailable', provider, detail: 'This composition mounts no credentials service.' };
      }
      const existing = await credentials.readRecord(recordKey);
      if (existing === undefined) return { status: 'nothing-stored', provider };
      await credentials.deleteRecord(recordKey);
      return {
        status: 'signed-out',
        provider,
        detail: 'Local record deleted. Revoke the authorization itself at https://github.com/settings/applications if you want it gone on GitHub too.',
      };
    },
  }));
}

export const name = 'github-copilot-signin';
export const inject = ['tools', 'authorization', 'userQuestions'];
export const Config = undefined;

/**
 * Mount the sign-in and sign-out tools.
 * @param ctx - plugin context carrying `tools`, `authorization` and `userQuestions`.
 */
export function apply(ctx) {
  registerSignInTool(ctx);
  registerSignOutTool(ctx);
}
