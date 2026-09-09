# Reading list — setup

The page at `/reading-list/` is static. Papers and votes live in a Google Sheet,
reached through a Google Apps Script web app. Nothing else is needed: no server,
no database, no build step beyond the usual Jekyll one.

**Google Sheet (already created in your Drive):**
[Lab Paper Reading List — Backend](https://docs.google.com/spreadsheets/d/1kS_6cFw4avyNIOd0ldB1d8QcOxI2KH5R87cbAZa-Ayw/edit)

---

## 1. Install the script

1. Open the Sheet above.
2. **Extensions → Apps Script.** An editor opens with an empty `Code.gs`.
3. Select everything in `Code.gs` and replace it with the contents of
   `reading-list-setup/apps-script.gs`.
4. Click the save icon.
5. In the function dropdown at the top, choose **setup**, then click **Run**.
   Google asks for authorization the first time: choose your account,
   click **Advanced → Go to (project name)**, then **Allow**. This is the standard
   prompt for a script you wrote yourself.
6. Go back to the Sheet. It now has three tabs: **Papers**, **Members**, **Votes**.

## 2. Deploy it as a web app

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear next to "Select type" and pick **Web app**.
3. Set:
   - Description: `reading list v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

"Anyone" means anyone can call the URL, not that anyone can edit the Sheet. The
script only exposes the four actions it implements, and voting still requires a
passcode.

## 3. Point the site at it

In `_config.yml`:

```yaml
reading_list_api: "https://script.google.com/macros/s/AKfyc.../exec"
```

Commit and push. GitHub Pages rebuilds and the page goes live.

## 4. Add lab members

In the **Members** tab, one row per person:

| name | email | passcode | active |
|---|---|---|---|
| Yi Ding | yding37@gmail.com | change-me | yes |
| Madeeha | madeeha@utk.edu | tulip-92 | yes |

- Members sign in with **name or email + passcode**. Name matching ignores case.
- Set `active` to `no` to switch someone off without deleting their votes.
- Passcodes are stored as plain text in the Sheet. They gate a reading list, not
  anything sensitive — give people a throwaway passcode, not one they use elsewhere.
- Use passcodes with at least one letter. An all-digit passcode is stored by Sheets
  as a number, so `007` becomes `7` and the member could not sign in with `007`.
- The Members tab has two more columns, `failed_attempts` and `locked_until`. Leave them
  empty for a new member; the script manages them. See "Failed login attempts" below.
- Delete the seeded `change-me` row or change its passcode before sharing the link.

---

## How the rules work

| Rule | Value | Where to change it |
|---|---|---|
| Upvotes per member per week | 3 | `CONFIG.UPVOTES_PER_WEEK` |
| Downvotes per member per week | 3 | `CONFIG.DOWNVOTES_PER_WEEK` |
| Submissions per member per week | 10 | `CONFIG.SUBMISSIONS_PER_WEEK` |
| Week boundary | Monday 00:00 America/New_York | `CONFIG.TIMEZONE` |
| Login validity | 30 days | `CONFIG.TOKEN_TTL_DAYS` |
| Wrong passcodes before lock | 3 | `CONFIG.LOGIN_MAX_ATTEMPTS` |
| Lockout length | 15 min | `CONFIG.LOGIN_LOCKOUT_MINUTES` |
| Contributor tally window | 30 days | `CONTRIBUTOR_WINDOW_DAYS` |
| Digest day and time | Friday, 9am ET | `DIGEST.DAY`, `DIGEST.HOUR` |
| Papers listed in the digest | 5 | `DIGEST.TOP_N` |

Up and down budgets are separate, so a member can spend 3 up and 3 down in the
same week.

**Votes stack.** A member holds a signed number on each paper, and the arrows move it
one step: up adds, down subtracts. Three upvotes can all go on one paper, or be spread
across three. The ceiling is simply whatever is left of that week's budget.

| you click | your holding goes | budget effect |
|---|---|---|
| up, from 0 | +1 | spends an upvote |
| up, from +2 | +3 | spends another upvote |
| down, from +3 | +2 | refunds an upvote |
| down, from 0 | -1 | spends a downvote |
| up, from -1 | 0 | refunds the downvote |

Stepping toward zero always refunds, so the arrow that reduces a holding stays available
even at zero budget. Arrows that would need a vote you do not have are greyed out.

### Past weeks are forgotten

Only the current week is attributed to anyone. When a week ends, its rows are folded
into two per-paper totals, `carried_up` and `carried_down`, and the rows are deleted.
The paper keeps every point it earned; the record of who cast those votes does not
survive the week.

That means:

- Each Monday everyone starts with a clean 3 and 3 and no arrows lit, whatever they
  voted before. Scores do not reset.
- A vote from a past week cannot be taken back, because it is no longer anyone's.
- The Votes tab stays small. It holds the current week only, not a growing history of
  everyone's opinions.

Folding happens whenever someone votes and again before the Friday digest, so it needs
no schedule of its own. Scores add the carried totals to whatever rows are still
present, so a paper's score is the same whether or not folding has run yet — the timing
is housekeeping, not arithmetic. `archiveOldVotesNow()` runs it by hand if you want the
tab tidied immediately.

The Votes tab gains a `count` column holding the size of each allocation. Rows written
before stacking existed have no count and are read as 1, so nothing needed migrating.

After editing `CONFIG`, save and then **Deploy → Manage deployments → edit (pencil)
→ Version: New version → Deploy**. Editing the code alone does not update the live
web app.

## Who added what

The **Papers** tab records `submitted_by` for every paper, and that column drives the
weekly submission cap. The page never shows it per paper. Instead a single line above
the list gives the aggregate for the last 30 days, for example:

> 12 papers added in the past month: Madeeha 4  Preetham 3  Yi Ding 3  Manish 2

Papers older than the window drop out of the tally but stay on the list with their
votes. Hidden papers count for neither.

To see per-paper attribution, open the Sheet. To change the window, edit
`CONTRIBUTOR_WINDOW_DAYS` near the top of the script and redeploy a new version.

## Running the list

- **Order.** The page sorts by score (up minus down), ties broken by upvotes, then
  by recency. "New" sorts by submission time.
- **Vote columns.** `carried_up` and `carried_down` on a paper are the anonymised
  totals from finished weeks. Edit them only if you want to correct a score by hand.
- **Removing a paper.** In the **Papers** tab set `status` to `hidden`. The row and
  its votes stay for the record but the paper leaves the public list. Deleting the
  row works too.
- **Editing a paper.** Fix the title, venue, summary or tags directly in the Sheet.
  The page reads live values on each load.
- **Adding a paper** starts with the link. The backend fetches the page and fills in
  title, venue, year and abstract; everything stays editable before posting, and
  "Skip lookup and type it in" opens the fields blank.
- **Where lookup data comes from**, in order: the arXiv API, OpenReview's API, Crossref
  by DOI, OpenAlex by DOI (mostly for abstracts Crossref lacks), then the page's own
  `citation_*` meta tags. Anything not found is left blank to fill in.
- **Abstracts are not always available.** Several publishers, Nature among them, do not
  release them to Crossref or OpenAlex. Title, venue and year still arrive; paste the
  abstract or leave it empty.
- The Sheet column is still called `summary`. It holds the abstract now; the header was
  left alone so existing rows keep working.
- **Technical focus** was removed from the form. The column stays in the Sheet, and
  anything you type there still renders as tags, so you can tag papers by hand.
- **Search** covers title, venue, abstract and tags. It does not cover submitter names,
  since those are not published.
- **Duplicate links** are rejected on submit.

## If something breaks

- **"The reading list backend is not connected yet."** `reading_list_api` is still
  blank in `_config.yml`, or the site has not rebuilt since you set it.
- **"Could not reach the backend."** The deployment access is not set to *Anyone*,
  or you pasted the `/dev` URL instead of `/exec`.
- **"Missing tab ... Run setup() once."** Step 1.5 was skipped.
- **Changes to the script have no effect.** You saved but did not deploy a new
  version. See the note above.
- To check the backend on its own, open `<your /exec URL>?action=ping` in a browser.
  A healthy deployment returns `{"ok":true,"pong":true,"week":"..."}`.

## Failed login attempts

Three wrong passcodes for a member lock **that account** for 15 minutes. A correct
passcode resets the counter, and an expired lock clears itself on the next attempt.
During a lock even the correct passcode is refused.

**This is per account, not per IP address.** Apps Script never receives the caller's IP:
the event object it hands `doGet`/`doPost` has no remote-address field, and there is no
API for it. A page can look its own address up and send it along, but an attacker simply
sends a different one, so limiting on it would stop nobody. Per account has the property
that actually matters here: with a fixed list of members, an attacker rotating through
IPs still gets three guesses per name and no more. Genuine per-IP limiting would mean
putting a proxy in front of the web app (a Cloudflare Worker, say) that sees the address
and counts failures before forwarding.

State is kept in the Members tab so it is visible:

| column | meaning |
|---|---|
| `failed_attempts` | consecutive wrong passcodes, cleared on success |
| `locked_until` | timestamp the lock lifts; empty when not locked |

To free someone early, clear both cells for their row, or run **unlockAllMembers** from
the editor. Change the numbers with `CONFIG.LOGIN_MAX_ATTEMPTS` and
`CONFIG.LOGIN_LOCKOUT_MINUTES`.

Note this is a lockout, not a ban: an attacker who knows a member's name can keep that
member locked out by guessing wrong on purpose. For a lab reading list that trade is
worth it, but it is the reason not to reuse these passcodes anywhere that matters.

## Marking papers read

Any signed-in member can click the circle on the right of a paper to move it into the
**Read** section, which sits collapsed under the main list. It is a lab-wide action, not
a personal one: the reading group covers papers together, so a paper leaves the queue for
everyone. Clicking the filled circle moves it back.

The Papers tab gains two columns, `read_at` and `read_by`. They are appended after
`status`, so existing rows keep working and simply show blanks until a paper is marked.
Read papers keep their votes and their place in the contributor tally, but they drop out
of the Top 5 in the Slack digest, since the point of the digest is what to read next.

## Weekly Slack digest

Posts to **#papers** every Friday at 9am Eastern, covering the vote week that began
Monday. Reading group is Wednesday, so the Friday post reports on the week just worked
through.

### 1. Create an incoming webhook

1. Go to <https://api.slack.com/apps> and click **Create New App → From scratch**.
2. Name it (for example `Reading List`) and pick the `assistintlab` workspace.
3. Open **Incoming Webhooks**, turn the toggle **On**.
4. Click **Add New Webhook to Workspace**, choose **#papers**, and **Allow**.
5. Copy the webhook URL. It looks like `https://hooks.slack.com/services/T000/B000/xxxx`.

### 2. Store it as a secret

In the Apps Script editor: **Project Settings** (the gear) → **Script Properties** →
**Add script property**.

| Property | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | the URL you copied |

Keep it there rather than in the code. A webhook URL is a credential: anyone holding it
can post to the channel, and this repo is public.

### 3. Schedule it

Back in the editor, run **installWeeklyDigest** once from the function dropdown. It
clears any previous digest trigger before adding the new one, so running it twice is
safe. Google will ask for the trigger permission the first time.

To check the wording without posting, run **previewWeeklyDigest** and open
**Execution log**. To post immediately, run **postWeeklyDigest**. To stop the schedule,
run **removeWeeklyDigest**.

### What it says

```
*Reading list — week of Sep 7*
3 new papers added this week  ·  6 papers on the list  ·  5 still unread  ·  1 marked read this week

*Top 5 right now*
1. <link|Attention Is All You Need>  _NeurIPS 2017_  — 4 points
2. ...

<https://yding37.github.io/reading-list/|Open the reading list>
```

Change the day, hour, or list length in the `DIGEST` block near the top of the script,
then run `installWeeklyDigest` again to move the trigger. The digest reads the Sheet
directly, so it does not depend on the web app deployment version.

## One-time reauthorization

The lookup feature calls out to arxiv.org, openreview.net, crossref.org and
openalex.org, and the digest posts to Slack, which needs a scope the script did not
previously use (`script.external_request`). Scheduling the digest needs another
(`script.scripts`). The first time you save and deploy this version, Google asks for
authorization again, including the "Advanced → Go to (project name)" step. That is
expected, and it is the same prompt as the first install.

## Redeploying after a code change

Saving the script does **not** change what the live URL runs. A deployment is pinned
to a version, so after editing:

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy.**

The URL stays the same. Only the code behind it changes.

## Files

| File | Purpose |
|---|---|
| `_pages/reading-list.md` | The page and its two dialogs |
| `assets/css/reading-list.css` | Styling, light and dark |
| `assets/js/reading-list.js` | Loading, voting, submitting |
| `reading-list-setup/apps-script.gs` | The backend, to paste into Apps Script |
| `reading-list-setup/preview.html` | Offline preview with sample data (passcode `demo`) |

`reading-list-setup/` is excluded from the built site in `_config.yml`.
