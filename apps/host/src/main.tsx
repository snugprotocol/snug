// Host kit entry — the ONE entry (TASK-20261003 K1). Everything the page does is `boot`
// (boot.tsx): decide the binding, compose its platform, install it BEFORE any playground
// module reads it, and render the playground's App. The theme is imported here because
// this file is the page: every branch of the boot — the callback page and the refusals
// included — is drawn with it. (After the boot's own imports, as it always was: the
// stylesheet's order in the built page follows import order.)

import { boot } from './boot.js';

import '@playground/theme/tokens.css';
import '@playground/theme/app.css';

void boot();
