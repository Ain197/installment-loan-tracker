# Test results

Run on 24 Nov 2026. Re-run before submitting, and add your own Floci evidence at the end.

## 1. Automated tests (`cd services && npm test`)

The tests run the real services with an in-memory DynamoDB (dynalite) and a fake S3, so they need
neither Floci nor internet. **Result: 63 passed, 0 failed.**

| Suite | What it proves |
|---|---|
| Auth and security | Roles, 401/403/415, broken JSON, internal routes locked, security headers, CORS |
| Service 1: Plan & Schedule | Schedule maths, business rules, ownership, search, admin-for-customer, reschedule, status workflow |
| Service 2: Payments & Balance | Payment rules, auto-complete, history/summary, S3 receipts (type sniffing, size), admin reversal |
| Service 3: Reminders & Notifications | Default rule via event, daily check sends once, overdue alerts, failed email + retry |
| Integrated scenario | The demo flow across all three services |
| Lambda handlers (Floci mode) | API Gateway v2 events, Lambda-to-Lambda calls, EventBridge and Scheduler events |
| Unit rule suites | Pure business rules (rounding, month ends, allocation order, reminder thresholds) |
| Interest / late fee / payoff rules | Amortisation (reducing and flat), weekly periods, fee/interest/principal order, grace periods, payoff waiver, escalation threshold |
| API: advanced features | Approval workflow (pending, receipt required, approve, reject, withdraw), late-fee run + waiver, payoff (admin and customer), escalation, run history, monitoring, CloudWatch metrics + SNS alert |
| Secrets Manager | Secrets loaded and cached, names-only health info, cold-start failure, JWT rotation with the previous key |

