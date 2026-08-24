// privacy.ts — the privacy statement, written straight out of the threat model
// (ADR-0055 §1; TASK-20260823-legal-terms-privacy-eula AC2).
//
// Sources, by section: threat-model §2 (assets), §4 boundary 5 (the custody line),
// §6 (R-1, R-3, R-9, R-10, R-27, R-30, R-32), §7 (what the model does not claim);
// ADR-0013 (no backend), ADR-0014 §2/§5 (custody + claim discipline), ADR-0043 (at-rest
// encryption, bounded), ADR-0047 §3/§9 (offered updates; the launch check), ADR-0052
// (feedback deep-links), ADR-0054 (Cloudflare Pages hosting).
//
// RULES THIS FILE OBEYS, pinned by legalContent.test.ts:
//   - it says only what the code can vouch for ("we run no analytics script", not "no
//     analytics" — Cloudflare shows the zone owner aggregate counts regardless);
//   - the third-party table is EXHAUSTIVE and typed (THIRD_PARTIES), so a new egress is a
//     row the test will miss, not prose it will not;
//   - the sync-origin and messaging rows are NOT softened: they are the strongest
//     disclosures in the set and earn the rest their credibility;
//   - every custody/encryption claim stays inside ADR-0014 §5 / threat-model §7 —
//     "zero-knowledge", "end-to-end", "never leave your file" appear only in negation.
//
// Plain data, no JSX: the website renders this through its @playground alias without a
// React integration, and the desktop app renders it offline from Settings → about.

import {
  CDN_HOSTS,
  LEGAL_CONTACT,
  LEGAL_UPDATED,
  PRIVACY_PATH,
  SITE_OPERATOR,
  SITE_OPERATOR_DESCRIBED,
  THREAT_MODEL_URL,
  UPDATE_CHECK_DISCLOSURE,
  UPDATE_CHECK_PAIRING,
  WEBLLM_WEIGHTS_HOST,
  WE_US_OUR_DEFINITION,
  link,
  list,
  p,
  type Block,
  type LegalDocument,
} from './legalShared.js';

/** One row of the "what leaves your device" table. Typed so the test walks rows, not prose. */
export interface ThirdParty {
  id: 'cloudflare' | 'model-provider' | 'cdn' | 'huggingface' | 'github' | 'sync-origin' | 'messaging';
  name: string;
  sees: string;
  when: string;
}

export const THIRD_PARTIES: readonly ThirdParty[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    sees: 'Each request for the website or the hosted Playground: your IP address, browser type, and which page or file you asked for — the ordinary logs of a hosting provider.',
    when: `Whenever you visit snugprotocol.org or the hosted Playground. Cloudflare hosts both as static files for ${SITE_OPERATOR}. We enable no analytics script, no challenge script and no beacon; Cloudflare still shows us aggregate request counts for the zone.`,
  },
  {
    id: 'model-provider',
    name: 'Your model provider (Anthropic, OpenAI, or the endpoint you configured)',
    sees: 'Your prompts, the app data an app puts in front of the model, and the results of any connected-service calls the model asked for.',
    when: 'Whenever the agent runs in "bring your own key" mode. Requests go straight from your browser or the desktop app to the provider, under their own terms, on your own bill. Nothing routes through us. In "local model" mode with an endpoint on this machine or your own network, no model traffic leaves it — if the endpoint you typed is elsewhere, Settings tells you so.',
  },
  {
    id: 'cdn',
    name: CDN_HOSTS.join(', '),
    sees: 'Your IP address and which library file was requested.',
    when: 'When an app you run loads a JavaScript library. Apps can load libraries only from these three hosts and have no other network of their own.',
  },
  {
    id: 'huggingface',
    name: WEBLLM_WEIGHTS_HOST,
    sees: 'Your IP address and which model weights were downloaded.',
    when: "Only if you turn on the experimental in-browser model (the ?webllm=1 flag). The weights download from Hugging Face on first use and are cached by your browser; the model's runtime library downloads from raw.githubusercontent.com (GitHub) the same way.",
  },
  {
    id: 'github',
    name: 'GitHub',
    sees: 'Your IP address, the time, and the desktop app version (the update check); the download itself; and, if you use it, the feedback you chose to send.',
    when: `${UPDATE_CHECK_DISCLOSURE} ${UPDATE_CHECK_PAIRING} Downloading the app from GitHub Releases is a request to GitHub. The in-app feedback links build a prefilled GitHub issue that you review in Snug and then confirm; nothing reaches GitHub until you confirm the jump, and nothing is filed until you submit it there.`,
  },
  {
    id: 'sync-origin',
    name: 'A personal sync origin you connect (for example your own Dropbox)',
    sees: 'Your whole file, including every saved key and token.',
    when: 'Only if you choose that origin in Settings — and then continuously, for as long as it stays selected: the file is re-copied on a schedule, so anyone with access to that storage holds your keys. That is how your file travels between your own devices; it is your storage, and its security is yours.',
  },
  {
    id: 'messaging',
    name: 'A messaging service you link (WhatsApp, through a helper on your computer)',
    sees: 'The other people in your chats — their names, numbers and messages — as far as an app you run reads them; and, when an app sends a thread to your model provider, the content of those messages.',
    when: 'Only if you link the service. Once linked, the helper starts with the desktop app and reconnects to that service on every launch until you unlink it. Linking an automation tool to a personal messaging account may be against that service\'s terms, and accounts have been banned for it. Removing the last linked app ends the session from that service\'s linked-devices list.',
  },
];

