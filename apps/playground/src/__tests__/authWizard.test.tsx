// AL-04 — AuthWizardSheet component contract (plan D5/D3/AC3/AC7/AC10/AC12):
// per-branch behavior, the B1 order wall, provenance-forced spec_confirm, full
// punycoded host disclosure on EVERY path, the re-approval union diff, write-only
// secret fields, and the paste tripwire. Mutations M4/M9/M10/M11/M13/M19/M20/M24.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type AuthWizardDirective } from '@snugprotocol/protocol';
import { UserDbCredentialStore } from '@snugprotocol/auth';

import { AuthWizardSheet } from '../connections/AuthWizardSheet.js';
import {
  __resetWizardStateForTests,
  __setWizardHooksForTests,
  applyInferenceResult,
  openWizard,
  saveWizardClientCreds,
  wizardStepStore,
  wizardStore,
} from '../state/wizard.js';
import * as net from '../state/net.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-wizard';

const apiKeySpec = {
  kind: 'api_key' as const,
  provider: { name: 'Example API' },
  fields: [{ key: 'api_key', label: 'API Key', type: 'secret' as const }],
  declaredApiHosts: ['api.example.com'],
};

const basicSpec = {
  kind: 'basic_auth' as const,
  provider: { name: 'Legacy' },
  fields: [
    { key: 'username', label: 'Username', type: 'text' as const },
    { key: 'password', label: 'Password', type: 'password' as const },
  ],
  declaredApiHosts: ['legacy.example.com'],
};

const clientCredsSpec = {
  kind: 'oauth2_client_creds' as const,
  provider: { name: 'B2B' },
  endpoints: { tokenUrl: 'https://b2b.example.com/oauth/token' },
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' as const },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' as const },
  ],
  declaredApiHosts: ['api.b2b.example.com'],
};

const directive = (proposal: AuthWizardDirective['proposal']): AuthWizardDirective => ({
  v: PROTOCOL_VERSION,
  kind: 'auth_wizard',
  proposal,
});

let container: HTMLDivElement;
let root: Root;

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AuthWizardSheet />);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setInput(el: Element, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function byLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
  const el = container.querySelector(`[aria-label="${label}"]`);
  expect(el, `no element labeled "${label}"`).not.toBeNull();
  return el as HTMLInputElement | HTMLTextAreaElement;
}

function button(re: RegExp): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));
  expect(el, `no button matching ${re}`).toBeDefined();
  return el!;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function seedRow(spec: unknown, approved = false): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Wizard App', html: '<p>x</p>' });
  db.putAuthSpec(APP, spec);
  if (approved) db.approveAuthSpec(APP);
}

beforeEach(async () => {
  await installTestUserDb();
  __resetWizardStateForTests();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  __resetWizardStateForTests();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------- review branches

describe('AC3 — review branch is selected by HOST-computed provenance (M4)', () => {
  it('registry provenance keeps the light prefilled path — wizard.light-path-hosts-displayed (M10/M24)', async () => {
    openWizard({ source: 'directive', appId: APP, directive: directive({ providerName: 'Spotify' }) });
    await renderSheet();
    // Full punycoded host list rendered before approve enables: registry union =
    // accounts.spotify.com (endpoints) + api.spotify.com (registry apiHosts).
    const hosts = container.querySelector('[data-testid="wizard-hosts"]')?.textContent ?? '';
    expect(hosts).toContain('accounts.spotify.com');
    expect(hosts).toContain('api.spotify.com');
    expect(button(/approve connection/i).disabled).toBe(false);
    // Light path — NOT the field-by-field forced confirm.
    expect(container.textContent).not.toMatch(/proposed by a model/i);
  });

  it('inference provenance ALWAYS forces the field-by-field spec_confirm — even at claimed confidence 1.0', async () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: {
        ...directive({ providerName: 'Unknown Corp', kindHint: 'api_key', declaredApiHosts: ['api.unknown.example'] }),
        confidence: 1.0,
        provenance: 'registry', // the claim; the host recomputes (B2)
      },
    });
    await renderSheet();
    expect(container.textContent).toMatch(/proposed by a model/i);
    expect(byLabel('api hosts (comma-separated)').value).toContain('api.unknown.example');
  });

  it('a smuggled host is DISPLAYED in the reviewable list, never silently absent (M27c)', async () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directive({
        providerName: 'Acme Weather',
        kindHint: 'api_key',
        declaredApiHosts: ['api.acme-weather.example', 'exfil.attacker.example'],
      }),
    });
    await renderSheet();
    const hosts = container.querySelector('[data-testid="wizard-hosts"]')?.textContent ?? '';
    expect(hosts).toContain('exfil.attacker.example');
  });

  it('AC7 — a unicode declared host renders as its punycoded xn-- form before approve', async () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directive({ providerName: 'Bücher API', kindHint: 'api_key', declaredApiHosts: ['bücher.example'] }),
    });
    await renderSheet();
    const hosts = container.querySelector('[data-testid="wizard-hosts"]')?.textContent ?? '';
    expect(hosts).toContain('xn--bcher-kva.example');
  });

  it('evidence quotes and the unsure-copy grade render inside spec_confirm (copy only)', async () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directive({ providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme-weather.example'] }),
    });
    applyInferenceResult({
      ok: true,
      provenance: 'user_docs',
      proposal: { providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme-weather.example'] },
      confidence: 0.69,
      evidence: ['"pass your key in the X-Api-Key header"'],
      spec: null,
      reason: 'api_key requires a non-empty declaredApiHosts list (the credential is fail-closed).',
    });
    await renderSheet();
    expect(container.querySelector('[data-testid="wizard-evidence"]')?.textContent).toContain('X-Api-Key');
    expect(container.textContent).toMatch(/the model was unsure/i);
  });

  it('the unsure copy disappears at confidence 0.70 (boundary wiring)', async () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directive({ providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme-weather.example'] }),
    });
    applyInferenceResult({
      ok: true,
      provenance: 'user_docs',
      proposal: { providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme-weather.example'] },
      confidence: 0.7,
      evidence: [],
      spec: null,
      reason: 'r',
    });
    await renderSheet();
    expect(container.textContent).not.toMatch(/the model was unsure/i);
  });
});

