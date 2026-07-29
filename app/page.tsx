/**
 * Switchboard has no user interface. Everything it does happens over webhooks,
 * and the only human surface is the Telegram supergroup.
 *
 * This page exists for one reason: opening the deployment in a browser should
 * say "this is up and it is switchboard" rather than returning a 404 that reads
 * like a broken deploy.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '3rem', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: '1rem', fontWeight: 600 }}>switchboard</h1>
      <p style={{ fontSize: '0.875rem' }}>
        Akme&apos;s phone and SMS line. No interface here: this service runs on webhooks.
      </p>
    </main>
  );
}
