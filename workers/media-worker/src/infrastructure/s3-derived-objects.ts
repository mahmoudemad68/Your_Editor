import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DerivedAsset, type DerivedArtifact, type MediaAsset } from "@editagent/domain";
import { type DerivativeObjects, type GeneratedDerivative } from "../application/derive-media.js";
import { canonicalJson, type DerivativePlan } from "../application/derivative-plan.js";
import { PermanentJobError } from "../application/job-errors.js";

/** Private streaming writes. A crash-recovery descriptor lives on the final object
 * so object-success/DB-failure can be reconciled without regenerating FFmpeg bytes.
 */
export class S3DerivedObjects implements DerivativeObjects {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async find(
    source: MediaAsset,
    plan: DerivativePlan,
    signal: AbortSignal,
  ): Promise<DerivedArtifact | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: plan.storageKey }),
        { abortSignal: signal },
      );
      const m = head.Metadata ?? {};
      if (
        m["signature"] !== plan.signature ||
        m["source-sha256"] !== source.contentSha256 ||
        head.ContentType !== plan.mimeType ||
        head.ContentLength === undefined ||
        m["byte-size"] !== String(head.ContentLength) ||
        m["descriptor"] === undefined ||
        m["sha256"] === undefined
      )
        throw new PermanentJobError("Derived object ownership or metadata conflict.");
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(Buffer.from(m["descriptor"], "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        throw new PermanentJobError("Derived object descriptor is invalid.");
      }
      if (
        metadata === null ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        metadata["variant"] !== plan.variant ||
        canonicalJson(metadata["parameters"]) !== canonicalJson(plan.parameters)
      )
        throw new PermanentJobError("Derived object parameters conflict.");
      const artifact: DerivedArtifact = {
        projectId: source.projectId,
        storageKey: plan.storageKey,
        parameterSignature: plan.signature,
        mimeType: plan.mimeType,
        byteSize: String(head.ContentLength),
        sha256: m["sha256"],
        metadata,
      };
      // Validate the same domain invariants on recovered object-only artifacts.
      new DerivedAsset(source.id, source.id, plan.kind, source.createdAt, undefined, artifact);
      return artifact;
    } catch (error) {
      signal.throwIfAborted();
      if (status(error) === 404) return null;
      if (error instanceof PermanentJobError) throw error;
      throw new Error("Derived object lookup failed.", { cause: error });
    }
  }
  async put(
    source: MediaAsset,
    plan: DerivativePlan,
    output: GeneratedDerivative,
    signal: AbortSignal,
  ): Promise<DerivedArtifact> {
    const file = await stat(output.filePath);
    const digest = createHash("sha256");
    const input = createReadStream(output.filePath, { signal });
    for await (const chunk of input) digest.update(chunk as Buffer);
    const sha256 = digest.digest("hex");
    const descriptor = Buffer.from(canonicalJson(output.metadata)).toString("base64");
    if (Buffer.byteLength(descriptor) > 1800)
      throw new PermanentJobError("Derived object descriptor exceeds metadata budget.");
    const body = createReadStream(output.filePath, { signal });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: plan.storageKey,
          ContentType: plan.mimeType,
          ContentLength: file.size,
          Body: body,
          IfNoneMatch: "*",
          Metadata: {
            signature: plan.signature,
            "source-sha256": source.contentSha256!,
            sha256,
            "byte-size": String(file.size),
            descriptor,
          },
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      signal.throwIfAborted();
      if (status(error) !== 412 && status(error) !== 409)
        throw new Error("Derived object upload failed.", { cause: error });
    } finally {
      body.destroy();
    }
    const saved = await this.find(source, plan, signal);
    if (
      saved === null ||
      saved.sha256 !== sha256 ||
      saved.byteSize !== String(file.size) ||
      canonicalJson(saved.metadata) !== canonicalJson(output.metadata)
    )
      throw new PermanentJobError("Conditional derived object write conflicted.");
    return saved;
  }
}
function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}
