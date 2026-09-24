# Reading list backend (AWS)

The `/reading-list/` page talks to this backend: a Lambda function behind a public
Function URL, storing everything in one DynamoDB table. A weekly schedule posts the
Slack digest. It replaces the Google Sheet + Apps Script version in
`../reading-list-setup/`, which is retired.

```
page (GitHub Pages)  ──fetch──▶  Lambda Function URL  ──▶  DynamoDB table
                                        ▲
EventBridge Scheduler, Fri 9am ET ──────┘  ──▶  Slack #papers
```

## Cost

Sized to stay inside AWS's always-free allowances, which apply on both account plans:

| service | always free | this backend |
|---|---|---|
| DynamoDB | 25 GB, 25 read + 25 write capacity units (provisioned) | 15 read, 10 write, a few MB |
| Lambda | 1M requests, 400,000 GB-seconds per month | a few thousand requests |
| EventBridge Scheduler | 14M invocations per month | 4 or 5 |

**Choose the Paid plan when you open the account.** New accounts on the Free plan close
automatically after 6 months. The always-free allowances continue on the Paid plan, so at
this usage the bill is $0. The table uses provisioned capacity rather than on-demand
because only provisioned capacity is covered by the free allowance.

## First-time setup

1. **AWS CLI.** Install it (<https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>),
   then run `aws configure` with an access key for your account. `aws sts get-caller-identity`
   should print your account number.

2. **Deploy and import.** From this folder:

   ```sh
   ./deploy.sh --import migration/migration.json
   ```

   This creates the table, function, URL and schedule (1-2 minutes the first time),
   uploads the code, loads the 15 papers, 7 members and this week's votes exported from the
   Google Sheet, and writes the new API address into `_config.yml`.

3. **Delete the export.** `rm migration/migration.json`. It holds passcode hashes, and
   short passcodes can be recovered from their hashes. It is git-ignored, but there is no
   reason to keep it once loaded.

4. **Commit and push** the site. The page and the `_config.yml` change must go out together.

5. **Retire the Apps Script.** In the Sheet: Extensions → Apps Script → Deploy → Manage
   deployments → Archive. Nothing should keep writing to the Sheet after the switch. Votes
   cast on the old site between steps 2 and 4 are not carried over.

6. **Slack.** Sign in on the page as `yi`, open **Admin → Slack**, and paste an incoming
   webhook URL for #papers (api.slack.com/apps → Create New App → From scratch → Incoming
   Webhooks → On → Add New Webhook → #papers). The Friday digest starts once it is saved.
   **Preview digest** shows the text without posting.

Everyone keeps their current name and passcode.

## Day to day

All admin work happens in the **Admin** panel on the page (visible only to admins):

- **Members**: add, reset a passcode, deactivate or reactivate, unlock. Resetting a passcode
  or deactivating someone signs them out on every device.
- **Papers**: edit any field, hide or unhide. Hiding takes a paper off the public list and
  stops voting on it; nothing is deleted.
- **Slack**: set the webhook, preview or send the digest.

If you lock yourself out of the admin account:

```sh
./deploy.sh --add-admin yi      # prompts for a new passcode
```

## Updating the code

Edit `lambda/`, run `./deploy.sh`, then commit and push. If you change the shape of any
request or response, bump `API_VERSION` in `lambda/util.mjs` **and** `EXPECTED_API` in
`assets/js/reading-list.js` together. The page checks the version on load; when the two
disagree it shows a notice and stops sending votes, rather than sending requests the
backend would read differently. That mismatch is what caused the add/remove vote bug in
September 2026: the site had the stacking frontend while the Apps Script was still the
version in which a second click on an arrow meant "undo".

## How it works

**Votes are partitioned by week.** A member's holding on a paper this week lives under
`VOTE#<monday>`, their budget under `USAGE#<monday>`, and the paper's running total in
`TALLY`. Each arrow click is one DynamoDB transaction that moves the holding by one step,
adjusts the budget, adds the difference to the tally, and checks the paper is still
votable. All four commit together or not at all, and each is conditioned on the values
read, so two tabs clicking at once cannot overspend. Last week's holdings are under a
different key, so nothing this week can read or rewrite them; last week's points are
already in the tally, which only ever receives deltas.

**Past weeks are forgotten.** Only the current week's partition is ever read, so who voted
for what is unreachable once the week ends. The rows carry a TTL and DynamoDB deletes them
a few days later.

**Sign-in limits.** Three wrong passcodes pause sign-in for 15 minutes, separately per
network address and per member. The counter is reserved atomically before the passcode is
checked, so twenty simultaneous guesses still get only three checks. IPv6 addresses are
grouped by /64, since one machine is routinely handed a whole /64. A wrong name and a wrong
passcode get the same message.

**Passcodes** are stored as scrypt hashes. Session tokens are signed and carry a version
number on the member record, which is how a reset or deactivation ends existing sessions.

**Read and Archive** are lab-wide states. A paper is in exactly one of: the ranked list,
Read, or Archived. Nobody can add votes to a read or archived paper, but anyone can take
back votes they placed on one.

**Who added what** is stored but not published per paper. The public list carries a 30-day
count per person; the admin Papers tab shows the submitter.

**Duplicate links** are caught across forms of the same paper: arXiv `/abs/` and `/pdf/`,
version suffixes, the same DOI behind different hosts, http versus https, `www.`, trailing
slashes.

## Rules

Change in `lambda/util.mjs`, then `./deploy.sh`.

| rule | value | setting |
|---|---|---|
| upvotes per member per week | 3, stackable on one paper | `UP_PER_WEEK` |
| downvotes per member per week | 3, stackable | `DOWN_PER_WEEK` |
| submissions per member per week | 10 | `SUBS_PER_WEEK` |
| week boundary | Monday 00:00 America/New_York | `TZ` |
| wrong passcodes before a pause | 3 per address, 3 per member | `LOGIN_MAX_ATTEMPTS` |
| pause length | 15 minutes | `LOCKOUT_MINUTES` |
| sign-in lasts | 30 days | `TOKEN_TTL_DAYS` |
| contributor tally window | 30 days | `CONTRIBUTOR_WINDOW_DAYS` |
| digest length | top 5 unread | `DIGEST_TOP_N` |

The digest day and time are in `template.yaml` (`FridayDigest`).

## Tests

Against a local copy of DynamoDB, so conditions and transactions behave as they do in AWS:

```sh
npm install
java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8765 &   # from the DynamoDB Local download
npm test
```

`test/run-tests.mjs` covers budgets, stacking, the cross-week case, concurrent voting,
read/archive, sign-in limits including parallel guessing, sessions, admin, and routing.
`test/import-test.mjs` checks the import against the live Sheet data.
`test/local-server.mjs` serves the handler on a local port for trying the page by hand.

## Files

| file | purpose |
|---|---|
| `lambda/index.mjs` | entry point; routes URL requests, the schedule, and direct invocations |
| `lambda/papers.mjs` | list, vote, submit, read/archive |
| `lambda/auth.mjs` | passcodes, tokens, sign-in limits |
| `lambda/admin.mjs` | admin panel operations, import |
| `lambda/lookup.mjs` | title/venue/year/abstract from a link |
| `lambda/digest.mjs` | Slack digest |
| `lambda/db.mjs` | table layout and DynamoDB calls |
| `lambda/util.mjs` | settings, week arithmetic, link normalizing |
| `template.yaml` | CloudFormation: table, function, URL, permissions, schedule |
| `deploy.sh` | deploy, import, admin recovery, digest on demand |
| `migration/` | the one-time Sheet export (git-ignored) |
