# Security policy

What raccoon-vtt protects, what it leaves to the people running it, and
the reasoning behind both are in the
[security assurance case](docs/assurance-case.md). This page is about
reporting a vulnerability and what happens next.

## Supported versions

Only the latest release receives security fixes. Self-hosters should follow
the [Updating](docs/self-hosting.md#updating) section of docs/self-hosting.md to keep their installation
current.

## Report a vulnerability

Report it privately through GitHub's private vulnerability reporting, at
https://github.com/jwhitlow45/raccoon-vtt/security/advisories/new. You can
also open this repository's **Security** tab and choose **Report a
vulnerability**. Never report a vulnerability in a public issue, a pull
request or a discussion.

Include the affected version, what you found, steps to reproduce it, the
expected impact, and a minimal proof of concept if possible. Remove passwords,
room links and other private data from logs and screenshots.

## Response times

These are the longest waits, not the usual ones:

- A first reply within 7 days of the report. It confirms the report arrived
  and says whether it is accepted as a vulnerability. If it is, you hear how
  the fix is going until it ships.
- A fix, or a plan with a date for one, within 90 days of the report.

## How a report is handled

Every report goes through the same steps, all inside the private advisory
the report opened:

1. **Acknowledge.** The maintainer sends the first reply, within the time
   above.
2. **Confirm and assess.** The maintainer reproduces the problem, decides
   whether it is a vulnerability, rates its severity with the CVSS
   calculator in the advisory, and works out which releases it affects. If
   it is not a vulnerability, you hear why, and the advisory is closed.
3. **Fix in private.** The fix is prepared privately and is not pushed to
   any public branch until it is ready to release. It comes with a test
   that fails without it, as every bug fix does.
4. **Release.** The fix goes out as a new release, following the usual
   [release process](docs/releasing.md). Server owners update as
   [Updating](docs/self-hosting.md#updating) describes.
5. **Publish.** The advisory is published as described below.

## Coordinated disclosure

This project follows coordinated disclosure. Please keep the report and the
vulnerability's details private until a fixed release is out, or until 90
days have passed since the report, whichever comes first. If a fix needs
longer, you will be asked before that date.

Once the fix ships, its details are published as a GitHub security advisory
for this repository, with the fixed version, and with a CVE when one applies,
requested through GitHub. The advisory credits you by the name you choose,
unless you would rather not be named.
