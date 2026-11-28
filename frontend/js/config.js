// infra/90-frontend.sh writes the API Gateway address into FLOCI_API.
const FLOCI_API = 'http://REPLACE_WITH_API_ID.execute-api.localhost.floci.io:4566';

const API_BASE = (() => {
  if (window.location.port === '4566') {                          // website served from the Floci S3 bucket
    // Same-origin API path on Floci, so the site works without DNS for *.localhost.floci.io
    const id = (FLOCI_API.match(/\/\/([^.]+)\.execute-api\./) || [])[1];
    return id && id !== 'REPLACE_WITH_API_ID' ? `${window.location.origin}/_aws/execute-api/${id}/$default` : FLOCI_API;
  }
  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  return window.location.origin;                                  // npm run dev serves site + API together
})();