describe('AC7/M4 — wizard.reapproval-diff-flags-new-hosts (M20)', () => {
  it('an added host is flagged NEW, a removed host is flagged, and the full list stays visible', async () => {
    await seedRow(apiKeySpec, true);
    openWizard({ source: 'settings', appId: APP, mode: 'reapprove' });
    await renderSheet();

    setInput(byLabel('api hosts (comma-separated)'), 'api.example.com, api.new-host.example');
    await settle();
    const hosts = container.querySelector('[data-testid="wizard-hosts"]')?.textContent ?? '';
    expect(hosts).toContain('api.example.com');
    expect(hosts).toContain('api.new-host.example');
    expect(hosts).toMatch(/NEW — not previously approved/);

    setInput(byLabel('api hosts (comma-separated)'), 'api.new-host.example');
    await settle();
    const after = container.querySelector('[data-testid="wizard-hosts"]')?.textContent ?? '';
    expect(after).toMatch(/removed/i);
    expect(after).toContain('api.example.com'); // still listed, flagged as removed
  });

  it('re-approve routes through reapproveAuthSpec with the edited spec and drops remembered grants (AC9)', async () => {
    await seedRow(apiKeySpec, true);
    const db = await getUserDb();
    const reapprove = vi.spyOn(db, 'reapproveAuthSpec');
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    openWizard({ source: 'settings', appId: APP, mode: 'reapprove' });
    await renderSheet();
    setInput(byLabel('api hosts (comma-separated)'), 'api.example.com, api.new-host.example');
    await settle();
    await click(button(/re-approve connection/i));
    expect(reapprove).toHaveBeenCalledWith(
      APP,
      expect.objectContaining({ declaredApiHosts: ['api.example.com', 'api.new-host.example'] }),
    );
    expect(invalidate).toHaveBeenCalledWith(APP);
  });
});

// -------------------------------------------------------------- B1 order wall

