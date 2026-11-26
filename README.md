# Installment & Loan Tracker

Record instalment plans (total amount, schedule, paid instalments), get email reminders before due
dates, and see the remaining balance of every plan. Cloud Computing group project, deployed on
**Floci** (local AWS emulator) with **Neon Postgres** and the **Brevo** email API.

- **Frontend:** HTML, CSS and JavaScript (no framework), hosted in an S3 bucket
- **Backend:** Node.js + Express, one Lambda function per service, behind one API Gateway HTTP API
- **Data:** DynamoDB (plans, instalments, payments, reminders, notifications), S3 (receipts), Neon (users)
- **Events:** EventBridge bus + rule, EventBridge Scheduler (daily job), SQS (failed emails, alerts inbox)
- **Security and operations:** Secrets Manager + KMS (every secret), IAM least privilege per service,
  CloudWatch Logs, custom metrics and an alarm, SNS alerts topic for the lender

**Business features:** loans with interest (reducing-balance or flat) and a principal/interest split
per instalment; late-fee policies with a grace period, charged by the daily job (admin can waive);
early payoff with a quote that waives future interest; customer payments wait for the lender's
approval (receipt required); reminders before due dates, overdue alerts, and escalation of instalments
14+ days late to the lender.

```
Browser ──> S3 website (loan-tracker-web)
   │
   └─HTTPS/JSON + login token──> API Gateway (loan-tracker-http-api)
                                   ├─ /api/auth, /api/users      -> Lambda loan-tracker-auth      -> Neon users
                                   ├─ /api/plans...              -> Lambda loan-tracker-plans     -> DynamoDB LoanPlans, LoanInstalments
                                   ├─ /api/.../payments, balance -> Lambda loan-tracker-payments  -> DynamoDB LoanPayments, S3 receipts
                                   └─ reminders, notifications   -> Lambda loan-tracker-reminders -> DynamoDB rules + log, Brevo email
Plans/Payments ──events──> EventBridge bus ──rule──> Reminders      Scheduler (daily) ──> Reminders
Payments ──Lambda invoke──> Plans (internal API)      Reminders ──Lambda invoke──> Plans
```

## Who owns what

| Owner | Service | Code | Deploy script | AWS services |
|---|---|---|---|---|
| mahmoud | Plan & Schedule: interest, late fees, payoff quote | `services/plans/`, `frontend/plans.html`, `js/plans.js` | `infra/20-plans.sh` | API Gateway, Lambda, DynamoDB ×2, IAM, EventBridge, Secrets Manager, CloudWatch |
| othman | Payments & Balance: approval workflow, payoff, receipts | `services/payments/`, payment parts of `plan.html`, `js/dashboard.js` | `infra/30-payments.sh` | Lambda, DynamoDB (+ status index), S3, IAM, EventBridge, Secrets Manager, CloudWatch |
| abdelrahman | Reminders, Notifications & Monitoring | `services/reminders/`, `notifications.html`, `admin.html` | `infra/40-reminders.sh` | Lambda, DynamoDB ×3, EventBridge rule + Scheduler, SQS ×2, SNS, CloudWatch metrics + alarm, IAM, Secrets Manager + Brevo API |
| Group | Auth, shared code, secrets, website | `services/auth/`, `services/shared/`, `frontend/js/api.js, ui.js` | `infra/00-shared.sh`, `05-secrets.sh`, `10-auth.sh`, `90-frontend.sh` | S3 website, KMS, Secrets Manager, Neon |

Each service has the same layers: `app.js` (routes + validation) → `*Service.js` (business rules)
→ `repository.js` (DynamoDB). Pure rules that are easy to test are in their own files:
`plans/schedule.js`, `payments/allocation.js`, `reminders/reminderLogic.js`.

## 1. Try it in 1 minute (no Floci needed)

```bash
cd services
npm install
npm run demo
```

Open <http://localhost:3000>. Log in as `mona@demo.com` / `password123` (user) or `admin@demo.com` /
`password123` (admin). The demo data has an interest loan, a plan with a late fee, an overdue plan
that was escalated, and a payment waiting for approval. This mode uses an in-memory database, so
nothing is saved, and emails are printed in the terminal instead of being sent.

## 2. Deploy on Floci (the real submission)

**You need:** Docker Desktop (running), Git Bash on Windows, Node.js 20+, AWS CLI, and Floci running on
port 4566, the same setup as Labs 7 and 8. If Floci is not running yet:
`docker compose -f infra/floci/docker-compose.yml up -d`.