```text
▶ Auth and security
  ✔ register gives USER role, ADMIN_EMAILS gives ADMIN, no password hash leaks (0.773615ms)
  ✔ duplicate email -> 409; bad input -> 400 with field messages (90.25901ms)
  ✔ wrong password -> 401 with a message that does not reveal which part was wrong (87.235476ms)
  ✔ no token -> 401, forged token -> 401 (6.655708ms)
  ✔ user calling an admin route -> 403 (16.52092ms)
  ✔ non-JSON body -> 415, broken JSON -> 400 (4.799978ms)
  ✔ internal routes refuse calls without the internal token (1.893651ms)
  ✔ security headers are set and CORS only allows our website (3.331949ms)
✔ Auth and security (978.112025ms)
▶ Service 1: Plan & Schedule
  ✔ create -> 201 with a generated schedule that adds up to the total (24.500913ms)
  ✔ business rules -> 400 (down payment >= total, 121 instalments, old start date) (9.793249ms)
  ✔ users only see their own plans; another user gets 403 (30.748121ms)
  ✔ search by text, status and due-before; unknown id -> 404 (45.040804ms)
  ✔ admin creates a plan for a customer; unknown customer -> 400; user cannot (23.413292ms)
  ✔ reschedule keeps paid instalments; money fields locked after a payment (90.992034ms)
  ✔ status workflow: cancel only without payments, delete only when cancelled (107.306736ms)
✔ Service 1: Plan & Schedule (332.281847ms)
▶ Service 2: Payments & Balance
  ✔ payment rules: > remaining, future date, bad method, 0 amount -> 400 (38.882405ms)
  ✔ paying everything completes the plan automatically; then no more payments (114.476885ms)
  ✔ history with filters and the dashboard summary (127.734751ms)
  ✔ receipt upload to S3: real PDF accepted, fake or big files rejected, owner only (102.172397ms)
  ✔ reversal: admin only, re-allocates the rest, reopens a completed plan (153.024249ms)
✔ Service 2: Payments & Balance (536.696017ms)
▶ Service 3: Reminders & Notifications
  ✔ a default rule is created by the PlanCreated event; owner can change it (36.924299ms)
  ✔ daily check sends each reminder once, skips paid instalments, and logs it (277.329631ms)
  ✔ overdue alert after the due date; upcoming dashboard lists due and overdue (91.41167ms)
  ✔ failed email is logged as FAILED and can be retried (115.993735ms)
✔ Service 3: Reminders & Notifications (522.097707ms)
▶ Integrated scenario (the demo flow)
  ✔ create -> remind -> pay -> no repeat reminder -> pay rest -> completed + emails (324.01682ms)
✔ Integrated scenario (the demo flow) (324.168129ms)
▶ Interest rules (unit)
  ✔ reducing balance: 10,000 over 12 months at 12% -> equal payments, exact principal (1.333246ms)
  ✔ flat: 12,000 over 12 months at 10% -> 1,200 interest, 100 a month (0.200461ms)
  ✔ weekly loans use 52 periods a year (0.162671ms)
  ✔ money paid into an instalment covers fee, then interest, then principal (0.628742ms)
✔ Interest rules (unit) (2.970437ms)
▶ Late fee, payoff and escalation rules (unit)
  ✔ no fee inside the grace period, one fixed fee after it, never on paid instalments (0.393387ms)
  ✔ percentage fee is taken from what is still unpaid (0.116913ms)
  ✔ payoff: due instalments in full, future ones without their unpaid interest (1.231409ms)
  ✔ escalation only for instalments at least ESCALATION_DAYS late (0.327629ms)
✔ Late fee, payoff and escalation rules (unit) (2.332194ms)
▶ API: advanced features
  ✔ interest loan: totals, validation of rate and late-fee policy (40.133387ms)
  ✔ approval workflow: pending -> receipt required -> verified; balance only changes when verified (137.318312ms)
  ✔ reject needs a reason and emails the customer; withdraw removes a pending payment (104.106093ms)
  ✔ daily run applies late fees once, emails the customer, admin can waive (133.485483ms)
  ✔ early payoff: quote waives future interest; admin payoff completes the plan (124.535588ms)
  ✔ customer payoff goes through approval (117.008402ms)
  ✔ escalation after 14 days late, run history and monitoring overview (88.032726ms)
  ✔ CloudWatch metrics and an SNS alert are sent when configured (67.085783ms)
✔ API: advanced features (1423.768616ms)
▶ Secrets Manager
  ✔ secrets are loaded into the environment, cached, and shown (names only) on health (3.162997ms)
  ✔ a failing Secrets Manager on a cold start is an error, not silent defaults (1.667546ms)
  ✔ JWT rotation: tokens signed with the previous secret stay valid until they expire (0.885548ms)
✔ Secrets Manager (5.894761ms)
▶ Lambda handlers (Floci mode)
  ✔ health answers runtime: lambda when AWS_LAMBDA_FUNCTION_NAME is set (12.674991ms)
  ✔ full flow through API Gateway events and Lambda-to-Lambda calls (216.329769ms)
  ✔ reminders handler accepts EventBridge events and the daily schedule event (23.489828ms)
  ✔ internal routes cannot be reached without the internal token, even through Lambda (1.298704ms)
✔ Lambda handlers (Floci mode) (399.115696ms)
▶ Service 1 rules: schedule generation
  ✔ 1000 over 3 instalments = 333.33, 333.33, 333.34 (remainder on the last) (1.739648ms)
  ✔ monthly dates keep the day and clamp to the end of short months (0.272592ms)
  ✔ weekly and bi-weekly schedules (0.207029ms)
  ✔ plan view works out remaining balance, statuses and next due (0.454968ms)
  ✔ reschedule keeps paid instalments and spreads the rest (0.546068ms)
✔ Service 1 rules: schedule generation (4.084793ms)
▶ Service 2 rules: payment allocation
  ✔ oldest instalment first; overpayment rolls over; partial stays partial (0.280869ms)
  ✔ payments are applied in the order they were recorded (6.519239ms)
  ✔ more money than owed is reported as unused (0.343418ms)
  ✔ cents are exact (0.1 + 0.2 style problems do not happen) (0.373277ms)
✔ Service 2 rules: payment allocation (7.828036ms)
▶ Service 3 rules: which reminders are due
  ✔ 3 days before -> one DUE_SOON; paid and far-away instalments are skipped; overdue alert once (0.340449ms)
  ✔ a missed day is caught up with the nearest reminder (due in 2 days -> 3-day reminder id) (0.078236ms)
  ✔ same day twice -> same ids, so the log prevents a second email (0.193577ms)
  ✔ rule off, cancelled or completed plan -> no reminders (0.068371ms)
✔ Service 3 rules: which reminders are due (0.795669ms)
▶ Validation helper
  ✔ collects every problem with a message per field (1.917378ms)
  ✔ rejects more than 2 decimals (0.119494ms)
✔ Validation helper (2.146343ms)
ℹ tests 63
ℹ suites 14
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5213.222892
```

## 2. Postman collection (`docs/postman_collection.json`)

Run with Newman against `npm run demo` (`baseUrl = http://localhost:3000`):
**47 requests, 54 assertions, 0 failed.**

Covers every route of all three services, including interest loans, payoff, the approval workflow,
the daily job and monitoring, plus invalid input (400), missing token (401), wrong role (403),
unknown id (404) and business-rule conflicts (409).

## 3. Browser test

Tested in Chrome: login and register, the dashboard (totals, upcoming, overdue), plan search and
filters, creating a plan (and an admin creating one for a customer), recording a payment with a
receipt, an over-large amount showing the field error, reschedule, admin reversal, the reminder
rule, the notification log, and the admin "Run check now".

## 4. Deployment on Floci (fill in on your laptop)

Paste the output of `bash infra/check.sh`, plus screenshots of: the website on
`localhost:4566/loan-tracker-web`, Floci Dash (DynamoDB tables, Lambda functions, S3 buckets),
`aws apigatewayv2 get-routes`, CloudWatch logs (`bash infra/logs.sh reminders`), and a reminder
email in your inbox.

```text
(paste here)
```

## 5. Limitations found

- The automated tests use a fake S3 and an in-memory DynamoDB; the real AWS calls are only
  exercised on Floci (section 4).
- The deploy scripts were checked against another AWS emulator (moto). Floci-specific behaviour,
  such as how Lambda containers reach Floci, must be confirmed on your machine.
- The rate limiter is per Lambda instance.