describe('AC12/B1 — approval precedes credentials in every branch (M13)', () => {
  it('wizard.mint-unreachable-while-unapproved — no credentials UI and no service call while unapproved', async () => {
    await seedRow(clientCredsSpec, false);
    const saveClientCreds = vi.fn(async () => undefined);
    __setWizardHooksForTests({
      service: { generateAuthUrl: vi.fn(), handleCallback: vi.fn(), saveClientCreds } as never,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await renderSheet();

    // Step machine parked at review: the credential step is structurally absent.
    expect([...container.querySelectorAll('button')].some((b) => /save & connect/i.test(b.textContent ?? ''))).toBe(false);
    // Even a direct store call cannot reach the mint: the SpecScope helper throws.
    await expect(saveWizardClientCreds({ client_id: 'x', client_secret: 'y' })).rejects.toMatchObject({
      code: 'spec_not_approved',
    });
    expect(saveClientCreds).not.toHaveBeenCalled();
  });

  it('client_creds save-mints POST-approval with the frozen row scope, and approve precedes the mint', async () => {
    await seedRow(clientCredsSpec, false);
    const order: string[] = [];
    const db = await getUserDb();
    const realApprove = db.approveAuthSpec.bind(db);
    vi.spyOn(db, 'approveAuthSpec').mockImplementation((appId) => {
      order.push('approve');
      return realApprove(appId);
    });
    const saveClientCreds = vi.fn(async () => {
      order.push('mint');
    });
    __setWizardHooksForTests({
      service: { generateAuthUrl: vi.fn(), handleCallback: vi.fn(), saveClientCreds } as never,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await renderSheet();
    await click(button(/approve connection/i));
    setInput(byLabel('Client ID'), 'cid-1');
    setInput(byLabel('Client Secret'), 'csec-1');
    await click(button(/save & connect/i));
    expect(saveClientCreds).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['approve', 'mint']);
    const scope = saveClientCreds.mock.calls[0]![0] as { allowedHosts: readonly string[]; clientCreds: Record<string, string> };
    // The frozen ROW union, never a proposal-derived one (M14 companion).
    expect([...scope.allowedHosts]).toEqual(db.getAuthSpec(APP)!.allowedHosts);
    expect(scope.clientCreds).toEqual({ client_id: 'cid-1', client_secret: 'csec-1' });
  });
});

// ------------------------------------------------------- write-only secrets

describe('AC10 — write-only secret fields (M9 value-echo mutation)', () => {
  it('api_key: approve, then the field writes through CredentialStore and clears — never echoed to the DOM', async () => {
    await seedRow(apiKeySpec, false);
    const db = await getUserDb();
    const invalidate = vi.spyOn(net, 'invalidateNetGrants');
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await renderSheet();

    await click(button(/approve connection/i));
    expect(invalidate).toHaveBeenCalledWith(APP);

    const field = byLabel('API Key');
    expect((field as HTMLInputElement).type).toBe('password'); // masked by AuthFieldType
    setInput(field, 'sekrit-value-123');
    await click(button(/save credentials/i));

    const store = new UserDbCredentialStore(db);
    expect(await store.getCredential(APP, 'api_key')).toBe('sekrit-value-123');
    // Write-only: the input cleared, and nothing renders the stored value back.
    expect(container.innerHTML).not.toContain('sekrit-value-123');
  });

  it('a stored credential is NEVER loaded back into the field (pre-seeded store)', async () => {
    await seedRow(apiKeySpec, true);
    const db = await getUserDb();
    await new UserDbCredentialStore(db).setCredential(APP, 'api_key', 'stored-secret-987');
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await renderSheet();
    await click(button(/approve connection/i));
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('');
    expect(container.innerHTML).not.toContain('stored-secret-987');
  });

  it('basic_auth collects its two named fields with password masking', async () => {
    await seedRow(basicSpec, false);
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await renderSheet();
    await click(button(/approve connection/i));
    setInput(byLabel('Username'), 'alice');
    setInput(byLabel('Password'), 'hunter2');
    expect((byLabel('Password') as HTMLInputElement).type).toBe('password');
    await click(button(/save credentials/i));
    const store = new UserDbCredentialStore(await getUserDb());
    expect(await store.getCredential(APP, 'username')).toBe('alice');
    expect(await store.getCredential(APP, 'password')).toBe('hunter2');
  });
});

// ------------------------------------------------------------- paste tripwire

describe('AC10/D10 — the paste tripwire runs BEFORE the completion seam (M19)', () => {
  it('a pasted credential shape warns and blocks; explicit override releases the inference', async () => {
    const runInference = vi.fn(async () => ({
      ok: false as const,
      provenance: 'user_docs' as const,
      code: 'completion_failed' as const,
      message: 'not reached in this test',
    }));
    __setWizardHooksForTests({ runInference } as never);
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directive({ providerName: 'Acme Weather', kindHint: 'api_key' }),
    });
    await renderSheet();

    setInput(byLabel('paste provider docs'), 'here are the docs: sk-live-abcdef1234567890 …');
    await click(button(/infer from docs/i));
    expect(runInference).not.toHaveBeenCalled(); // seam untouched (M19)
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/looks like it contains a credential/i);

    const override = byLabel('send anyway — this is not a real credential');
    await click(override as HTMLElement);
    await click(button(/infer from docs/i));
    expect(runInference).toHaveBeenCalledTimes(1);
  });
});