1. **Settings.** Copy `infra/deploy.env.example` to `infra/deploy.env` and fill it in.
   `infra/05-secrets.sh` moves the secret values into **Secrets Manager** (encrypted with a KMS key).
   The login-token and service secrets are generated there automatically.
   - `ADMIN_EMAILS`: the email the lender/admin will register with. `ALERT_EMAIL`: where escalations go.
   - `DATABASE_URL`: Neon. In Neon, create a project, then **Connect** and copy the connection string.
     The `users` table is created automatically.
   - `BREVO_API_KEY`, `EMAIL_FROM`: Brevo. Create a free account, go to **SMTP & API → API keys**, and
     verify a sender email under **Senders**. `EMAIL_FROM` must be that verified email.
2. **Deploy everything** (Git Bash, project folder):
   ```bash
   bash infra/deploy-all.sh
   ```
   This builds the four Lambda zips, creates every table, role, function, route, bucket, queue, rule
   and schedule, uploads the website, and ends with `infra/check.sh` (PASS/FAIL list). It is safe to
   run again. Use it after every code change, and after Floci restarts if Floci lost its resources.
3. **Open the app:** <http://localhost:4566/loan-tracker-web/index.html>. Type `localhost`, not
   `127.0.0.1`. The login page should show **API online: lambda (production)**.

**Updating only your own service** (for example, Student B):
```bash
node infra/build-zips.js payments && bash infra/30-payments.sh
```

**Useful commands**

| Command | What it does |
|---|---|
| `bash infra/check.sh` | Smoke test of the deployed app (copy the output into your evidence) |
| `bash infra/logs.sh plans 30` | CloudWatch logs of a service for the last 30 minutes |
| `bash infra/run-reminders.sh` | Runs the daily reminder check now (`… 2026-12-01` pretends it is that date) |
| `bash infra/alerts.sh` | Shows the lender alerts that arrived on the SNS topic, and the alarm state |
| `bash infra/rotate-secrets.sh` | Rotates the login-token and service secrets in Secrets Manager (no redeploy, nobody is logged out) |
| `bash infra/reset.sh` | Deletes everything from Floci, to start again |

## Secrets Manager

| Secret | Contents | Read by |
|---|---|---|
| `loan-tracker/app` | `JWT_SECRET`, `INTERNAL_TOKEN` (+ `*_PREVIOUS` after a rotation) | all four Lambdas |
| `loan-tracker/neon` | `DATABASE_URL` | auth only |
| `loan-tracker/brevo` | `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | reminders only |

All three secrets are encrypted with the customer KMS key `alias/loan-tracker-secrets`. Each Lambda
gets only `SECRET_IDS`, the names of the secrets it may read. Its IAM role allows `GetSecretValue` on
those names only, and `kms:Decrypt` only through Secrets Manager. `shared/secrets.js` loads the
values when a function starts and caches them for 5 minutes, which is how a rotation reaches every
Lambda without a redeploy. `infra/check.sh` checks that no secret value is in any Lambda's environment,
and each `/api/health/<service>` route shows which secret names it loaded (never the values).

## 3. Develop on your PC against Floci

```bash
cd services
cp .env.example .env        # fill in the same values as infra/deploy.env
npm install
npm run tables              # creates the DynamoDB tables on Floci (if not created yet)
aws --endpoint-url http://localhost:4566 s3 mb s3://loan-tracker-receipts
npm run dev                 # API + website on http://localhost:3000
```

`local-server.js` sends each path to the service that owns it, using the same route table as API
Gateway. Services call each other over HTTP instead of Lambda Invoke, and events go straight to
Reminders instead of through EventBridge.

## 4. Tests

```bash
cd services
npm test
```

63 automated tests: business rules (schedule, allocation, reminders), every API route with valid and
invalid input, security (401/403/415, CORS, internal routes), the full demo scenario, the Lambda
handlers with API Gateway, EventBridge and Scheduler events, interest maths, late fees, payoff, the
approval workflow, escalation, CloudWatch metrics, SNS alerts, Secrets Manager loading and JWT rotation. The tests use an in-memory DynamoDB, so
they need neither Floci nor internet.

For manual testing, import `docs/postman_collection.json` into Postman. Set `baseUrl` to
`http://localhost:3000` or your API address, then run the folders in order (32 requests). Results are
in `docs/test-results.md`.

## API

All routes are under one API address. Every route except register, login and health needs the
`Authorization: Bearer <token>` header. Errors always look like
`{ "error": { "code", "message", "details": [{ "field", "message" }] } }`.

