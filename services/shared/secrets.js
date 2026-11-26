// Secrets come from AWS Secrets Manager, not from the code or the Lambda environment.
//
// Each Lambda only gets the NAMES of the secrets it may read (SECRET_IDS, e.g.
// "loan-tracker/app,loan-tracker/neon"), and its IAM role allows GetSecretValue on exactly those.
// Every secret is a JSON object such as {"JWT_SECRET":"...","INTERNAL_TOKEN":"..."}; its keys are
// loaded into process.env, so the rest of the code just reads process.env.JWT_SECRET.
//
// Values are cached for SECRETS_TTL_SECONDS (default 5 minutes). After a rotation
// (infra/rotate-secrets.sh) every Lambda picks up the new value within that time, without a redeploy.
//
// On your PC with no SECRET_IDS, nothing is loaded and the values come from services/.env.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let client;
let loadedAt = 0;
let inFlight = null;
const loadedKeys = new Set();

const secretIds = () => (process.env.SECRET_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ttlMs = () => Number(process.env.SECRETS_TTL_SECONDS || 300) * 1000;

async function fetchAll(ids) {
  client = client || new SecretsManagerClient({});
  for (const id of ids) {
    const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
    let values;
    try { values = JSON.parse(result.SecretString || '{}'); } catch {
      throw new Error(`Secret ${id} is not a JSON object.`);
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined) continue;
      process.env[key] = String(value);
      loadedKeys.add(key);
    }
  }
  loadedAt = Date.now();
  console.log(`[secrets] loaded ${ids.length} secret(s) from Secrets Manager: ${ids.join(', ')}`);
}

// Call before handling a request. Cheap when the cache is fresh.
async function loadSecrets({ force = false } = {}) {
  const ids = secretIds();
  if (!ids.length) return;
  if (!force && loadedAt && Date.now() - loadedAt < ttlMs()) return;
  if (!inFlight) {
    inFlight = fetchAll(ids)
      .catch((error) => {
        // Keep serving with the last good values if we have them; fail only on a cold start
        console.error('[secrets] could not load secrets:', error.name, error.message);
        if (!loadedAt) throw error;
      })
      .finally(() => { inFlight = null; });
  }
  await inFlight;
}

// Shown on the health route as evidence (names only, never values)
function secretsInfo() {
  const ids = secretIds();
  return ids.length
    ? { source: 'secrets-manager', secrets: ids, keys: [...loadedKeys].sort(), loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null }
    : { source: 'environment' };
}

module.exports = { loadSecrets, secretsInfo };