function thirdPartyTable(): Block {
  return {
    kind: 'table',
    head: ['Who', 'What they can see', 'When, and why'],
    rows: THIRD_PARTIES.map((t) => [[t.name], [t.sees], [t.when]]),
  };
}

export const PRIVACY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy',
  updated: LEGAL_UPDATED,
  intro: [
    `This statement is written from Snug's threat model, so it says what the software actually does — including the parts we would rather were tidier. The website and the hosted Playground are operated by ${SITE_OPERATOR_DESCRIBED}. The macOS app is distributed by Jeetu Maker. `,
    WE_US_OUR_DEFINITION,
  ],
  sections: [
    {
      id: 'what-does-not-happen',
      heading: 'What does not happen',
      blocks: [
        p(
          'We operate no server that holds your data, we hold no account for you, we run no analytics script, and we set no cookie. There is no sign-up, no profile, and no copy of your file anywhere we can reach. When you use Snug, nothing about you is collected by us — not because of a policy, but because there is nothing on our side to collect it into.',
        ),
        p(
          'Two honest bounds on that sentence. Cloudflare, which hosts the website and the Playground as static files, shows us aggregate request counts for the domain, and GitHub shows download counts for the desktop app; neither identifies you to us. And your file, together with a few preferences (theme, layout, whether the desktop app checks for updates), lives in this app\'s browser storage on this device — on a Mac, the file itself lives in ~/Snug. On a shared computer, that is where they are, readable by whoever else uses that account.',
        ),
      ],
    },
    {
      id: 'where-your-data-lives',
      heading: 'Where your data lives',
      blocks: [
        p(
          'Everything Snug knows — your apps, their data, your chats, your settings, and every API key or token you save — lives in one file that is yours: in your browser\'s private storage on the web, or in ~/Snug in the desktop app. Export it and you have all of it; delete it and it is gone, because we never had a copy.',
        ),
        p(
          'One thing lives beside that file rather than in it: if you link a messaging account, the helper\'s session — its keys, its access token, and a cache of the chats it has synced, which includes other people\'s messages — sits next to the file (in ~/Snug/whatsapp-session on a Mac). It does not ride exports or sync, and deleting the file does not delete it; unlinking the account, or removing the last linked app, does.',
        ),
        p(
          'By default that file is an ordinary database, readable by any program running under your user account on that computer. You can turn on protection in Settings: the whole file is then encrypted at rest with a passphrase only you hold, plus a Recovery Key shown to you once. If you lose both, the data is unrecoverable — there is no reset and no backdoor, which is the point of the feature and also its cost.',
        ),
        p(
          'Snug is not zero-knowledge and not end-to-end encrypted, and we do not claim your keys never leave your file — a personal sync origin you connect carries them, by your choice. What we do claim is exactly this: your keys never reach our servers, because we have none, and your file goes only to storage you choose.',
        ),
      ],
    },
    {
      id: 'what-leaves-your-device',
      heading: 'What leaves your device, and to whom',
      blocks: [
        p(
          'Nothing leaves your device to us. What can leave is decided by choices you make in the app, and each one reaches a third party under that party\'s own terms. This table is meant to be complete; if you find an egress it does not name, that is a bug in this statement and we want to hear about it.',
        ),
        thirdPartyTable(),
      ],
    },
    {
      id: 'update-check',
      heading: 'The desktop update check',
      blocks: [
        p(UPDATE_CHECK_DISCLOSURE, ' ', UPDATE_CHECK_PAIRING),
        p(
          'It is on by default because a desktop app that never learns about a security fix is worse for you than one request to GitHub per launch; the threat model records it as an accepted residual rather than pretending it is not there. The desktop app makes no other automatic outbound request of its own — except the messaging helper described above and a sync origin you selected, each running only because you set it up.',
        ),
      ],
    },
    {
      id: 'other-people',
      heading: 'Other people\'s messages',
      blocks: [
        p(
          'If you link a messaging account and run an app that analyses a conversation, the other people in that conversation never agreed to anything. Their messages reach your model provider because that is what analysing a thread means. Before those messages leave, Snug redacts the names and numbers it has seen from the contact list and replaces them with stable labels; that is a reduction, never a guarantee. The scrub is anti-default and anti-naive, not anti-adversarial — a nickname typed only inside a message, or an app that obfuscates, gets through, and the words themselves always go. The threat model states the exact limits.',
        ),
        p(
          'Linking an automation tool to a personal messaging account may be against that service\'s terms, and accounts have been banned for it. Snug paces its requests, which is harm reduction, not a guarantee. The screen where you link says all of this again, where it matters.',
        ),
      ],
    },
    {
      id: 'security-honestly',
      heading: 'Security, honestly',
      blocks: [
        p(
          'Snug\'s security claims are written down, with the test that would catch each one regressing, in the ',
          link(THREAT_MODEL_URL, 'threat model'),
          '. It also lists, with equal prominence, what is accepted and not mitigated: for example, that a compromise of the page Snug runs in is a compromise of everything it holds, and that the messaging scrub is bounded as described above. Read that document if you are deciding whether to trust this software with something that matters; this statement is the shorter, plainer version of it.',
        ),
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        p(
          'Snug has no accounts and collects nothing, so there is no profile of a child for us to hold, correct or delete. Because the software can connect to real accounts and sends text to a model provider, we ask that a parent or guardian set it up for a child and stay involved in what it is connected to.',
        ),
      ],
    },
    {
      id: 'your-rights',
      heading: 'Your rights, and why the answer is short',
      blocks: [
        p(
          'Under the California Consumer Privacy Act (CCPA), the GDPR and similar laws you have rights to access, correct, delete and port personal information a business holds about you, and to opt out of its sale or sharing. We hold nothing to produce, correct, delete or port, and nothing is sold or shared, because nothing about you reaches us. Your control is direct instead: export your file, or delete it, in Settings.',
        ),
        list(
          ['To see everything Snug knows about you: Settings → your file → export.'],
          ['To erase it: delete the file (the desktop app keeps it in ~/Snug; the web Playground keeps it in this browser\'s site data) — and if you linked a messaging account, unlink it too: its session store lives beside the file.'],
          ['To stop any third-party egress: revoke the connection, unlink the account, choose "this device only" as the sync origin, or turn off the update check — each in Settings.'],
        ),
      ],
    },
    {
      id: 'changes-and-contact',
      heading: 'Changes and contact',
      blocks: [
        p(
          `This statement is dated ${LEGAL_UPDATED} and lives at ${PRIVACY_PATH} on the Playground and on snugprotocol.org. When the software gains a new egress, this statement changes with it and the release notes say so. Questions, corrections, or an egress we failed to name: ${LEGAL_CONTACT}.`,
        ),
      ],
    },
  ],
};
