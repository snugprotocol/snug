// AL-04 D9 — the chat directive card: parse-don't-trust at the reply boundary
// (renderDirectiveSchema before ANY UI effect; malformed ⇒ dropped with a note,
// never partially rendered — mutation M12-table), the validated-evidence-free
// persisted meta (M1), and the card → openWizard intent wiring.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type AuthWizardDirective } from '@snugprotocol/protocol';

import { directiveToMeta, metaToDirective, scanForRenderDirective } from '../agent/renderDirective.js';
import { ChatLog } from '../views/ChatLog.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const directive: AuthWizardDirective = {
  v: PROTOCOL_VERSION,
  kind: 'auth_wizard',
  proposal: { providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme-weather.example'] },
};

describe('D9 — scanForRenderDirective (parse, never trust)', () => {
  it('extracts a valid fenced directive from a prose reply', () => {
    const text = `I built your app. To reach the weather API it needs a connection:\n\n\`\`\`json\n${JSON.stringify(directive)}\n\`\`\`\n\nApprove it when ready.`;
    const scan = scanForRenderDirective(text);
    expect(scan).not.toBeNull();
    expect(scan && 'directive' in scan ? scan.directive.kind : null).toBe('auth_wizard');
  });

  it('extracts a bare (unfenced) directive object too', () => {
    const scan = scanForRenderDirective(`connect it: ${JSON.stringify(directive)}`);
    expect(scan && 'directive' in scan ? scan.directive.proposal.providerName : null).toBe('Acme Weather');
  });

  it('a MALFORMED directive (evidence smuggled in) is reported malformed — never partially rendered', () => {
    const poisoned = { ...directive, evidence: ['a docs quote that could hold a key'] };
    const scan = scanForRenderDirective(`\`\`\`json\n${JSON.stringify(poisoned)}\n\`\`\``);
    expect(scan).toEqual({ malformed: true });
  });

  it('a directive whose proposal carries LLM-authored fields[] is malformed — the label surface never mounts (fix-first 2)', () => {
    const poisoned = {
      ...directive,
      proposal: {
        ...directive.proposal,
        fields: [{ key: 'k', label: 'Your OpenAI admin key (sk-…)', type: 'secret' }],
      },
    };
    const scan = scanForRenderDirective(`\`\`\`json\n${JSON.stringify(poisoned)}\n\`\`\``);
    expect(scan).toEqual({ malformed: true });
  });

  it('an unknown-kind directive is malformed, not silently a card', () => {
    const scan = scanForRenderDirective(JSON.stringify({ ...directive, kind: 'auth_wizard_v9' }));
    expect(scan).toEqual({ malformed: true });
  });

  it('ordinary prose and ordinary JSON yield null (no note, no card)', () => {
    expect(scanForRenderDirective('a perfectly normal reply about tic-tac-toe')).toBeNull();
    expect(scanForRenderDirective('data: {"answer": 42}')).toBeNull();
  });
});

describe('M1 — persisted meta carries ONLY the validated, evidence-free directive', () => {
  it('directiveToMeta → metaToDirective round-trips the validated shape', () => {
    const meta = directiveToMeta(directive);
    expect(metaToDirective(meta)).toEqual(directive);
  });

  it('a persisted meta whose directive grew an evidence field is REJECTED on read', () => {
    const tampered = { directive: { ...directive, evidence: ['quote'] } };
    expect(metaToDirective(tampered)).toBeUndefined();
  });

  it('a persisted meta whose directive PROPOSAL grew fields[] is REJECTED on read — the check descends (fix-first 2)', () => {
    const tampered = {
      directive: {
        ...directive,
        proposal: {
          ...directive.proposal,
          fields: [{ key: 'k', label: 'Your OpenAI admin key (sk-…)', type: 'secret' }],
        },
      },
    };
    expect(metaToDirective(tampered)).toBeUndefined();
  });

  it('a meta without a directive reads as none', () => {
    expect(metaToDirective({ artifact: { appId: 'a', displayName: 'x' } })).toBeUndefined();
    expect(metaToDirective(undefined)).toBeUndefined();
  });
});

describe('D9 — the chat card mounts the wizard intent', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  async function renderLog(messages: ChatMessage[], onDirectiveConnect?: () => void): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ChatLog messages={messages} onDirectiveConnect={onDirectiveConnect} />);
    });
  }

  /**
   * P3: the card is a DOORBELL and no longer hands the directive to the mount. In v4 the
   * requirement was already persisted at build time through the gated pipeline, so what
   * the wizard reviews comes from the ROW — a card that could pass a proposal at click
   * time would be re-opening the channel the persisted-requirement design closed. The
   * guarantee under test is unchanged: the card renders for a validated directive and its
   * button fires the mount.
   */
  it('a message carrying a directive renders the card; connect fires the mount', async () => {
    const onConnect = vi.fn();
    await renderLog(
      [{ id: 1, role: 'agent', displayText: 'this app needs a weather connection', directive }],
      onConnect,
    );
    const card = container.querySelector('[data-testid="auth-directive-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Acme Weather');
    const connect = [...container.querySelectorAll('button')].find((b) => /connect/i.test(b.textContent ?? ''));
    expect(connect).toBeDefined();
    await act(async () => {
      connect!.click();
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
    // The mount is rung with NOTHING: the directive is not an authority over what is
    // reviewed, and there is no argument through which it could become one.
    expect(onConnect).toHaveBeenCalledWith();
  });

  it('without a directive there is no card and no connect button', async () => {
    await renderLog([{ id: 1, role: 'agent', displayText: 'plain reply' }]);
    expect(container.querySelector('[data-testid="auth-directive-card"]')).toBeNull();
  });

  it('a dropped (malformed) directive renders the note, not a card', async () => {
    await renderLog([
      { id: 1, role: 'agent', displayText: 'reply', directiveNote: 'the agent proposed a connection card that failed validation — ignored' },
    ]);
    expect(container.querySelector('[data-testid="auth-directive-card"]')).toBeNull();
    expect(container.textContent).toMatch(/failed validation — ignored/i);
  });
});
