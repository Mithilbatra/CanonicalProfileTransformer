// A plain, honest privacy notice. It is a TEMPLATE: replace the bracketed
// placeholders (controller name, contact, jurisdiction) before going live, and
// have it reviewed for your region (GDPR / India's DPDP Act / CCPA all apply to
// candidate personal data). It describes how the app actually handles data so
// it isn't boilerplate that contradicts the product.

export default function Privacy({ onBack }) {
  return (
    <section className="legal">
      <button className="linklike" onClick={onBack}>← back to the app</button>
      <h2>Privacy &amp; candidate data</h2>
      <p className="legal-lead">
        This tool processes personal data about job candidates on behalf of the recruiting
        organization that uses it. This notice explains what is collected, why, how long it is
        kept, and the rights people have over it. <em>[Replace the bracketed placeholders and have
        this reviewed before you rely on it.]</em>
      </p>

      <h3>Who controls the data</h3>
      <p>
        The data controller is <b>[your organization name]</b>. Questions or requests can be sent to{' '}
        <b>[privacy contact email]</b>.
      </p>

      <h3>What is collected</h3>
      <ul>
        <li>Candidate identity and contact details (name, emails, phone, location).</li>
        <li>Professional information (headline, work history, education, skills, projects, links).</li>
        <li>The <b>source</b> each field came from and a confidence score — the app records provenance for every value.</li>
        <li>Recruiter-added workflow data: pipeline stage, tags, and private notes.</li>
      </ul>

      <h3>Where it comes from &amp; why</h3>
      <p>
        Data is supplied by the recruiting organization — uploaded résumés, CSV/ATS exports, notes,
        and (optionally) public profile links it chooses to enrich from. It is used only to build a
        single, de-duplicated candidate profile and to support hiring decisions. It is not sold, and
        it is not used to train any model.
      </p>

      <h3>AI-assisted features</h3>
      <p>
        Optional AI features (search, briefs, interview kits, outreach drafts) send the relevant
        profile to a language-model provider to generate <em>drafts a human reviews</em>. Their output
        is never written into the stored record and never makes an automated decision about a person.
        These features can be turned off entirely.
      </p>

      <h3>How long it is kept</h3>
      <p>
        An administrator can set a <b>data-retention window</b> in the admin settings; candidate
        records whose most recent source data is older than that window are automatically deleted.
        With no window set, data is kept until manually removed.
      </p>

      <h3>Your rights</h3>
      <p>
        Depending on your jurisdiction you may have the right to access, correct, export, or delete
        your data. The app supports these directly: a record can be corrected field-by-field,
        exported (CSV/JSON), or permanently deleted along with all of its source data. To exercise a
        right, contact <b>[privacy contact email]</b>.
      </p>

      <h3>Security</h3>
      <p>
        Access requires an account and is scoped to a single organization; roles limit who can edit.
        Every action on candidate data is recorded in an audit log. Transport should be served over
        HTTPS in production.
      </p>

      <p className="legal-foot">Last updated: [date]. This is a starting template, not legal advice.</p>
    </section>
  );
}
