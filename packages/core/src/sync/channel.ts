/** Plugin message channels (A-4): opaque payloads between peers, outside the packet log. */

export interface PeerSummary {
  /** `${transportId}:${peerId}`. Pass it to `Channel.send`. */
  key: string;
  transport: string;
  peerId: string;
  label?: string;
  /** Spaces the peer declared in its hello (empty until the hello arrives). A relay that holds data for everyone reports ["*"]. */
  spaces: string[];
  /** The peer's hello `relay` flag (false until the hello arrives). */
  relay: boolean;
  /** Largest single message the transport carries unframed. */
  maxMessageBytes: number;
  /** The transport has a separate channel for bulk data (`capabilities.blobs`). */
  bulk: boolean;
  /** Lane magics the peer advertised in its hello (spec 004 B-1). */
  lanes: number[];
}

export interface Channel {
  /** Send to one peer by key. `space` lets a relay route the message (default "*": every other peer). */
  send(peerKey: string, payload: Uint8Array, opts?: { space?: string }): Promise<void>;
  /** Send to every connected peer. Resolves with how many peers were addressed. */
  broadcast(payload: Uint8Array, opts?: { space?: string }): Promise<number>;
  onMessage(handler: (peerKey: string, payload: Uint8Array) => void): () => void;
  /** Spaces to announce in `hello` so a relay can route to this device before it holds any data. */
  setRoutes(spaces: string[]): void;
}

export class ChannelHub {
  private handlers = new Map<string, Set<(peerKey: string, payload: Uint8Array) => void>>();
  private routeSets = new Map<string, string[]>();
  onRoutesChanged: () => void = () => undefined;
  send: (peerKey: string, name: string, space: string, payload: Uint8Array) => Promise<void> = async () => undefined;
  broadcast: (name: string, space: string, payload: Uint8Array) => Promise<number> = async () => 0;

  channel(name: string): Channel {
    return {
      send: (peerKey, payload, opts) => this.send(peerKey, name, opts?.space ?? '*', payload),
      broadcast: (payload, opts) => this.broadcast(name, opts?.space ?? '*', payload),
      onMessage: (h) => {
        let set = this.handlers.get(name);
        if (!set) this.handlers.set(name, (set = new Set()));
        set.add(h);
        return () => void set!.delete(h);
      },
      setRoutes: (spaces) => {
        this.routeSets.set(name, [...spaces]);
        this.onRoutesChanged();
      },
    };
  }

  dispatch(name: string, peerKey: string, payload: Uint8Array): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) {
      try {
        h(peerKey, payload);
      } catch {
        // a faulty plugin must never break the core
      }
    }
  }

  routes(): string[] {
    return [...new Set([...this.routeSets.values()].flat())];
  }
}
