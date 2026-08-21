import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RouteContext, Store } from "@emulators/core";
import { forbidden, notFound } from "./problem.js";
import { getApsStore, type ApsStore } from "./store.js";

const SIGNING_SECRET_KEY = "aps.signedBlobSecret";

function signingSecret(store: Store): string {
  const existing = store.getData<string>(SIGNING_SECRET_KEY);
  if (existing) return existing;
  const secret = randomBytes(32).toString("base64url");
  store.setData(SIGNING_SECRET_KEY, secret);
  return secret;
}

function signatureFor(store: Store, blobId: string, expires: number, nonce: string): string {
  return createHmac("sha256", signingSecret(store)).update(`${blobId}\n${expires}\n${nonce}`).digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function putSignedBlob(
  aps: ApsStore,
  input: { blobId: string; filename: string; contentType: string; content: Buffer },
): void {
  const data = {
    blob_id: input.blobId,
    filename: input.filename,
    content_type: input.contentType,
    content_base64: input.content.toString("base64"),
  };
  const existing = aps.signedBlobs.findOneBy("blob_id", input.blobId);
  if (existing) aps.signedBlobs.update(existing.id, data);
  else aps.signedBlobs.insert(data);
}

export function issueSignedBlobUrl(
  store: Store,
  baseUrl: string,
  blobId: string,
  ttlMs: number,
): { url: string; validUntil: string } {
  const expires = Date.now() + ttlMs;
  const nonce = randomBytes(12).toString("base64url");
  const signature = signatureFor(store, blobId, expires, nonce);
  const url = new URL(`/_aps/blobs/${encodeURIComponent(blobId)}`, baseUrl);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("signature", signature);
  return { url: url.toString(), validUntil: new Date(expires).toISOString() };
}

export function signedBlobRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);
  app.get("/_aps/blobs/:blobId", (c) => {
    const blobId = c.req.param("blobId");
    const expiresValue = c.req.query("expires");
    const nonce = c.req.query("nonce");
    const signature = c.req.query("signature");
    const expires = expiresValue ? Number(expiresValue) : Number.NaN;

    if (!Number.isSafeInteger(expires) || !nonce || !signature || expires <= Date.now()) {
      return forbidden(c, "The signed blob URL is invalid or has expired.");
    }
    const expected = signatureFor(store, blobId, expires, nonce);
    if (!signaturesMatch(signature, expected)) {
      return forbidden(c, "The signed blob URL is invalid or has expired.");
    }

    const blob = aps.signedBlobs.findOneBy("blob_id", blobId);
    if (!blob) return notFound(c, "The requested blob");
    return new Response(Buffer.from(blob.content_base64, "base64"), {
      status: 200,
      headers: {
        "Content-Type": blob.content_type,
        "Content-Disposition": `attachment; filename="${blob.filename}"`,
      },
    });
  });
}
