// ChatgptButton — "Continue with ChatGPT" in OpenAI's own button format (TASK-20261023-siwc-chatgpt-plan
// §12 L5-6; ADR-0078 §9).
//
// The text IS the accessible name; the logo is decorative (`alt=""`, `aria-hidden`), so the button
// reads the same to a screen reader as it looks. The two SVGs beside `assets/openai-button/` are
// OpenAI's trademark asset, committed VERBATIM with a NOTICE carve-out (not MIT; permission
// revocable) — the black logo on the light theme, the white one where the house theme is dark, as
// OpenAI's guideline asks. Nothing here comes from the DevKit.

import type { ButtonHTMLAttributes, ReactElement } from 'react';

import { useTheme } from '../state/theme.js';
import logoBlack from './assets/openai-button/chatgpt-logo-black.svg?url';
import logoWhite from './assets/openai-button/chatgpt-logo-white.svg?url';

export const CONTINUE_WITH_CHATGPT = 'Continue with ChatGPT';

export type ChatgptButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'>;

export function ChatgptButton({ className, ...rest }: ChatgptButtonProps): ReactElement {
  const theme = useTheme();
  return (
    <button type="button" className={`btn chatgpt-button${className ? ` ${className}` : ''}`} {...rest}>
      <img src={theme === 'dark' ? logoWhite : logoBlack} alt="" aria-hidden="true" width={20} height={20} />
      <span>{CONTINUE_WITH_CHATGPT}</span>
    </button>
  );
}
