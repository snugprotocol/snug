// LegalPage — renders a legal content module (legal/terms.ts, legal/privacy.ts) at
// /terms and /privacy (ADR-0055 §1/§4; TASK-20260823-legal-terms-privacy-eula AC1).
//
// Disclosure, not a gate: this is an ordinary route reachable from the footer and from
// Settings → about, and on the desktop shell it renders OFFLINE — the content is data
// bundled with the app, so a legal page never becomes a network request (a legal page
// that phones home would be a new egress in an app whose threat model discloses the one
// it has, R-30). The website renders the same modules through its own Astro component;
// the two renderers walk the same three node kinds (text, link, list/table/quote).

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import type { Block, LegalDocument, Run } from '../legal/legalShared.js';
import { ExternalLink } from '../ui/ExternalLink.js';

function Runs({ runs }: { runs: Run[] }): ReactElement {
  return (
    <>
      {runs.map((run, i) =>
        typeof run === 'string' ? (
          run
        ) : run.href.startsWith('/') ? (
          <Link key={i} to={run.href}>
            {run.label}
          </Link>
        ) : (
          <ExternalLink key={i} href={run.href}>
            {run.label}
          </ExternalLink>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { block: Block }): ReactElement {
  switch (block.kind) {
    case 'p':
      return (
        <p>
          <Runs runs={block.runs} />
        </p>
      );
    case 'quote':
      return <blockquote className="legal-quote">{block.text}</blockquote>;
    case 'list':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Runs runs={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="legal-table-wrap">
          <table className="legal-table">
            <thead>
              <tr>
                {block.head.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Runs runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function LegalPage({ doc }: { doc: LegalDocument }): ReactElement {
  return (
    <article className="legal-page" data-testid={`legal-page-${doc.slug}`}>
      <header className="legal-head">
        <h1>{doc.title}</h1>
        <p className="hint">updated {doc.updated}</p>
        <p className="legal-intro">
          <Runs runs={doc.intro} />
        </p>
      </header>
      {doc.sections.map((section) => (
        <section key={section.id} className="legal-section" aria-labelledby={section.id}>
          <h2 id={section.id}>{section.heading}</h2>
          {section.blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </section>
      ))}
    </article>
  );
}
