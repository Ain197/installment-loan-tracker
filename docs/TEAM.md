# Team split and commit guide

Three members, one service each, no file owned by two people. Every member commits only their own files,
from their own GitHub account, on their own branch, and merges through a pull request.

| Member | Service | Owns (main parts) | AWS services in their service |
|---|---|---|---|
| **C: Abdelrahman** (repo owner) | Reminders, Notifications & Monitoring | `services/reminders/`, Secrets Manager loader, events, metrics, alerts, Emails page, Lender desk, deploy tooling, `infra/00-shared.sh`, `05-secrets.sh`, `40-reminders.sh` | Lambda, DynamoDB ×3, EventBridge rule + Scheduler, SQS ×2, SNS, CloudWatch metrics + alarm, IAM, Secrets Manager + KMS; Brevo API |
| **A** | Plan & Schedule | `services/plans/`, shared helpers (errors, validation, money, dates, app factory, DynamoDB), design system, Plans + Plan pages, `infra/20-plans.sh`, `90-frontend.sh` | API Gateway, Lambda, DynamoDB ×2, EventBridge, IAM, Secrets Manager, CloudWatch, S3 website |
| **B** | Payments & Balance (+ Auth) | `services/payments/`, `services/auth/`, login tokens and service client, Login + Overview pages, `infra/10-auth.sh`, `30-payments.sh` | Lambda, DynamoDB (+ status index), S3 receipts, EventBridge, IAM, Secrets Manager, CloudWatch; Neon Postgres |

The exact files and the order of commits are in `team/plan.txt`: 9 commits for A, 8 for B, 9 for C.

## 1. Abdelrahman: create the repository (once)

1. On GitHub: **New repository**, name `installment-loan-tracker`, **Private**, no README.
2. **Settings → Collaborators → Add people**: add A and B.
3. In Git Bash, in an empty folder (not the deployed project folder):
   ```bash
   git clone https://github.com/<your-user>/installment-loan-tracker.git
   cd installment-loan-tracker
   git config user.name "Abdelrahman Mohamed"
   git config user.email "<the email of your GitHub account>"
   mkdir team && cp ~/Documents/installment-loan-tracker/team/* team/
   bash team/commit-step.sh C1 ~/Documents/installment-loan-tracker
   git push -u origin main
   ```
4. Send A and B the project zip (`installment-loan-tracker.zip`). That is the full project they copy their files from.

## 2. Everyone: commit your own part

```bash
git clone https://github.com/<abdelrahman-user>/installment-loan-tracker.git
cd installment-loan-tracker
git config user.name "Your Name"
git config user.email "<the email of YOUR GitHub account>"
git switch -c feature/plans            # A: feature/plans   B: feature/payments   C: feature/reminders
bash team/commit-step.sh --list A      # your steps (A, B or C) and which are done
```

Then, for each of your steps, in order (for example A1, A2, …):

```bash
bash team/commit-step.sh A1 /c/Users/<you>/Downloads/installment-loan-tracker
```

The script copies only that step's files from the unzipped project, shows them, and commits them under
**your** name with a clear message, for example `Plans: schedule maths with interest, late fees and payoff quote [A3]`.

Spread your steps over several days and read each step's files before you commit it. Then push and open a
pull request into `main`:

```bash
git push -u origin feature/plans
```

On GitHub: **Compare & pull request**, then Abdelrahman merges it. The three branches never touch the
same file, so the merges never conflict, in any order. After all three are merged, `main` is the complete,
working app (this was rehearsed: same files, all 63 tests pass).

The email in `git config user.email` must be one that is added to your GitHub account, otherwise GitHub
does not show the commits as yours.

## 3. After the merge: everyone can run it

```bash
git switch main && git pull
cd services && npm install && npm test      # 63 tests
npm run demo                                # http://localhost:3000 without Floci
```

Deploying on Floci: copy `infra/deploy.env.example` to `infra/deploy.env`, fill it in, then double-click
`deploy.cmd` (or `bash infra/deploy-all.sh`). Never commit `deploy.env`; it is in `.gitignore`.

## 4. What each member must be able to explain

**A: Plan & Schedule**
- How a schedule is built: equal parts with the rounding cent on the last instalment; month ends (31 Jan → 28 Feb).
- Reducing-balance interest (annuity formula) versus flat interest, and why the principal always adds up exactly.
- Late fees: grace period, fixed or percentage, charged once, waived by an admin only if no part is paid.
- Payoff quote: due instalments in full, future ones without their unpaid interest.
- Status workflow ACTIVE → COMPLETED/CANCELLED, reschedule keeps paid instalments.
- Your AWS: API Gateway routes, Lambda, the two DynamoDB tables and the ownerId index, IAM policy, events you publish.

**B: Payments & Balance (+ Auth)**
- Oldest-first allocation (fee, then interest, then principal) and why it is always rebuilt from all valid payments.
- The approval workflow: PENDING → VERIFIED or REJECTED; why a receipt is required; withdraw; 24-hour reversal.
- Early payoff as a payment, and how it settles the plan through the Plans internal API.
- Receipts in a private S3 bucket: type check by file signature, 2 MB limit, ownership check on download.
- Login: bcrypt hashes, JWT with role, 401 vs 403, users in Neon (and the DynamoDB fallback).
- Your AWS: Lambda, DynamoDB with the status index, S3, IAM, how Payments calls Plans by Lambda Invoke.

**C: Reminders & Monitoring (Abdelrahman)**
- The daily job: late fees (via Plans) → reminders → escalations → metrics → alerts → run history.
- Why a reminder is never sent twice (deterministic notification id + conditional write) and the catch-up rule.
- Brevo as the external API, failed emails, retries and the SQS dead-letter queue.
- CloudWatch custom metrics and the alarm on failed emails → SNS topic → SQS alerts inbox.
- Secrets Manager + KMS: what is stored where, least-privilege IAM per Lambda, rotation without logging anyone out.
- How EventBridge (rule + Scheduler) starts the Reminders Lambda in three different ways.

## 5. Demo video (5 minutes): suggested split

| Time | Who | What to show |
|---|---|---|
| 0:00–0:30 | C | Floci running, `deploy.cmd` / `check.cmd` all PASS, the AWS resources in Floci |
| 0:30–1:45 | A | Create a loan with interest and a late-fee policy, its schedule and ribbon, payoff quote |
| 1:45–3:00 | B | Customer records a payment with a receipt → pending → lender approves → balance updates |
| 3:00–4:30 | C | Lender desk: run the daily job → late fee, reminder and escalation; emails page; `alerts.sh` |
| 4:30–5:00 | all | Secrets Manager (no secrets in Lambda), tests passing |
