import LegalPage from "@/components/legal";

export default function Privacy() {
  return <LegalPage title="Privacy Policy">
    <p>ClipShort processes YouTube video identifiers and the clip settings you submit to create a requested file.</p>
    <h2>Temporary processing</h2><p>Video sections and finished clips are held in temporary storage and automatically deleted within 30 minutes. We do not intend to store videos permanently.</p>
    <h2>Operational data</h2><p>Our service processes your IP address for rate limiting and operational security. The browser stores the last video metadata, editor selection, and job ID locally so a refresh or reopened tab can resume for up to 30 minutes. Server logs omit submitted URLs and query parameters; request IDs and error details may be retained briefly to diagnose failures.</p>
    <h2>Third parties</h2><p>Video metadata and media are retrieved from YouTube. Your use of YouTube content remains subject to YouTube&apos;s terms and privacy practices.</p>
    <h2>Questions</h2><p>Contact the service operator through the deployment that hosts this ClipShort instance.</p>
  </LegalPage>;
}