| Service | Method and path | Notes |
|---|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/users` (admin) | Emails in `ADMIN_EMAILS` become ADMIN |
| Plans | `POST /api/plans` | Generates the schedule; an admin may set `ownerId` |
| Plans | `GET /api/plans?q=&status=&provider=&dueBefore=&overdue=&ownerId=&sort=` | Search/filter |
| Plans | `GET /api/plans/{planId}`, `PUT /api/plans/{planId}` | Reschedule keeps paid instalments |
| Plans | `PATCH /api/plans/{planId}/status`, `DELETE /api/plans/{planId}` | Cancel (no payments), delete (cancelled only) |
| Payments | `POST /api/plans/{planId}/payments`, `GET /api/plans/{planId}/payments?from=&to=&method=` | Oldest-first allocation |
| Payments | `GET /api/plans/{planId}/balance`, `GET /api/balances/summary` | Remaining balance per plan / dashboard |
| Payments | `POST` and `GET /api/payments/{paymentId}/receipt` | PDF/PNG/JPG up to 2 MB, private S3 |
| Payments | `PATCH /api/payments/{paymentId}/reversal` | Admin, within 24 h |
| Payments | `POST /api/plans/{planId}/payoffs` | Pay everything today (the payoff quote amount) |
| Payments | `GET /api/payments/pending`, `PATCH /api/payments/{paymentId}/verification` | Admin approval queue: APPROVE or REJECT (needs a reason) |
| Payments | `DELETE /api/payments/{paymentId}` | Customer withdraws a payment still waiting for approval |
| Plans | `GET /api/plans/{planId}/payoff-quote` | Amount to close the plan today and the interest saved |
| Plans | `POST /api/plans/{planId}/instalments/{seq}/late-fee-waivers` | Admin waives a late fee (with a reason) |
| Reminders | `GET /api/reminder-runs`, `GET /api/monitoring/overview` (admin) | Daily-job history, email stats, alert settings |
| Reminders | `GET` and `PUT /api/plans/{planId}/reminder-rule` | Days before (0–30), on/off, email |
| Reminders | `GET /api/reminders/upcoming?days=`, `GET /api/notifications?planId=&status=&type=` | Dashboard and log |
| Reminders | `POST /api/notifications/{id}/retries`, `POST /api/reminder-runs` (admin) | Retry a failed email / run the daily job now |

## Troubleshooting on Floci

| Problem | Fix |
|---|---|
| `check.sh` health checks fail with 500/502 | `bash infra/logs.sh <service>`. Lambda containers need Docker Desktop running. |
| Logs show the Lambda cannot reach DynamoDB (`ECONNREFUSED`, or calls to `amazonaws.com`) | Your Floci does not pass its address into Lambda. Set `LAMBDA_AWS_ENDPOINT=http://host.docker.internal:4566` in `infra/deploy.env` (or `http://floci:4566` if Floci runs in Docker Compose) and run `deploy-all.sh` again. |
| Login fails with Neon errors / emails fail with "Brevo unreachable" | The Lambda container has no internet. Check Docker Desktop's network, or leave `DATABASE_URL` empty to keep users in DynamoDB. |
| Reminder schedule shows a warning | Your Floci has no EventBridge Scheduler; the script falls back to a scheduled EventBridge rule. The Admin page's **Run check now** always works. |
| Website has no colours | Run `bash infra/90-frontend.sh` again (it sets the content types), then press Ctrl+F5. |
| "API offline" on the login page | Run `bash infra/90-frontend.sh` again, because the API address changes when Floci forgets the API. |

## Security notes

- Secrets live in Secrets Manager, encrypted with KMS. Each Lambda can read only its own secrets, and
  no secret value is in a Lambda environment, the code or git (`infra/deploy.env` and `services/.env`
  are git-ignored). Check with `git log -p | grep -i secret` before submitting.
- Passwords are hashed with bcrypt, login tokens are signed JWTs (8 hours), roles and plan ownership
  are checked in the backend on every request, and a forbidden request returns 403.
- Each Lambda role allows only its own tables, bucket, queue and the functions it must call.
- Input is validated on every route (400 with a message per field), bodies must be JSON (415),
  there are security headers, a per-IP rate limit (429), and CORS allows only the website.
- The frontend escapes all user text before showing it, so stored HTML or script never runs.

## Known limitations

- Floci is an emulator, so some AWS behaviour differs (for example, the API address, and scheduled
  rules in some versions). Moving to real AWS changes settings, not code.
- The rate limiter counts per Lambda instance (in memory), like in Lab 8.
- Payments are recorded, not processed. There is no real money movement.
- The Brevo free plan limits how many emails can be sent per day.
