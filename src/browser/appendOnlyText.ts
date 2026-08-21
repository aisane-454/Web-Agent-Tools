/**
 * Copied verbatim from web-agent-codex-runtime/src/runtime/appendOnlyText.ts:
 * turns provider DOM observations into safe append-only output deltas and
 * refuses provider rewrites (STREAM_DESYNC-class protection upstream).
 */
export type AppendOnlyObservation =
  | { kind: "unchanged" }
  | { kind: "delta"; delta: string }
  | { kind: "desynchronized"; previousCharacters: number; observedCharacters: number };

export class AppendOnlyTextAccumulator {
  private value = "";

  constructor(initialValue = "") {
    this.value = initialValue;
  }

  reset(value = ""): void {
    this.value = value;
  }

  current(): string {
    return this.value;
  }

  observe(nextValue: string): AppendOnlyObservation {
    if (nextValue === this.value) return { kind: "unchanged" };
    if (!nextValue.startsWith(this.value)) {
      return {
        kind: "desynchronized",
        previousCharacters: this.value.length,
        observedCharacters: nextValue.length
      };
    }
    const delta = nextValue.slice(this.value.length);
    this.value = nextValue;
    return delta ? { kind: "delta", delta } : { kind: "unchanged" };
  }
}
