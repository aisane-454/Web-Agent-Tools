/**
 * Copied verbatim from web-agent-codex-runtime/src/runtime/surfaceLease.ts:
 * exclusive physical-surface ownership so two concurrent tool calls can never
 * type into the same web page.
 */
import { ToolError } from "../errors.js";

export interface SurfaceLease {
  readonly key: string;
  readonly ownerId: string;
  readonly acquiredAt: number;
  release(): void;
}

export class SurfaceLeaseManager {
  private readonly active = new Map<string, SurfaceLease>();

  acquire(providerId: string, surfaceId: string, ownerId: string): SurfaceLease {
    const key = `${providerId}:${surfaceId}`;
    if (this.active.has(key)) {
      throw new ToolError("PROVIDER_BUSY", `Surface ${key} is already leased by another in-flight call.`, { provider: providerId });
    }
    let released = false;
    const lease: SurfaceLease = {
      key,
      ownerId,
      acquiredAt: Date.now(),
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(key) === lease) this.active.delete(key);
      }
    };
    this.active.set(key, lease);
    return lease;
  }

  snapshot(): Array<Pick<SurfaceLease, "key" | "ownerId" | "acquiredAt">> {
    return [...this.active.values()].map(({ key, ownerId, acquiredAt }) => ({ key, ownerId, acquiredAt }));
  }
}
