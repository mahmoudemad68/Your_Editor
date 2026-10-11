import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { READINESS_DEADLINE_MS } from "@editagent/job-queue";

/** Authenticated access to the configured bucket, not merely a reachable S3 host.
 * No write, list, output key, credential or SDK exception reaches the health response.
 */
export async function storageReady(client: S3Client, bucket: string): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client
        .send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: controller.signal })
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, READINESS_DEADLINE_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Share only in-flight work during simultaneous HTTP probes. Never cache a past
 * successful result: the next probe checks the current dependencies again.
 * Checks run in parallel; an individual error fails closed without leaking it.
 */
export function createRenderReadiness(
  probes: readonly (() => Promise<boolean>)[],
  shutdown: AbortSignal,
): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (shutdown.aborted) return Promise.resolve(false);
    pending ??= Promise.all(
      probes.map(async (probe) => {
        try {
          return await probe();
        } catch {
          return false;
        }
      }),
    )
      .then((results) => !shutdown.aborted && results.every(Boolean))
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
