import type { DataPacketEnvelope, PacketBody } from '../types';
import type { CompactionPin, PacketSigner, PacketValidator, PayloadCodec, SnapshotGuard, ValidationPhase, ValidationResult, ValidatorContext } from './types';

/** Codec and validator registries (FR-010). Validators run in registration order. */
export class Extensions {
  private codecs = new Map<string, PayloadCodec>();
  private defaultId: string | undefined;
  private validators: PacketValidator[] = [];
  private _signer: PacketSigner | undefined;
  private _guard: SnapshotGuard | undefined;
  private pins: CompactionPin[] = [];

  registerSigner(signer: PacketSigner): void {
    this._signer = signer;
  }

  signer(): PacketSigner | undefined {
    return this._signer;
  }

  registerSnapshotGuard(guard: SnapshotGuard): void {
    this._guard = guard;
  }

  snapshotGuard(): SnapshotGuard | undefined {
    return this._guard;
  }

  registerCompactionPin(pin: CompactionPin): void {
    this.pins.push(pin);
  }

  isPinned(type: string, obj: string): boolean {
    return this.pins.some((p) => p(type, obj));
  }

  registerCodec(codec: PayloadCodec, opts: { makeDefault?: boolean } = {}): void {
    this.codecs.set(codec.id, codec);
    if (opts.makeDefault || this.defaultId === undefined) this.defaultId = codec.id;
  }

  registerValidator(validator: PacketValidator): void {
    this.validators = [...this.validators.filter((v) => v.id !== validator.id), validator];
  }

  codec(id: string): PayloadCodec | undefined {
    return this.codecs.get(id);
  }

  codecIds(): { default?: string; ids: string[] } {
    return { default: this.defaultId, ids: [...this.codecs.keys()] };
  }

  defaultCodec(): PayloadCodec | undefined {
    return this.defaultId ? this.codecs.get(this.defaultId) : undefined;
  }

  /** The first reject wins, then the first defer, otherwise accept. */
  async validate(
    phase: ValidationPhase,
    env: DataPacketEnvelope,
    body: PacketBody | undefined,
    ctx: ValidatorContext,
  ): Promise<ValidationResult> {
    let deferred: ValidationResult | undefined;
    for (const v of this.validators) {
      if (!v.phases.includes(phase)) continue;
      let r: ValidationResult;
      try {
        r = await v.validate(phase, env, body, ctx);
      } catch (e) {
        return { verdict: 'reject', reason: `validator ${v.id} threw: ${(e as Error).message}` };
      }
      if (r.verdict === 'reject') return r;
      if (r.verdict === 'defer' && !deferred) deferred = r;
    }
    return deferred ?? { verdict: 'accept' };
  }
}
