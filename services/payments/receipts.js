// Receipts sit in a private S3 bucket and only pass through this API, so every download is checked.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { badRequest } = require('../shared/errors');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (keeps the request under Lambda's 6 MB limit after base64)
const TYPES = {
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] }
};

let s3;
// forcePathStyle: Floci (like LocalStack) serves buckets as http://host:4566/bucket/key
const client = () => (s3 = s3 || new S3Client({ forcePathStyle: true }));
const bucket = () => process.env.RECEIPTS_BUCKET || 'loan-tracker-receipts';

// Checks the declared type, the real file signature (first bytes) and the size.
function decodeReceipt({ fileName, contentType, dataBase64 }) {
  const problems = [];
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 120) problems.push({ field: 'fileName', message: 'fileName is required (max 120 characters).' });
  if (!TYPES[contentType]) problems.push({ field: 'contentType', message: 'Only PDF, PNG or JPG receipts are accepted.' });
  if (typeof dataBase64 !== 'string' || !dataBase64 || !/^[A-Za-z0-9+/]+=*$/.test(dataBase64)) problems.push({ field: 'dataBase64', message: 'dataBase64 must be the file content in base64.' });
  if (problems.length) throw badRequest('The receipt is not valid.', problems);

  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0) throw badRequest('The receipt file is empty.', [{ field: 'dataBase64', message: 'Empty file.' }]);
  if (bytes.length > MAX_BYTES) throw badRequest('The receipt is larger than 2 MB.', [{ field: 'dataBase64', message: 'Max size is 2 MB.' }]);
  const { magic, ext } = TYPES[contentType];
  if (!magic.every((b, i) => bytes[i] === b)) {
    throw badRequest('The file content does not match its type.', [{ field: 'contentType', message: `This is not a real ${ext.toUpperCase()} file.` }]);
  }
  const safeName = fileName.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return { bytes, safeName, contentType };
}

async function saveReceipt(planId, paymentId, { bytes, safeName, contentType }) {
  const key = `receipts/${planId}/${paymentId}/${safeName}`;
  await client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: contentType }));
  return { key, size: bytes.length };
}

async function loadReceipt(key) {
  const result = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  return { dataBase64: bytes.toString('base64'), contentType: result.ContentType };
}

module.exports = { decodeReceipt, saveReceipt, loadReceipt, MAX_BYTES };
